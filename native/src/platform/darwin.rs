use super::{macos_event_tap, EventSink, Platform};
use crate::{DisplayMetric, NativeEvent, Point, Rect, WindowInfo};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::{
    collections::BTreeMap,
    ffi::{c_char, c_void, CStr},
    panic::{catch_unwind, AssertUnwindSafe},
    ptr::{null, null_mut},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
};

type CfType = *const c_void;
type CfArray = *const c_void;
type CfString = *const c_void;
type CfRunLoop = *mut c_void;
type CfMachPort = *mut c_void;
type AxElement = *mut c_void;
type AxObserver = *mut c_void;
type AxValue = *const c_void;
type CgEvent = *mut c_void;
type CgEventTapProxy = *mut c_void;
type CgDisplay = u32;

#[repr(C)]
struct AeDesc {
    descriptor_type: u32,
    data_handle: *mut c_void,
}

const CG_EVENT_LEFT_DOWN: u32 = 1;
const CG_EVENT_LEFT_UP: u32 = 2;
const CG_EVENT_RIGHT_DOWN: u32 = 3;
const CG_EVENT_RIGHT_UP: u32 = 4;
const CG_EVENT_MOUSE_MOVED: u32 = 5;
const CG_EVENT_LEFT_DRAGGED: u32 = 6;
const CG_EVENT_RIGHT_DRAGGED: u32 = 7;
const CG_EVENT_KEY_DOWN: u32 = 10;
const CG_EVENT_KEY_UP: u32 = 11;
const CG_EVENT_FLAGS_CHANGED: u32 = 12;
const CG_EVENT_SCROLL_WHEEL: u32 = 22;
const CG_EVENT_OTHER_DOWN: u32 = 25;
const CG_EVENT_OTHER_UP: u32 = 26;
const CG_EVENT_OTHER_DRAGGED: u32 = 27;
const CG_FIELD_MOUSE_BUTTON: u32 = 3;
// Unlike kCGMouseEventDeltaX/Y, these fields contain raw device movement and
// are not contaminated by CoreGraphics cursor acceleration or our own warps.
// They have been public CGEventField values since macOS 10.15.1.
const CG_FIELD_UNACCELERATED_POINTER_MOVEMENT_X: u32 = 170;
const CG_FIELD_UNACCELERATED_POINTER_MOVEMENT_Y: u32 = 171;
const CG_FIELD_KEYCODE: u32 = 9;
const CG_FIELD_SCROLL_DELTA_AXIS_1: u32 = 11;
const CG_FIELD_SCROLL_FIXED_DELTA_AXIS_1: u32 = 93;
const CG_FIELD_SOURCE_USER_DATA: u32 = 42;
const COMPUSYNC_SOURCE_TAG: i64 = 0x4353_594E;
const COMPUSYNC_MOVE_LOOP_TAG: i64 = 0x4353_4D4C;
const CG_FLAG_SHIFT: u64 = 1 << 17;
const CG_FLAG_CONTROL: u64 = 1 << 18;
const CG_FLAG_ALTERNATE: u64 = 1 << 19;
const CG_FLAG_COMMAND: u64 = 1 << 20;
const AX_VALUE_POINT: u32 = 1;
const AX_VALUE_SIZE: u32 = 2;
const TYPE_APPLICATION_BUNDLE_ID: u32 = u32::from_be_bytes(*b"bund");
const TYPE_WILDCARD: u32 = u32::from_be_bytes(*b"****");
const ERR_AE_EVENT_NOT_PERMITTED: i32 = -1743;

struct AxConstants {
    windows: usize,
    focused_application: usize,
    focused_window: usize,
    position: usize,
    size: usize,
    title: usize,
    minimized: usize,
    fullscreen: usize,
    moved: usize,
    resized: usize,
    focused: usize,
    raise: usize,
    close: usize,
}

static AX: Lazy<AxConstants> = Lazy::new(|| {
    let make = |value: &'static [u8]| unsafe {
        CFStringCreateWithCString(null(), value.as_ptr().cast(), 0x0800_0100) as usize
    };
    AxConstants {
        windows: make(b"AXWindows\0"),
        focused_application: make(b"AXFocusedApplication\0"),
        focused_window: make(b"AXFocusedWindow\0"),
        position: make(b"AXPosition\0"),
        size: make(b"AXSize\0"),
        title: make(b"AXTitle\0"),
        minimized: make(b"AXMinimized\0"),
        fullscreen: make(b"AXFullScreen\0"),
        moved: make(b"AXMoved\0"),
        resized: make(b"AXResized\0"),
        focused: make(b"AXFocused\0"),
        raise: make(b"AXRaise\0"),
        close: make(b"AXClose\0"),
    }
});

