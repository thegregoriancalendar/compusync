mod buffer;
mod channel;
mod clock;
#[cfg(any(target_os = "windows", target_os = "macos"))]
mod device;
mod latency;
#[cfg(target_os = "macos")]
mod mac_tap;
mod packet;
#[cfg(any(target_os = "windows", test))]
mod pcm;
mod transport;
mod volume;
#[cfg(target_os = "windows")]
mod windows_capture;

use crate::napi_error as fail;
use napi::{bindgen_prelude::AsyncTask, Env, Result, Task};
use napi_derive::napi;
use parking_lot::Mutex;
use std::{
    net::{IpAddr, UdpSocket},
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicU8, Ordering},
        Arc,
    },
    thread::JoinHandle,
    time::Instant,
};

#[napi(object)]
pub struct AudioOutput {
    pub id: String,
    pub label: String,
}
#[napi(object)]
pub struct AudioRouting {
    pub ready: bool,
    pub reason: Option<String>,
    pub buses: Vec<AudioOutput>,
    pub output_id: Option<String>,
}
#[napi(object)]
pub struct AudioVolume {
    pub level: u32,
    pub muted: bool,
    pub label: String,
}
#[napi(object)]
pub struct AudioSnapshot {
    pub running: bool,
    pub packets: f64,
    pub captured_frames: f64,
    pub underruns: f64,
    pub last_packet_age_ms: f64,
    pub clock_ready: bool,
    pub clock_rtt_ms: f64,
    pub clock_uncertainty_ms: f64,
    pub playout_delay_ms: f64,
    pub played_frames: f64,
    pub late_packets: f64,
    pub resyncs: f64,
    pub phase_error_ms: f64,
    pub output_horizon_ms: f64,
    pub warning: Option<String>,
    pub error: Option<String>,
}
pub struct Stats {
    pub stopped: AtomicBool,
    pub packets: AtomicU64,
    pub captured: AtomicU64,
    pub underruns: AtomicU64,
    pub last_packet_ms: AtomicU64,
    pub clock_ready: AtomicBool,
    pub clock_offset_ns: AtomicI64,
    pub clock_rtt_ns: AtomicI64,
    pub delay_ns: AtomicI64,
    pub played: AtomicU64,
    pub late_packets: AtomicU64,
    pub resyncs: AtomicU64,
    pub phase_error_ns: AtomicI64,
    pub resync_requested: AtomicBool,
    pub device_clock_invalid: AtomicBool,
    pub output_lead_ns: AtomicI64,
    pub output_horizon_ns: AtomicI64,
    pub output_horizon_peak_ns: AtomicI64,
    pub peer_output_ns: AtomicI64,
    pub output_clock_ready: AtomicBool,
    pub warning: Mutex<Option<String>>,
    pub error: Mutex<Option<String>>,
    pub started: Instant,
}
impl Stats {
    fn new() -> Self {
        // Initialize host clock conversion before any real-time callback.
        let _ = clock::now_ns();
        Self {
            stopped: AtomicBool::new(false),
            packets: AtomicU64::new(0),
            captured: AtomicU64::new(0),
            underruns: AtomicU64::new(0),
            last_packet_ms: AtomicU64::new(0),
            clock_ready: AtomicBool::new(false),
            clock_offset_ns: AtomicI64::new(0),
            clock_rtt_ns: AtomicI64::new(0),
            delay_ns: AtomicI64::new(0),
            played: AtomicU64::new(0),
            late_packets: AtomicU64::new(0),
            resyncs: AtomicU64::new(0),
            phase_error_ns: AtomicI64::new(0),
            resync_requested: AtomicBool::new(false),
            device_clock_invalid: AtomicBool::new(false),
            output_lead_ns: AtomicI64::new(0),
            output_horizon_ns: AtomicI64::new(0),
            output_horizon_peak_ns: AtomicI64::new(0),
            peer_output_ns: AtomicI64::new(0),
            output_clock_ready: AtomicBool::new(false),
            warning: Mutex::new(None),
            error: Mutex::new(None),
            started: Instant::now(),
        }
    }
    pub fn fail(&self, message: impl ToString) {
        *self.error.lock() = Some(message.to_string());
        self.clock_ready.store(false, Ordering::Release);
        self.stopped.store(true, Ordering::Release);
    }
    pub fn packet(&self) {
        self.packets.fetch_add(1, Ordering::Relaxed);
        self.last_packet_ms
            .store(self.started.elapsed().as_millis() as u64, Ordering::Relaxed);
    }
}
struct Running {
    stats: Arc<Stats>,
    worker: Option<JoinHandle<()>>,
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    capture: Option<Arc<Mutex<Option<device::Capture>>>>,
}
impl Drop for Running {
    fn drop(&mut self) {
        self.stats.stopped.store(true, Ordering::Release);
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            if let Some(capture) = self.capture.take() {
                capture.lock().take();
            }
        } // Restore normal source playback before waiting.
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
#[derive(Default)]
struct State {
    generation: AtomicU64,
    running: Mutex<Option<Running>>,
    pending: Mutex<Option<Arc<Stats>>>,
    playback_channel: Arc<AtomicU8>,
}
#[napi]
pub struct NativeAudio {
    state: Arc<State>,
}
impl Default for NativeAudio {
    fn default() -> Self {
        Self::new()
    }
}
#[napi]
impl NativeAudio {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            state: Arc::new(State::default()),
        }
    }
    #[napi]
    pub fn protocol_version(&self) -> u32 {
        packet::VERSION
    }
    #[napi]
    pub fn set_playback_channel(&self, channel: String) -> Result<()> {
        channel::set(&self.state.playback_channel, &channel).map_err(fail)
    }
    #[napi]
    pub fn routing_status(&self, source_id: String, output_id: String) -> Result<AudioRouting> {
        #[cfg(target_os = "windows")]
        {
            let mut system = compusync_windows_audio::System::new().map_err(fail)?;
            let buses = system
                .endpoints()
                .map_err(fail)?
                .into_iter()
                .filter(|d| d.bus)
                .map(|d| AudioOutput {
                    id: format!("wasapi:{}", d.id),
                    label: d.label,
                })
                .collect();
            let result = system
                .enable_policy()
                .and_then(|_| windows_capture::plan(&source_id, &output_id));
            let output_id = result
                .as_ref()
                .ok()
                .map(|p| format!("wasapi:{}", p.snapshot.output));
            Ok(AudioRouting {
                ready: result.is_ok(),
                reason: result.err(),
                buses,
                output_id,
            })
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (source_id, output_id);
            Ok(AudioRouting {
                ready: cfg!(target_os = "macos"),
                reason: None,
                buses: vec![],
                output_id: None,
            })
        }
    }
    #[napi]
    pub fn outputs(&self) -> Result<Vec<AudioOutput>> {
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            device::outputs().map_err(napi::Error::from_reason)
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            Ok(vec![])
        }
    }
    #[napi]
    pub fn volume(&self, output_id: String) -> Result<AudioVolume> {
        volume::get(&output_id).map_err(napi::Error::from_reason)
    }
    #[napi]
    pub fn set_volume(&self, output_id: String, level: u32) -> Result<AudioVolume> {
        if level > 100 {
            return Err(napi::Error::from_reason(
                "Volume must be between 0 and 100.",
            ));
        }
        volume::set(&output_id, level).map_err(napi::Error::from_reason)
    }
    #[napi]
    pub fn start_receiver(
        &self,
        key: String,
        peer_ip: String,
        output_id: String,
    ) -> AsyncTask<StartAudio> {
        self.begin(StartKind::Receiver { peer_ip, output_id }, key)
    }
    #[napi]
    pub fn start_sender(
        &self,
        key: String,
        peer_ip: String,
        port: u32,
        output_id: String,
        source_id: String,
        guard_path: String,
    ) -> AsyncTask<StartAudio> {
        self.begin(
            StartKind::Sender {
                peer_ip,
                port,
                output_id,
                source_id,
                guard_path,
            },
            key,
        )
    }
    #[napi]
    pub fn stop(&self) {
        self.state.generation.fetch_add(1, Ordering::AcqRel);
        if let Some(stats) = self.state.pending.lock().take() {
            stats.stopped.store(true, Ordering::Release);
        }
        self.state.running.lock().take();
    }
    #[napi]
    pub fn status(&self) -> AudioSnapshot {
        let running = self.state.running.lock();
        let stats = running.as_ref().map(|r| &r.stats);
        let count = |f: fn(&Stats) -> &AtomicU64| {
            stats.map_or(0.0, |s| f(s).load(Ordering::Relaxed) as f64)
        };
        let ms = |f: fn(&Stats) -> &AtomicI64| {
            stats.map_or(0.0, |s| {
                f(s).load(Ordering::Relaxed) as f64 / clock::MS as f64
            })
        };
        AudioSnapshot {
            running: stats.is_some_and(|s| !s.stopped.load(Ordering::Acquire)),
            packets: count(|s| &s.packets),
            captured_frames: count(|s| &s.captured),
            underruns: count(|s| &s.underruns),
            last_packet_age_ms: stats.map_or(0.0, |s| {
                s.started
                    .elapsed()
                    .as_millis()
                    .saturating_sub(s.last_packet_ms.load(Ordering::Relaxed) as u128)
                    as f64
            }),
            clock_ready: stats.is_some_and(|s| s.clock_ready.load(Ordering::Acquire)),
            clock_rtt_ms: ms(|s| &s.clock_rtt_ns),
            clock_uncertainty_ms: ms(|s| &s.clock_rtt_ns) * 0.5,
            playout_delay_ms: ms(|s| &s.delay_ns),
            played_frames: count(|s| &s.played),
            late_packets: count(|s| &s.late_packets),
            resyncs: count(|s| &s.resyncs),
            phase_error_ms: ms(|s| &s.phase_error_ns),
            output_horizon_ms: ms(|s| &s.output_horizon_ns),
            warning: stats.and_then(|s| s.warning.lock().clone()),
            error: stats.and_then(|s| s.error.lock().clone()),
        }
    }
}
impl NativeAudio {
    fn begin(&self, kind: StartKind, key: String) -> AsyncTask<StartAudio> {
        self.stop();
        let generation = self.state.generation.load(Ordering::Acquire);
        AsyncTask::new(StartAudio {
            state: self.state.clone(),
            generation,
            kind,
            key,
        })
    }
}
impl Drop for NativeAudio {
    fn drop(&mut self) {
        self.stop();
    }
}
enum StartKind {
    Receiver {
        peer_ip: String,
        output_id: String,
    },
    Sender {
        peer_ip: String,
        port: u32,
        output_id: String,
        source_id: String,
        guard_path: String,
    },
}
pub struct StartAudio {
    state: Arc<State>,
    generation: u64,
    kind: StartKind,
    key: String,
}
impl Task for StartAudio {
    type Output = u32;
    type JsValue = u32;
    fn compute(&mut self) -> Result<u32> {
        let cancelled = || self.generation != self.state.generation.load(Ordering::Acquire);
        if cancelled() {
            return Err(fail("Audio start cancelled."));
        }
        let wire = packet::Wire::new(&self.key, matches!(self.kind, StartKind::Sender { .. }))
            .map_err(fail)?;
        let address: IpAddr = match &self.kind {
            StartKind::Receiver { peer_ip, .. } | StartKind::Sender { peer_ip, .. } => {
                peer_ip.parse()
            }
        }
        .map_err(|_| fail("The paired laptop has no usable IPv4 audio address."))?;
        if !address.is_ipv4() || address.is_unspecified() || address.is_multicast() {
            return Err(fail("Invalid audio peer address."));
        }
        let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| fail(e.to_string()))?;
        socket
            .set_nonblocking(true)
            .map_err(|e| fail(e.to_string()))?;
        let local_port = socket.local_addr().map_err(|e| fail(e.to_string()))?.port() as u32;
        let stats = Arc::new(Stats::new());
        {
            let mut pending = self.state.pending.lock();
            if cancelled() {
                return Err(fail("Audio start cancelled."));
            }
            *pending = Some(stats.clone());
        }
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        let running = match &self.kind {
            StartKind::Receiver { output_id, .. } => {
                let (producer, consumer) = rtrb::RingBuffer::new(128);
                let output = device::output_device(output_id).map_err(fail)?;
                let stream = device::playback(
                    &output,
                    consumer,
                    stats.clone(),
                    self.state.playback_channel.clone(),
                )
                .map_err(fail)?;
                let worker_stats = stats.clone();
                let worker = std::thread::Builder::new()
                    .name("compusync-audio-receive".into())
                    .spawn(move || {
                        let _stream = stream;
                        transport::receive(socket, address, wire, producer, worker_stats)
                    })
                    .map_err(|e| fail(e.to_string()))?;
                Running {
                    stats,
                    worker: Some(worker),
                    #[cfg(any(target_os = "macos", target_os = "windows"))]
                    capture: None,
                }
            }
            StartKind::Sender {
                port,
                output_id,
                source_id,
                guard_path,
                ..
            } => {
                if *port == 0 || *port > u16::MAX as u32 {
                    return Err(fail("Invalid audio receiver port."));
                }
                {
                    #[cfg(target_os = "windows")]
                    let plan = windows_capture::plan(source_id, output_id).map_err(fail)?;
                    #[cfg(target_os = "macos")]
                    let _ = (output_id, source_id, guard_path);
                    let mut wire = wire;
                    socket
                        .connect((address, *port as u16))
                        .map_err(|e| fail(e.to_string()))?;
                    let filter = transport::synchronize(&socket, &mut wire, &stats, cancelled)
                        .map_err(fail)?;
                    #[cfg(target_os = "macos")]
                    let output = device::output_device("").map_err(fail)?;
                    #[cfg(target_os = "windows")]
                    let output = device::output_device(&format!("wasapi:{}", plan.snapshot.output))
                        .map_err(fail)?;
                    let (local, consumer) = rtrb::RingBuffer::new(128);
                    let stream = device::playback(
                        &output,
                        consumer,
                        stats.clone(),
                        self.state.playback_channel.clone(),
                    )
                    .map_err(fail)?;
                    let (producer, input) = rtrb::RingBuffer::new(24_000);
                    // The tap aggregate follows the selected device's nominal rate.
                    #[cfg(target_os = "macos")]
                    let rate = {
                        use cpal::traits::DeviceTrait;
                        output
                            .default_output_config()
                            .map_err(|e| fail(e.to_string()))?
                            .sample_rate()
                    };
                    #[cfg(target_os = "windows")]
                    let rate = plan.rate;
                    let worker_stats = stats.clone();
                    let capture_slot = Arc::new(Mutex::new(None));
                    let worker_capture = capture_slot.clone();
                    let worker = std::thread::Builder::new()
                        .name("compusync-audio-send".into())
                        .spawn(move || {
                            let _stream = stream;
                            transport::send(socket, wire, filter, input, rate, local, worker_stats);
                            // Native failures restore original source audio even
                            // if Electron's event loop cannot process status.
                            worker_capture.lock().take();
                        })
                        .map_err(|e| fail(e.to_string()))?;
                    let running = Running {
                        stats: stats.clone(),
                        worker: Some(worker),
                        capture: Some(capture_slot.clone()),
                    };
                    let deadline = Instant::now() + std::time::Duration::from_secs(1);
                    while !stats.output_clock_ready.load(Ordering::Acquire) {
                        if cancelled()
                            || stats.stopped.load(Ordering::Acquire)
                            || Instant::now() > deadline
                        {
                            return Err(fail("The local output did not provide a valid playback clock. Choose built-in or wired speakers and retry."));
                        }
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                    if cancelled() || stats.stopped.load(Ordering::Acquire) {
                        return Err(fail("Audio start cancelled."));
                    }
                    #[cfg(target_os = "macos")]
                    let (capture, capture_rate) =
                        device::capture(&output, producer, stats.clone()).map_err(fail)?;
                    #[cfg(target_os = "windows")]
                    let (capture, capture_rate) = (
                        windows_capture::Capture::start(
                            plan,
                            guard_path.clone(),
                            producer,
                            stats.clone(),
                        )
                        .map_err(fail)?,
                        rate,
                    );
                    if capture_rate != rate {
                        return Err(fail("The Mac tap sample rate changed. Choose built-in speakers and restart sharing."));
                    }
                    {
                        let mut slot = capture_slot.lock();
                        if cancelled() || stats.stopped.load(Ordering::Acquire) {
                            return Err(fail("Audio start cancelled."));
                        }
                        *slot = Some(capture);
                    }
                    running
                }
            }
        };
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        let running: Running = {
            return Err(fail("Native audio requires Windows or macOS."));
        };
        let mut active = self.state.running.lock();
        if cancelled() || running.stats.stopped.load(Ordering::Acquire) {
            let message = running
                .stats
                .error
                .lock()
                .clone()
                .unwrap_or_else(|| "Audio start cancelled.".into());
            drop(running);
            return Err(fail(message));
        }
        *active = Some(running);
        Ok(local_port)
    }
    fn resolve(&mut self, _env: Env, port: u32) -> Result<u32> {
        Ok(port)
    }
}
