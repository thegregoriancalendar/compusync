// Mission Control uses session-level DockControl events rather than scroll
// events. The type/subtype/axis fields are undocumented macOS values; keep
// their use isolated here. Flatten the original event so progress, velocity,
// and the embedded HID payload survive transport without reconstruction.
use super::*;
use std::{fmt::Write, sync::atomic::AtomicUsize};

const SESSION_TAP: u32 = 1;
const GESTURE: u32 = 29;
const DOCK_CONTROL: u32 = 30;
const HID_TYPE: u32 = 110;
const DOCK_SWIPE: i64 = 23;
const SWIPE_AXIS: u32 = 123;
const VERTICAL: i64 = 2;
const PHASE: u32 = 132;
const BEGAN: i64 = 1;
const CHANGED: i64 = 2;
const ENDED: i64 = 4;
const CANCELLED: i64 = 8;
const MAX_BYTES: usize = 16384;

unsafe extern "C" {
    fn CGEventGetType(event: CgEvent) -> u32;
    fn CGEventSetType(event: CgEvent, kind: u32);
    fn CGEventSetTimestamp(event: CgEvent, timestamp: u64);
    fn CGEventCreateCopy(event: CgEvent) -> CgEvent;
    fn CGEventCreateData(allocator: CfType, event: CgEvent) -> CfType;
    fn CGEventCreateFromData(allocator: CfType, data: CfType) -> CgEvent;
    fn CFDataCreate(allocator: CfType, bytes: *const u8, length: isize) -> CfType;
    fn CFDataGetLength(data: CfType) -> isize;
    fn CFDataGetBytePtr(data: CfType) -> *const u8;
}

fn vertical_swipe(event: CgEvent) -> bool {
    unsafe {
        CGEventGetType(event) == DOCK_CONTROL
            && CGEventGetIntegerValueField(event, HID_TYPE) == DOCK_SWIPE
            && CGEventGetIntegerValueField(event, SWIPE_AXIS) == VERTICAL
            && matches!(
                CGEventGetIntegerValueField(event, PHASE),
                BEGAN | CHANGED | ENDED | CANCELLED
            )
    }
}

fn flatten(event: CgEvent) -> Result<String, String> {
    let data = OwnedCf(unsafe { CGEventCreateData(null(), event) });
    if data.0.is_null() {
        return Err("could not flatten trackpad gesture".into());
    }
    let length = unsafe { CFDataGetLength(data.0) };
    if length <= 0 || length as usize > MAX_BYTES {
        return Err("trackpad gesture exceeds the transport limit".into());
    }
    let bytes = unsafe { std::slice::from_raw_parts(CFDataGetBytePtr(data.0), length as usize) };
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(encoded, "{byte:02x}");
    }
    Ok(encoded)
}

fn restore(encoded: &str) -> Result<OwnedCf, String> {
    if encoded.is_empty() || encoded.len() > MAX_BYTES * 2 || encoded.len() % 2 != 0 {
        return Err("invalid trackpad gesture size".into());
    }
    let digit = |byte| match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    };
    let bytes: Option<Vec<u8>> = encoded
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| Some(digit(pair[0])? * 16 + digit(pair[1])?))
        .collect();
    let bytes = bytes.ok_or("invalid trackpad gesture encoding")?;
    let data = OwnedCf(unsafe { CFDataCreate(null(), bytes.as_ptr(), bytes.len() as isize) });
    if data.0.is_null() {
        return Err("could not allocate trackpad gesture data".into());
    }
    let event = OwnedCf(unsafe { CGEventCreateFromData(null(), data.0) }.cast());
    if event.0.is_null() || !vertical_swipe(event.0 as CgEvent) {
        return Err("only vertical Dock swipes may be replayed".into());
    }
    Ok(event)
}

pub(super) struct Capture {
    sink: EventSink,
    enabled: AtomicBool,
    non_owner: AtomicBool,
    redirecting: AtomicBool,
    suppress_companion: AtomicBool,
    tap: AtomicUsize,
}

impl Capture {
    pub(super) fn new(sink: EventSink, enabled: bool) -> Self {
        Self {
            sink,
            enabled: AtomicBool::new(enabled),
            non_owner: AtomicBool::new(false),
            redirecting: AtomicBool::new(false),
            suppress_companion: AtomicBool::new(false),
            tap: AtomicUsize::new(0),
        }
    }

