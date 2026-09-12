#![deny(unsafe_op_in_unsafe_fn)]

mod acceleration;
mod platform;

use acceleration::{apply as accelerate, AccelerationConfig, AppliedDelta};
use napi::{
    bindgen_prelude::*,
    threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use once_cell::sync::{Lazy, OnceCell};
use parking_lot::Mutex;
use platform::{EventSink, HostPlatform, Platform};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Weak,
    },
    thread,
    time::{Duration, Instant},
};

pub use acceleration::{
    AccelerationConfig as SharedAccelerationConfig, AppliedDelta as SharedAppliedDelta,
};

static PROCESS_STARTED: Lazy<Instant> = Lazy::new(Instant::now);
static GLOBAL_STATE: OnceCell<Mutex<Weak<Inner>>> = OnceCell::new();
static RECOVERY_HOOKS_INSTALLED: OnceCell<()> = OnceCell::new();
const EVENT_QUEUE_CAPACITY: usize = 8192;
// USB HID keyboard usages; platform backends translate these to native codes.
const SYNTHETIC_MODIFIERS: [u32; 8] = [0xE0, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7];

fn monotonic_ms() -> u64 {
    PROCESS_STARTED.elapsed().as_millis().min(u64::MAX as u128) as u64
}

#[napi(object)]
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[napi(object)]
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    fn validate(self) -> std::result::Result<Self, &'static str> {
        if !self.x.is_finite()
            || !self.y.is_finite()
            || !self.width.is_finite()
            || !self.height.is_finite()
        {
            return Err("window bounds must be finite");
        }
        if self.width < 1.0 || self.height < 1.0 || self.width > 32_768.0 || self.height > 32_768.0
        {
            return Err("window size must be between 1 and 32768 device pixels");
        }
        if self.x.abs() > 1_000_000.0 || self.y.abs() > 1_000_000.0 {
            return Err("window origin is outside the safety limit");
        }
        Ok(self)
    }
}

#[napi(object)]
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DisplayMetric {
    pub id: String,
    pub bounds: Rect,
    pub work_area: Rect,
    pub scale: f64,
    pub primary: bool,
}

#[napi(object)]
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WindowInfo {
    /// Opaque native handle. It is a string because HWND/CGWindowID cannot safely
    /// round-trip through a JavaScript Number on every architecture.
    pub id: String,
    pub pid: u32,
    pub process_name: String,
    pub title: String,
    pub bounds: Rect,
    pub visible: bool,
    pub minimized: bool,
    pub maximized: bool,
}

#[napi(object)]
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct NativeEvent {
    pub kind: String,
    pub timestamp: f64,
    pub dx: Option<f64>,
    pub dy: Option<f64>,
    pub dt: Option<f64>,
    pub button: Option<String>,
    pub down: Option<bool>,
    pub code: Option<u32>,
    pub modifiers: Option<u32>,
    pub window_id: Option<String>,
    pub message: Option<String>,
}

impl NativeEvent {
    pub(crate) fn simple(kind: &str) -> Self {
        Self {
            kind: kind.into(),
            timestamp: monotonic_ms() as f64,
            ..Default::default()
        }
    }
}

type JsEventCallback = ThreadsafeFunction<String, ErrorStrategy::Fatal>;

struct EventHub {
    queue: Mutex<VecDeque<NativeEvent>>,
    callback: Mutex<Option<JsEventCallback>>,
}

impl EventHub {
    fn new() -> Self {
        Self {
            queue: Mutex::new(VecDeque::with_capacity(1024)),
            callback: Mutex::new(None),
        }
    }

    fn emit(&self, event: NativeEvent) {
        if let Some(callback) = self.callback.lock().as_ref() {
            if let Ok(json) = serde_json::to_string(&event) {
                let _ = callback.call(json, ThreadsafeFunctionCallMode::NonBlocking);
            }
        }
        let mut queue = self.queue.lock();
        if queue.len() == EVENT_QUEUE_CAPACITY {
            queue.pop_front();
        }
        queue.push_back(event);
    }
}

struct Inner {
    platform: Mutex<HostPlatform>,
    events: Arc<EventHub>,
    acceleration: Arc<Mutex<AccelerationConfig>>,
    linked: AtomicBool,
    owner: AtomicBool,
    recovering: AtomicBool,
    stopped: AtomicBool,
    recovery_requested: AtomicBool,
    last_heartbeat_ms: AtomicU64,
    guarded_windows: Mutex<HashMap<String, Rect>>,
}

