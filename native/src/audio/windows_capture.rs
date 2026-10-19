use super::{buffer::CapturedFrame, clock, pcm::Format, Stats};
use compusync_windows_audio::{
    windows::Win32::{
        Media::Audio::*,
        System::Com::{CoTaskMemFree, CLSCTX_ALL},
    },
    Snapshot, System,
};
use cpal::traits::{DeviceTrait, StreamTrait};
use std::{
    io::{BufRead, Write},
    os::windows::process::CommandExt,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub struct Plan {
    pub snapshot: Snapshot,
    pub rate: u32,
}
fn native_id(id: &str) -> Result<&str, String> {
    if id.is_empty() {
        Ok("")
    } else {
        id.strip_prefix("wasapi:")
            .ok_or("Choose a Windows audio device.".into())
    }
}
pub fn plan(source: &str, output: &str) -> Result<Plan, String> {
    let system = System::new()?;
    let snapshot = system.plan(native_id(source)?, native_id(output)?)?;
    let device = system.device(&snapshot.bus)?;
    let client: IAudioClient =
        unsafe { device.Activate(CLSCTX_ALL, None) }.map_err(|e| e.to_string())?;
    let (_, _, rate) = mix_format(&client)?;
    Ok(Plan { snapshot, rate })
}
fn mix_format(client: &IAudioClient) -> Result<(Vec<u8>, Format, u32), String> {
    let ptr = unsafe { client.GetMixFormat() }.map_err(|e| e.to_string())?;
    let base = unsafe { ptr.read_unaligned() };
    let bytes = unsafe {
        std::slice::from_raw_parts(
            ptr.cast::<u8>(),
            std::mem::size_of::<WAVEFORMATEX>() + base.cbSize as usize,
        )
    }
    .to_vec();
    unsafe { CoTaskMemFree(Some(ptr.cast())) };
    let tag = if base.wFormatTag == 0xfffe
        && base.cbSize as usize
            >= std::mem::size_of::<WAVEFORMATEXTENSIBLE>() - std::mem::size_of::<WAVEFORMATEX>()
    {
        let ext = unsafe {
            bytes
                .as_ptr()
                .cast::<WAVEFORMATEXTENSIBLE>()
                .read_unaligned()
        };
        let sub = ext.SubFormat;
        // PCM / IEEE_FLOAT canonical subtype GUIDs.
        if sub
            == compusync_windows_audio::windows::core::GUID::from_u128(
                0x00000001_0000_0010_8000_00aa00389b71,
            )
        {
            1
        } else if sub
            == compusync_windows_audio::windows::core::GUID::from_u128(
                0x00000003_0000_0010_8000_00aa00389b71,
            )
        {
            3
        } else {
            0
        }
    } else {
        base.wFormatTag
    };
    let rate = base.nSamplesPerSec;
    let format = Format {
        channels: base.nChannels as usize,
        bytes: base.wBitsPerSample as usize / 8,
        float: tag == 3,
    };
    if ![1, 3].contains(&tag)
        || !format.valid()
        || format.channels > 2
        || base.wBitsPerSample % 8 != 0
        || base.nBlockAlign as usize != format.channels * format.bytes
        || !(8_000..=192_000).contains(&rate)
    {
        return Err(
            "Unsupported VB-CABLE mix format. Select 48 kHz stereo in Windows Sound settings."
                .into(),
        );
    }
    Ok((bytes, format, base.nSamplesPerSec))
}

struct RouteGuard {
    child: Child,
    input: Option<ChildStdin>,
    replies: mpsc::Receiver<String>,
    stats: Arc<Stats>,
}
impl RouteGuard {
    fn start(
        path: &str,
        snapshot: &Snapshot,
        stop: &AtomicBool,
        stats: &Arc<Stats>,
    ) -> Result<Self, String> {
        let mut child = Command::new(path).args(["--audio-route", &snapshot.bus, &snapshot.output, &std::process::id().to_string()])
            .creation_flags(0x08000000).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .spawn().map_err(|e| format!("Could not start the Windows audio recovery helper: {e}. Rebuild the native addon."))?;
        let input = child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or("Windows audio helper has no response pipe.")?;
        let (tx, replies) = mpsc::sync_channel(16);
        thread::spawn(move || {
            for line in std::io::BufReader::new(stdout)
                .lines()
                .map_while(Result::ok)
            {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let mut guard = Self {
            child,
            input,
            replies,
            stats: stats.clone(),
        };
        guard.expect("READY")?;
        if stop.load(Ordering::Acquire) || stats.stopped.load(Ordering::Acquire) {
            return Err("Audio start cancelled.".into());
        }
        guard.command("START")?;
        guard.expect("ROUTED")?;
        Ok(guard)
    }
    fn expect(&self, expected: &str) -> Result<(), String> {
        let reply = self
            .replies
            .recv_timeout(Duration::from_secs(4))
            .map_err(|_| {
                "Windows audio recovery helper did not respond. Routing was cancelled.".to_owned()
            })?;
        if reply == expected {
            Ok(())
        } else {
            Err(reply.strip_prefix("ERROR ").unwrap_or(&reply).to_owned())
        }
    }
    fn command(&mut self, text: &str) -> Result<(), String> {
        writeln!(
            self.input
                .as_mut()
                .ok_or("Windows audio helper disconnected.")?,
            "{text}"
        )
        .map_err(|e| e.to_string())
    }
    fn heartbeat(&mut self) -> Result<(), String> {
        if let Ok(message) = self.replies.try_recv() {
            return Err(message
                .strip_prefix("ERROR ")
                .unwrap_or("Windows audio routing stopped. Check output devices and retry.")
                .into());
        }
        if self.child.try_wait().map_err(|e| e.to_string())?.is_some() {
            return Err(
                "Windows audio recovery helper stopped. Refresh devices to retry output recovery."
                    .into(),
            );
        }
        self.command("HEARTBEAT")
    }
}
impl Drop for RouteGuard {
    fn drop(&mut self) {
        // Silence delayed playback before restoring immediate application audio.
        self.stats.stopped.store(true, Ordering::Release);
        let _ = self.command("STOP");
        self.input.take();
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        // Do not kill the process responsible for restoring Windows output.
        // Its stdin EOF/watchdog remains independent of this thread's lifetime.
    }
}

pub struct Capture {
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}
impl Capture {
    pub fn start(
        plan: Plan,
        guard_path: String,
        mut producer: rtrb::Producer<CapturedFrame>,
        stats: Arc<Stats>,
    ) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let (tx, rx) = mpsc::sync_channel(1);
        let worker_stats = stats.clone();
        let worker = thread::Builder::new().name("compusync-windows-capture".into()).spawn(move || {
            let result = (|| -> Result<(), String> {
                let system = System::new()?;
                let device = system.device(&plan.snapshot.bus)?;
                let client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None) }.map_err(|e| e.to_string())?;
                let (bytes, format, rate) = mix_format(&client)?;
                if rate != plan.rate { return Err("VB-CABLE sample rate changed during setup. Retry sharing.".into()); }
                unsafe { client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 1_000_000, 0, bytes.as_ptr().cast(), None) }.map_err(|e| e.to_string())?;
                let capture: IAudioCaptureClient = unsafe { client.GetService() }.map_err(|e| e.to_string())?;
                // Keep loopback clocking even when all apps are silent. This
                // stream renders only zeroes to the virtual bus, never speakers.
                let bus = super::device::output_device(&format!("wasapi:{}", plan.snapshot.bus))?;
                let _silence = silence(&bus, worker_stats.clone())?;
                unsafe { client.Start() }.map_err(|e| e.to_string())?;
                struct StopClient(IAudioClient);
                impl Drop for StopClient { fn drop(&mut self) { let _ = unsafe { self.0.Stop() }; } }
                let _client = StopClient(client);
                if worker_stop.load(Ordering::Acquire) || worker_stats.stopped.load(Ordering::Acquire) { return Err("Audio start cancelled.".into()); }
                let mut guard = RouteGuard::start(&guard_path, &plan.snapshot, &worker_stop, &worker_stats)?;
                tx.send(Ok(())).map_err(|_| "Audio start cancelled.")?;
                let mut next_heartbeat = Instant::now();
                let mut last_packet = Instant::now();
                let mut invalid_timestamps = 0;
                while !worker_stop.load(Ordering::Acquire) && !worker_stats.stopped.load(Ordering::Acquire) {
                    if Instant::now() >= next_heartbeat { guard.heartbeat()?; next_heartbeat = Instant::now() + Duration::from_millis(250); }
                    if last_packet.elapsed() > Duration::from_secs(2) { return Err("Windows capture stalled. Outputs are being restored.".into()); }
                    for _ in 0..64 {
                        if unsafe { capture.GetNextPacketSize() }.map_err(|e| e.to_string())? == 0 { break; }
                        let (mut data, mut frames, mut flags, mut qpc) = (std::ptr::null_mut(), 0, 0, 0);
                        unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, Some(&mut qpc)) }.map_err(|e| e.to_string())?;
                        last_packet = Instant::now();
                        // Always release a WASAPI buffer, including validation failures.
                        let result = (|| -> Result<(), String> {
                            if frames > rate { return Err("Invalid Windows capture buffer length.".into()); }
                            if flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 != 0 || qpc == 0 {
                                invalid_timestamps += 1;
                                if invalid_timestamps >= 8 { return Err("Windows capture timestamps are unavailable. Outputs are being restored.".into()); }
                                worker_stats.resync_requested.store(true, Ordering::Release); return Ok(());
                            }
                            invalid_timestamps = 0;
                            let first = i64::try_from(qpc as u128 * 100).map_err(|_| "Invalid Windows capture timestamp.")?;
                            if (clock::now_ns() - first).abs() > 500_000_000 { return Err("Windows capture timestamp is outside the host clock timeline.".into()); }
                            if flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0 { worker_stats.resync_requested.store(true, Ordering::Release); }
                            let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
                            if !silent && data.is_null() { return Err("Windows supplied an empty audio buffer.".into()); }
                            let bytes = if silent { &[][..] } else { unsafe { std::slice::from_raw_parts(data, frames as usize * format.channels * format.bytes) } };
                            for index in 0..frames as usize {
                                let at = index * format.channels * format.bytes;
                                let samples = if silent { [0.0; 2] } else { format.stereo(&bytes[at..at + format.channels * format.bytes]) };
                                if producer.push(CapturedFrame { samples, time_ns: first + index as i64 * 1_000_000_000 / rate as i64 }).is_err() {
                                    worker_stats.resync_requested.store(true, Ordering::Release); break;
                                }
                                worker_stats.captured.fetch_add(1, Ordering::Relaxed);
                            }
                            Ok(())
                        })();
                        unsafe { capture.ReleaseBuffer(frames) }.map_err(|e| e.to_string())?; result?;
                    }
                    thread::sleep(Duration::from_millis(1));
                }
                Ok(())
            })();
            if let Err(error) = result { let _ = tx.try_send(Err(error.clone())); worker_stats.fail(error); }
        }).map_err(|e| e.to_string())?;
        let capture = Self {
            stop,
            worker: Some(worker),
        };
        rx.recv_timeout(Duration::from_secs(12)).map_err(|_| {
            "Windows capture setup timed out. Routing is being restored.".to_owned()
        })??;
        Ok(capture)
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn silence(device: &cpal::Device, stats: Arc<Stats>) -> Result<cpal::Stream, String> {
    let config = device.default_output_config().map_err(|e| e.to_string())?;
    fn build<T: cpal::SizedSample + cpal::FromSample<f32>>(
        device: &cpal::Device,
        config: cpal::StreamConfig,
        stats: Arc<Stats>,
    ) -> Result<cpal::Stream, String> {
        let stream = device
            .build_output_stream(
                config,
                |data: &mut [T], _| data.fill(T::from_sample(0.0)),
                move |e| stats.fail(format!("Windows capture bus stopped: {e}")),
                Some(Duration::from_secs(3)),
            )
            .map_err(|e| e.to_string())?;
        stream.play().map_err(|e| e.to_string())?;
        Ok(stream)
    }
    match config.sample_format() {
        cpal::SampleFormat::F32 => build::<f32>(device, config.config(), stats),
        cpal::SampleFormat::I16 => build::<i16>(device, config.config(), stats),
        cpal::SampleFormat::I32 => build::<i32>(device, config.config(), stats),
        _ => Err("Select a 16-bit or 32-bit Windows capture bus format.".into()),
    }
}