    pub(super) fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Release);
    }

    pub(super) fn set_mode(&self, linked: bool, owner: bool) {
        self.non_owner.store(linked && !owner, Ordering::Release);
    }

    fn handle(&self, kind: u32, event: CgEvent) -> CgEvent {
        if unsafe { CGEventGetIntegerValueField(event, CG_FIELD_SOURCE_USER_DATA) }
            == COMPUSYNC_SOURCE_TAG
        {
            return event;
        }
        if kind == GESTURE && self.suppress_companion.swap(false, Ordering::AcqRel) {
            return null_mut();
        }
        if !vertical_swipe(event) {
            return event;
        }
        let phase = unsafe { CGEventGetIntegerValueField(event, PHASE) };
        let forward =
            self.enabled.load(Ordering::Acquire) && self.non_owner.load(Ordering::Acquire);
        if phase == BEGAN {
            self.redirecting.store(forward, Ordering::Release);
        }
        if !self.redirecting.load(Ordering::Acquire) {
            return event;
        }
        // Once a swipe was redirected, consume its remaining local phases
        // even if ownership changes. The destination cancels on relinquish.
        if forward {
            match flatten(event) {
                Ok(data) => {
                    let mut native = NativeEvent::simple("trackpadGesture");
                    native.data = Some(data);
                    (self.sink)(native);
                }
                Err(_) if phase == BEGAN => {
                    self.redirecting.store(false, Ordering::Release);
                    return event;
                }
                Err(_) => {}
            }
        }
        self.suppress_companion.store(true, Ordering::Release);
        if matches!(phase, ENDED | CANCELLED) {
            self.redirecting.store(false, Ordering::Release);
        }
        null_mut()
    }
}

unsafe extern "C" fn callback(
    _: CgEventTapProxy,
    kind: u32,
    event: CgEvent,
    user: *mut c_void,
) -> CgEvent {
    if user.is_null() {
        return event;
    }
    catch_unwind(AssertUnwindSafe(|| {
        let context = unsafe { &*(user as *const Capture) };
        macos_event_tap::dispatch(
            kind,
            event,
            || {
                let tap = context.tap.load(Ordering::Acquire) as CfMachPort;
                if !tap.is_null() {
                    unsafe { CGEventTapEnable(tap, true) };
                }
            },
            || context.handle(kind, event),
        )
    }))
    .unwrap_or(event)
}

pub(super) struct Tap {
    tap: OwnedCf,
    source: OwnedCf,
    run_loop: CfRunLoop,
    context: Arc<Capture>,
}

impl Tap {
    pub(super) fn install(context: Arc<Capture>, run_loop: CfRunLoop) -> Result<Self, String> {
        let tap = OwnedCf(
            unsafe {
                CGEventTapCreate(
                    SESSION_TAP,
                    0,
                    0,
                    (1 << GESTURE) | (1 << DOCK_CONTROL),
                    Some(callback),
                    Arc::as_ptr(&context) as *mut c_void,
                )
            }
            .cast(),
        );
        if tap.0.is_null() {
            return Err("CGEventTapCreate for trackpad gestures failed; grant Accessibility and Input Monitoring permissions".into());
        }
        let source =
            OwnedCf(unsafe { CFMachPortCreateRunLoopSource(null(), tap.0 as CfMachPort, 0) });
        if source.0.is_null() {
            return Err("could not create the gesture event source".into());
        }
        context.tap.store(tap.0 as usize, Ordering::Release);
        unsafe {
            CFRunLoopAddSource(run_loop, source.0, kCFRunLoopCommonModes);
            CGEventTapEnable(tap.0 as CfMachPort, true);
        }
        Ok(Self {
            tap,
            source,
            run_loop,
            context,
        })
    }
}

impl Drop for Tap {
    fn drop(&mut self) {
        unsafe {
            CGEventTapEnable(self.tap.0 as CfMachPort, false);
            CFRunLoopRemoveSource(self.run_loop, self.source.0, kCFRunLoopCommonModes);
        }
        self.context.tap.store(0, Ordering::Release);
    }
}

#[derive(Default)]
pub(super) struct Replay {
    active: Option<OwnedCf>,
}