impl Inner {
    fn recover(&self, reason: &str) {
        if self.recovering.swap(true, Ordering::AcqRel) {
            return;
        }
        self.linked.store(false, Ordering::Release);
        self.owner.store(true, Ordering::Release);

        let guarded = std::mem::take(&mut *self.guarded_windows.lock());
        let mut platform = self.platform.lock();
        platform.stop_capture();
        for code in SYNTHETIC_MODIFIERS {
            let _ = platform.synthesize_key(code, false, 0);
        }
        for button in ["left", "right", "middle", "x1", "x2"] {
            let _ = platform.synthesize_button(button, false);
        }
        for (id, bounds) in guarded {
            let _ = platform.set_window_bounds(&id, bounds);
        }
        let _ = platform.release_cursor();
        let _ = platform.show_cursor();
        drop(platform);

        let mut event = NativeEvent::simple("recovered");
        event.message = Some(reason.into());
        self.events.emit(event);
        self.recovering.store(false, Ordering::Release);
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.recover("native addon dropped");
    }
}

extern "C" fn process_exit_recovery() {
    if let Some(inner) = GLOBAL_STATE.get().and_then(|state| state.lock().upgrade()) {
        inner.recover("process exit");
    }
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
unsafe extern "C" {
    fn atexit(callback: extern "C" fn()) -> i32;
}

fn install_recovery_hooks(inner: &Arc<Inner>) {
    GLOBAL_STATE
        .get_or_init(|| Mutex::new(Weak::new()))
        .lock()
        .clone_from(&Arc::downgrade(inner));
    RECOVERY_HOOKS_INSTALLED.get_or_init(|| {
        #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
        unsafe {
            let _ = atexit(process_exit_recovery);
        }

        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if let Some(inner) = GLOBAL_STATE.get().and_then(|state| state.lock().upgrade()) {
                inner.recover("native addon panic");
            }
            previous(info);
        }));
    });
}

fn napi_error(message: impl Into<String>) -> napi::Error {
    napi::Error::from_reason(message.into())
}

#[napi]
pub struct NativeSubstrate {
    inner: Arc<Inner>,
}

#[napi]
impl NativeSubstrate {
    #[napi(constructor)]
    pub fn new() -> Self {
        let inner = Arc::new(Inner {
            platform: Mutex::new(HostPlatform::new()),
            events: Arc::new(EventHub::new()),
            acceleration: Arc::new(Mutex::new(AccelerationConfig::default())),
            linked: AtomicBool::new(false),
            owner: AtomicBool::new(true),
            recovering: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            recovery_requested: AtomicBool::new(false),
            last_heartbeat_ms: AtomicU64::new(monotonic_ms()),
            guarded_windows: Mutex::new(HashMap::new()),
        });
        install_recovery_hooks(&inner);

        let weak = Arc::downgrade(&inner);
        thread::Builder::new()
            .name("compusync-watchdog".into())
            .spawn(move || {
                while let Some(inner) = weak.upgrade() {
                    if inner.stopped.load(Ordering::Acquire) {
                        break;
                    }
                    if inner.recovery_requested.swap(false, Ordering::AcqRel) {
                        inner.recover("unlink hotkey");
                    }
                    if inner.linked.load(Ordering::Acquire)
                        && monotonic_ms()
                            .saturating_sub(inner.last_heartbeat_ms.load(Ordering::Acquire))
                            > 2_000
                    {
                        inner.recover("heartbeat timeout");
                    }
                    thread::sleep(Duration::from_millis(100));
                }
            })
            .expect("watchdog thread must start");
        Self { inner }
    }

    #[napi(getter)]
    pub fn platform_name(&self) -> String {
        self.inner.platform.lock().name().into()
    }

    #[napi(getter)]
    pub fn linked(&self) -> bool {
        self.inner.linked.load(Ordering::Acquire)
    }

    #[napi(getter)]
    pub fn owner(&self) -> bool {
        self.inner.owner.load(Ordering::Acquire)
    }

    /// Native events are delivered as compact JSON to avoid allocating a JS
    /// object graph on the input thread. Queue draining remains available for
    /// startup and test harnesses.
    #[napi]
    pub fn set_event_callback(&self, env: Env, callback: JsFunction) -> Result<()> {
        let mut tsfn = callback.create_threadsafe_function(1024, |ctx| {
            Ok(vec![ctx.env.create_string_from_std(ctx.value)?])
        })?;
        // Input capture must not keep Electron alive after every window has closed.
        tsfn.unref(&env)?;
        *self.inner.events.callback.lock() = Some(tsfn);
        Ok(())
    }

