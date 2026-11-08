use crate::{DisplayMetric, NativeEvent, Point, Rect, WindowInfo};
use std::sync::Arc;

pub type EventSink = Arc<dyn Fn(NativeEvent) + Send + Sync + 'static>;

#[cfg(any(target_os = "macos", test))]
mod macos_event_tap;

#[cfg(any(target_os = "macos", test))]
mod macos_window_drag;

pub trait Platform: Send {
    fn name(&self) -> &'static str;
    fn hide_cursor(&mut self) -> Result<(), String>;
    fn show_cursor(&mut self) -> Result<(), String>;
    fn park_cursor(&mut self) -> Result<(), String>;
    fn release_cursor(&mut self) -> Result<(), String>;
    fn warp_cursor(&mut self, point: Point) -> Result<(), String>;
    fn cursor_position(&self) -> Result<Point, String>;
    fn displays(&self) -> Result<Vec<DisplayMetric>, String>;
    fn windows(&self) -> Result<Vec<WindowInfo>, String>;
    fn window_exists(&self, id: &str) -> Result<bool, String>;
    fn set_window_bounds(&mut self, id: &str, bounds: Rect) -> Result<(), String>;
    fn focus_window(&mut self, id: &str) -> Result<(), String>;
    fn close_window(&mut self, id: &str) -> Result<(), String>;
    fn synthesize_button(
        &mut self,
        button: &str,
        down: bool,
        click_count: u32,
    ) -> Result<(), String>;
    fn synthesize_key(&mut self, code: u32, down: bool, modifiers: u32) -> Result<(), String>;
    fn synthesize_scroll(&mut self, dy: f64) -> Result<(), String>;
    fn set_gesture_forwarding(&mut self, _enabled: bool) {}
    fn synthesize_gesture(&mut self, _data: &str) -> Result<(), String> {
        Err("trackpad gesture synthesis requires macOS".into())
    }
    fn cancel_gesture(&mut self) {}
    fn foreground_is_elevated(&self) -> Result<bool, String>;
    fn start_capture(&mut self, sink: EventSink) -> Result<(), String>;
    fn set_capture_mode(&mut self, linked: bool, owner: bool);
    fn stop_capture(&mut self);
    fn terminate_move_loop(&mut self, id: &str) -> Result<(), String>;
}

/// Permission probes live outside `Platform` because they are process-level
/// macOS TCC state, not state owned by an input-capture instance.
#[cfg(target_os = "macos")]
pub fn input_monitoring_access(request: bool) -> bool {
    darwin::input_monitoring_access(request)
}

#[cfg(not(target_os = "macos"))]
pub fn input_monitoring_access(_: bool) -> bool {
    false
}

#[cfg(target_os = "macos")]
pub fn chrome_automation_access(request: bool) -> &'static str {
    darwin::chrome_automation_access(request)
}

#[cfg(not(target_os = "macos"))]
pub fn chrome_automation_access(_: bool) -> &'static str {
    "unavailable"
}

// File drag and file clipboard between computers. These are process-level OS
// services (drag pasteboard, clipboard, shell windows), not state owned by an
// input-capture instance.
#[cfg(target_os = "macos")]
mod macos_file_drag;
#[cfg(target_os = "macos")]
pub use macos_file_drag::{
    clipboard_files, clipboard_generation, drag_files, drag_generation, set_clipboard_files,
    windows_at_point,
};
#[cfg(target_os = "windows")]
mod windows_file_drag;
#[cfg(target_os = "windows")]
pub use windows_file_drag::{
    clipboard_files, clipboard_generation, drag_files, drag_generation, folder_at_point,
    set_clipboard_files, set_drag_capture_region,
};

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn clipboard_generation() -> f64 {
    0.0
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn clipboard_files() -> Result<Vec<String>, String> {
    Ok(vec![])
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn set_clipboard_files(_: &[String]) -> Result<(), String> {
    Err("file clipboard is unsupported on this platform".into())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn drag_generation() -> f64 {
    0.0
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn drag_files() -> Result<Vec<String>, String> {
    Ok(vec![])
}

#[cfg(not(target_os = "windows"))]
pub fn set_drag_capture_region(_: Option<Rect>) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn folder_at_point(_: Point) -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(not(target_os = "macos"))]
pub fn windows_at_point(_: Point) -> Result<Vec<crate::ScreenWindow>, String> {
    Ok(vec![])
}

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::HostPlatform;

#[cfg(target_os = "macos")]
mod darwin;
#[cfg(target_os = "macos")]
pub use darwin::HostPlatform;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod unsupported;
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub use unsupported::HostPlatform;