// Each DockControl sample needs a companion gesture marker. Keeping them in
// one transport message prevents interleaving and preserves the final marker.
fn post_pair(event: CgEvent) {
    let marker = OwnedCf(unsafe { CGEventCreate(null()) }.cast());
    if marker.0.is_null() {
        return;
    }
    unsafe {
        CGEventSetType(marker.0 as CgEvent, GESTURE);
        CGEventSetIntegerValueField(
            marker.0 as CgEvent,
            CG_FIELD_SOURCE_USER_DATA,
            COMPUSYNC_SOURCE_TAG,
        );
        CGEventPost(SESSION_TAP, event);
        CGEventPost(SESSION_TAP, marker.0 as CgEvent);
    }
}

impl Replay {
    pub(super) fn receive(&mut self, encoded: &str) -> Result<(), String> {
        self.receive_with(encoded, post_pair)
    }

    fn receive_with(&mut self, encoded: &str, mut post: impl FnMut(CgEvent)) -> Result<(), String> {
        let event = restore(encoded)?;
        let raw = event.0 as CgEvent;
        let phase = unsafe { CGEventGetIntegerValueField(raw, PHASE) };
        if phase == BEGAN {
            self.cancel_with(&mut post);
        } else if self.active.is_none() {
            // Ignore delayed phases after unlink, cancellation, or handoff.
            return Ok(());
        }
        let now = OwnedCf(unsafe { CGEventCreate(null()) }.cast());
        if now.0.is_null() {
            return Err("could not read the local gesture context".into());
        }
        unsafe {
            CGEventSetLocation(raw, CGEventGetLocation(now.0 as CgEvent));
            CGEventSetTimestamp(raw, CGEventGetTimestamp(now.0 as CgEvent));
            CGEventSetIntegerValueField(raw, CG_FIELD_SOURCE_USER_DATA, COMPUSYNC_SOURCE_TAG);
        }
        post(raw);
        self.active = if matches!(phase, ENDED | CANCELLED) {
            None
        } else {
            Some(event)
        };
        Ok(())
    }

    pub(super) fn cancel(&mut self) {
        self.cancel_with(post_pair);
    }

