//! Standalone last-resort recovery process.
//!
//! Keep this crate independent from the Node-API addon. The helper must start
//! after a hard daemon exit and therefore cannot dynamically resolve `napi_*`
//! symbols from Node or Electron.

use serde::{Deserialize, Serialize};
use std::process::ExitCode;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct GuardedWindowState {
    id: String,
    bounds: Rect,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct RecoveryGuardState {
    windows: Vec<GuardedWindowState>,
    buttons: u32,
    modifiers: u32,
}

fn main() -> ExitCode {
    let Some(pid) = std::env::args()
        .nth(1)
        .and_then(|value| value.parse::<u32>().ok())
    else {
        return ExitCode::from(2);
    };
    let state_path = std::env::args().nth(2);
    if !platform::wait_for_exit(pid) {
        return ExitCode::from(1);
    }
    let state = state_path
        .as_deref()
        .and_then(read_state)
        .unwrap_or_default();
    platform::recover(&state);
    if let Some(path) = state_path {
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(std::path::Path::new(&path).with_extension("next"));
    }
    ExitCode::SUCCESS
}

fn read_state(path: &str) -> Option<RecoveryGuardState> {
    let path = std::path::Path::new(path);
    [path.with_extension("next"), path.to_path_buf()]
        .into_iter()
        .find_map(|candidate| {
            std::fs::read(candidate)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        })
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{RecoveryGuardState, Rect};
    use std::{ffi::c_void, mem::size_of, ptr::null_mut};

    type Handle = *mut c_void;
    type Hwnd = *mut c_void;

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

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn ClipCursor(rect: *const c_void) -> i32;
        fn ShowCursor(show: i32) -> i32;
        fn SendInput(count: u32, inputs: *const Input, size: i32) -> u32;
        fn SetWindowPos(
            window: Hwnd,
            after: Hwnd,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            flags: u32,
        ) -> i32;
    }

    pub fn wait_for_exit(pid: u32) -> bool {
        const SYNCHRONIZE: u32 = 0x0010_0000;
        let process = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
        if process.is_null() {
            return false;
        }
        let result = unsafe { WaitForSingleObject(process, u32::MAX) };
        unsafe { CloseHandle(process) };
        result == 0
    }

    pub fn recover(state: &RecoveryGuardState) {
        unsafe {
            ClipCursor(std::ptr::null());
        }
        if state.buttons != 0 {
            release_buttons(state.buttons);
        }
        if state.modifiers != 0 {
            release_modifiers();
        }
        for window in &state.windows {
            if let Ok(hwnd) = usize::from_str_radix(window.id.trim_start_matches("0x"), 16) {
                restore_window(hwnd as Hwnd, window.bounds);
            }
        }
        // The helper did not hide the cursor itself, so it cannot rely on an
        // in-process `hidden` flag. Balance the dead process's ShowCursor call.
        for _ in 0..32 {
            if unsafe { ShowCursor(1) } >= 0 {
                break;
            }
        }
    }

    fn release_buttons(mask: u32) {
        const INPUT_MOUSE: u32 = 0;
        const FLAGS: [(u32, u32, u32); 5] = [
            (1, 0x0004, 0),
            (2, 0x0010, 0),
            (4, 0x0040, 0),
            (8, 0x0100, 1),
            (16, 0x0100, 2),
        ];
        for (bit, flags, data) in FLAGS {
            if mask & bit == 0 {
                continue;
            }
            let input = Input {
                kind: INPUT_MOUSE,
                data: InputData {
                    mouse: MouseInput {
                        dx: 0,
                        dy: 0,
                        mouse_data: data,
                        flags,
                        time: 0,
                        extra_info: 0,
                    },
                },
            };
            unsafe { SendInput(1, &input, size_of::<Input>() as i32) };
        }
    }

    fn release_modifiers() {
        const INPUT_KEYBOARD: u32 = 1;
        const KEYEVENTF_KEYUP: u32 = 0x0002;
        for vk in [0xA0u16, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C] {
            let input = Input {
                kind: INPUT_KEYBOARD,
                data: InputData {
                    keyboard: KeyboardInput {
                        vk,
                        scan: 0,
                        flags: KEYEVENTF_KEYUP,
                        time: 0,
                        extra_info: 0,
                    },
                },
            };
            unsafe { SendInput(1, &input, size_of::<Input>() as i32) };
        }
    }

    fn restore_window(hwnd: Hwnd, bounds: Rect) {
        const SWP_NOZORDER: u32 = 0x0004;
        const SWP_NOACTIVATE: u32 = 0x0010;
        unsafe {
            SetWindowPos(
                hwnd,
                null_mut(),
                bounds.x.round() as i32,
                bounds.y.round() as i32,
                bounds.width.round() as i32,
                bounds.height.round() as i32,
                SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{RecoveryGuardState, Rect};
    use std::{ffi::c_void, ptr::null};

    type CfType = *const c_void;
    type CfArray = *const c_void;
    type CfString = *const c_void;
    type AxElement = *const c_void;

    struct OwnedCf(CfType);

    impl OwnedCf {
        fn new(value: CfType) -> Option<Self> {
            (!value.is_null()).then_some(Self(value))
        }
    }

    impl Drop for OwnedCf {
        fn drop(&mut self) {
            unsafe { CFRelease(self.0) };
        }
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: f64,
        y: f64,
    }

    #[repr(C)]
    struct Size {
        width: f64,
        height: f64,
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXUIElementCreateApplication(pid: i32) -> AxElement;
        fn AXUIElementCopyAttributeValues(
            element: AxElement,
            attribute: CfString,
            index: isize,
            maximum: isize,
            values: *mut CfArray,
        ) -> i32;
        fn AXValueCreate(kind: u32, value: *const c_void) -> CfType;
        fn AXUIElementSetAttributeValue(
            element: AxElement,
            attribute: CfString,
            value: CfType,
        ) -> i32;
        fn CGMainDisplayID() -> u32;
        fn CGDisplayShowCursor(display: u32) -> i32;
        fn CGAssociateMouseAndMouseCursorPosition(connected: bool) -> i32;
        fn CGEventCreate(source: CfType) -> CfType;
        fn CGEventGetLocation(event: CfType) -> Point;
        fn CGEventCreateMouseEvent(source: CfType, kind: u32, point: Point, button: u32) -> CfType;
        fn CGEventCreateKeyboardEvent(source: CfType, keycode: u16, down: bool) -> CfType;
        fn CGEventPost(location: u32, event: CfType);
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithCString(
            allocator: CfType,
            value: *const i8,
            encoding: u32,
        ) -> CfString;
        fn CFArrayGetCount(array: CfArray) -> isize;
        fn CFArrayGetValueAtIndex(array: CfArray, index: isize) -> CfType;
        fn CFRelease(value: CfType);
    }

    pub fn wait_for_exit(pid: u32) -> bool {
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
            fn usleep(microseconds: u32) -> i32;
        }
        loop {
            if unsafe { kill(pid as i32, 0) } != 0 {
                return true;
            }
            unsafe { usleep(50_000) };
        }
    }

    pub fn recover(state: &RecoveryGuardState) {
        unsafe {
            CGAssociateMouseAndMouseCursorPosition(true);
        }
        if state.buttons != 0 {
            release_buttons(state.buttons);
        }
        if state.modifiers != 0 {
            release_modifiers();
        }
        for window in &state.windows {
            restore_window(&window.id, window.bounds);
        }
        unsafe {
            CGDisplayShowCursor(CGMainDisplayID());
        }
    }

    fn cursor_location() -> Point {
        let event = unsafe { CGEventCreate(null()) };
        if event.is_null() {
            return Point { x: 0.0, y: 0.0 };
        }
        let point = unsafe { CGEventGetLocation(event) };
        unsafe { CFRelease(event) };
        point
    }

    fn release_buttons(mask: u32) {
        let point = cursor_location();
        for (bit, kind, button) in [(1, 2, 0), (2, 4, 1), (4, 26, 2), (8, 26, 3), (16, 26, 4)] {
            if mask & bit == 0 {
                continue;
            }
            let event = unsafe { CGEventCreateMouseEvent(null(), kind, point, button) };
            if !event.is_null() {
                unsafe {
                    CGEventPost(0, event);
                    CFRelease(event);
                }
            }
        }
    }

    fn release_modifiers() {
        for keycode in [56u16, 60, 59, 62, 58, 61, 55, 54] {
            let event = unsafe { CGEventCreateKeyboardEvent(null(), keycode, false) };
            if !event.is_null() {
                unsafe {
                    CGEventPost(0, event);
                    CFRelease(event);
                }
            }
        }
    }

    fn restore_window(id: &str, bounds: Rect) {
        let mut parts = id.split(':');
        if parts.next() != Some("ax") {
            return;
        }
        let Some(pid) = parts.next().and_then(|part| part.parse::<i32>().ok()) else {
            return;
        };
        let Some(index) = parts.next().and_then(|part| part.parse::<isize>().ok()) else {
            return;
        };
        if pid <= 0 || !(0..200).contains(&index) || parts.next().is_some() {
            return;
        }
        unsafe {
            const UTF8: u32 = 0x0800_0100;
            let Some(app) = OwnedCf::new(AXUIElementCreateApplication(pid)) else {
                return;
            };
            let Some(windows_attribute) = OwnedCf::new(CFStringCreateWithCString(
                null(),
                b"AXWindows\0".as_ptr().cast(),
                UTF8,
            )) else {
                return;
            };
            let Some(position_attribute) = OwnedCf::new(CFStringCreateWithCString(
                null(),
                b"AXPosition\0".as_ptr().cast(),
                UTF8,
            )) else {
                return;
            };
            let Some(size_attribute) = OwnedCf::new(CFStringCreateWithCString(
                null(),
                b"AXSize\0".as_ptr().cast(),
                UTF8,
            )) else {
                return;
            };
            let mut windows: CfArray = null();
            if AXUIElementCopyAttributeValues(app.0, windows_attribute.0, 0, 200, &mut windows) != 0
                || windows.is_null()
                || index >= CFArrayGetCount(windows)
            {
                if !windows.is_null() {
                    CFRelease(windows);
                }
                return;
            }
            let windows = OwnedCf(windows);
            let window = CFArrayGetValueAtIndex(windows.0, index) as AxElement;
            let point = Point {
                x: bounds.x,
                y: bounds.y,
            };
            let size = Size {
                width: bounds.width,
                height: bounds.height,
            };
            if let Some(position_value) =
                OwnedCf::new(AXValueCreate(1, (&point as *const Point).cast()))
            {
                AXUIElementSetAttributeValue(window, position_attribute.0, position_value.0);
            }
            if let Some(size_value) = OwnedCf::new(AXValueCreate(2, (&size as *const Size).cast()))
            {
                AXUIElementSetAttributeValue(window, size_attribute.0, size_value.0);
            }
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod platform {
    use super::RecoveryGuardState;

    pub fn wait_for_exit(_: u32) -> bool {
        false
    }

    pub fn recover(_: &RecoveryGuardState) {}
}

#[cfg(test)]
mod tests {
    use super::{read_state, GuardedWindowState, RecoveryGuardState, Rect};

    #[test]
    fn recovery_state_prefers_complete_journal_and_falls_back_after_torn_write() {
        let path = std::env::temp_dir().join(format!(
            "compusync-guard-test-{}-{:?}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let committed = RecoveryGuardState {
            windows: vec![GuardedWindowState {
                id: "0x123".into(),
                bounds: Rect {
                    x: -10.0,
                    y: 20.0,
                    width: 800.0,
                    height: 600.0,
                },
            }],
            buttons: 1,
            modifiers: 2,
        };
        std::fs::write(&path, serde_json::to_vec(&committed).unwrap()).unwrap();
        let journal = RecoveryGuardState {
            buttons: 3,
            ..committed.clone()
        };
        std::fs::write(
            path.with_extension("next"),
            serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();
        assert_eq!(read_state(path.to_str().unwrap()).unwrap().buttons, 3);
        std::fs::write(path.with_extension("next"), b"{").unwrap();
        let fallback = read_state(path.to_str().unwrap()).unwrap();
        assert_eq!(fallback.buttons, 1);
        assert_eq!(fallback.modifiers, 2);
        assert_eq!(fallback.windows[0].id, "0x123");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("next"));
    }
}
