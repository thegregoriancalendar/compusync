use super::{EventSink, Platform};
use crate::{DisplayMetric, NativeEvent, Point, Rect, WindowInfo};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::{
    collections::{BTreeMap, HashSet},
    ffi::{c_char, c_void, CStr},
    ptr::{null, null_mut},
    sync::{
        atomic::{AtomicBool, Ordering},
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
const CG_EVENT_OTHER_DOWN: u32 = 25;
const CG_EVENT_OTHER_UP: u32 = 26;
const CG_EVENT_OTHER_DRAGGED: u32 = 27;
const CG_EVENT_TAP_DISABLED_TIMEOUT: u32 = 0xFFFF_FFFE;
const CG_EVENT_TAP_DISABLED_USER: u32 = 0xFFFF_FFFF;
const CG_FIELD_MOUSE_BUTTON: u32 = 3;
const CG_FIELD_MOUSE_DELTA_X: u32 = 4;
const CG_FIELD_MOUSE_DELTA_Y: u32 = 5;
const CG_FIELD_KEYCODE: u32 = 9;
const CG_FIELD_SOURCE_USER_DATA: u32 = 42;
const COMPUSYNC_SOURCE_TAG: i64 = 0x4353_594E;
const CG_FLAG_SHIFT: u64 = 1 << 17;
const CG_FLAG_CONTROL: u64 = 1 << 18;
const CG_FLAG_ALTERNATE: u64 = 1 << 19;
const CG_FLAG_COMMAND: u64 = 1 << 20;
const AX_VALUE_POINT: u32 = 1;
const AX_VALUE_SIZE: u32 = 2;

struct AxConstants {
    windows: usize,
    focused_window: usize,
    position: usize,
    size: usize,
    title: usize,
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
        focused_window: make(b"AXFocusedWindow\0"),
        position: make(b"AXPosition\0"),
        size: make(b"AXSize\0"),
        title: make(b"AXTitle\0"),
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
    static kCFBooleanTrue: CfType;
    static kCGWindowOwnerPID: CfString;
    static kCGWindowOwnerName: CfString;
    static kCGWindowName: CfString;
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
    fn CFRunLoopStop(run_loop: CfRunLoop);

    fn CGMainDisplayID() -> CgDisplay;
    fn CGDisplayHideCursor(display: CgDisplay) -> i32;
    fn CGDisplayShowCursor(display: CgDisplay) -> i32;
    fn CGAssociateMouseAndMouseCursorPosition(connected: bool) -> i32;
    fn CGWarpMouseCursorPosition(point: CgPoint) -> i32;
    fn CGEventCreate(source: CfType) -> CgEvent;
    fn CGEventGetLocation(event: CgEvent) -> CgPoint;
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
    fn CGWindowListCopyWindowInfo(options: u32, relative: u32) -> CfArray;

    fn AXIsProcessTrusted() -> bool;
    fn AXUIElementCreateSystemWide() -> AxElement;
    fn AXUIElementCreateApplication(pid: i32) -> AxElement;
    fn AXUIElementGetPid(element: AxElement, pid: *mut i32) -> i32;
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
    tap: Mutex<CfMachPort>,
    drag_watch: Mutex<Option<AxDragWatch>>,
}
unsafe impl Send for TapContext {}
unsafe impl Sync for TapContext {}

struct AxDragWatch {
    observer: AxObserver,
    element: AxElement,
    source: CfType,
    run_loop: CfRunLoop,
    id: String,
    active: bool,
    resize_subscribed: bool,
}
unsafe impl Send for AxDragWatch {}

fn focused_window() -> Option<(String, i32, OwnedCf)> {
    let system = OwnedCf(unsafe { AXUIElementCreateSystemWide() });
    if system.0.is_null() {
        return None;
    }
    let mut focused = null();
    if unsafe {
        AXUIElementCopyAttributeValue(system.0 as AxElement, ax(AX.focused_window), &mut focused)
    } != 0
        || focused.is_null()
    {
        return None;
    }
    let focused = OwnedCf(focused);
    let mut pid = 0;
    if unsafe { AXUIElementGetPid(focused.0 as AxElement, &mut pid) } != 0 {
        return None;
    }
    let app = OwnedCf(unsafe { AXUIElementCreateApplication(pid) });
    let mut windows = null();
    if unsafe {
        AXUIElementCopyAttributeValues(app.0 as AxElement, ax(AX.windows), 0, 200, &mut windows)
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
    let left_down = context.left_down.load(Ordering::Acquire);
    let id = {
        let mut watch = context.drag_watch.lock();
        let Some(watch) = watch.as_mut() else {
            return;
        };
        if !activate_drag_watch(left_down, &mut watch.active) {
            return;
        }
        watch.id.clone()
    };
    let mut event = NativeEvent::simple("moveSizeStart");
    event.window_id = Some(id);
    (context.sink)(event);
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
    std::mem::forget(element);
    *context.drag_watch.lock() = Some(AxDragWatch {
        observer,
        element: raw_element,
        source,
        run_loop,
        id,
        active: false,
        resize_subscribed,
    });
}

unsafe extern "C" fn event_tap(
    _: CgEventTapProxy,
    kind: u32,
    event: CgEvent,
    user: *mut c_void,
) -> CgEvent {
    let context = unsafe { &*(user as *const TapContext) };
    if kind == CG_EVENT_TAP_DISABLED_TIMEOUT || kind == CG_EVENT_TAP_DISABLED_USER {
        let tap = *context.tap.lock();
        if !tap.is_null() {
            unsafe {
                CGEventTapEnable(tap, true);
            }
        }
        return event;
    }
    if unsafe { CGEventGetIntegerValueField(event, CG_FIELD_SOURCE_USER_DATA) }
        == COMPUSYNC_SOURCE_TAG
    {
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
            let mut native = NativeEvent::simple("cursorDelta");
            native.dx =
                Some(unsafe { CGEventGetIntegerValueField(event, CG_FIELD_MOUSE_DELTA_X) } as f64);
            native.dy =
                Some(unsafe { CGEventGetIntegerValueField(event, CG_FIELD_MOUSE_DELTA_Y) } as f64);
            (context.sink)(native);
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
                context.left_down.store(true, Ordering::Release);
                begin_drag_watch(context);
            } else if kind == CG_EVENT_LEFT_UP {
                context.left_down.store(false, Ordering::Release);
                clear_drag_watch(context, true);
            }
            (context.sink)(native);
            if context.linked.load(Ordering::Acquire) && !context.owner.load(Ordering::Acquire) {
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
}
unsafe impl Send for CaptureRuntime {}
impl CaptureRuntime {
    fn stop(&mut self) {
        clear_drag_watch(&self.context, false);
        if !self.run_loop.is_null() {
            unsafe {
                CFRunLoopStop(self.run_loop);
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
    capture: Option<CaptureRuntime>,
}
unsafe impl Send for HostPlatform {}
impl HostPlatform {
    pub fn new() -> Self {
        Self {
            hidden: false,
            decoupled: false,
            capture: None,
        }
    }
}

impl Platform for HostPlatform {
    fn name(&self) -> &'static str {
        "darwin"
    }
    fn hide_cursor(&mut self) -> Result<(), String> {
        if self.hidden {
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
        if !self.hidden {
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
        let mut visible = HashSet::<(i32, String)>::new();
        for i in 0..unsafe { CFArrayGetCount(list.0) } {
            let d = unsafe { CFArrayGetValueAtIndex(list.0, i) };
            if cf_i64(d, unsafe { kCGWindowLayer }) != 0 {
                continue;
            }
            let pid = cf_i64(d, unsafe { kCGWindowOwnerPID }) as i32;
            let owner = cf_string(unsafe { CFDictionaryGetValue(d, kCGWindowOwnerName) });
            owners.entry(pid).or_insert(owner);
            visible.insert((
                pid,
                cf_string(unsafe { CFDictionaryGetValue(d, kCGWindowName) }),
            ));
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
                    visible: visible.contains(&(pid, title)),
                    minimized: false,
                    maximized: false,
                    fullscreen: ax_bool(window, ax(AX.fullscreen)).unwrap_or(false),
                });
            }
        }
        Ok(result)
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
            tap: Mutex::new(null_mut()),
            drag_watch: Mutex::new(None),
        });
        let user = Arc::into_raw(context.clone()) as usize;
        let (sender, receiver) = std::sync::mpsc::sync_channel::<Result<usize, String>>(1);
        let thread=thread::Builder::new().name("compusync-mac-input".into()).spawn(move||unsafe{let mask=[CG_EVENT_LEFT_DOWN,CG_EVENT_LEFT_UP,CG_EVENT_RIGHT_DOWN,CG_EVENT_RIGHT_UP,CG_EVENT_MOUSE_MOVED,CG_EVENT_LEFT_DRAGGED,CG_EVENT_RIGHT_DRAGGED,CG_EVENT_KEY_DOWN,CG_EVENT_KEY_UP,CG_EVENT_FLAGS_CHANGED,CG_EVENT_OTHER_DOWN,CG_EVENT_OTHER_UP,CG_EVENT_OTHER_DRAGGED].iter().fold(0u64,|m,v|m|(1u64<<v));let tap=CGEventTapCreate(1,0,0,mask,Some(event_tap),user as *mut c_void);if tap.is_null(){let _=sender.send(Err("CGEventTapCreate failed; grant Accessibility and Input Monitoring permissions".into()));drop(Arc::from_raw(user as *const TapContext));return}*(*(user as *const TapContext)).tap.lock()=tap;let source=CFMachPortCreateRunLoopSource(null(),tap,0);let run_loop=CFRunLoopGetCurrent();CFRunLoopAddSource(run_loop,source,kCFRunLoopCommonModes);CGEventTapEnable(tap,true);let _=sender.send(Ok(run_loop as usize));CFRunLoopRun();CFRelease(source);CFRelease(tap);drop(Arc::from_raw(user as *const TapContext));}).map_err(|e|e.to_string())?;
        let run_loop = receiver
            .recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|_| "event tap thread did not start".to_string())??
            as CfRunLoop;
        self.capture = Some(CaptureRuntime {
            context,
            run_loop,
            thread: Some(thread),
        });
        Ok(())
    }
    fn set_capture_mode(&mut self, linked: bool, owner: bool) {
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
    // macOS foreign windows do not enter the Windows-style modal SC_MOVE loop.
    fn terminate_move_loop(&mut self, _: &str) -> Result<(), String> {
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
    use super::activate_drag_watch;

    #[test]
    fn ax_notification_starts_once_only_while_physical_left_is_held() {
        let mut active = false;

        assert!(!activate_drag_watch(false, &mut active));
        assert!(!active);
        assert!(activate_drag_watch(true, &mut active));
        assert!(active);
        assert!(!activate_drag_watch(true, &mut active));
    }
}