    fn cancel_with(&mut self, mut post: impl FnMut(CgEvent)) {
        if let Some(event) = self.active.take() {
            let cancelled = OwnedCf(unsafe { CGEventCreateCopy(event.0 as CgEvent) }.cast());
            if cancelled.0.is_null() {
                return;
            }
            unsafe {
                CGEventSetIntegerValueField(cancelled.0 as CgEvent, PHASE, CANCELLED);
                CGEventSetIntegerValueField(cancelled.0 as CgEvent, 134, CANCELLED);
            }
            post(cancelled.0 as CgEvent);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn swipe(phase: i64, progress: f64) -> OwnedCf {
        let event = OwnedCf(unsafe { CGEventCreate(null()) }.cast());
        assert!(!event.0.is_null());
        unsafe {
            CGEventSetType(event.0 as CgEvent, DOCK_CONTROL);
            CGEventSetIntegerValueField(event.0 as CgEvent, HID_TYPE, DOCK_SWIPE);
            CGEventSetIntegerValueField(event.0 as CgEvent, SWIPE_AXIS, VERTICAL);
            CGEventSetIntegerValueField(event.0 as CgEvent, PHASE, phase);
            CGEventSetDoubleValueField(event.0 as CgEvent, 124, progress);
            CGEventSetLocation(
                event.0 as CgEvent,
                CgPoint {
                    x: -9000.0,
                    y: -8000.0,
                },
            );
        }
        event
    }

    #[test]
    fn only_the_non_owner_redirects_vertical_swipes_and_their_final_companion() {
        for enabled in [false, true] {
            for (linked, owner) in [(false, false), (false, true), (true, true), (true, false)] {
                let events = Arc::new(Mutex::new(Vec::<NativeEvent>::new()));
                let captured = events.clone();
                let capture =
                    Capture::new(Arc::new(move |event| captured.lock().push(event)), enabled);
                capture.set_mode(linked, owner);
                let redirect = enabled && linked && !owner;
                for (phase, progress) in [(BEGAN, 0.0), (CHANGED, 0.75), (ENDED, 1.5)] {
                    let event = swipe(phase, progress);
                    assert_eq!(
                        capture.handle(DOCK_CONTROL, event.0 as CgEvent).is_null(),
                        redirect
                    );
                    let marker = OwnedCf(unsafe { CGEventCreate(null()) }.cast());
                    unsafe {
                        CGEventSetType(marker.0 as CgEvent, GESTURE);
                    }
                    assert_eq!(
                        capture.handle(GESTURE, marker.0 as CgEvent).is_null(),
                        redirect
                    );
                    // Never consume an unrelated second gesture marker.
                    assert_eq!(
                        capture.handle(GESTURE, marker.0 as CgEvent),
                        marker.0 as CgEvent
                    );
                }
                assert_eq!(events.lock().len(), if redirect { 3 } else { 0 });
                for native in events.lock().iter() {
                    assert_eq!(native.kind, "trackpadGesture");
                    assert!(restore(native.data.as_ref().unwrap()).is_ok());
                }
            }
        }
    }

    #[test]
    fn horizontal_pinch_and_injected_gestures_pass_without_echo() {
        let capture = Capture::new(
            Arc::new(|_| panic!("unrelated gesture was forwarded")),
            true,
        );
        capture.set_mode(true, false);
        for (axis, subtype, tag) in [
            (1, DOCK_SWIPE, 0),
            (3, DOCK_SWIPE, 0),
            (2, 8, 0),
            (2, DOCK_SWIPE, COMPUSYNC_SOURCE_TAG),
        ] {
            let event = swipe(BEGAN, 0.0);
            unsafe {
                CGEventSetIntegerValueField(event.0 as CgEvent, SWIPE_AXIS, axis);
                CGEventSetIntegerValueField(event.0 as CgEvent, HID_TYPE, subtype);
                CGEventSetIntegerValueField(event.0 as CgEvent, CG_FIELD_SOURCE_USER_DATA, tag);
            }
            assert_eq!(
                capture.handle(DOCK_CONTROL, event.0 as CgEvent),
                event.0 as CgEvent
            );
        }
    }

    #[test]
    fn replay_preserves_swipe_progress_and_cancellation_and_rejects_stale_phases() {
        let mut replay = Replay::default();
        let mut posted = Vec::new();
        let mut post = |event| {
            posted.push(unsafe {
                assert_eq!(
                    CGEventGetIntegerValueField(event, CG_FIELD_SOURCE_USER_DATA),
                    COMPUSYNC_SOURCE_TAG
                );
                assert_ne!(CGEventGetLocation(event).x, -9000.0);
                (
                    CGEventGetIntegerValueField(event, PHASE),
                    CGEventGetDoubleValueField(event, 124),
                )
            });
        };
        for (phase, progress) in [
            (BEGAN, 0.0),
            (CHANGED, 0.75),
            (CHANGED, 0.25),
            (CANCELLED, 0.0),
        ] {
            replay
                .receive_with(
                    &flatten(swipe(phase, progress).0 as CgEvent).unwrap(),
                    &mut post,
                )
                .unwrap();
        }
        assert!(replay.active.is_none());
        replay
            .receive_with(
                &flatten(swipe(CHANGED, 1.0).0 as CgEvent).unwrap(),
                &mut post,
            )
            .unwrap();
        assert_eq!(
            posted,
            [
                (BEGAN, 0.0),
                (CHANGED, 0.75),
                (CHANGED, 0.25),
                (CANCELLED, 0.0)
            ]
        );

        let begin = flatten(swipe(BEGAN, 0.0).0 as CgEvent).unwrap();
        replay.receive_with(&begin, |_| {}).unwrap();
        let mut cancelled = Vec::new();
        replay.cancel_with(|event| {
            cancelled.push(unsafe { CGEventGetIntegerValueField(event, PHASE) })
        });
        replay.cancel_with(|_| panic!("gesture cancelled twice"));
        replay
            .receive_with(&flatten(swipe(ENDED, 1.5).0 as CgEvent).unwrap(), |_| {
                panic!("stale ending replayed")
            })
            .unwrap();
        assert_eq!(cancelled, [CANCELLED]);
    }

    #[test]
    fn malformed_or_non_swipe_payloads_never_reach_the_os() {
        let mut replay = Replay::default();
        for data in [
            "".into(),
            "0".into(),
            "zz".into(),
            "00".into(),
            "00".repeat(MAX_BYTES + 1),
        ] {
            assert!(replay
                .receive_with(&data, |_| panic!("invalid data posted"))
                .is_err());
        }
        for event in [
            OwnedCf(unsafe { CGEventCreate(null()) }.cast()),
            swipe(16, 0.0),
        ] {
            let data = flatten(event.0 as CgEvent).unwrap();
            assert!(replay
                .receive_with(&data, |_| panic!("non-swipe data posted"))
                .is_err());
        }
    }
}