fn ax(value: usize) -> CfString {
    value as CfString
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CgPoint {
    x: f64,
    y: f64,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CgSize {
    width: f64,
    height: f64,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CgRect {
    origin: CgPoint,
    size: CgSize,
}

unsafe extern "C" {
    static kCFRunLoopCommonModes: CfString;
    static kCFRunLoopDefaultMode: CfString;
    static kCFBooleanTrue: CfType;
    static kCGWindowOwnerPID: CfString;
    static kCGWindowOwnerName: CfString;
    static kCGWindowLayer: CfString;
    fn CFRelease(value: CfType);
    fn CFArrayGetCount(array: CfArray) -> isize;
    fn CFArrayGetValueAtIndex(array: CfArray, index: isize) -> CfType;
    fn CFDictionaryGetValue(dictionary: CfType, key: CfType) -> CfType;
    fn CFEqual(left: CfType, right: CfType) -> bool;
    fn CFNumberGetValue(number: CfType, kind: i32, value: *mut c_void) -> bool;
    fn CFStringGetCStringPtr(string: CfString, encoding: u32) -> *const c_char;
    fn CFStringGetCString(
        string: CfString,
        buffer: *mut c_char,
        size: isize,
        encoding: u32,
    ) -> bool;
    fn CFStringCreateWithCString(
        allocator: CfType,
        value: *const c_char,
        encoding: u32,
    ) -> CfString;
    fn CFMachPortCreateRunLoopSource(allocator: CfType, port: CfMachPort, order: isize) -> CfType;
    fn CFRunLoopGetCurrent() -> CfRunLoop;
    fn CFRunLoopAddSource(run_loop: CfRunLoop, source: CfType, mode: CfString);
    fn CFRunLoopRemoveSource(run_loop: CfRunLoop, source: CfType, mode: CfString);
    fn CFRunLoopRun();
    fn CFRunLoopRunInMode(mode: CfString, seconds: f64, return_after_source_handled: bool) -> i32;
    fn CFRunLoopStop(run_loop: CfRunLoop);

    fn CGMainDisplayID() -> CgDisplay;
    fn CGDisplayHideCursor(display: CgDisplay) -> i32;
    fn CGDisplayShowCursor(display: CgDisplay) -> i32;
    fn CGAssociateMouseAndMouseCursorPosition(connected: bool) -> i32;
    fn CGWarpMouseCursorPosition(point: CgPoint) -> i32;
    fn CGEventCreate(source: CfType) -> CgEvent;
    fn CGEventGetLocation(event: CgEvent) -> CgPoint;
    fn CGEventGetTimestamp(event: CgEvent) -> u64;
    fn CGEventGetIntegerValueField(event: CgEvent, field: u32) -> i64;
    fn CGEventSetIntegerValueField(event: CgEvent, field: u32, value: i64);
    fn CGEventGetFlags(event: CgEvent) -> u64;
    fn CGEventCreateMouseEvent(
        source: CfType,
        event_type: u32,
        position: CgPoint,
        button: u32,
    ) -> CgEvent;
    fn CGEventCreateKeyboardEvent(source: CfType, keycode: u16, down: bool) -> CgEvent;
    fn CGEventCreateScrollWheelEvent(
        source: CfType,
        units: u32,
        wheel_count: u32,
        wheel_1: i32,
        ...
    ) -> CgEvent;
    fn CGEventSetFlags(event: CgEvent, flags: u64);
    fn CGEventPost(location: u32, event: CgEvent);
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        mask: u64,
        callback: Option<
            unsafe extern "C" fn(CgEventTapProxy, u32, CgEvent, *mut c_void) -> CgEvent,
        >,
        user: *mut c_void,
    ) -> CfMachPort;
    fn CGEventTapEnable(tap: CfMachPort, enabled: bool);
    fn CGGetActiveDisplayList(max: u32, displays: *mut CgDisplay, count: *mut u32) -> i32;
    fn CGDisplayBounds(display: CgDisplay) -> CgRect;
    fn CGDisplayPixelsWide(display: CgDisplay) -> usize;
    fn CGDisplayScreenSize(display: CgDisplay) -> CgSize;
    fn CGWindowListCopyWindowInfo(options: u32, relative: u32) -> CfArray;
    fn CGPreflightListenEventAccess() -> bool;
    fn CGRequestListenEventAccess() -> bool;

    fn AECreateDesc(
        descriptor_type: u32,
        data: *const c_void,
        size: isize,
        result: *mut AeDesc,
    ) -> i32;
    fn AEDisposeDesc(descriptor: *mut AeDesc) -> i32;
    fn AEDeterminePermissionToAutomateTarget(
        target: *const AeDesc,
        event_class: u32,
        event_id: u32,
        ask_user_if_needed: bool,
    ) -> i32;

    fn AXIsProcessTrusted() -> bool;
    fn AXUIElementCreateSystemWide() -> AxElement;
    fn AXUIElementCreateApplication(pid: i32) -> AxElement;
    fn AXUIElementGetPid(element: AxElement, pid: *mut i32) -> i32;
    fn AXUIElementSetMessagingTimeout(element: AxElement, timeout: f32) -> i32;
    fn AXUIElementCopyAttributeValues(
        element: AxElement,
        attribute: CfString,
        index: isize,
        max: isize,
        value: *mut CfArray,
    ) -> i32;
    fn AXUIElementCopyAttributeValue(
        element: AxElement,
        attribute: CfString,
        value: *mut CfType,
    ) -> i32;
    fn AXUIElementSetAttributeValue(element: AxElement, attribute: CfString, value: CfType) -> i32;
    fn AXUIElementPerformAction(element: AxElement, action: CfString) -> i32;
    fn AXObserverCreate(
        pid: i32,
        callback: Option<unsafe extern "C" fn(AxObserver, AxElement, CfString, *mut c_void)>,
        observer: *mut AxObserver,
    ) -> i32;
    fn AXObserverAddNotification(
        observer: AxObserver,
        element: AxElement,
        notification: CfString,
        context: *mut c_void,
    ) -> i32;
    fn AXObserverRemoveNotification(
        observer: AxObserver,
        element: AxElement,
        notification: CfString,
    ) -> i32;
    fn AXObserverGetRunLoopSource(observer: AxObserver) -> CfType;
    fn AXValueCreate(kind: u32, value: *const c_void) -> AxValue;
    fn AXValueGetValue(value: AxValue, kind: u32, output: *mut c_void) -> bool;
}

fn cf_string(value: CfType) -> String {
    if value.is_null() {
        return String::new();
    }
    let direct = unsafe { CFStringGetCStringPtr(value, 0x0800_0100) };
    if !direct.is_null() {
        return unsafe { CStr::from_ptr(direct) }
            .to_string_lossy()
            .into_owned();
    }
    let mut buffer = vec![0i8; 4096];
    if unsafe {
        CFStringGetCString(
            value,
            buffer.as_mut_ptr(),
            buffer.len() as isize,
            0x0800_0100,
        )
    } {
        unsafe { CStr::from_ptr(buffer.as_ptr()) }
            .to_string_lossy()
            .into_owned()
    } else {
        String::new()
    }
}
fn cf_i64(dictionary: CfType, key: CfString) -> i64 {
    let value = unsafe { CFDictionaryGetValue(dictionary, key) };
    let mut output = 0i64;
    if !value.is_null() {
        unsafe {
            CFNumberGetValue(value, 4, (&mut output as *mut i64).cast());
        }
    }
    output
}
fn ax_bool(element: AxElement, attribute: CfString) -> Option<bool> {
    let mut value = null();
    if unsafe { AXUIElementCopyAttributeValue(element, attribute, &mut value) } != 0
        || value.is_null()
    {
        return None;
    }
    let value = OwnedCf(value);
    Some(unsafe { CFEqual(value.0, kCFBooleanTrue) })
}
fn ax_error(code: i32, action: &str) -> Result<(), String> {
    if code == 0 {
        Ok(())
    } else {
        Err(format!("{action} failed with AXError {code}; grant Accessibility permission in System Settings > Privacy & Security > Accessibility"))
    }
}
fn parse_ax_id(id: &str) -> Result<(i32, isize), String> {
    let mut parts = id
        .strip_prefix("ax:")
        .ok_or("invalid macOS window id")?
        .split(':');
    let pid = parts
        .next()
        .and_then(|v| v.parse().ok())
        .ok_or("invalid macOS window pid")?;
    let index = parts
        .next()
        .and_then(|v| v.parse().ok())
        .ok_or("invalid macOS window index")?;
    Ok((pid, index))
}

fn mac_to_hid(code: u32) -> Option<u32> {
    Some(match code {
        0 => 0x04,
        11 => 0x05,
        8 => 0x06,
        2 => 0x07,
        14 => 0x08,
        3 => 0x09,
        5 => 0x0A,
        4 => 0x0B,
        34 => 0x0C,
        38 => 0x0D,
        40 => 0x0E,
        37 => 0x0F,
        46 => 0x10,
        45 => 0x11,
        31 => 0x12,
        35 => 0x13,
        12 => 0x14,
        15 => 0x15,
        1 => 0x16,
        17 => 0x17,
        32 => 0x18,
        9 => 0x19,
        13 => 0x1A,
        7 => 0x1B,
        16 => 0x1C,
        6 => 0x1D,
        18 => 0x1E,
        19 => 0x1F,
        20 => 0x20,
        21 => 0x21,
        23 => 0x22,
        22 => 0x23,
        26 => 0x24,
        28 => 0x25,
        25 => 0x26,
        29 => 0x27,
        36 => 0x28,
        53 => 0x29,
        51 => 0x2A,
        48 => 0x2B,
        49 => 0x2C,
        27 => 0x2D,
        24 => 0x2E,
        33 => 0x2F,
        30 => 0x30,
        42 => 0x31,
        41 => 0x33,
        39 => 0x34,
        50 => 0x35,
        43 => 0x36,
        47 => 0x37,
        44 => 0x38,
        122 => 0x3A,
        120 => 0x3B,
        99 => 0x3C,
        118 => 0x3D,
        96 => 0x3E,
        97 => 0x3F,
        98 => 0x40,
        100 => 0x41,
        101 => 0x42,
        109 => 0x43,
        103 => 0x44,
        111 => 0x45,
        124 => 0x4F,
        123 => 0x50,
        125 => 0x51,
        126 => 0x52,
        59 => 0xE0,
        56 => 0xE1,
        58 => 0xE2,
        55 => 0xE3,
        62 => 0xE4,
        60 => 0xE5,
        61 => 0xE6,
        54 => 0xE7,
        _ => return None,
    })
}
fn hid_to_mac(hid: u32) -> Option<u16> {
    // Inverse lookup is intentionally explicit: these are keyboard layout
    // independent physical usages, not characters.
    (0u32..=126)
        .find(|code| mac_to_hid(*code) == Some(hid))
        .map(|v| v as u16)
}
fn modifier_down(hid: u32, flags: u64) -> bool {
    match hid {
        0xE0 | 0xE4 => flags & CG_FLAG_CONTROL != 0,
        0xE1 | 0xE5 => flags & CG_FLAG_SHIFT != 0,
        0xE2 | 0xE6 => flags & CG_FLAG_ALTERNATE != 0,
        0xE3 | 0xE7 => flags & CG_FLAG_COMMAND != 0,
        _ => true,
    }
}

struct OwnedCf(CfType);
impl Drop for OwnedCf {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CFRelease(self.0);
            }
        }
    }
}

