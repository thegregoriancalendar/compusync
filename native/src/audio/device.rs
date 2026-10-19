use super::{
    buffer::{PlaybackCursor, TimedBuffer},
    clock::{self, MS},
    packet::AudioPacket,
    AudioOutput, Stats,
};
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    FromSample, SampleFormat, SizedSample,
};
use rtrb::Consumer;
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc,
};

pub fn outputs() -> Result<Vec<AudioOutput>, String> {
    cpal::default_host()
        .output_devices()
        .map_err(|e| e.to_string())?
        .take(100)
        .map(|device| {
            Ok(AudioOutput {
                id: device.id().map_err(|e| e.to_string())?.to_string(),
                label: device
                    .description()
                    .map_err(|e| e.to_string())?
                    .name()
                    .to_string(),
            })
        })
        .collect()
}
pub fn output_device(id: &str) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    (if id.is_empty() {
        host.default_output_device()
    } else {
        host.device_by_id(
            &id.parse()
                .map_err(|e| format!("Invalid audio device: {e}"))?,
        )
    })
    .ok_or("The selected audio output is unavailable. Select another output and try again.".into())
}
pub fn playback(
    device: &cpal::Device,
    consumer: Consumer<AudioPacket>,
    stats: Arc<Stats>,
    channel: Arc<AtomicU8>,
) -> Result<cpal::Stream, String> {
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let config = supported.config();
    match supported.sample_format() {
        SampleFormat::F32 => output::<f32>(device, config, consumer, stats, channel),
        SampleFormat::F64 => output::<f64>(device, config, consumer, stats, channel),
        SampleFormat::I16 => output::<i16>(device, config, consumer, stats, channel),
        SampleFormat::I32 => output::<i32>(device, config, consumer, stats, channel),
        SampleFormat::U16 => output::<u16>(device, config, consumer, stats, channel),
        format => Err(format!(
            "Audio output format {format} is not supported yet."
        )),
    }
}
fn stream_ns(time: cpal::StreamInstant) -> i64 {
    // CPAL 0.18.2 uses the same host clock as clock::now_ns on each backend.
    time.duration_since(cpal::StreamInstant::ZERO)
        .as_nanos()
        .min(i64::MAX as u128) as i64
}
fn output<T: SizedSample + FromSample<f32>>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    mut consumer: Consumer<AudioPacket>,
    stats: Arc<Stats>,
    playback_channel: Arc<AtomicU8>,
) -> Result<cpal::Stream, String> {
    let channels = config.channels as usize;
    let rate = config.sample_rate;
    if channels == 0 || rate == 0 {
        return Err("Invalid audio output format.".into());
    }
    let mut buffer = TimedBuffer::new();
    let mut cursor = PlaybackCursor::new();
    let mut was_playing = false;
    let error_stats = stats.clone();
    let stream = device
        .build_output_stream(
            config,
            move |data: &mut [T], info| {
                // All memory was allocated before starting. No networking, mutexes,
                // allocations, or JS calls occur on the real-time device thread.
                for _ in 0..128 {
                    match consumer.pop() {
                        Ok(packet) => {
                            if !buffer.push(packet) {
                                stats.late_packets.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                        Err(_) => break,
                    }
                }
                if stats.stopped.load(Ordering::Relaxed) {
                    data.fill(T::from_sample(0.0));
                    return;
                }
                let playback_ns = stream_ns(info.timestamp().playback);
                let lead = playback_ns - clock::now_ns();
                if !(-20 * MS..=100 * MS).contains(&lead) {
                    stats.device_clock_invalid.store(true, Ordering::Relaxed);
                    data.fill(T::from_sample(0.0));
                    return;
                }
                stats.output_lead_ns.store(lead.max(0), Ordering::Relaxed);
                stats.output_clock_ready.store(true, Ordering::Release);
                if !stats.clock_ready.load(Ordering::Acquire) {
                    data.fill(T::from_sample(0.0));
                    return;
                }
                let master_ns =
                    playback_ns.saturating_sub(stats.clock_offset_ns.load(Ordering::Acquire));
                let (start, step, error, reset) =
                    cursor.begin(master_ns, data.len() / channels, rate);
                stats.phase_error_ns.store(error, Ordering::Relaxed);
                if reset {
                    stats.resync_requested.store(true, Ordering::Release);
                }
                let mut played = 0;
                let mut gap = false;
                let mode = playback_channel.load(Ordering::Acquire);
                for (index, frame) in data.chunks_mut(channels).enumerate() {
                    let sample = buffer.sample((start + index as f64 * step) as i64);
                    if sample.is_some() {
                        played += 1;
                        was_playing = true;
                    } else if was_playing {
                        gap = true;
                    }
                    let stereo = sample.unwrap_or([0.0; 2]);
                    for (channel, value) in frame.iter_mut().enumerate() {
                        *value =
                            T::from_sample(super::channel::sample(stereo, mode, channel, channels));
                    }
                }
                stats.played.fetch_add(played, Ordering::Relaxed);
                if gap {
                    stats.underruns.fetch_add(1, Ordering::Relaxed);
                }
            },
            move |error| {
                error_stats.fail(format!(
                    "The audio output stopped: {error}. Choose an available output and try again."
                ))
            },
            Some(std::time::Duration::from_secs(5)),
        )
        .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}

#[cfg(target_os = "macos")]
pub type Capture = super::mac_tap::MutedTap;
#[cfg(target_os = "macos")]
pub fn capture(
    output: &cpal::Device,
    producer: rtrb::Producer<super::buffer::CapturedFrame>,
    stats: Arc<Stats>,
) -> Result<(Capture, u32), String> {
    super::mac_tap::MutedTap::new(output, producer, stats)
}

#[cfg(target_os = "windows")]
pub type Capture = super::windows_capture::Capture;
