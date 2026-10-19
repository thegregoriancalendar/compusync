use std::sync::atomic::{AtomicU8, Ordering};

pub const STEREO: u8 = 0;
pub const LEFT: u8 = 1;
pub const RIGHT: u8 = 2;

pub fn set(target: &AtomicU8, channel: &str) -> Result<(), String> {
    let value = match channel {
        "stereo" => STEREO,
        "left" => LEFT,
        "right" => RIGHT,
        _ => return Err("Choose stereo, left, or right playback.".into()),
    };
    target.store(value, Ordering::Release);
    Ok(())
}

/// Each computer is one side of the stereo pair. Duplicate its assigned
/// channel across its front speakers; do not downmix the opposite channel.
pub fn sample(stereo: [f32; 2], mode: u8, channel: usize, channels: usize) -> f32 {
    if channel >= 2 {
        return 0.0;
    }
    match mode {
        LEFT => stereo[0],
        RIGHT => stereo[1],
        _ if channels == 1 => (stereo[0] + stereo[1]) * 0.5,
        _ => stereo[channel],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_channels_remain_isolated_on_mono_stereo_and_surround_outputs() {
        for channels in [1, 2, 6] {
            for (mode, expected) in [(LEFT, 0.75), (RIGHT, -0.25)] {
                for channel in 0..channels {
                    assert_eq!(
                        sample([0.75, -0.25], mode, channel, channels),
                        if channel < 2 { expected } else { 0.0 }
                    );
                }
            }
        }
        assert_eq!(sample([0.75, -0.25], STEREO, 0, 1), 0.25);
        assert_eq!(sample([0.75, -0.25], STEREO, 0, 2), 0.75);
        assert_eq!(sample([0.75, -0.25], STEREO, 1, 2), -0.25);
        assert_eq!(sample([0.0, 0.0], RIGHT, 0, 2), 0.0);
    }

    #[test]
    fn channel_switches_are_validated_before_changing_playback() {
        let target = AtomicU8::new(STEREO);
        for (name, expected) in [("left", LEFT), ("right", RIGHT), ("stereo", STEREO)] {
            set(&target, name).unwrap();
            assert_eq!(target.load(Ordering::Acquire), expected);
        }
        assert!(set(&target, "invalid").is_err());
        assert_eq!(target.load(Ordering::Acquire), STEREO);
    }
}
