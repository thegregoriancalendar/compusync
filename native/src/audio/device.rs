use super::{packet::RATE, AudioOutput, Stats};
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

pub fn playback(
    id: &str,
    consumer: Consumer<[f32; 2]>,
    stats: Arc<Stats>,
) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = if id.is_empty() {
        host.default_output_device()
    } else {
        host.device_by_id(
            &id.parse()
                .map_err(|e| format!("Invalid audio device: {e}"))?,
        )
    }
    .ok_or("The selected audio output is unavailable. Select another output and try again.")?;
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let config = supported.config();
    match supported.sample_format() {
        SampleFormat::F32 => output::<f32>(&device, config, consumer, stats),
        SampleFormat::F64 => output::<f64>(&device, config, consumer, stats),
        SampleFormat::I16 => output::<i16>(&device, config, consumer, stats),
        SampleFormat::I32 => output::<i32>(&device, config, consumer, stats),
        SampleFormat::U16 => output::<u16>(&device, config, consumer, stats),
        format => Err(format!(
            "Audio output format {format} is not supported yet."
        )),
    }
}

fn output<T: SizedSample + FromSample<f32>>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    mut consumer: Consumer<[f32; 2]>,
    stats: Arc<Stats>,
) -> Result<cpal::Stream, String> {
    let channels = config.channels as usize;
    if channels == 0 || config.sample_rate == 0 {
        return Err("Invalid audio output format.".into());
    }
    let step = RATE as f64 / config.sample_rate as f64;
    let mut phase = 1.0;
    let mut current = [0.0f32; 2];
    let mut next = [0.0f32; 2];
    let mut primed = false;
    let error_stats = stats.clone();
    let stream = device
        .build_output_stream(
            config,
            move |data: &mut [T], _| {
                // The callback never waits for a network thread, allocates, or locks.
                // Rebuffer after starvation and cap latency after a scheduling stall.
                if consumer.slots() > 7_200 {
                    while consumer.slots() > 1_920 {
                        let _ = consumer.pop();
                    }
                    primed = false;
                }
                if !primed && consumer.slots() >= 480 {
                    primed = true;
                    phase = 1.0;
                }
                let correction = if consumer.slots() > 2_880 {
                    1.001
                } else if consumer.slots() < 960 {
                    0.999
                } else {
                    1.0
                };
                let mut underflow = false;
                for frame in data.chunks_mut(channels) {
                    if !primed || stats.stopped.load(Ordering::Relaxed) {
                        frame.fill(T::from_sample(0.0));
                        continue;
                    }
                    while phase >= 1.0 {
                        current = next;
                        match consumer.pop() {
                            Ok(value) => next = value,
                            Err(_) => {
                                primed = false;
                                underflow = true;
                                next = [0.0; 2];
                            }
                        }
                        phase -= 1.0;
                    }
                    let alpha = phase as f32;
                    let stereo = [
                        current[0] + (next[0] - current[0]) * alpha,
                        current[1] + (next[1] - current[1]) * alpha,
                    ];
                    for (channel, value) in frame.iter_mut().enumerate() {
                        *value = T::from_sample(if channels == 1 {
                            (stereo[0] + stereo[1]) * 0.5
                        } else if channel < 2 {
                            stereo[channel]
                        } else {
                            0.0
                        });
                    }
                    phase += step * correction;
                }
                if underflow {
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
pub fn capture(
    producer: rtrb::Producer<[f32; 2]>,
    stats: Arc<Stats>,
) -> Result<(cpal::Stream, u32), String> {
    let device = cpal::default_host()
        .default_output_device()
        .ok_or("The Mac has no default audio output.")?;
    // CPAL treats a duplex device's input as a microphone. Until we have an
    // explicit global tap, reject that device rather than ever recording a mic.
    if device.supports_input() {
        return Err("For this first audio test, select the Mac's built-in speakers as its sound output. Duplex audio devices are not supported for capture yet.".into());
    }
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let rate = supported.sample_rate();
    let config = supported.config();
    let stream = match supported.sample_format() {
        SampleFormat::F32 => input::<f32>(&device, config, producer, stats),
        SampleFormat::F64 => input::<f64>(&device, config, producer, stats),
        SampleFormat::I16 => input::<i16>(&device, config, producer, stats),
        SampleFormat::I32 => input::<i32>(&device, config, producer, stats),
        format => Err(format!("Mac capture format {format} is not supported yet.")),
    }?;
    Ok((stream, rate))
}

#[cfg(target_os = "macos")]
fn input<T: SizedSample>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    mut producer: rtrb::Producer<[f32; 2]>,
    stats: Arc<Stats>,
) -> Result<cpal::Stream, String>
where
    f32: FromSample<T>,
{
    let channels = config.channels as usize;
    if channels == 0 || config.sample_rate == 0 {
        return Err("Invalid Mac audio capture format.".into());
    }
    let error_stats = stats.clone();
    // Opening an output-only device as input uses CPAL's unmuted Core Audio
    // process tap. It does not change the Mac's output or capture a microphone.
    let stream = device.build_input_stream(config, move |data: &[T], _| {
        if stats.stopped.load(Ordering::Relaxed) { return; }
        stats.captured.fetch_add((data.len() / channels) as u64, Ordering::Relaxed);
        for frame in data.chunks_exact(channels) {
            let left = frame[0].to_sample::<f32>();
            let right = frame.get(1).map_or(left, |value| value.to_sample::<f32>());
            let _ = producer.push([left, right]); // Drop on overflow, never block the audio callback.
        }
    }, move |error| error_stats.fail(format!("Mac audio capture stopped: {error}. Check System Audio Recording permission and try again.")),
        Some(std::time::Duration::from_secs(10))).map_err(|e| format!("Mac audio capture could not start: {e}. Allow CompuSync in Privacy & Security → Screen & System Audio Recording, then quit and reopen it."))?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}