fn ax_window(id: &str) -> Result<(OwnedCf, AxElement), String> {
    if !unsafe { AXIsProcessTrusted() } {
        return Err("Accessibility permission is required; enable Compusync in System Settings > Privacy & Security > Accessibility".into());
    }
    let (pid, index) = parse_ax_id(id)?;
    let app = OwnedCf(unsafe { AXUIElementCreateApplication(pid) });
    let mut windows = null();
    ax_error(
        unsafe {
            AXUIElementCopyAttributeValues(app.0 as AxElement, ax(AX.windows), 0, 200, &mut windows)
        },
        "AX windows",
    )?;
    let windows = OwnedCf(windows);
    let count = unsafe { CFArrayGetCount(windows.0) };
    if index < 0 || index >= count {
        return Err("macOS window no longer exists".into());
    }
    let window = unsafe { CFArrayGetValueAtIndex(windows.0, index) } as AxElement;
    Ok((windows, window))
}

fn ax_value<T: Default>(window: AxElement, attribute: CfString, kind: u32) -> Option<T> {
    let mut raw = null();
    if unsafe { AXUIElementCopyAttributeValue(window, attribute, &mut raw) } != 0 || raw.is_null() {
        return None;
    }
    let owned = OwnedCf(raw);
    let mut output = T::default();
    if unsafe { AXValueGetValue(owned.0, kind, (&mut output as *mut T).cast()) } {
        Some(output)
    } else {
        None
    }
}

struct TapContext {
    sink: EventSink,
    linked: AtomicBool,
    owner: AtomicBool,
    left_down: AtomicBool,
    drag_generation: AtomicU64,
    drag_moved: AtomicBool,
    move_loop_terminated: AtomicBool,
    tap: Mutex<CfMachPort>,
    drag_watch: Mutex<Option<AxDragWatch>>,
}
unsafe impl Send for TapContext {}
unsafe impl Sync for TapContext {}

fn record_left_button(context: &TapContext, down: bool) {
    if down {
        context.drag_moved.store(false, Ordering::Release);
        context.drag_generation.fetch_add(1, Ordering::AcqRel);
    }
    context.left_down.store(down, Ordering::Release);
    context.move_loop_terminated.store(false, Ordering::Release);
}

fn suppress_for_non_owner(linked: bool, owner: bool) -> bool {
    linked && !owner
}

fn tap_is_non_owner(context: &TapContext) -> bool {
    suppress_for_non_owner(
        context.linked.load(Ordering::Acquire),
        context.owner.load(Ordering::Acquire),
    )
}

unsafe fn reinforce_non_owner_motion_barrier(context: &TapContext) -> bool {
    if !tap_is_non_owner(context) {
        return false;
    }
    // macOS can restore the mouse/cursor association after display/session
    // transitions. Reassert it on physical motion, but never issue another
    // counted cursor hide: HostPlatform owns the one matching hide/show pair.
    let _ = unsafe { CGAssociateMouseAndMouseCursorPosition(false) };
    tap_is_non_owner(context)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CursorVisibilityAction {
    Hide,
    Show,
}

fn cursor_visibility_action(hidden: bool, target_hidden: bool) -> Option<CursorVisibilityAction> {
    match (hidden, target_hidden) {
        (false, true) => Some(CursorVisibilityAction::Hide),
        (true, false) => Some(CursorVisibilityAction::Show),
        _ => None,
    }
}

struct AxDragWatch {
    observer: AxObserver,
    element: AxElement,
    source: CfType,
    run_loop: CfRunLoop,
    id: String,
    generation: u64,
    active: bool,
    initial_geometry: Option<AxWindowGeometry>,
    resize_subscribed: bool,
}

pub(super) fn input_monitoring_access(request: bool) -> bool {
    // CGRequestListenEventAccess is the only supported way to raise the Input
    // Monitoring TCC prompt. It returns the current decision and macOS itself
    // suppresses repeat prompts after a denial.
    unsafe {
        if CGPreflightListenEventAccess() {
            true
        } else if request {
            CGRequestListenEventAccess()
        } else {
            false
        }
    }
}

pub(super) fn chrome_automation_access(request: bool) -> &'static str {
    // Ask TCC about Chrome by bundle id. Unlike executing AppleScript, this
    // does not launch Chrome or inspect any browser data; it only obtains the
    // Automation decision needed by later window handoffs.
    const CHROME_BUNDLE_ID: &[u8] = b"com.google.Chrome";
    let mut target = AeDesc {
        descriptor_type: 0,
        data_handle: null_mut(),
    };
    let created = unsafe {
        AECreateDesc(
            TYPE_APPLICATION_BUNDLE_ID,
            CHROME_BUNDLE_ID.as_ptr().cast(),
            CHROME_BUNDLE_ID.len() as isize,
            &mut target,
        )
    };
    if created != 0 {
        return "unavailable";
    }
    let result = unsafe {
        AEDeterminePermissionToAutomateTarget(&target, TYPE_WILDCARD, TYPE_WILDCARD, request)
    };
    unsafe {
        AEDisposeDesc(&mut target);
    }
    match result {
        0 => "granted",
        ERR_AE_EVENT_NOT_PERMITTED => "denied",
        _ => "unavailable",
    }
}
unsafe impl Send for AxDragWatch {}

#[derive(Clone, Copy)]
struct AxWindowGeometry {
    position: CgPoint,
    size: CgSize,
}

fn ax_window_geometry(element: AxElement) -> Option<AxWindowGeometry> {
    Some(AxWindowGeometry {
        position: ax_value::<CgPoint>(element, ax(AX.position), AX_VALUE_POINT)?,
        size: ax_value::<CgSize>(element, ax(AX.size), AX_VALUE_SIZE)?,
    })
}

fn geometry_changed(initial: AxWindowGeometry, current: AxWindowGeometry) -> bool {
    const AX_GEOMETRY_EPSILON: f64 = 0.5;
    (initial.position.x - current.position.x).abs() >= AX_GEOMETRY_EPSILON
        || (initial.position.y - current.position.y).abs() >= AX_GEOMETRY_EPSILON
        || (initial.size.width - current.size.width).abs() >= AX_GEOMETRY_EPSILON
        || (initial.size.height - current.size.height).abs() >= AX_GEOMETRY_EPSILON
}

fn emit_move_size_start(context: &TapContext, id: String) {
    let mut event = NativeEvent::simple("moveSizeStart");
    event.window_id = Some(id);
    (context.sink)(event);
}

// Chrome commonly coalesces AXMoved notifications until the native drag ends.
// The AXPosition value itself is live, so sample it on the drag worker while the
// button is held. This starts JS's 60 Hz geometry polling as soon as
// the window has actually moved without mistaking tab/text drags for window
// drags.
fn poll_drag_watch(context: &TapContext) {
    let id = {
        let mut watch = context.drag_watch.lock();
        let Some(watch) = watch.as_mut() else {
            return;
        };
        if watch.active || !drag_watch_is_current(context, watch) {
            return;
        }
        let Some(initial) = watch.initial_geometry else {
            return;
        };
        let Some(current) = ax_window_geometry(watch.element) else {
            return;
        };
        // AX queries can outlast a release and another press. Never activate
        // the old window's watch for the new gesture.
        if !drag_watch_is_current(context, watch)
            || !geometry_changed(initial, current)
            || !activate_drag_watch(true, &mut watch.active)
        {
            return;
        }
        watch.id.clone()
    };
    emit_move_size_start(context, id);
}

