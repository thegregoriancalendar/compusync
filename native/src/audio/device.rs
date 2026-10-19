#[cfg(target_os = "macos")]
use super::buffer::CapturedFrame;
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
use std::sync::{atomic::Ordering, Arc};

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
) -> Result<cpal::Stream, String> {
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let config = supported.config();
    match supported.sample_format() {
        SampleFormat::F32 => output::<f32>(device, config, consumer, stats),
        SampleFormat::F64 => output::<f64>(device, config, consumer, stats),
        SampleFormat::I16 => output::<i16>(device, config, consumer, stats),
        SampleFormat::I32 => output::<i32>(device, config, consumer, stats),
        SampleFormat::U16 => output::<u16>(device, config, consumer, stats),
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
                        *value = T::from_sample(if channels == 1 {
                            (stereo[0] + stereo[1]) * 0.5
                        } else if channel < 2 {
                            stereo[channel]
                        } else {
                            0.0
                        });
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
pub struct Capture {
    // Declaration order: stop IO before destroying the tap.
    _stream: cpal::Stream,
    _tap: super::mac_tap::MutedTap,
}
#[cfg(target_os = "macos")]
pub fn capture(
    output: &cpal::Device,
    producer: rtrb::Producer<CapturedFrame>,
    stats: Arc<Stats>,
) -> Result<(Capture, u32), String> {
    let (tap, device) = super::mac_tap::MutedTap::new(output)?;
    let supported = device.default_input_config().map_err(|e| e.to_string())?;
    let rate = supported.sample_rate();
    let config = supported.config();
    let stream = match supported.sample_format() {
        SampleFormat::F32 => input::<f32>(&device, config, producer, stats),
        SampleFormat::F64 => input::<f64>(&device, config, producer, stats),
        SampleFormat::I16 => input::<i16>(&device, config, producer, stats),
        SampleFormat::I32 => input::<i32>(&device, config, producer, stats),
        format => Err(format!("Mac capture format {format} is not supported yet.")),
    }?;
    Ok((
        Capture {
            _stream: stream,
            _tap: tap,
        },
        rate,
    ))
}
#[cfg(target_os = "macos")]
fn input<T: SizedSample>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    mut producer: rtrb::Producer<CapturedFrame>,
    stats: Arc<Stats>,
) -> Result<cpal::Stream, String>
where
    f32: FromSample<T>,
{
    let channels = config.channels as usize;
    let rate = config.sample_rate as i64;
    if channels == 0 || rate == 0 {
        return Err("Invalid Mac audio capture format.".into());
    }
    let error_stats = stats.clone();
    let stream = device.build_input_stream(config, move |data: &[T], info| {
        if stats.stopped.load(Ordering::Relaxed) { return; }
        let first_ns = stream_ns(info.timestamp().capture);
        stats.captured.fetch_add((data.len() / channels) as u64, Ordering::Relaxed);
        for (index, frame) in data.chunks_exact(channels).enumerate() {
            let left = frame[0].to_sample::<f32>(); let right = frame.get(1).map_or(left, |value| value.to_sample::<f32>());
            if producer.push(CapturedFrame { samples: [left, right], time_ns: first_ns + index as i64 * 1_000_000_000 / rate }).is_err() {
                stats.resync_requested.store(true, Ordering::Release); break;
            }
        }
    }, move |error| error_stats.fail(format!("Mac audio capture stopped: {error}. Check System Audio Recording permission and try again.")),
    Some(std::time::Duration::from_secs(10))).map_err(|e| format!("Mac capture could not start: {e}. Check System Audio Recording permission for CompuSync or Electron, then restart."))?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}