    #[napi]
    pub fn drain_events(&self, limit: Option<u32>) -> Vec<NativeEvent> {
        let mut queue = self.inner.events.queue.lock();
        let count = (limit.unwrap_or(1024) as usize).min(4096).min(queue.len());
        queue.drain(..count).collect()
    }

    #[napi]
    pub fn start_capture(&self) -> Result<()> {
        let events = self.inner.events.clone();
        let config = self.inner.acceleration.clone();
        let last_delta = Arc::new(Mutex::new(Instant::now()));
        let weak_inner = Arc::downgrade(&self.inner);
        let sink: EventSink = Arc::new(move |mut event| {
            if event.kind == "unlinkHotkey" {
                // Event taps invoke this closure on their capture thread. Recovery
                // stops and joins that thread, so hand the request to the watchdog.
                if let Some(inner) = weak_inner.upgrade() {
                    inner.recovery_requested.store(true, Ordering::Release);
                }
            }
            if event.kind == "cursorDelta" {
                let now = Instant::now();
                let mut previous = last_delta.lock();
                let dt = now.duration_since(*previous).as_secs_f64() * 1000.0;
                *previous = now;
                let applied = accelerate(
                    *config.lock(),
                    event.dx.unwrap_or(0.0),
                    event.dy.unwrap_or(0.0),
                    dt,
                );
                event.dx = Some(applied.dx);
                event.dy = Some(applied.dy);
                event.dt = Some(dt);
            }
            events.emit(event);
        });
        let mut platform = self.inner.platform.lock();
        platform.start_capture(sink).map_err(napi_error)?;
        platform.set_capture_mode(true, self.owner());
        Ok(())
    }

    #[napi]
    pub fn stop_capture(&self) {
        let mut platform = self.inner.platform.lock();
        platform.set_capture_mode(false, true);
        platform.stop_capture();
    }

    #[napi]
    pub fn heartbeat(&self) {
        self.inner
            .last_heartbeat_ms
            .store(monotonic_ms(), Ordering::Release);
    }

    #[napi]
    pub fn set_linked(&self, linked: bool) -> Result<()> {
        if linked {
            self.inner
                .last_heartbeat_ms
                .store(monotonic_ms(), Ordering::Release);
            self.inner.linked.store(true, Ordering::Release);
            self.start_capture()?;
        } else {
            self.inner.recover("unlinked");
        }
        Ok(())
    }

    #[napi]
    pub fn assume_ownership(&self, point: Point) -> Result<()> {
        if !point.x.is_finite() || !point.y.is_finite() {
            return Err(napi_error("cursor point must be finite"));
        }
        let mut platform = self.inner.platform.lock();
        platform.release_cursor().map_err(napi_error)?;
        platform.warp_cursor(point).map_err(napi_error)?;
        platform.show_cursor().map_err(napi_error)?;
        self.inner.owner.store(true, Ordering::Release);
        platform.set_capture_mode(self.linked(), true);
        Ok(())
    }

    #[napi]
    pub fn relinquish_ownership(&self) -> Result<()> {
        let mut platform = self.inner.platform.lock();
        platform.hide_cursor().map_err(napi_error)?;
        if let Err(error) = platform.park_cursor() {
            let _ = platform.show_cursor();
            return Err(napi_error(error));
        }
        self.inner.owner.store(false, Ordering::Release);
        platform.set_capture_mode(self.linked(), false);
        Ok(())
    }

    #[napi]
    pub fn recover(&self, reason: Option<String>) {
        self.inner
            .recover(reason.as_deref().unwrap_or("requested by main process"));
    }

    #[napi]
    pub fn configure_acceleration(&self, config: AccelerationConfig) -> Result<()> {
        *self.inner.acceleration.lock() = config.validate().map_err(napi_error)?;
        Ok(())
    }

    #[napi]
    pub fn accelerate_delta(&self, dx: f64, dy: f64, dt_ms: f64) -> AppliedDelta {
        accelerate(*self.inner.acceleration.lock(), dx, dy, dt_ms)
    }

    #[napi]
    pub fn cursor_position(&self) -> Result<Point> {
        self.inner
            .platform
            .lock()
            .cursor_position()
            .map_err(napi_error)
    }

    #[napi]
    pub fn warp_cursor(&self, point: Point) -> Result<()> {
        self.inner
            .platform
            .lock()
            .warp_cursor(point)
            .map_err(napi_error)
    }