fn focused_window() -> Option<(String, i32, OwnedCf)> {
    let system = OwnedCf(unsafe { AXUIElementCreateSystemWide() });
    if system.0.is_null() {
        return None;
    }
    // AXFocusedWindow is an application attribute, not a system-wide one.
    // Resolve the frontmost application first; asking the system-wide element
    // for AXFocusedWindow fails silently on macOS and prevents drag lifecycle
    // events from ever being emitted.
    let mut focused_app = null();
    if unsafe {
        AXUIElementCopyAttributeValue(
            system.0 as AxElement,
            ax(AX.focused_application),
            &mut focused_app,
        )
    } != 0
        || focused_app.is_null()
    {
        return None;
    }
    let focused_app = OwnedCf(focused_app);
    unsafe {
        AXUIElementSetMessagingTimeout(focused_app.0 as AxElement, 0.05);
    }
    let mut focused = null();
    if unsafe {
        AXUIElementCopyAttributeValue(
            focused_app.0 as AxElement,
            ax(AX.focused_window),
            &mut focused,
        )
    } != 0
        || focused.is_null()
    {
        return None;
    }
    let focused = OwnedCf(focused);
    unsafe {
        AXUIElementSetMessagingTimeout(focused.0 as AxElement, 0.05);
    }
    let mut pid = 0;
    if unsafe { AXUIElementGetPid(focused.0 as AxElement, &mut pid) } != 0 {
        return None;
    }
    let mut windows = null();
    if unsafe {
        AXUIElementCopyAttributeValues(
            focused_app.0 as AxElement,
            ax(AX.windows),
            0,
            200,
            &mut windows,
        )
    } != 0
        || windows.is_null()
    {
        return None;
    }
    let windows = OwnedCf(windows);
    let index = (0..unsafe { CFArrayGetCount(windows.0) })
        .find(|index| unsafe { CFEqual(CFArrayGetValueAtIndex(windows.0, *index), focused.0) })?;
    Some((format!("ax:{pid}:{index}"), pid, focused))
}

unsafe extern "C" fn ax_window_moved(_: AxObserver, _: AxElement, _: CfString, user: *mut c_void) {
    if user.is_null() {
        return;
    }
    let context = unsafe { &*(user as *const TapContext) };
    let id = {
        let mut watch = context.drag_watch.lock();
        let Some(watch) = watch.as_mut() else {
            return;
        };
        if !drag_watch_is_current(context, watch) || !activate_drag_watch(true, &mut watch.active) {
            return;
        }
        watch.id.clone()
    };
    emit_move_size_start(context, id);
}

fn drag_watch_is_current(context: &TapContext, watch: &AxDragWatch) -> bool {
    context.left_down.load(Ordering::Acquire)
        && watch.generation == context.drag_generation.load(Ordering::Acquire)
}

fn activate_drag_watch(left_down: bool, active: &mut bool) -> bool {
    if !left_down || *active {
        return false;
    }
    *active = true;
    true
}

fn clear_drag_watch(context: &TapContext, emit_end: bool) {
    let Some(watch) = context.drag_watch.lock().take() else {
        return;
    };
    if emit_end && watch.active {
        let mut event = NativeEvent::simple("moveSizeEnd");
        event.window_id = Some(watch.id.clone());
        (context.sink)(event);
    }
    unsafe {
        AXObserverRemoveNotification(watch.observer, watch.element, ax(AX.moved));
        if watch.resize_subscribed {
            AXObserverRemoveNotification(watch.observer, watch.element, ax(AX.resized));
        }
        CFRunLoopRemoveSource(watch.run_loop, watch.source, kCFRunLoopCommonModes);
        CFRelease(watch.observer);
        CFRelease(watch.element);
    }
}

fn begin_drag_watch(context: &TapContext) {
    clear_drag_watch(context, false);
    let generation = context.drag_generation.load(Ordering::Acquire);
    let Some((id, pid, element)) = focused_window() else {
        return;
    };
    let mut observer = null_mut();
    if unsafe { AXObserverCreate(pid, Some(ax_window_moved), &mut observer) } != 0
        || observer.is_null()
    {
        return;
    }
    if unsafe {
        AXObserverAddNotification(
            observer,
            element.0 as AxElement,
            ax(AX.moved),
            context as *const TapContext as *mut c_void,
        )
    } != 0
    {
        unsafe {
            CFRelease(observer);
        }
        return;
    }
    let resize_subscribed = unsafe {
        AXObserverAddNotification(
            observer,
            element.0 as AxElement,
            ax(AX.resized),
            context as *const TapContext as *mut c_void,
        ) == 0
    };
    let source = unsafe { AXObserverGetRunLoopSource(observer) };
    let run_loop = unsafe { CFRunLoopGetCurrent() };
    unsafe {
        CFRunLoopAddSource(run_loop, source, kCFRunLoopCommonModes);
    }
    let raw_element = element.0 as AxElement;
    let initial_geometry = ax_window_geometry(raw_element);
    std::mem::forget(element);
    *context.drag_watch.lock() = Some(AxDragWatch {
        observer,
        element: raw_element,
        source,
        run_loop,
        id,
        generation,
        active: false,
        initial_geometry,
        resize_subscribed,
    });
}

fn ensure_drag_watch(context: &TapContext) {
    let watching = context.drag_watch.lock().is_some();
    if !watching {
        // Wait until input has delivered a drag event so the clicked window
        // can gain focus before the worker resolves it.
        begin_drag_watch(context);
    }
}

unsafe extern "C" fn event_tap(
    proxy: CgEventTapProxy,
    kind: u32,
    event: CgEvent,
    user: *mut c_void,
) -> CgEvent {
    if user.is_null() {
        return event;
    }
    // A panic may not unwind through CoreGraphics' C callback. Returning the
    // original event keeps local input usable instead of aborting Electron.
    catch_unwind(AssertUnwindSafe(|| {
        macos_event_tap::dispatch(
            kind,
            event,
            || {
                let context = unsafe { &*(user as *const TapContext) };
                let tap = *context.tap.lock();
                if !tap.is_null() {
                    unsafe { CGEventTapEnable(tap, true) };
                }
            },
            || unsafe { event_tap_inner(proxy, kind, event, user) },
        )
    }))
    .unwrap_or(event)
}

