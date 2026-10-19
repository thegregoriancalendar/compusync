use super::packet::FRAMES;
use std::collections::BTreeMap;
#[cfg(any(target_os = "macos", test))]
use std::collections::VecDeque;

#[cfg(any(target_os = "macos", test))]
pub struct Resampler {
    frames: VecDeque<[f32; 2]>,
    position: f64,
    step: f64,
}

#[cfg(any(target_os = "macos", test))]
impl Resampler {
    pub fn new(input_rate: u32, output_rate: u32) -> Self {
        Self {
            frames: VecDeque::with_capacity(48_000 / 4),
            position: 0.0,
            step: input_rate as f64 / output_rate as f64,
        }
    }

    pub fn push(&mut self, frame: [f32; 2]) {
        self.frames.push_back(frame);
        if self.frames.len() > 9_600 {
            // Never let a stalled network build a long delay.
            self.frames.drain(..self.frames.len() - 1_920);
            self.position = 0.0;
        }
    }

    pub fn next(&mut self) -> Option<[f32; 2]> {
        if self.frames.len() < 2 {
            return None;
        }
        let fraction = self.position as f32;
        let a = self.frames[0];
        let b = self.frames[1];
        let value = [
            a[0] + (b[0] - a[0]) * fraction,
            a[1] + (b[1] - a[1]) * fraction,
        ];
        self.position += self.step;
        while self.position >= 1.0 {
            self.frames.pop_front();
            self.position -= 1.0;
            if self.frames.is_empty() {
                self.position = 0.0;
                break;
            }
        }
        Some(value)
    }
}

// Ordered, bounded playout with silence for missing packets. Old/duplicate
// sequence numbers are discarded, so authenticated packets cannot be replayed.
pub struct JitterBuffer {
    pending: BTreeMap<u64, [[f32; 2]; FRAMES]>,
    expected: Option<u64>,
    pub lost: u64,
}

impl JitterBuffer {
    pub fn new() -> Self {
        Self {
            pending: BTreeMap::new(),
            expected: None,
            lost: 0,
        }
    }

    pub fn push(&mut self, sequence: u64, samples: [[f32; 2]; FRAMES]) -> bool {
        let expected = *self.expected.get_or_insert(sequence);
        if sequence < expected
            || sequence.saturating_sub(expected) > 60
            || self.pending.contains_key(&sequence)
        {
            return false;
        }
        self.pending.insert(sequence, samples);
        true
    }

    pub fn next(&mut self) -> [[f32; 2]; FRAMES] {
        let Some(expected) = self.expected else {
            return [[0.0; 2]; FRAMES];
        };
        self.expected = expected.checked_add(1);
        self.pending.remove(&expected).unwrap_or_else(|| {
            self.lost += 1;
            [[0.0; 2]; FRAMES]
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jitter_reorders_rejects_replays_and_conceals_loss() {
        let mut buffer = JitterBuffer::new();
        assert!(buffer.push(0, [[0.1; 2]; FRAMES]));
        assert!(buffer.push(2, [[0.3; 2]; FRAMES]));
        assert!(buffer.push(1, [[0.2; 2]; FRAMES]));
        assert!(!buffer.push(1, [[0.9; 2]; FRAMES]));
        assert_eq!(buffer.next()[0], [0.1; 2]);
        assert!(!buffer.push(0, [[0.9; 2]; FRAMES]));
        assert_eq!(buffer.next()[0], [0.2; 2]);
        assert_eq!(buffer.next()[0], [0.3; 2]);
        assert_eq!(buffer.next()[0], [0.0; 2]);
        assert_eq!(buffer.lost, 1);
        assert!(!buffer.push(1000, [[0.9; 2]; FRAMES]));
    }

    #[test]
    fn resamples_44100_to_48000_without_changing_stereo_channels() {
        let mut resampler = Resampler::new(44_100, 48_000);
        for _ in 0..4410 {
            resampler.push([0.25, -0.5]);
        }
        let mut count = 0;
        while let Some(sample) = resampler.next() {
            assert_eq!(sample, [0.25, -0.5]);
            count += 1;
        }
        assert!((4797..=4800).contains(&count), "{count}");
    }
}
