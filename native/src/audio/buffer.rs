use super::{
    clock::MS,
    packet::{AudioPacket, BLOCK_NS, FRAMES, RATE},
};
#[cfg(any(target_os = "macos", test))]
use std::collections::VecDeque;

#[derive(Clone, Copy, Debug, Default)]
#[cfg(any(target_os = "macos", test))]
pub struct CapturedFrame {
    pub samples: [f32; 2],
    pub time_ns: i64,
}

/// Copy a native interleaved or planar float block into the capture ring. The
/// callback supplies channel views without allocating or changing host time.
#[cfg(any(target_os = "macos", test))]
pub fn push_capture_block(
    left: (&[f32], usize),
    right: Option<(&[f32], usize)>,
    first_ns: i64,
    rate: u32,
    producer: &mut rtrb::Producer<CapturedFrame>,
) -> (usize, bool) {
    let right = right.unwrap_or(left);
    if left.1 == 0 || right.1 == 0 || rate == 0 {
        return (0, false);
    }
    let count = left
        .0
        .len()
        .div_ceil(left.1)
        .min(right.0.len().div_ceil(right.1));
    for index in 0..count {
        let frame = CapturedFrame {
            samples: [left.0[index * left.1], right.0[index * right.1]],
            time_ns: first_ns + index as i64 * 1_000_000_000 / rate as i64,
        };
        if producer.push(frame).is_err() {
            return (index, true);
        }
    }
    (count, false)
}

/// Carries capture time through sample-rate conversion. Never invents capture
/// times from socket send time, including after dropped capture callbacks.
#[cfg(any(target_os = "macos", test))]
pub struct Resampler {
    frames: VecDeque<CapturedFrame>,
    position: f64,
    step: f64,
}
#[cfg(any(target_os = "macos", test))]
impl Resampler {
    pub fn new(input_rate: u32) -> Self {
        Self {
            frames: VecDeque::with_capacity(24_002),
            position: 0.0,
            step: input_rate as f64 / RATE as f64,
        }
    }
    pub fn push(&mut self, frame: CapturedFrame) {
        self.frames.push_back(frame);
    }
    pub fn next(&mut self) -> Option<CapturedFrame> {
        if self.frames.len() < self.step.ceil() as usize + 1 {
            return None;
        }
        let a = self.frames[0];
        let b = self.frames[1];
        let fraction = self.position as f32;
        let value = CapturedFrame {
            samples: [
                a.samples[0] + (b.samples[0] - a.samples[0]) * fraction,
                a.samples[1] + (b.samples[1] - a.samples[1]) * fraction,
            ],
            time_ns: a.time_ns + ((b.time_ns - a.time_ns) as f64 * self.position) as i64,
        };
        self.position += self.step;
        while self.position >= 1.0 {
            self.frames.pop_front();
            self.position -= 1.0;
        }
        Some(value)
    }
    pub fn clear(&mut self) {
        self.frames.clear();
        self.position = 0.0;
    }
}

/// Allocated before the audio callback starts. Inserts/reorders without growing
/// memory; samples are selected by scheduled DAC time, never queue occupancy.
pub struct TimedBuffer {
    packets: Vec<AudioPacket>,
    epoch: Option<u32>,
    epoch_start_ns: i64,
    last_ns: i64,
}
impl TimedBuffer {
    pub fn new() -> Self {
        Self {
            packets: Vec::with_capacity(128),
            epoch: None,
            epoch_start_ns: 0,
            last_ns: 0,
        }
    }
    pub fn push(&mut self, packet: AudioPacket) -> bool {
        if self.epoch.is_some_and(|epoch| packet.epoch < epoch) {
            return false;
        }
        if self.epoch != Some(packet.epoch) {
            self.epoch = Some(packet.epoch);
            self.epoch_start_ns = packet.play_ns;
            // Keep the previous epoch until the scheduled transition. Network
            // arrival times must not decide when local playback is interrupted.
            self.packets.retain(|p| p.play_ns < packet.play_ns);
        } else if packet.play_ns < self.epoch_start_ns {
            self.epoch_start_ns = packet.play_ns;
        }
        if self.packets.len() >= 128 || packet.play_ns + BLOCK_NS <= self.last_ns {
            return false;
        }
        let index = match self
            .packets
            .binary_search_by_key(&packet.play_ns, |p| p.play_ns)
        {
            Ok(_) => return false,
            Err(index) => index,
        };
        self.packets.insert(index, packet);
        true
    }
    pub fn sample(&mut self, master_ns: i64) -> Option<[f32; 2]> {
        self.last_ns = master_ns;
        while self.packets.first().is_some_and(|packet| {
            packet.play_ns + BLOCK_NS <= master_ns
                || (Some(packet.epoch) != self.epoch && master_ns >= self.epoch_start_ns)
        }) {
            self.packets.remove(0);
        }
        let packet = self.packets.first()?;
        if master_ns < packet.play_ns {
            return None;
        }
        let position = (master_ns - packet.play_ns) as f64 * RATE as f64 / 1_000_000_000.0;
        let index = (position as usize).min(FRAMES - 1);
        let fraction = (position - index as f64) as f32;
        let a = packet.samples[index];
        let b = if index + 1 < FRAMES {
            packet.samples[index + 1]
        } else {
            self.packets
                .get(1)
                .filter(|p| (p.play_ns - packet.play_ns - BLOCK_NS).abs() < 100_000)
                .map_or(a, |p| p.samples[0])
        };
        Some([
            a[0] + (b[0] - a[0]) * fraction,
            a[1] + (b[1] - a[1]) * fraction,
        ])
    }
}

