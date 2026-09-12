use super::{EventSink, Platform};
use crate::{DisplayMetric, NativeEvent, Point, Rect, WindowInfo};
use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use std::{
    ffi::c_void,
    mem::{size_of, zeroed},
    path::Path,
    ptr::{null, null_mut},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{SystemTime, UNIX_EPOCH},
};

type Bool = i32;
type Handle = *mut c_void;
type Hwnd = *mut c_void;
type Hhook = *mut c_void;
type Hwineventhook = *mut c_void;
type Hmonitor = *mut c_void;
type Hinstance = *mut c_void;
type Lparam = isize;
type Wparam = usize;
type Lresult = isize;

const WM_DESTROY: u32 = 0x0002;
const WM_CLOSE: u32 = 0x0010;
const WM_QUIT: u32 = 0x0012;
const WM_DISPLAYCHANGE: u32 = 0x007E;
const WM_INPUT: u32 = 0x00FF;
const WM_HOTKEY: u32 = 0x0312;
const RIM_TYPEMOUSE: u32 = 0;
const RID_INPUT: u32 = 0x10000003;
const RIDEV_INPUTSINK: u32 = 0x00000100;
const SWP_NOZORDER: u32 = 0x0004;
const SWP_NOACTIVATE: u32 = 0x0010;
const SW_RESTORE: i32 = 9;
const MONITORINFOF_PRIMARY: u32 = 1;
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const TOKEN_QUERY: u32 = 0x0008;
const TOKEN_ELEVATION_CLASS: u32 = 20;
const INPUT_MOUSE: u32 = 0;
const INPUT_KEYBOARD: u32 = 1;
const MOUSEEVENTF_LEFTDOWN: u32 = 0x0002;
const MOUSEEVENTF_LEFTUP: u32 = 0x0004;
const MOUSEEVENTF_RIGHTDOWN: u32 = 0x0008;
const MOUSEEVENTF_RIGHTUP: u32 = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN: u32 = 0x0020;
const MOUSEEVENTF_MIDDLEUP: u32 = 0x0040;
const MOUSEEVENTF_XDOWN: u32 = 0x0080;
const MOUSEEVENTF_XUP: u32 = 0x0100;
const KEYEVENTF_KEYUP: u32 = 0x0002;
const WH_KEYBOARD_LL: i32 = 13;
const WH_MOUSE_LL: i32 = 14;
const HC_ACTION: i32 = 0;
const LLKHF_UP: u32 = 0x80;
const EVENT_SYSTEM_MOVESIZESTART: u32 = 0x000A;
const EVENT_SYSTEM_MOVESIZEEND: u32 = 0x000B;
const WINEVENT_OUTOFCONTEXT: u32 = 0;
const MOD_SHIFT: u32 = 0x0004;
const MOD_CONTROL: u32 = 0x0002;
const MOD_NOREPEAT: u32 = 0x4000;
const HOTKEY_UNLINK: i32 = 0x4355;
const HOTKEY_TOGGLE_OWNER: i32 = 0x434F;
const VK_U: u32 = 0x55;
const VK_Y: u32 = 0x59;
const COMPUSYNC_EXTRA_INFO: usize = 0x4353_594E;
const RI_MOUSE_LEFT_BUTTON_DOWN: u16 = 0x0001;
const RI_MOUSE_LEFT_BUTTON_UP: u16 = 0x0002;
const RI_MOUSE_RIGHT_BUTTON_DOWN: u16 = 0x0004;
const RI_MOUSE_RIGHT_BUTTON_UP: u16 = 0x0008;
const RI_MOUSE_MIDDLE_BUTTON_DOWN: u16 = 0x0010;
const RI_MOUSE_MIDDLE_BUTTON_UP: u16 = 0x0020;
const RI_MOUSE_BUTTON_4_DOWN: u16 = 0x0040;
const RI_MOUSE_BUTTON_4_UP: u16 = 0x0080;
const RI_MOUSE_BUTTON_5_DOWN: u16 = 0x0100;
const RI_MOUSE_BUTTON_5_UP: u16 = 0x0200;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct WinPoint {
    x: i32,
    y: i32,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct WinRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}
