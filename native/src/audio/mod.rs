mod buffer;
#[cfg(any(target_os = "windows", target_os = "macos"))]
mod device;
mod packet;
mod transport;

use crate::napi_error as fail;
use napi::{bindgen_prelude::AsyncTask, Env, Result, Task};
use napi_derive::napi;
use parking_lot::Mutex;
use std::{
    net::{IpAddr, UdpSocket},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
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
pub struct AudioSnapshot {
    pub running: bool,
    pub packets: f64,
    pub captured_frames: f64,
    pub underruns: f64,
    pub last_packet_age_ms: f64,
    pub error: Option<String>,
}

pub struct Stats {
    pub stopped: AtomicBool,
    pub packets: AtomicU64,
    pub captured: AtomicU64,
    pub underruns: AtomicU64,
    pub last_packet_ms: AtomicU64,
    pub error: Mutex<Option<String>>,
    pub started: Instant,
}

impl Stats {
    fn new() -> Self {
        Self {
            stopped: AtomicBool::new(false),
            packets: AtomicU64::new(0),
            captured: AtomicU64::new(0),
            underruns: AtomicU64::new(0),
            last_packet_ms: AtomicU64::new(0),
            error: Mutex::new(None),
            started: Instant::now(),
        }
    }
    pub fn fail(&self, message: impl ToString) {
        *self.error.lock() = Some(message.to_string());
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
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    _stream: cpal::Stream,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.stats.stopped.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[derive(Default)]
struct State {
    generation: AtomicU64,
    running: Mutex<Option<Running>>,
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
    pub fn start_receiver(
        &self,
        key: String,
        peer_ip: String,
        output_id: String,
    ) -> AsyncTask<StartAudio> {
        self.begin(StartKind::Receiver { peer_ip, output_id }, key)
    }

    #[napi]
    pub fn start_sender(&self, key: String, peer_ip: String, port: u32) -> AsyncTask<StartAudio> {
        self.begin(StartKind::Sender { peer_ip, port }, key)
    }

    #[napi]
    pub fn stop(&self) {
        self.state.generation.fetch_add(1, Ordering::AcqRel);
        self.state.running.lock().take();
    }

    #[napi]
    pub fn status(&self) -> AudioSnapshot {
        let running = self.state.running.lock();
        let stats = running.as_ref().map(|r| &r.stats);
        AudioSnapshot {
            running: stats.is_some_and(|s| !s.stopped.load(Ordering::Acquire)),
            packets: stats.map_or(0.0, |s| s.packets.load(Ordering::Relaxed) as f64),
            captured_frames: stats.map_or(0.0, |s| s.captured.load(Ordering::Relaxed) as f64),
            underruns: stats.map_or(0.0, |s| s.underruns.load(Ordering::Relaxed) as f64),
            last_packet_age_ms: stats.map_or(0.0, |s| {
                s.started
                    .elapsed()
                    .as_millis()
                    .saturating_sub(s.last_packet_ms.load(Ordering::Relaxed) as u128)
                    as f64
            }),
            error: stats.and_then(|s| s.error.lock().clone()),
        }
    }
}

impl NativeAudio {
    fn begin(&self, kind: StartKind, key: String) -> AsyncTask<StartAudio> {
        let generation = self.state.generation.fetch_add(1, Ordering::AcqRel) + 1;
        self.state.running.lock().take();
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
    Receiver { peer_ip: String, output_id: String },
    Sender { peer_ip: String, port: u32 },
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
        if self.generation != self.state.generation.load(Ordering::Acquire) {
            return Err(fail("Audio start cancelled."));
        }
        let cipher = packet::cipher(&self.key).map_err(fail)?;
        // Never accept hostnames or IPv6 mapped addresses here. The caller uses
        // the authenticated control socket's IPv4 peer, not a supplied endpoint.
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
        let port = socket.local_addr().map_err(|e| fail(e.to_string()))?.port() as u32;
        let stats = Arc::new(Stats::new());
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        let running = match &self.kind {
            StartKind::Receiver { output_id, .. } => {
                let (producer, consumer) = rtrb::RingBuffer::new(9_600);
                let stream = device::playback(output_id, consumer, stats.clone()).map_err(fail)?;
                let worker_stats = stats.clone();
                let worker = std::thread::Builder::new()
                    .name("compusync-audio-receive".into())
                    .spawn(move || {
                        transport::receive(socket, address, cipher, producer, worker_stats)
                    })
                    .map_err(|e| fail(e.to_string()))?;
                Running {
                    stats,
                    worker: Some(worker),
                    _stream: stream,
                }
            }
            StartKind::Sender { port, .. } => {
                if *port == 0 || *port > u16::MAX as u32 {
                    return Err(fail("Invalid audio receiver port."));
                }
                #[cfg(not(target_os = "macos"))]
                {
                    return Err(fail(
                        "Start audio sharing from the Mac. Windows capture is not enabled yet.",
                    ));
                }
                #[cfg(target_os = "macos")]
                {
                    socket
                        .connect((address, *port as u16))
                        .map_err(|e| fail(e.to_string()))?;
                    let (producer, consumer) = rtrb::RingBuffer::new(24_000);
                    let (stream, rate) = device::capture(producer, stats.clone()).map_err(fail)?;
                    let worker_stats = stats.clone();
                    let worker = std::thread::Builder::new()
                        .name("compusync-audio-send".into())
                        .spawn(move || {
                            transport::send(socket, cipher, consumer, rate, worker_stats)
                        })
                        .map_err(|e| fail(e.to_string()))?;
                    Running {
                        stats,
                        worker: Some(worker),
                        _stream: stream,
                    }
                }
            }
        };
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        let running: Running = {
            return Err(fail("Native audio requires Windows or macOS."));
        };
        let mut active = self.state.running.lock();
        if self.generation != self.state.generation.load(Ordering::Acquire) {
            drop(running);
            return Err(fail("Audio start cancelled."));
        }
        *active = Some(running);
        Ok(port)
    }

    fn resolve(&mut self, _env: Env, port: u32) -> Result<u32> {
        Ok(port)
    }
}