unsafe fn event_tap_inner(
    _: CgEventTapProxy,
    kind: u32,
    event: CgEvent,
    user: *mut c_void,
) -> CgEvent {
    let context = unsafe { &*(user as *const TapContext) };
    let source_tag = unsafe { CGEventGetIntegerValueField(event, CG_FIELD_SOURCE_USER_DATA) };
    if source_tag == COMPUSYNC_MOVE_LOOP_TAG {
        // This release is delivered only to AppKit to leave its native drag;
        // the physical button remains logically held until the user's actual
        // release completes the cross-screen handoff.
        return event;
    }
    let compusync_event = source_tag == COMPUSYNC_SOURCE_TAG;
    if compusync_event {
        // Do not echo injected peer input back across the transport, but keep
        // the local drag watcher in sync so a peer-driven Chrome drag can
        // still become a live cross-screen handoff.
        if kind == CG_EVENT_LEFT_DOWN {
            record_left_button(context, true);
        } else if kind == CG_EVENT_LEFT_DRAGGED {
            context.drag_moved.store(true, Ordering::Release);
        } else if kind == CG_EVENT_LEFT_UP {
            record_left_button(context, false);
        }
        return event;
    }
    let flags = unsafe { CGEventGetFlags(event) };
    let modifiers = ((flags & CG_FLAG_SHIFT != 0) as u32)
        | (((flags & CG_FLAG_CONTROL != 0) as u32) << 1)
        | (((flags & CG_FLAG_ALTERNATE != 0) as u32) << 2)
        | (((flags & CG_FLAG_COMMAND != 0) as u32) << 3);
    match kind {
        CG_EVENT_MOUSE_MOVED
        | CG_EVENT_LEFT_DRAGGED
        | CG_EVENT_RIGHT_DRAGGED
        | CG_EVENT_OTHER_DRAGGED => {
            if kind == CG_EVENT_LEFT_DRAGGED {
                context.drag_moved.store(true, Ordering::Release);
            }
            let mut native = NativeEvent::simple("cursorDelta");
            native.timestamp = unsafe { CGEventGetTimestamp(event) } as f64 / 1_000_000.0;
            native.dx = Some(unsafe {
                CGEventGetIntegerValueField(event, CG_FIELD_UNACCELERATED_POINTER_MOVEMENT_X)
            } as f64);
            native.dy = Some(unsafe {
                CGEventGetIntegerValueField(event, CG_FIELD_UNACCELERATED_POINTER_MOVEMENT_Y)
            } as f64);
            (context.sink)(native);
            if kind == CG_EVENT_LEFT_DRAGGED && context.move_loop_terminated.load(Ordering::Acquire)
            {
                return null_mut();
            }
            // Forward the raw delta to the shared owner, but do not also move
            // the non-owner Mac cursor. Owner motion continues to applications
            // normally so native hover and drag behavior remain intact.
            if unsafe { reinforce_non_owner_motion_barrier(context) } {
                return null_mut();
            }
        }
        CG_EVENT_KEY_DOWN | CG_EVENT_KEY_UP | CG_EVENT_FLAGS_CHANGED => {
            let native_code =
                unsafe { CGEventGetIntegerValueField(event, CG_FIELD_KEYCODE) } as u32;
            let Some(code) = mac_to_hid(native_code) else {
                return event;
            };
            let down = if kind == CG_EVENT_FLAGS_CHANGED {
                modifier_down(code, flags)
            } else {
                kind != CG_EVENT_KEY_UP
            };
            if down
                && flags & (CG_FLAG_COMMAND | CG_FLAG_SHIFT) == (CG_FLAG_COMMAND | CG_FLAG_SHIFT)
                && (code == 0x18 || code == 0x1C)
            {
                (context.sink)(NativeEvent::simple(if code == 0x18 {
                    "unlinkHotkey"
                } else {
                    "toggleOwnershipHotkey"
                }));
                return null_mut();
            }
            let mut native = NativeEvent::simple("keyEvent");
            native.code = Some(code);
            native.down = Some(down);
            native.modifiers = Some(modifiers);
            (context.sink)(native);
            if suppress_for_non_owner(
                context.linked.load(Ordering::Acquire),
                context.owner.load(Ordering::Acquire),
            ) {
                return null_mut();
            }
        }
        CG_EVENT_SCROLL_WHEEL => {
            let fixed =
                unsafe { CGEventGetIntegerValueField(event, CG_FIELD_SCROLL_FIXED_DELTA_AXIS_1) };
            let dy = if fixed != 0 {
                fixed as f64 / 65_536.0
            } else {
                (unsafe { CGEventGetIntegerValueField(event, CG_FIELD_SCROLL_DELTA_AXIS_1) }) as f64
            };
            if dy != 0.0 {
                let mut native = NativeEvent::simple("scrollDelta");
                native.dy = Some(dy);
                (context.sink)(native);
            }
            if context.linked.load(Ordering::Acquire) && !context.owner.load(Ordering::Acquire) {
                return null_mut();
            }
        }
        CG_EVENT_LEFT_DOWN | CG_EVENT_LEFT_UP | CG_EVENT_RIGHT_DOWN | CG_EVENT_RIGHT_UP
        | CG_EVENT_OTHER_DOWN | CG_EVENT_OTHER_UP => {
            let button = match unsafe { CGEventGetIntegerValueField(event, CG_FIELD_MOUSE_BUTTON) }
            {
                0 => "left",
                1 => "right",
                2 => "middle",
                3 => "x1",
                _ => "x2",
            };
            let mut native = NativeEvent::simple("cursorButton");
            native.button = Some(button.into());
            native.down = Some(matches!(
                kind,
                CG_EVENT_LEFT_DOWN | CG_EVENT_RIGHT_DOWN | CG_EVENT_OTHER_DOWN
            ));
            native.modifiers = Some(modifiers);
            if kind == CG_EVENT_LEFT_DOWN {
                record_left_button(context, true);
            } else if kind == CG_EVENT_LEFT_UP {
                record_left_button(context, false);
            }
            (context.sink)(native);
            if suppress_for_non_owner(
                context.linked.load(Ordering::Acquire),
                context.owner.load(Ordering::Acquire),
            ) {
                return null_mut();
            }
        }
        _ => {}
    }
    event
}

struct CaptureRuntime {
    context: Arc<TapContext>,
    run_loop: CfRunLoop,
    thread: Option<JoinHandle<()>>,
    drag_poll_stop: Arc<AtomicBool>,
    drag_poll_thread: Option<JoinHandle<()>>,
}
unsafe impl Send for CaptureRuntime {}

fn take_run_loop(run_loop: &mut CfRunLoop) -> Option<CfRunLoop> {
    let run_loop = std::mem::replace(run_loop, null_mut());
    (!run_loop.is_null()).then_some(run_loop)
}