    #[napi]
    pub fn hide_cursor(&self) -> Result<()> {
        let mut platform = self.inner.platform.lock();
        platform.hide_cursor().map_err(napi_error)?;
        platform.set_capture_mode(true, false);
        self.inner.owner.store(false, Ordering::Release);
        Ok(())
    }

    #[napi]
    pub fn show_cursor(&self) -> Result<()> {
        let mut platform = self.inner.platform.lock();
        platform.show_cursor().map_err(napi_error)?;
        platform.set_capture_mode(true, true);
        self.inner.owner.store(true, Ordering::Release);
        Ok(())
    }

    #[napi]
    pub fn park_cursor(&self) -> Result<()> {
        self.inner.platform.lock().park_cursor().map_err(napi_error)
    }

    #[napi]
    pub fn release_cursor(&self) -> Result<()> {
        self.inner
            .platform
            .lock()
            .release_cursor()
            .map_err(napi_error)
    }

    #[napi]
    pub fn display_metrics(&self) -> Result<Vec<DisplayMetric>> {
        self.inner.platform.lock().displays().map_err(napi_error)
    }

    #[napi]
    pub fn enumerate_windows(&self) -> Result<Vec<WindowInfo>> {
        self.inner.platform.lock().windows().map_err(napi_error)
    }

    #[napi]
    pub fn set_window_bounds(&self, id: String, bounds: Rect) -> Result<()> {
        self.inner
            .platform
            .lock()
            .set_window_bounds(&id, bounds.validate().map_err(napi_error)?)
            .map_err(napi_error)
    }

    #[napi]
    pub fn focus_window(&self, id: String) -> Result<()> {
        self.inner
            .platform
            .lock()
            .focus_window(&id)
            .map_err(napi_error)
    }

    #[napi]
    pub fn close_window(&self, id: String) -> Result<()> {
        self.inner
            .platform
            .lock()
            .close_window(&id)
            .map_err(napi_error)
    }

    #[napi]
    pub fn guard_window(&self, id: String, restore_bounds: Rect) -> Result<()> {
        self.inner
            .guarded_windows
            .lock()
            .insert(id, restore_bounds.validate().map_err(napi_error)?);
        Ok(())
    }

    #[napi]
    pub fn release_window_guard(&self, id: String) {
        self.inner.guarded_windows.lock().remove(&id);
    }

    #[napi]
    pub fn synthesize_button(&self, button: String, down: bool) -> Result<()> {
        self.inner
            .platform
            .lock()
            .synthesize_button(&button, down)
            .map_err(napi_error)
    }

    #[napi]
    pub fn synthesize_key(&self, code: u32, down: bool, modifiers: u32) -> Result<()> {
        self.inner
            .platform
            .lock()
            .synthesize_key(code, down, modifiers)
            .map_err(napi_error)
    }

    #[napi]
    pub fn assume_input_state(&self, buttons: u32, modifiers: u32) -> Result<()> {
        let mut platform = self.inner.platform.lock();
        for (bit, button) in [
            (1, "left"),
            (2, "right"),
            (4, "middle"),
            (8, "x1"),
            (16, "x2"),
        ] {
            if buttons & bit != 0 {
                platform
                    .synthesize_button(button, true)
                    .map_err(napi_error)?;
            }
        }
        for (bit, code) in [(1, 0xE1), (2, 0xE0), (4, 0xE2), (8, 0xE3)] {
            if modifiers & bit != 0 {
                platform
                    .synthesize_key(code, true, modifiers)
                    .map_err(napi_error)?;
            }
        }
        Ok(())
    }

    #[napi]
    pub fn release_input_state(&self) {
        let mut platform = self.inner.platform.lock();
        for button in ["left", "right", "middle", "x1", "x2"] {
            let _ = platform.synthesize_button(button, false);
        }
        for code in SYNTHETIC_MODIFIERS {
            let _ = platform.synthesize_key(code, false, 0);
        }
    }

    #[napi]
    pub fn foreground_is_elevated(&self) -> Result<bool> {
        self.inner
            .platform
            .lock()
            .foreground_is_elevated()
            .map_err(napi_error)
    }

    #[napi]
    pub fn terminate_move_loop(&self, id: String) -> Result<()> {
        self.inner
            .platform
            .lock()
            .terminate_move_loop(&id)
            .map_err(napi_error)
    }
}

impl Drop for NativeSubstrate {
    fn drop(&mut self) {
        self.inner.stopped.store(true, Ordering::Release);
        self.inner.recover("native substrate released");
    }
}

#[napi]
pub fn platform_name() -> String {
    HostPlatform::new().name().into()
}
