use super::{EventSink, Platform};
use crate::{DisplayMetric, Point, Rect, WindowInfo};

pub struct HostPlatform;
impl HostPlatform {
    pub fn new() -> Self {
        Self
    }
}

impl Platform for HostPlatform {
    fn name(&self) -> &'static str {
        "unsupported"
    }
    fn hide_cursor(&mut self) -> Result<(), String> {
        Err("Compusync native input supports Windows and macOS only".into())
    }
    fn show_cursor(&mut self) -> Result<(), String> {
        Ok(())
    }
    fn park_cursor(&mut self) -> Result<(), String> {
        Err("cursor parking is unavailable".into())
    }
    fn release_cursor(&mut self) -> Result<(), String> {
        Ok(())
    }
    fn warp_cursor(&mut self, _: Point) -> Result<(), String> {
        Err("cursor warping is unavailable".into())
    }
    fn cursor_position(&self) -> Result<Point, String> {
        Err("cursor position is unavailable".into())
    }
    fn displays(&self) -> Result<Vec<DisplayMetric>, String> {
        Ok(vec![])
    }
    fn windows(&self) -> Result<Vec<WindowInfo>, String> {
        Ok(vec![])
    }
    fn set_window_bounds(&mut self, _: &str, _: Rect) -> Result<(), String> {
        Err("window positioning is unavailable".into())
    }
    fn focus_window(&mut self, _: &str) -> Result<(), String> {
        Err("window focus is unavailable".into())
    }
    fn close_window(&mut self, _: &str) -> Result<(), String> {
        Err("window close is unavailable".into())
    }
    fn synthesize_button(&mut self, _: &str, _: bool) -> Result<(), String> {
        Err("input synthesis is unavailable".into())
    }
    fn synthesize_key(&mut self, _: u32, _: bool, _: u32) -> Result<(), String> {
        Err("input synthesis is unavailable".into())
    }
    fn foreground_is_elevated(&self) -> Result<bool, String> {
        Ok(false)
    }
    fn start_capture(&mut self, _: EventSink) -> Result<(), String> {
        Err("input capture is unavailable".into())
    }
    fn set_capture_mode(&mut self, _: bool, _: bool) {}
    fn stop_capture(&mut self) {}
    fn terminate_move_loop(&mut self, _: &str) -> Result<(), String> {
        Err("native move loops are unavailable".into())
    }
}