impl CaptureRuntime {
    fn stop(&mut self) {
        self.drag_poll_stop.store(true, Ordering::Release);
        if let Some(thread) = self.drag_poll_thread.take() {
            let _ = thread.join();
        }
        // HostPlatform stops this runtime explicitly and dropping it invokes
        // stop again. Consume the run-loop pointer before waking and joining
        // its thread so the Drop pass cannot use the now-retired CF object.
        if let Some(run_loop) = take_run_loop(&mut self.run_loop) {
            unsafe {
                CFRunLoopStop(run_loop);
            }
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for CaptureRuntime {
    fn drop(&mut self) {
        self.stop();
    }
}

pub struct HostPlatform {
    hidden: bool,
    decoupled: bool,
    scroll_remainder: f64,
    capture: Option<CaptureRuntime>,
}
unsafe impl Send for HostPlatform {}
impl HostPlatform {
    pub fn new() -> Self {
        Self {
            hidden: false,
            decoupled: false,
            scroll_remainder: 0.0,
            capture: None,
        }
    }
}

impl Platform for HostPlatform {
    fn name(&self) -> &'static str {
        "darwin"
    }
    fn hide_cursor(&mut self) -> Result<(), String> {
        if cursor_visibility_action(self.hidden, true) != Some(CursorVisibilityAction::Hide) {
            return Ok(());
        }
        let code = unsafe { CGDisplayHideCursor(CGMainDisplayID()) };
        if code == 0 {
            self.hidden = true;
            Ok(())
        } else {
            Err(format!("CGDisplayHideCursor failed: {code}"))
        }
    }
    fn show_cursor(&mut self) -> Result<(), String> {
        if cursor_visibility_action(self.hidden, false) != Some(CursorVisibilityAction::Show) {
            return Ok(());
        }
        let code = unsafe { CGDisplayShowCursor(CGMainDisplayID()) };
        if code == 0 {
            self.hidden = false;
            Ok(())
        } else {
            Err(format!("CGDisplayShowCursor failed: {code}"))
        }
    }
    fn park_cursor(&mut self) -> Result<(), String> {
        let code = unsafe { CGAssociateMouseAndMouseCursorPosition(false) };
        if code == 0 {
            self.decoupled = true;
            Ok(())
        } else {
            Err(format!(
                "CGAssociateMouseAndMouseCursorPosition(false) failed: {code}"
            ))
        }
    }
    fn release_cursor(&mut self) -> Result<(), String> {
        let code = unsafe { CGAssociateMouseAndMouseCursorPosition(true) };
        if code == 0 {
            self.decoupled = false;
            Ok(())
        } else {
            Err(format!(
                "CGAssociateMouseAndMouseCursorPosition(true) failed: {code}"
            ))
        }
    }
    fn warp_cursor(&mut self, p: Point) -> Result<(), String> {
        let code = unsafe { CGWarpMouseCursorPosition(CgPoint { x: p.x, y: p.y }) };
        if code == 0 {
            // CoreGraphics cursor warps do not reliably produce a
            // kCGEventLeftMouseDragged callback. Deliver drag events while a
            // peer button is held; the background worker handles AX queries.
            if let Some(capture) = self.capture.as_ref() {
                if capture.context.left_down.load(Ordering::Acquire) {
                    // A decoupled CoreGraphics cursor warp does not create an
                    // AppKit drag event. Deliver one at the authoritative
                    // position so Chrome visibly follows both local and peer
                    // input while the button remains held.
                    if !capture.context.move_loop_terminated.load(Ordering::Acquire) {
                        let drag = unsafe {
                            CGEventCreateMouseEvent(
                                null(),
                                CG_EVENT_LEFT_DRAGGED,
                                CgPoint { x: p.x, y: p.y },
                                0,
                            )
                        };
                        if !drag.is_null() {
                            unsafe {
                                CGEventSetIntegerValueField(
                                    drag,
                                    CG_FIELD_SOURCE_USER_DATA,
                                    COMPUSYNC_SOURCE_TAG,
                                );
                                CGEventPost(0, drag);
                                CFRelease(drag);
                            }
                        }
                    }
                }
            }
            Ok(())
        } else {
            Err(format!("CGWarpMouseCursorPosition failed: {code}"))
        }
    }
    fn cursor_position(&self) -> Result<Point, String> {
        let event = unsafe { CGEventCreate(null()) };
        if event.is_null() {
            return Err("CGEventCreate failed; Input Monitoring permission may be missing".into());
        }
        let p = unsafe { CGEventGetLocation(event) };
        unsafe {
            CFRelease(event);
        }
        Ok(Point { x: p.x, y: p.y })
    }
    fn displays(&self) -> Result<Vec<DisplayMetric>, String> {
        let mut count = 0;
        let code = unsafe { CGGetActiveDisplayList(0, null_mut(), &mut count) };
        if code != 0 {
            return Err(format!("CGGetActiveDisplayList failed: {code}"));
        }
        let mut ids = vec![0; count.min(64) as usize];
        let code =
            unsafe { CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) };
        if code != 0 {
            return Err(format!("CGGetActiveDisplayList failed: {code}"));
        }
        let main = unsafe { CGMainDisplayID() };
        Ok(ids
            .into_iter()
            .take(count as usize)
            .map(|id| {
                let b = unsafe { CGDisplayBounds(id) };
                let sx = unsafe { CGDisplayPixelsWide(id) } as f64 / b.size.width.max(1.0);
                let physical = unsafe { CGDisplayScreenSize(id) };
                DisplayMetric {
                    id: id.to_string(),
                    bounds: Rect {
                        x: b.origin.x,
                        y: b.origin.y,
                        width: b.size.width,
                        height: b.size.height,
                    },
                    work_area: Rect {
                        x: b.origin.x,
                        y: b.origin.y,
                        width: b.size.width,
                        height: b.size.height,
                    },
                    scale: sx,
                    primary: id == main,
                    physical_width_mm: (physical.width.is_finite() && physical.width > 0.0)
                        .then_some(physical.width),
                    physical_height_mm: (physical.height.is_finite() && physical.height > 0.0)
                        .then_some(physical.height),
                }
            })
            .collect())
    }
    fn windows(&self) -> Result<Vec<WindowInfo>, String> {
        let list = OwnedCf(unsafe { CGWindowListCopyWindowInfo(1 | 16, 0) });
        if list.0.is_null() {
            return Err("CGWindowListCopyWindowInfo failed; Screen Recording/Accessibility permission may be missing".into());
        }
        let mut owners = BTreeMap::<i32, String>::new();
        for i in 0..unsafe { CFArrayGetCount(list.0) } {
            let d = unsafe { CFArrayGetValueAtIndex(list.0, i) };
            if cf_i64(d, unsafe { kCGWindowLayer }) != 0 {
                continue;
            }
            let pid = cf_i64(d, unsafe { kCGWindowOwnerPID }) as i32;
            let owner = cf_string(unsafe { CFDictionaryGetValue(d, kCGWindowOwnerName) });
            owners.entry(pid).or_insert(owner);
        }
        let mut result = vec![];
        for (pid, process_name) in owners {
            let app = OwnedCf(unsafe { AXUIElementCreateApplication(pid) });
            let mut array = null();
            if unsafe {
                AXUIElementCopyAttributeValues(
                    app.0 as AxElement,
                    ax(AX.windows),
                    0,
                    200,
                    &mut array,
                )
            } != 0
                || array.is_null()
            {
                continue;
            }
            let array = OwnedCf(array);
            for index in 0..unsafe { CFArrayGetCount(array.0) } {
                let window = unsafe { CFArrayGetValueAtIndex(array.0, index) } as AxElement;
                let pos = ax_value::<CgPoint>(window, ax(AX.position), AX_VALUE_POINT)
                    .unwrap_or_default();
                let size =
                    ax_value::<CgSize>(window, ax(AX.size), AX_VALUE_SIZE).unwrap_or_default();
                let mut title_ref = null();
                let title = if unsafe {
                    AXUIElementCopyAttributeValue(window, ax(AX.title), &mut title_ref)
                } == 0
                {
                    let owned = OwnedCf(title_ref);
                    cf_string(owned.0)
                } else {
                    String::new()
                };
                let minimized = ax_bool(window, ax(AX.minimized)).unwrap_or(false);
                result.push(WindowInfo {
                    id: format!("ax:{pid}:{index}"),
                    pid: pid as u32,
                    process_name: process_name.clone(),
                    title: title.clone(),
                    bounds: Rect {
                        x: pos.x,
                        y: pos.y,
                        width: size.width,
                        height: size.height,
                    },
                    // The owner was discovered from the on-screen CG list.
                    // AXTitle and CGWindowName are not stable join keys (and
                    // CGWindowName may be empty without Screen Recording), so
                    // AXMinimized is the reliable per-window visibility gate.
                    visible: !minimized,
                    minimized,
                    maximized: false,
                    fullscreen: ax_bool(window, ax(AX.fullscreen)).unwrap_or(false),
                });
            }
        }
        Ok(result)
    }
    fn window_exists(&self, id: &str) -> Result<bool, String> {
        if !unsafe { AXIsProcessTrusted() } {
            return Err("Accessibility permission is required; enable Compusync in System Settings > Privacy & Security > Accessibility".into());
        }
        let (pid, index) = parse_ax_id(id)?;
        let app = OwnedCf(unsafe { AXUIElementCreateApplication(pid) });
        let mut windows = null();
        let code = unsafe {
            AXUIElementCopyAttributeValues(app.0 as AxElement, ax(AX.windows), 0, 200, &mut windows)
        };
        // A terminated application reports an invalid element or cannot-
        // complete AX error. Those are normal liveness misses, not permission
        // failures that should trip the shared-input watchdog.
        if code == -25202 || code == -25204 || (code == 0 && windows.is_null()) {
            return Ok(false);
        }
        ax_error(code, "AX windows")?;
        let windows = OwnedCf(windows);
        Ok(index >= 0 && index < unsafe { CFArrayGetCount(windows.0) })
    }
    fn set_window_bounds(&mut self, id: &str, b: Rect) -> Result<(), String> {
        let (_owner, w) = ax_window(id)?;
        let p = CgPoint { x: b.x, y: b.y };
        let s = CgSize {
            width: b.width,
            height: b.height,
        };
        let pv = OwnedCf(unsafe { AXValueCreate(AX_VALUE_POINT, (&p as *const CgPoint).cast()) });
        let sv = OwnedCf(unsafe { AXValueCreate(AX_VALUE_SIZE, (&s as *const CgSize).cast()) });
        ax_error(
            unsafe { AXUIElementSetAttributeValue(w, ax(AX.position), pv.0) },
            "set AX position",
        )?;
        ax_error(
            unsafe { AXUIElementSetAttributeValue(w, ax(AX.size), sv.0) },
            "set AX size",
        )
    }
    fn focus_window(&mut self, id: &str) -> Result<(), String> {
        let (_owner, w) = ax_window(id)?;
        ax_error(
            unsafe { AXUIElementSetAttributeValue(w, ax(AX.focused), kCFBooleanTrue) },
            "focus AX window",
        )?;
        ax_error(
            unsafe { AXUIElementPerformAction(w, ax(AX.raise)) },
            "raise AX window",
        )
    }
    fn close_window(&mut self, id: &str) -> Result<(), String> {
        let (_owner, w) = ax_window(id)?;
        ax_error(
            unsafe { AXUIElementPerformAction(w, ax(AX.close)) },
            "close AX window",
        )
    }
    fn synthesize_button(&mut self, button: &str, down: bool) -> Result<(), String> {
        let button = match button {
            "left" => 0,
            "right" => 1,
            "middle" => 2,
            "x1" | "back" => 3,
            "x2" | "forward" => 4,
            _ => return Err("button must be left, right, middle, x1, or x2".into()),
        };
        let location = self.cursor_position()?;
        let kind = match (button, down) {
            (0, true) => CG_EVENT_LEFT_DOWN,
            (0, false) => CG_EVENT_LEFT_UP,
            (1, true) => CG_EVENT_RIGHT_DOWN,
            (1, false) => CG_EVENT_RIGHT_UP,
            (_, true) => CG_EVENT_OTHER_DOWN,
            _ => CG_EVENT_OTHER_UP,
        };
        let event = unsafe {
            CGEventCreateMouseEvent(
                null(),
                kind,
                CgPoint {
                    x: location.x,
                    y: location.y,
                },
                button,
            )
        };
        if event.is_null() {
            return Err("CGEventCreateMouseEvent failed".into());
        }
        unsafe {
            CGEventSetIntegerValueField(event, CG_FIELD_SOURCE_USER_DATA, COMPUSYNC_SOURCE_TAG);
            CGEventPost(0, event);
            CFRelease(event)
        }
        Ok(())
    }
    fn synthesize_key(&mut self, code: u32, down: bool, modifiers: u32) -> Result<(), String> {
        let native = hid_to_mac(code)
            .ok_or_else(|| format!("unsupported USB HID keyboard usage 0x{code:X}"))?;
        let event = unsafe { CGEventCreateKeyboardEvent(null(), native, down) };
        if event.is_null() {
            return Err("CGEventCreateKeyboardEvent failed".into());
        }
        let flags = ((modifiers & 1 != 0) as u64) * CG_FLAG_SHIFT
            | ((modifiers & 2 != 0) as u64) * CG_FLAG_CONTROL
            | ((modifiers & 4 != 0) as u64) * CG_FLAG_ALTERNATE
            | ((modifiers & 8 != 0) as u64) * CG_FLAG_COMMAND;
        unsafe {
            CGEventSetFlags(event, flags);
            CGEventSetIntegerValueField(event, CG_FIELD_SOURCE_USER_DATA, COMPUSYNC_SOURCE_TAG);
            CGEventPost(0, event);
            CFRelease(event)
        }
        Ok(())
    }
    fn synthesize_scroll(&mut self, dy: f64) -> Result<(), String> {
        self.scroll_remainder += dy;
        let whole = self.scroll_remainder.trunc();
        if whole == 0.0 {
            return Ok(());
        }
        self.scroll_remainder -= whole;
        let amount = whole.clamp(i32::MIN as f64, i32::MAX as f64) as i32;
        let event = unsafe { CGEventCreateScrollWheelEvent(null(), 1, 1, amount) };
        if event.is_null() {
            return Err("CGEventCreateScrollWheelEvent failed".into());
        }
        unsafe {
            CGEventSetIntegerValueField(event, CG_FIELD_SOURCE_USER_DATA, COMPUSYNC_SOURCE_TAG);
            CGEventPost(0, event);
            CFRelease(event)
        }
        Ok(())
    }
    fn foreground_is_elevated(&self) -> Result<bool, String> {
        Ok(false)
    }
    fn start_capture(&mut self, sink: EventSink) -> Result<(), String> {
        if self.capture.is_some() {
            return Ok(());
        }
        if !unsafe { AXIsProcessTrusted() } {
            return Err("Accessibility permission is required; enable Compusync in System Settings > Privacy & Security > Accessibility".into());
        }
        let context = Arc::new(TapContext {
            sink,
            linked: AtomicBool::new(false),
            owner: AtomicBool::new(true),
            left_down: AtomicBool::new(false),
            drag_generation: AtomicU64::new(0),
            drag_moved: AtomicBool::new(false),
            move_loop_terminated: AtomicBool::new(false),
            tap: Mutex::new(null_mut()),
            drag_watch: Mutex::new(None),
        });
        let user = Arc::into_raw(context.clone()) as usize;
        let (sender, receiver) = std::sync::mpsc::sync_channel::<Result<usize, String>>(1);
        let thread = thread::Builder::new()
            .name("compusync-mac-input".into())
            .spawn(move || unsafe {
                let mask = [
                    CG_EVENT_LEFT_DOWN,
                    CG_EVENT_LEFT_UP,
                    CG_EVENT_RIGHT_DOWN,
                    CG_EVENT_RIGHT_UP,
                    CG_EVENT_MOUSE_MOVED,
                    CG_EVENT_LEFT_DRAGGED,
                    CG_EVENT_RIGHT_DRAGGED,
                    CG_EVENT_KEY_DOWN,
                    CG_EVENT_KEY_UP,
                    CG_EVENT_FLAGS_CHANGED,
                    CG_EVENT_SCROLL_WHEEL,
                    CG_EVENT_OTHER_DOWN,
                    CG_EVENT_OTHER_UP,
                    CG_EVENT_OTHER_DRAGGED,
                ]
                .iter()
                .fold(0u64, |mask, kind| mask | (1u64 << kind));
                // Filter at the HID entry to WindowServer, before physical
                // samples reach session handling. This gives non-owner motion
                // the earliest public filtering point instead of relying on
                // foreground-dependent mouse/cursor disassociation alone.
                let tap = CGEventTapCreate(
                    macos_event_tap::CG_HID_EVENT_TAP,
                    0,
                    0,
                    mask,
                    Some(event_tap),
                    user as *mut c_void,
                );
                if tap.is_null() {
                    let _ = sender.send(Err("CGEventTapCreate failed; grant Accessibility and Input Monitoring permissions".into()));
                    drop(Arc::from_raw(user as *const TapContext));
                    return;
                }
                *(*(user as *const TapContext)).tap.lock() = tap;
                let source = CFMachPortCreateRunLoopSource(null(), tap, 0);
                let run_loop = CFRunLoopGetCurrent();
                CFRunLoopAddSource(run_loop, source, kCFRunLoopCommonModes);
                CGEventTapEnable(tap, true);
                let _ = sender.send(Ok(run_loop as usize));
                CFRunLoopRun();
                CFRelease(source);
                CFRelease(tap);
                drop(Arc::from_raw(user as *const TapContext));
            })
            .map_err(|e| e.to_string())?;
        let run_loop = receiver
            .recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|_| "event tap thread did not start".to_string())??
            as CfRunLoop;
        // Keep the entire AX observer lifecycle and geometry queries on this
        // worker. AX can block on another app, so neither the input tap nor
        // cursor warps may query it or take the drag-watch lock.
        let drag_poll_stop = Arc::new(AtomicBool::new(false));
        let poll_stop = drag_poll_stop.clone();
        let poll_context = context.clone();
        let drag_poll_thread = match thread::Builder::new()
            .name("compusync-mac-window-drag".into())
            .spawn(move || {
                while !poll_stop.load(Ordering::Acquire) {
                    let stale = poll_context
                        .drag_watch
                        .lock()
                        .as_ref()
                        .is_some_and(|watch| !drag_watch_is_current(&poll_context, watch));
                    if stale {
                        clear_drag_watch(&poll_context, true);
                    }
                    if poll_context.left_down.load(Ordering::Acquire) {
                        if poll_context.drag_moved.load(Ordering::Acquire) {
                            ensure_drag_watch(&poll_context);
                            poll_drag_watch(&poll_context);
                        }
                    } else {
                        clear_drag_watch(&poll_context, true);
                    }
                    // Observer sources belong to this thread's run loop.
                    unsafe {
                        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.001, false);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(8));
                }
                clear_drag_watch(&poll_context, false);
            }) {
            Ok(thread) => thread,
            Err(error) => {
                unsafe { CFRunLoopStop(run_loop) };
                let _ = thread.join();
                return Err(error.to_string());
            }
        };
        self.capture = Some(CaptureRuntime {
            context,
            run_loop,
            thread: Some(thread),
            drag_poll_stop,
            drag_poll_thread: Some(drag_poll_thread),
        });
        Ok(())
    }
    fn set_capture_mode(&mut self, linked: bool, owner: bool) {
        self.scroll_remainder = 0.0;
        if let Some(runtime) = &self.capture {
            runtime.context.linked.store(linked, Ordering::Release);
            runtime.context.owner.store(owner, Ordering::Release)
        }
    }
    fn stop_capture(&mut self) {
        if let Some(mut runtime) = self.capture.take() {
            runtime.stop()
        }
    }
    fn terminate_move_loop(&mut self, _: &str) -> Result<(), String> {
        let context = self
            .capture
            .as_ref()
            .map(|runtime| runtime.context.clone())
            .ok_or_else(|| "input capture is not active".to_string())?;
        let location = self.cursor_position()?;
        let event = unsafe {
            CGEventCreateMouseEvent(
                null(),
                CG_EVENT_LEFT_UP,
                CgPoint {
                    x: location.x,
                    y: location.y,
                },
                0,
            )
        };
        if event.is_null() {
            return Err("CGEventCreateMouseEvent move-loop release failed".into());
        }
        context.move_loop_terminated.store(true, Ordering::Release);
        unsafe {
            CGEventSetIntegerValueField(event, CG_FIELD_SOURCE_USER_DATA, COMPUSYNC_MOVE_LOOP_TAG);
            CGEventPost(0, event);
            CFRelease(event);
        }
        Ok(())
    }
}
impl Drop for HostPlatform {
    fn drop(&mut self) {
        self.stop_capture();
        let _ = self.release_cursor();
        let _ = self.show_cursor();
    }
}