/// Device-clock servo. Gentle corrections preserve continuity; large timeline
/// changes re-anchor at the shared scheduled time rather than replaying backlog.
pub struct PlaybackCursor {
    position: Option<f64>,
}
impl PlaybackCursor {
    pub fn new() -> Self {
        Self { position: None }
    }
    pub fn begin(&mut self, master_ns: i64, frames: usize, rate: u32) -> (f64, f64, i64, bool) {
        let target = master_ns as f64;
        let previous = self.position.unwrap_or(target);
        let error = target - previous;
        let reset = error.abs() > (20 * MS) as f64;
        let start = if reset { target } else { previous };
        let correction = (error / 500_000_000.0).clamp(-0.002, 0.002);
        let step = 1_000_000_000.0 / rate as f64 * (1.0 + correction);
        self.position = Some(start + frames as f64 * step);
        (start, step, error as i64, reset)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_capture_handles_interleaved_planar_mono_timestamps_and_overflow() {
        let interleaved = [0.1, -0.1, 0.2, -0.2, 0.3, -0.3];
        let planar_left = [0.1, 0.2, 0.3];
        let planar_right = [-0.1, -0.2, -0.3];
        for (left, right) in [
            ((&interleaved[..], 2), Some((&interleaved[1..], 2))),
            ((&planar_left[..], 1), Some((&planar_right[..], 1))),
        ] {
            let (mut producer, mut consumer) = rtrb::RingBuffer::new(3);
            assert_eq!(
                push_capture_block(left, right, 9_000 * MS, 48_000, &mut producer),
                (3, false)
            );
            for index in 0..3 {
                let frame = consumer.pop().unwrap();
                assert_eq!(frame.samples, [planar_left[index], planar_right[index]]);
                assert_eq!(
                    frame.time_ns,
                    9_000 * MS + index as i64 * 1_000_000_000 / 48_000
                );
            }
        }
        let (mut producer, mut consumer) = rtrb::RingBuffer::new(2);
        assert_eq!(
            push_capture_block((&planar_left, 1), None, 0, 44_100, &mut producer),
            (2, true)
        );
        assert_eq!(consumer.pop().unwrap().samples, [0.1; 2]);
        let second = consumer.pop().unwrap();
        assert_eq!(second.samples, [0.2; 2]);
        assert_eq!(second.time_ns, 1_000_000_000 / 44_100);
        assert!(consumer.pop().is_err());
    }
    fn packet(frame: u64, epoch: u32, play_ns: i64, value: f32) -> AudioPacket {
        AudioPacket {
            epoch,
            frame,
            capture_ns: play_ns - 150 * MS,
            play_ns,
            samples: [[value; 2]; FRAMES],
        }
    }
    #[test]
    fn scheduled_playout_reorders_and_missing_data_does_not_shift_the_timeline() {
        let mut buffer = TimedBuffer::new();
        assert!(buffer.push(packet(240, 1, 155 * MS, 0.5)));
        assert!(buffer.push(packet(0, 1, 150 * MS, 0.25)));
        assert_eq!(buffer.sample(149 * MS), None);
        assert_eq!(buffer.sample(150 * MS), Some([0.25; 2]));
        assert_eq!(buffer.sample(155 * MS), Some([0.5; 2]));
        assert_eq!(buffer.sample(160 * MS), None);
        assert!(!buffer.push(packet(0, 1, 150 * MS, 0.9)));
        assert!(buffer.push(packet(720, 1, 165 * MS, 0.75)));
        assert_eq!(buffer.sample(164 * MS), None);
        assert_eq!(buffer.sample(165 * MS), Some([0.75; 2]));
    }
    #[test]
    fn epoch_changes_discard_backlog_and_reject_old_inflight_audio() {
        let mut buffer = TimedBuffer::new();
        buffer.push(packet(0, 1, 150 * MS, 0.1));
        buffer.push(packet(0, 2, 300 * MS, 0.2));
        assert!(!buffer.push(packet(240, 1, 155 * MS, 0.9)));
        assert_eq!(buffer.sample(150 * MS), Some([0.1; 2]));
        assert_eq!(buffer.sample(300 * MS), Some([0.2; 2]));
    }
    #[test]
    fn timestamped_resampling_preserves_capture_time_at_44100_and_96000() {
        for rate in [44_100, 96_000] {
            let mut r = Resampler::new(rate);
            for frame in 0..rate / 10 {
                r.push(CapturedFrame {
                    samples: [0.25, -0.5],
                    time_ns: 1_000_000_000 + frame as i64 * 1_000_000_000 / rate as i64,
                });
            }
            let mut count = 0;
            while let Some(frame) = r.next() {
                assert_eq!(frame.samples, [0.25, -0.5]);
                assert!(
                    (frame.time_ns - 1_000_000_000 - count * 1_000_000_000 / RATE as i64).abs() < 3
                );
                count += 1;
            }
            assert!((4797..=4800).contains(&count));
        }
    }
    #[test]
    fn servo_tracks_clock_drift_and_reanchors_after_stalls() {
        let mut cursor = PlaybackCursor::new();
        let mut clock: i64 = 1_000 * MS;
        let mut error = 0;
        for _ in 0..10_000 {
            let (_, step, e, reset) = cursor.begin(clock, 480, RATE);
            assert!(!reset);
            assert!((step / (1e9 / RATE as f64) - 1.0).abs() <= 0.00201);
            error = e;
            clock += 10 * MS + 1_000; // 100 ppm hardware skew.
        }
        assert!(error.abs() < MS);
        assert!(cursor.begin(clock + 200 * MS, 480, RATE).3);
    }
    #[test]
    fn different_device_rates_and_latencies_render_against_the_same_clock() {
        // Predicted DAC times already include each device's different lead.
        // A known host offset must cancel out before selecting the audio sample.
        let mut results = Vec::new();
        for (rate, offset, lead, ppm) in [
            (44_100u32, -9_000 * MS, 7 * MS, -100.0),
            (48_000u32, 4_000 * MS, 25 * MS, 150.0),
            (96_000u32, 20_000 * MS, 40 * MS, 50.0),
        ] {
            let mut buffer = TimedBuffer::new();
            for block in (0..80).rev() {
                let mut packet = packet(
                    block * FRAMES as u64,
                    1,
                    1_000 * MS + block as i64 * BLOCK_NS,
                    0.0,
                );
                // A pulse longer than a device sample avoids missing the click
                // entirely when the DAC runs at a different nominal rate.
                packet.samples[..12].fill([1.0; 2]);
                buffer.push(packet);
            }
            let mut cursor = PlaybackCursor::new();
            let frames = rate as usize / 100;
            let actual_rate = rate as f64 * (1.0 + ppm / 1_000_000.0);
            let mut rising = Vec::new();
            let mut high = false;
            for callback in 0..60 {
                let dac_ns =
                    (900 * MS) as f64 + callback as f64 * frames as f64 * 1e9 / actual_rate;
                let callback_host_ns = dac_ns as i64 + offset - lead;
                let (position, step, _, reset) =
                    cursor.begin(callback_host_ns + lead - offset, frames, rate);
                assert!(!reset);
                for index in 0..frames {
                    let sample = buffer
                        .sample((position + index as f64 * step) as i64)
                        .unwrap_or([0.0; 2]);
                    let next_high = sample[0] >= 0.5;
                    if next_high && !high {
                        rising.push(dac_ns + index as f64 * 1e9 / actual_rate);
                    }
                    high = next_high;
                }
            }
            assert_eq!(rising.len(), 80);
            results.push(rising);
        }
        for click in 0..80 {
            let earliest = results
                .iter()
                .map(|r| r[click])
                .fold(f64::INFINITY, f64::min);
            let latest = results.iter().map(|r| r[click]).fold(0.0, f64::max);
            assert!(
                latest - earliest < 150_000.0,
                "simulated DAC skew {} ns",
                latest - earliest
            );
        }
    }
    #[test]
    fn packet_loss_does_not_move_later_samples_on_either_output() {
        let mut a = TimedBuffer::new();
        let mut b = TimedBuffer::new();
        for index in [2, 0, 3, 1, 5] {
            a.push(packet(
                index * 240,
                1,
                150 * MS + index as i64 * BLOCK_NS,
                index as f32,
            ));
            if index != 3 {
                b.push(packet(
                    index * 240,
                    1,
                    150 * MS + index as i64 * BLOCK_NS,
                    index as f32,
                ));
            }
        }
        for elapsed in 0..30 {
            let time = 150 * MS + elapsed * MS;
            let left = a.sample(time);
            let right = b.sample(time);
            if !(15..20).contains(&elapsed) {
                assert_eq!(left, right);
            } else {
                assert!(right.is_none());
            }
        }
    }
}
