/// WASAPI's interleaved mix formats. Integer valid bits are left aligned in
/// their container, so normalizing by container width also covers 24-in-32.
#[derive(Clone, Copy, Debug)]
pub struct Format {
    pub channels: usize,
    pub bytes: usize,
    pub float: bool,
}
impl Format {
    pub fn valid(self) -> bool {
        (1..=32).contains(&self.channels)
            && if self.float {
                [4, 8].contains(&self.bytes)
            } else {
                [2, 3, 4].contains(&self.bytes)
            }
    }
    pub fn stereo(self, frame: &[u8]) -> [f32; 2] {
        let sample = |channel| {
            let at = channel * self.bytes;
            let b = &frame[at..at + self.bytes];
            let value = match (self.float, self.bytes) {
                (true, 4) => f32::from_le_bytes(b.try_into().unwrap()),
                (true, 8) => f64::from_le_bytes(b.try_into().unwrap()) as f32,
                (false, 2) => i16::from_le_bytes(b.try_into().unwrap()) as f32 / 32768.0,
                (false, 3) => (i32::from_le_bytes([0, b[0], b[1], b[2]]) >> 8) as f32 / 8388608.0,
                (false, 4) => i32::from_le_bytes(b.try_into().unwrap()) as f32 / 2147483648.0,
                _ => 0.0,
            };
            if value.is_finite() {
                value.clamp(-1.0, 1.0)
            } else {
                0.0
            }
        };
        [sample(0), sample(if self.channels > 1 { 1 } else { 0 })]
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decodes_float_pcm_mono_and_signed_container_widths() {
        for (bytes, data) in [
            (2, vec![0, 64, 0, 192]),
            (3, vec![0, 0, 64, 0, 0, 192]),
            (4, vec![0, 0, 0, 64, 0, 0, 0, 192]),
        ] {
            let format = Format {
                channels: 2,
                bytes,
                float: false,
            };
            assert!(format.valid());
            assert_eq!(format.stereo(&data), [0.5, -0.5]);
        }
        let mono = Format {
            channels: 1,
            bytes: 4,
            float: true,
        };
        assert_eq!(mono.stereo(&0.25f32.to_le_bytes()), [0.25; 2]);
        assert_eq!(mono.stereo(&f32::NAN.to_le_bytes()), [0.0; 2]);
        assert!(!Format {
            channels: 0,
            bytes: 4,
            float: true
        }
        .valid());
    }
}