#[cfg(test)]
mod tests {
    use super::{
        activate_drag_watch, cursor_visibility_action, geometry_changed, suppress_for_non_owner,
        take_run_loop, AxWindowGeometry, CfRunLoop, CgPoint, CgSize, CursorVisibilityAction,
        CG_FIELD_UNACCELERATED_POINTER_MOVEMENT_X, CG_FIELD_UNACCELERATED_POINTER_MOVEMENT_Y,
    };

    #[test]
    fn physical_and_peer_drag_input_does_not_wait_for_ax_work() {
        use super::*;
        use std::{sync::mpsc, time::Duration};

        let context = Arc::new(TapContext {
            sink: Arc::new(|_| {}),
            linked: AtomicBool::new(false),
            owner: AtomicBool::new(true),
            left_down: AtomicBool::new(false),
            drag_generation: AtomicU64::new(0),
            drag_moved: AtomicBool::new(false),
            move_loop_terminated: AtomicBool::new(false),
            tap: Mutex::new(null_mut()),
            drag_watch: Mutex::new(None),
        });
        // Simulate an Accessibility query blocked on an app. None of these
        // input callbacks may acquire the worker's lock or make AX calls.
        let guard = context.drag_watch.lock();
        let input_context = context.clone();
        let (sender, receiver) = mpsc::channel();
        let input_thread = thread::spawn(move || {
            for tag in [0, COMPUSYNC_SOURCE_TAG] {
                for kind in [CG_EVENT_LEFT_DOWN, CG_EVENT_LEFT_DRAGGED, CG_EVENT_LEFT_UP] {
                    let event = OwnedCf(unsafe {
                        CGEventCreateMouseEvent(null(), kind, CgPoint::default(), 0)
                    });
                    assert!(!event.0.is_null());
                    unsafe {
                        CGEventSetIntegerValueField(
                            event.0 as CgEvent,
                            CG_FIELD_SOURCE_USER_DATA,
                            tag,
                        );
                        event_tap_inner(
                            null_mut(),
                            kind,
                            event.0 as CgEvent,
                            Arc::as_ptr(&input_context) as *mut c_void,
                        );
                    }
                }
            }
            sender.send(()).unwrap();
        });
        let completed = receiver.recv_timeout(Duration::from_secs(1));
        drop(guard);
        input_thread.join().unwrap();
        assert!(
            completed.is_ok(),
            "input waited for the Accessibility worker"
        );
        assert!(!context.left_down.load(Ordering::Acquire));
        assert_eq!(context.drag_generation.load(Ordering::Acquire), 2);
    }