#[repr(C)]
struct MonitorInfo {
    size: u32,
    monitor: WinRect,
    work: WinRect,
    flags: u32,
}
#[repr(C)]
struct RawInputDevice {
    usage_page: u16,
    usage: u16,
    flags: u32,
    target: Hwnd,
}
#[repr(C)]
struct RawInputHeader {
    kind: u32,
    size: u32,
    device: Handle,
    wparam: Wparam,
}
#[repr(C)]
struct RawMouse {
    flags: u16,
    _alignment: u16,
    buttons: u32,
    raw_buttons: u32,
    last_x: i32,
    last_y: i32,
    extra_information: u32,
}
#[repr(C)]
struct WndClass {
    style: u32,
    wnd_proc: Option<unsafe extern "system" fn(Hwnd, u32, Wparam, Lparam) -> Lresult>,
    class_extra: i32,
    window_extra: i32,
    instance: Hinstance,
    icon: Handle,
    cursor: Handle,
    background: Handle,
    menu_name: *const u16,
    class_name: *const u16,
}
#[repr(C)]
struct Message {
    hwnd: Hwnd,
    message: u32,
    wparam: Wparam,
    lparam: Lparam,
    time: u32,
    point: WinPoint,
    private: u32,
}
#[repr(C)]
struct KeyboardHook {
    vk_code: u32,
    scan_code: u32,
    flags: u32,
    time: u32,
    extra_info: usize,
}
#[repr(C)]
struct MouseHook {
    point: WinPoint,
    mouse_data: u32,
    flags: u32,
    time: u32,
    extra_info: usize,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct MouseInput {
    dx: i32,
    dy: i32,
    mouse_data: u32,
    flags: u32,
    time: u32,
    extra_info: usize,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct KeyboardInput {
    vk: u16,
    scan: u16,
    flags: u32,
    time: u32,
    extra_info: usize,
}
#[repr(C)]
union InputData {
    mouse: MouseInput,
    keyboard: KeyboardInput,
}
#[repr(C)]
struct Input {
    kind: u32,
    data: InputData,
}
#[repr(C)]
struct TokenElevation {
    elevated: u32,
}

#[link(name = "user32")]
unsafe extern "system" {
    fn ShowCursor(show: Bool) -> i32;
    fn ClipCursor(rect: *const WinRect) -> Bool;
    fn SetCursorPos(x: i32, y: i32) -> Bool;
    fn GetCursorPos(point: *mut WinPoint) -> Bool;
    fn EnumDisplayMonitors(
        dc: Handle,
        clip: *const WinRect,
        callback: unsafe extern "system" fn(Hmonitor, Handle, *mut WinRect, Lparam) -> Bool,
        data: Lparam,
    ) -> Bool;
    fn GetMonitorInfoW(monitor: Hmonitor, info: *mut MonitorInfo) -> Bool;
    fn EnumWindows(callback: unsafe extern "system" fn(Hwnd, Lparam) -> Bool, data: Lparam)
        -> Bool;
    fn IsWindowVisible(window: Hwnd) -> Bool;
    fn IsIconic(window: Hwnd) -> Bool;
    fn IsZoomed(window: Hwnd) -> Bool;
    fn GetWindowRect(window: Hwnd, rect: *mut WinRect) -> Bool;
    fn GetWindowTextLengthW(window: Hwnd) -> i32;
    fn GetWindowTextW(window: Hwnd, text: *mut u16, length: i32) -> i32;
    fn GetWindowThreadProcessId(window: Hwnd, pid: *mut u32) -> u32;
    fn SetWindowPos(
        window: Hwnd,
        after: Hwnd,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        flags: u32,
    ) -> Bool;
    fn SetForegroundWindow(window: Hwnd) -> Bool;
    fn ShowWindow(window: Hwnd, command: i32) -> Bool;
    fn PostMessageW(window: Hwnd, message: u32, wparam: Wparam, lparam: Lparam) -> Bool;
    fn SendInput(count: u32, inputs: *const Input, size: i32) -> u32;
    fn GetForegroundWindow() -> Hwnd;
    fn RegisterClassW(class: *const WndClass) -> u16;
    fn CreateWindowExW(
        ex_style: u32,
        class: *const u16,
        name: *const u16,
        style: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        parent: Hwnd,
        menu: Handle,
        instance: Hinstance,
        param: *mut c_void,
    ) -> Hwnd;
    fn DestroyWindow(window: Hwnd) -> Bool;
    fn DefWindowProcW(window: Hwnd, message: u32, wparam: Wparam, lparam: Lparam) -> Lresult;
    fn RegisterRawInputDevices(devices: *const RawInputDevice, count: u32, size: u32) -> Bool;
    fn GetRawInputData(
        input: Handle,
        command: u32,
        data: *mut c_void,
        size: *mut u32,
        header_size: u32,
    ) -> u32;
    fn GetMessageW(message: *mut Message, window: Hwnd, min: u32, max: u32) -> i32;
    fn TranslateMessage(message: *const Message) -> Bool;
    fn DispatchMessageW(message: *const Message) -> Lresult;
    fn PostThreadMessageW(thread: u32, message: u32, wparam: Wparam, lparam: Lparam) -> Bool;
    fn RegisterHotKey(window: Hwnd, id: i32, modifiers: u32, key: u32) -> Bool;
    fn UnregisterHotKey(window: Hwnd, id: i32) -> Bool;
    fn SetWindowsHookExW(
        kind: i32,
        callback: Option<unsafe extern "system" fn(i32, Wparam, Lparam) -> Lresult>,
        module: Hinstance,
        thread: u32,
    ) -> Hhook;
    fn UnhookWindowsHookEx(hook: Hhook) -> Bool;
    fn CallNextHookEx(hook: Hhook, code: i32, wparam: Wparam, lparam: Lparam) -> Lresult;
    fn SetWinEventHook(
        min: u32,
        max: u32,
        module: Hinstance,
        callback: Option<unsafe extern "system" fn(Hwineventhook, u32, Hwnd, i32, i32, u32, u32)>,
        process: u32,
        thread: u32,
        flags: u32,
    ) -> Hwineventhook;
    fn UnhookWinEvent(hook: Hwineventhook) -> Bool;
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentThreadId() -> u32;
    fn OpenProcess(access: u32, inherit: Bool, pid: u32) -> Handle;
    fn QueryFullProcessImageNameW(
        process: Handle,
        flags: u32,
        name: *mut u16,
        size: *mut u32,
    ) -> Bool;
    fn CloseHandle(handle: Handle) -> Bool;
}
#[link(name = "advapi32")]
unsafe extern "system" {
    fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> Bool;
    fn GetTokenInformation(
        token: Handle,
        class: u32,
        info: *mut c_void,
        length: u32,
        returned: *mut u32,
    ) -> Bool;
}
#[link(name = "shcore")]
unsafe extern "system" {
    fn GetDpiForMonitor(monitor: Hmonitor, dpi_type: u32, x: *mut u32, y: *mut u32) -> i32;
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn os_error(context: &str) -> String {
    format!("{context}: {}", std::io::Error::last_os_error())
}
fn hwnd_string(hwnd: Hwnd) -> String {
    format!("0x{:X}", hwnd as usize)
}
fn parse_hwnd(value: &str) -> Result<Hwnd, String> {
    usize::from_str_radix(value.trim_start_matches("0x"), 16)
        .map(|v| v as Hwnd)
        .map_err(|_| "invalid native window id".into())
}
fn event_time() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.0
}

fn vk_to_hid(vk: u32) -> Option<u32> {
    Some(match vk {
        0x41..=0x5A => 0x04 + (vk - 0x41),
        0x31..=0x39 => 0x1E + (vk - 0x31),
        0x30 => 0x27,
        0x0D => 0x28,
        0x1B => 0x29,
        0x08 => 0x2A,
        0x09 => 0x2B,
        0x20 => 0x2C,
        0xBD => 0x2D,
        0xBB => 0x2E,
        0xDB => 0x2F,
        0xDD => 0x30,
        0xDC => 0x31,
        0xBA => 0x33,
        0xDE => 0x34,
        0xC0 => 0x35,
        0xBC => 0x36,
        0xBE => 0x37,
        0xBF => 0x38,
        0x70..=0x7B => 0x3A + (vk - 0x70),
        0x2C => 0x46,
        0x91 => 0x47,
        0x13 => 0x48,
        0x2D => 0x49,
        0x24 => 0x4A,
        0x21 => 0x4B,
        0x2E => 0x4C,
        0x23 => 0x4D,
        0x22 => 0x4E,
        0x27 => 0x4F,
        0x25 => 0x50,
        0x28 => 0x51,
        0x26 => 0x52,
        0x90 => 0x53,
        0x6F => 0x54,
        0x6A => 0x55,
        0x6D => 0x56,
        0x6B => 0x57,
        0x61..=0x69 => 0x59 + (vk - 0x61),
        0x60 => 0x62,
        0x6E => 0x63,
        0xA2 => 0xE0,
        0xA0 => 0xE1,
        0xA4 => 0xE2,
        0x5B => 0xE3,
        0xA3 => 0xE4,
        0xA1 => 0xE5,
        0xA5 => 0xE6,
        0x5C => 0xE7,
        // Generic modifier VKs are mapped left; low-level hooks normally report the sided VK.
        0x11 => 0xE0,
        0x10 => 0xE1,
        0x12 => 0xE2,
        _ => return None,
    })
}

fn hid_to_vk(hid: u32) -> Option<u16> {
    Some(match hid {
        0x04..=0x1D => (0x41 + hid - 0x04) as u16,
        0x1E..=0x26 => (0x31 + hid - 0x1E) as u16,
        0x27 => 0x30,
        0x28 => 0x0D,
        0x29 => 0x1B,
        0x2A => 0x08,
        0x2B => 0x09,
        0x2C => 0x20,
        0x2D => 0xBD,
        0x2E => 0xBB,
        0x2F => 0xDB,
        0x30 => 0xDD,
        0x31 => 0xDC,
        0x33 => 0xBA,
        0x34 => 0xDE,
        0x35 => 0xC0,
        0x36 => 0xBC,
        0x37 => 0xBE,
        0x38 => 0xBF,
        0x3A..=0x45 => (0x70 + hid - 0x3A) as u16,
        0x4F => 0x27,
        0x50 => 0x25,
        0x51 => 0x28,
        0x52 => 0x26,
        0xE0 => 0xA2,
        0xE1 => 0xA0,
        0xE2 => 0xA4,
        0xE3 => 0x5B,
        0xE4 => 0xA3,
        0xE5 => 0xA1,
        0xE6 => 0xA5,
        0xE7 => 0x5C,
        _ => return None,
    })
}

struct HookContext {
    sink: EventSink,
    linked: AtomicBool,
    owner: AtomicBool,
    modifiers: AtomicU32,
}
static HOOK_CONTEXT: OnceCell<Mutex<Option<Arc<HookContext>>>> = OnceCell::new();
fn hook_context() -> Option<Arc<HookContext>> {
    HOOK_CONTEXT.get()?.lock().clone()
}

unsafe extern "system" fn window_proc(
    hwnd: Hwnd,
    message: u32,
    wparam: Wparam,
    lparam: Lparam,
) -> Lresult {
    match message {
        WM_INPUT => {
            let mut bytes = 0u32;
            unsafe {
                GetRawInputData(
                    lparam as Handle,
                    RID_INPUT,
                    null_mut(),
                    &mut bytes,
                    size_of::<RawInputHeader>() as u32,
                );
            }
            if bytes >= (size_of::<RawInputHeader>() + size_of::<RawMouse>()) as u32 && bytes < 4096
            {
                let mut data = vec![0u8; bytes as usize];
                if unsafe {
                    GetRawInputData(
                        lparam as Handle,
                        RID_INPUT,
                        data.as_mut_ptr().cast(),
                        &mut bytes,
                        size_of::<RawInputHeader>() as u32,
                    )
                } == bytes
                {
                    let header = unsafe { &*(data.as_ptr().cast::<RawInputHeader>()) };
                    if header.kind == RIM_TYPEMOUSE {
                        let mouse = unsafe {
                            &*(data
                                .as_ptr()
                                .add(size_of::<RawInputHeader>())
                                .cast::<RawMouse>())
                        };
                        if (mouse.last_x != 0 || mouse.last_y != 0)
                            && mouse.extra_information as usize != COMPUSYNC_EXTRA_INFO
                        {
                            if let Some(context) = hook_context() {
                                let mut event = NativeEvent::simple("cursorDelta");
                                event.timestamp = event_time();
                                event.dx = Some(mouse.last_x as f64);
                                event.dy = Some(mouse.last_y as f64);
                                (context.sink)(event);
                            }
                        }
                        let flags = mouse.buttons as u16;
                        for (flag, button, down) in [
                            (RI_MOUSE_LEFT_BUTTON_DOWN, "left", true),
                            (RI_MOUSE_LEFT_BUTTON_UP, "left", false),
                            (RI_MOUSE_RIGHT_BUTTON_DOWN, "right", true),
                            (RI_MOUSE_RIGHT_BUTTON_UP, "right", false),
                            (RI_MOUSE_MIDDLE_BUTTON_DOWN, "middle", true),
                            (RI_MOUSE_MIDDLE_BUTTON_UP, "middle", false),
                            (RI_MOUSE_BUTTON_4_DOWN, "x1", true),
                            (RI_MOUSE_BUTTON_4_UP, "x1", false),
                            (RI_MOUSE_BUTTON_5_DOWN, "x2", true),
                            (RI_MOUSE_BUTTON_5_UP, "x2", false),
                        ] {
                            if flags & flag != 0 {
                                if let Some(context) = hook_context() {
                                    let mut event = NativeEvent::simple("cursorButton");
                                    event.timestamp = event_time();
                                    event.button = Some(button.into());
                                    event.down = Some(down);
                                    event.modifiers =
                                        Some(context.modifiers.load(Ordering::Relaxed));
                                    (context.sink)(event);
                                }
                            }
                        }
                    }
                }
            }
            0
        }
        WM_DISPLAYCHANGE => {
            if let Some(context) = hook_context() {
                (context.sink)(NativeEvent::simple("displayChanged"));
            }
            0
        }
        WM_HOTKEY => {
            if let Some(context) = hook_context() {
                let kind = if wparam as i32 == HOTKEY_UNLINK {
                    "unlinkHotkey"
                } else {
                    "toggleOwnershipHotkey"
                };
                (context.sink)(NativeEvent::simple(kind));
            }
            0
        }
        WM_DESTROY => 0,
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

unsafe extern "system" fn keyboard_hook(code: i32, wparam: Wparam, lparam: Lparam) -> Lresult {
    if code == HC_ACTION {
        let key = unsafe { &*(lparam as *const KeyboardHook) };
        if key.extra_info != COMPUSYNC_EXTRA_INFO {
            if let Some(context) = hook_context() {
                let down = key.flags & LLKHF_UP == 0;
                let mut modifiers = context.modifiers.load(Ordering::Relaxed);
                let bit = match key.vk_code {
                    0x10 | 0xA0 | 0xA1 => 1,
                    0x11 | 0xA2 | 0xA3 => 2,
                    0x12 | 0xA4 | 0xA5 => 4,
                    0x5B | 0x5C => 8,
                    _ => 0,
                };
                if down {
                    modifiers |= bit
                } else {
                    modifiers &= !bit
                }
                context.modifiers.store(modifiers, Ordering::Relaxed);
                if let Some(hid) = vk_to_hid(key.vk_code) {
                    let mut event = NativeEvent::simple("keyEvent");
                    event.timestamp = event_time();
                    event.code = Some(hid);
                    event.down = Some(down);
                    event.modifiers = Some(modifiers);
                    (context.sink)(event);
                }
                // The non-owner forwards keys instead of delivering them locally.
                if context.linked.load(Ordering::Acquire) && !context.owner.load(Ordering::Acquire)
                {
                    return 1;
                }
            }
        }
    }
    unsafe { CallNextHookEx(null_mut(), code, wparam, lparam) }
}

unsafe extern "system" fn mouse_hook(code: i32, wparam: Wparam, lparam: Lparam) -> Lresult {
    if code == HC_ACTION
        && matches!(
            wparam as u32,
            0x0201 | 0x0202 | 0x0204 | 0x0205 | 0x0207 | 0x0208 | 0x020B | 0x020C
        )
    {
        let mouse = unsafe { &*(lparam as *const MouseHook) };
        if mouse.extra_info != COMPUSYNC_EXTRA_INFO {
            if let Some(context) = hook_context() {
                if context.linked.load(Ordering::Acquire) && !context.owner.load(Ordering::Acquire)
                {
                    return 1;
                }
            }
        }
    }
    unsafe { CallNextHookEx(null_mut(), code, wparam, lparam) }
}

unsafe extern "system" fn move_event(
    _: Hwineventhook,
    event: u32,
    hwnd: Hwnd,
    object: i32,
    child: i32,
    _: u32,
    _: u32,
) {
    if object == 0 && child == 0 && !hwnd.is_null() {
        if let Some(context) = hook_context() {
            let mut native = NativeEvent::simple(if event == EVENT_SYSTEM_MOVESIZESTART {
                "moveSizeStart"
            } else {
                "moveSizeEnd"
            });
            native.window_id = Some(hwnd_string(hwnd));
            (context.sink)(native);
        }
    }
}

struct CaptureRuntime {
    thread_id: u32,
    context: Arc<HookContext>,
    thread: Option<JoinHandle<()>>,
}
impl CaptureRuntime {
    fn stop(&mut self) {
        unsafe {
            PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0);
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
    parked: bool,
    capture: Option<CaptureRuntime>,
}
impl HostPlatform {
    pub fn new() -> Self {
        Self {
            hidden: false,
            parked: false,
            capture: None,
        }
    }
}

impl Platform for HostPlatform {
    fn name(&self) -> &'static str {
        "windows"
    }
    fn hide_cursor(&mut self) -> Result<(), String> {
        if !self.hidden {
            for _ in 0..32 {
                if unsafe { ShowCursor(0) } < 0 {
                    break;
                }
            }
            self.hidden = true;
        }
        Ok(())
    }
    fn show_cursor(&mut self) -> Result<(), String> {
        if !self.hidden {
            return Ok(());
        }
        for _ in 0..32 {
            if unsafe { ShowCursor(1) } >= 0 {
                break;
            }
        }
        self.hidden = false;
        Ok(())
    }
    fn park_cursor(&mut self) -> Result<(), String> {
        let mut p = WinPoint::default();
        if unsafe { GetCursorPos(&mut p) } == 0 {
            return Err(os_error("GetCursorPos"));
        }
        let rect = WinRect {
            left: p.x,
            top: p.y,
            right: p.x + 1,
            bottom: p.y + 1,
        };
        if unsafe { ClipCursor(&rect) } == 0 {
            return Err(os_error("ClipCursor"));
        }
        self.parked = true;
        Ok(())
    }
    fn release_cursor(&mut self) -> Result<(), String> {
        if unsafe { ClipCursor(null()) } == 0 {
            return Err(os_error("ClipCursor(NULL)"));
        }
        self.parked = false;
        Ok(())
    }
    fn warp_cursor(&mut self, point: Point) -> Result<(), String> {
        if unsafe { SetCursorPos(point.x.round() as i32, point.y.round() as i32) } == 0 {
            Err(os_error("SetCursorPos"))
        } else {
            Ok(())
        }
    }
    fn cursor_position(&self) -> Result<Point, String> {
        let mut point = WinPoint::default();
        if unsafe { GetCursorPos(&mut point) } == 0 {
            Err(os_error("GetCursorPos"))
        } else {
            Ok(Point {
                x: point.x as f64,
                y: point.y as f64,
            })
        }
    }
    fn displays(&self) -> Result<Vec<DisplayMetric>, String> {
        unsafe extern "system" fn callback(
            monitor: Hmonitor,
            _: Handle,
            _: *mut WinRect,
            data: Lparam,
        ) -> Bool {
            let output = unsafe { &mut *(data as *mut Vec<DisplayMetric>) };
            let mut info = MonitorInfo {
                size: size_of::<MonitorInfo>() as u32,
                monitor: WinRect::default(),
                work: WinRect::default(),
                flags: 0,
            };
            if unsafe { GetMonitorInfoW(monitor, &mut info) } != 0 {
                let mut xdpi = 96;
                let mut ydpi = 96;
                unsafe {
                    let _ = GetDpiForMonitor(monitor, 0, &mut xdpi, &mut ydpi);
                }
                let rect = |r: WinRect| Rect {
                    x: r.left as f64,
                    y: r.top as f64,
                    width: (r.right - r.left) as f64,
                    height: (r.bottom - r.top) as f64,
                };
                output.push(DisplayMetric {
                    id: hwnd_string(monitor),
                    bounds: rect(info.monitor),
                    work_area: rect(info.work),
                    scale: xdpi as f64 / 96.0,
                    primary: info.flags & MONITORINFOF_PRIMARY != 0,
                });
            }
            1
        }
        let mut result = vec![];
        if unsafe {
            EnumDisplayMonitors(
                null_mut(),
                null(),
                callback,
                &mut result as *mut _ as Lparam,
            )
        } == 0
        {
            Err(os_error("EnumDisplayMonitors"))
        } else {
            Ok(result)
        }
    }
    fn windows(&self) -> Result<Vec<WindowInfo>, String> {
        unsafe extern "system" fn callback(hwnd: Hwnd, data: Lparam) -> Bool {
            if unsafe { IsWindowVisible(hwnd) } == 0 {
                return 1;
            }
            let length = unsafe { GetWindowTextLengthW(hwnd) };
            if length <= 0 {
                return 1;
            }
            let mut text = vec![0u16; length as usize + 1];
            let read = unsafe { GetWindowTextW(hwnd, text.as_mut_ptr(), text.len() as i32) };
            let title = String::from_utf16_lossy(&text[..read.max(0) as usize]);
            let mut pid = 0;
            unsafe {
                GetWindowThreadProcessId(hwnd, &mut pid);
            }
            let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
            let mut process_name = String::new();
            if !process.is_null() {
                let mut path = vec![0u16; 32768];
                let mut path_len = path.len() as u32;
                if unsafe {
                    QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut path_len)
                } != 0
                {
                    process_name = Path::new(&String::from_utf16_lossy(&path[..path_len as usize]))
                        .file_name()
                        .and_then(|v| v.to_str())
                        .unwrap_or("")
                        .to_owned();
                }
                unsafe {
                    CloseHandle(process);
                }
            }
            let mut bounds = WinRect::default();
            if unsafe { GetWindowRect(hwnd, &mut bounds) } == 0 {
                return 1;
            }
            unsafe { &mut *(data as *mut Vec<WindowInfo>) }.push(WindowInfo {
                id: hwnd_string(hwnd),
                pid,
                process_name,
                title,
                bounds: Rect {
                    x: bounds.left as f64,
                    y: bounds.top as f64,
                    width: (bounds.right - bounds.left) as f64,
                    height: (bounds.bottom - bounds.top) as f64,
                },
                visible: true,
                minimized: unsafe { IsIconic(hwnd) } != 0,
                maximized: unsafe { IsZoomed(hwnd) } != 0,
            });
            1
        }
        let mut result = vec![];
        if unsafe { EnumWindows(callback, &mut result as *mut _ as Lparam) } == 0 {
            Err(os_error("EnumWindows"))
        } else {
            Ok(result)
        }
    }
    fn set_window_bounds(&mut self, id: &str, b: Rect) -> Result<(), String> {
        let hwnd = parse_hwnd(id)?;
        if unsafe {
            SetWindowPos(
                hwnd,
                null_mut(),
                b.x.round() as i32,
                b.y.round() as i32,
                b.width.round() as i32,
                b.height.round() as i32,
                SWP_NOZORDER | SWP_NOACTIVATE,
            )
        } == 0
        {
            Err(os_error("SetWindowPos"))
        } else {
            Ok(())
        }
    }
    fn focus_window(&mut self, id: &str) -> Result<(), String> {
        let hwnd = parse_hwnd(id)?;
        unsafe {
            ShowWindow(hwnd, SW_RESTORE);
        }
        if unsafe { SetForegroundWindow(hwnd) } == 0 {
            Err(os_error("SetForegroundWindow"))
        } else {
            Ok(())
        }
    }
    fn close_window(&mut self, id: &str) -> Result<(), String> {
        if unsafe { PostMessageW(parse_hwnd(id)?, WM_CLOSE, 0, 0) } == 0 {
            Err(os_error("PostMessage(WM_CLOSE)"))
        } else {
            Ok(())
        }
    }
    fn synthesize_button(&mut self, button: &str, down: bool) -> Result<(), String> {
        let (flags, data) = match (button, down) {
            ("left", true) => (MOUSEEVENTF_LEFTDOWN, 0),
            ("left", false) => (MOUSEEVENTF_LEFTUP, 0),
            ("right", true) => (MOUSEEVENTF_RIGHTDOWN, 0),
            ("right", false) => (MOUSEEVENTF_RIGHTUP, 0),
            ("middle", true) => (MOUSEEVENTF_MIDDLEDOWN, 0),
            ("middle", false) => (MOUSEEVENTF_MIDDLEUP, 0),
            ("x1", true) | ("back", true) => (MOUSEEVENTF_XDOWN, 1),
            ("x1", false) | ("back", false) => (MOUSEEVENTF_XUP, 1),
            ("x2", true) | ("forward", true) => (MOUSEEVENTF_XDOWN, 2),
            ("x2", false) | ("forward", false) => (MOUSEEVENTF_XUP, 2),
            _ => return Err("button must be left, right, middle, x1, or x2".into()),
        };
        let input = Input {
            kind: INPUT_MOUSE,
            data: InputData {
                mouse: MouseInput {
                    dx: 0,
                    dy: 0,
                    mouse_data: data,
                    flags,
                    time: 0,
                    extra_info: COMPUSYNC_EXTRA_INFO,
                },
            },
        };
        if unsafe { SendInput(1, &input, size_of::<Input>() as i32) } != 1 {
            Err(os_error("SendInput(mouse)"))
        } else {
            Ok(())
        }
    }
    fn synthesize_key(&mut self, code: u32, down: bool, _: u32) -> Result<(), String> {
        let vk = hid_to_vk(code)
            .ok_or_else(|| format!("unsupported USB HID keyboard usage 0x{code:X}"))?;
        let input = Input {
            kind: INPUT_KEYBOARD,
            data: InputData {
                keyboard: KeyboardInput {
                    vk,
                    scan: 0,
                    flags: if down { 0 } else { KEYEVENTF_KEYUP },
                    time: 0,
                    extra_info: COMPUSYNC_EXTRA_INFO,
                },
            },
        };
        if unsafe { SendInput(1, &input, size_of::<Input>() as i32) } != 1 {
            Err(os_error("SendInput(keyboard)"))
        } else {
            Ok(())
        }
    }
    fn foreground_is_elevated(&self) -> Result<bool, String> {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_null() {
            return Ok(false);
        }
        let mut pid = 0;
        unsafe {
            GetWindowThreadProcessId(hwnd, &mut pid);
        }
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return Err(os_error("OpenProcess"));
        }
        let mut token = null_mut();
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            unsafe {
                CloseHandle(process);
            }
            return Err(os_error("OpenProcessToken"));
        }
        let mut elevation = TokenElevation { elevated: 0 };
        let mut returned = 0;
        let ok = unsafe {
            GetTokenInformation(
                token,
                TOKEN_ELEVATION_CLASS,
                (&mut elevation as *mut TokenElevation).cast(),
                size_of::<TokenElevation>() as u32,
                &mut returned,
            )
        };
        unsafe {
            CloseHandle(token);
            CloseHandle(process);
        }
        if ok == 0 {
            Err(os_error("GetTokenInformation(TokenElevation)"))
        } else {
            Ok(elevation.elevated != 0)
        }
    }
    fn start_capture(&mut self, sink: EventSink) -> Result<(), String> {
        if self.capture.is_some() {
            return Ok(());
        }
        let context = Arc::new(HookContext {
            sink,
            linked: AtomicBool::new(false),
            owner: AtomicBool::new(true),
            modifiers: AtomicU32::new(0),
        });
        *HOOK_CONTEXT.get_or_init(|| Mutex::new(None)).lock() = Some(context.clone());
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let thread = thread::Builder::new()
            .name("compusync-win-input".into())
            .spawn(move || unsafe {
                let thread_id = GetCurrentThreadId();
                let class_name = wide("CompusyncRawInputV3");
                let class = WndClass {
                    style: 0,
                    wnd_proc: Some(window_proc),
                    class_extra: 0,
                    window_extra: 0,
                    instance: null_mut(),
                    icon: null_mut(),
                    cursor: null_mut(),
                    background: null_mut(),
                    menu_name: null(),
                    class_name: class_name.as_ptr(),
                };
                RegisterClassW(&class);
                // A message-only HWND does not receive broadcast WM_DISPLAYCHANGE.
                let hwnd = CreateWindowExW(
                    0,
                    class_name.as_ptr(),
                    class_name.as_ptr(),
                    0,
                    0,
                    0,
                    0,
                    0,
                    null_mut(),
                    null_mut(),
                    null_mut(),
                    null_mut(),
                );
                if hwnd.is_null() {
                    let _ = sender.send(Err(os_error("CreateWindowExW")));
                    return;
                }
                let mouse = RawInputDevice {
                    usage_page: 1,
                    usage: 2,
                    flags: RIDEV_INPUTSINK,
                    target: hwnd,
                };
                if RegisterRawInputDevices(&mouse, 1, size_of::<RawInputDevice>() as u32) == 0 {
                    let _ = sender.send(Err(os_error("RegisterRawInputDevices")));
                    DestroyWindow(hwnd);
                    return;
                }
                let keyboard =
                    SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), null_mut(), 0);
                let mouse_hook_handle =
                    SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), null_mut(), 0);
                let moves = SetWinEventHook(
                    EVENT_SYSTEM_MOVESIZESTART,
                    EVENT_SYSTEM_MOVESIZEEND,
                    null_mut(),
                    Some(move_event),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT,
                );
                if keyboard.is_null() || mouse_hook_handle.is_null() || moves.is_null() {
                    let _ = sender.send(Err(os_error("install input/move hooks")));
                    DestroyWindow(hwnd);
                    return;
                }
                if RegisterHotKey(
                    hwnd,
                    HOTKEY_UNLINK,
                    MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT,
                    VK_U,
                ) == 0
                    || RegisterHotKey(
                        hwnd,
                        HOTKEY_TOGGLE_OWNER,
                        MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT,
                        VK_Y,
                    ) == 0
                {
                    let _ = sender.send(Err(os_error("RegisterHotKey")));
                    UnhookWindowsHookEx(keyboard);
                    UnhookWindowsHookEx(mouse_hook_handle);
                    UnhookWinEvent(moves);
                    DestroyWindow(hwnd);
                    return;
                }
                let _ = sender.send(Ok(thread_id));
                let mut message: Message = zeroed();
                while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
                UnregisterHotKey(hwnd, HOTKEY_UNLINK);
                UnregisterHotKey(hwnd, HOTKEY_TOGGLE_OWNER);
                if !keyboard.is_null() {
                    UnhookWindowsHookEx(keyboard);
                }
                if !mouse_hook_handle.is_null() {
                    UnhookWindowsHookEx(mouse_hook_handle);
                }
                if !moves.is_null() {
                    UnhookWinEvent(moves);
                }
                DestroyWindow(hwnd);
            })
            .map_err(|e| e.to_string())?;
        let thread_id = receiver
            .recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|_| "input thread did not start".to_string())??;
        self.capture = Some(CaptureRuntime {
            thread_id,
            context,
            thread: Some(thread),
        });
        Ok(())
    }
    fn set_capture_mode(&mut self, linked: bool, owner: bool) {
        if let Some(runtime) = &self.capture {
            runtime.context.linked.store(linked, Ordering::Release);
            runtime.context.owner.store(owner, Ordering::Release);
        }
    }
    fn stop_capture(&mut self) {
        if let Some(mut runtime) = self.capture.take() {
            runtime.stop();
        }
        if let Some(context) = HOOK_CONTEXT.get() {
            *context.lock() = None;
        }
    }
    fn terminate_move_loop(&mut self, _: &str) -> Result<(), String> {
        self.synthesize_button("left", false)
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
    use super::{hid_to_vk, vk_to_hid};

    #[test]
    fn canonical_hid_mapping_round_trips_common_keys() {
        for vk in [
            0x41, 0x5A, 0x31, 0x30, 0x0D, 0x1B, 0x25, 0x28, 0xA0, 0xA3, 0x5B,
        ] {
            let hid = vk_to_hid(vk).expect("test key has a HID mapping");
            assert_eq!(
                vk_to_hid(hid_to_vk(hid).expect("HID maps back") as u32),
                Some(hid)
            );
        }
    }

    #[test]
    fn unknown_keys_are_rejected_instead_of_cross_platform_misinterpreted() {
        assert_eq!(vk_to_hid(0xFF), None);
        assert_eq!(hid_to_vk(0xFFFF), None);
    }
}