    #[test]
    fn capture_run_loop_stop_target_is_consumed_once() {
        let expected = std::ptr::NonNull::<std::ffi::c_void>::dangling().as_ptr();
        let mut run_loop = expected as CfRunLoop;

        assert_eq!(take_run_loop(&mut run_loop), Some(expected));
        assert_eq!(take_run_loop(&mut run_loop), None);
    }

    #[test]
    fn ax_notification_starts_once_only_while_physical_left_is_held() {
        let mut active = false;

        assert!(!activate_drag_watch(false, &mut active));
        assert!(!active);
        assert!(activate_drag_watch(true, &mut active));
        assert!(active);
        assert!(!activate_drag_watch(true, &mut active));
    }

    #[test]
    fn live_ax_geometry_starts_drag_only_after_the_window_moves() {
        let initial = AxWindowGeometry {
            position: CgPoint { x: 100.0, y: 40.0 },
            size: CgSize {
                width: 900.0,
                height: 700.0,
            },
        };
        let stationary = AxWindowGeometry {
            position: CgPoint {
                x: 100.25,
                y: 40.25,
            },
            size: initial.size,
        };
        let moved = AxWindowGeometry {
            position: CgPoint { x: 102.0, y: 40.0 },
            size: initial.size,
        };

        assert!(!geometry_changed(initial, stationary));
        assert!(geometry_changed(initial, moved));
    }

    #[test]
    fn raw_cursor_capture_uses_unaccelerated_core_graphics_fields() {
        assert_eq!(CG_FIELD_UNACCELERATED_POINTER_MOVEMENT_X, 170);
        assert_eq!(CG_FIELD_UNACCELERATED_POINTER_MOVEMENT_Y, 171);
    }

    #[test]
    fn linked_non_owner_suppresses_local_os_input_only() {
        assert!(!suppress_for_non_owner(false, true));
        assert!(!suppress_for_non_owner(false, false));
        assert!(!suppress_for_non_owner(true, true));
        assert!(suppress_for_non_owner(true, false));
    }

    #[test]
    fn cursor_visibility_uses_one_balanced_hide_show_pair() {
        assert_eq!(
            cursor_visibility_action(false, true),
            Some(CursorVisibilityAction::Hide)
        );
        assert_eq!(cursor_visibility_action(true, true), None);
        assert_eq!(
            cursor_visibility_action(true, false),
            Some(CursorVisibilityAction::Show)
        );
        assert_eq!(cursor_visibility_action(false, false), None);
    }
}
