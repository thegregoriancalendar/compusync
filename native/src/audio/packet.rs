use aes_gcm::{
    aead::{AeadInPlace, KeyInit},
    Aes256Gcm, Nonce, Tag,
};
pub const VERSION: u32 = 4;
pub const RATE: u32 = 48_000;
pub const FRAMES: usize = 240;
pub const BLOCK_NS: i64 = 5_000_000;
pub const HEADER: usize = 12;
pub const MAX_PACKET: usize = 1200;
#[derive(Clone, Debug)]
pub struct AudioPacket {
    pub epoch: u32,
    pub frame: u64,
    pub capture_ns: i64,
    pub play_ns: i64,
    pub epoch_start_ns: i64,
    pub samples: [[f32; 2]; FRAMES],
}
#[derive(Debug)]
pub enum Message {
    Ping {
        t1: i64,
    },
    Pong {
        t1: i64,
        t2: i64,
        t3: i64,
    },
    Model {
        offset: i64,
        rtt: i64,
    },
    Ready,
    Resync,
    Timing {
        capture_age: i64,
        output_horizon: i64,
    },
    Audio(Box<AudioPacket>),
}
/// A counter per direction and disjoint nonce prefixes. Reordering is allowed;
/// duplicates and packets older than the 256-counter replay window are rejected.
pub struct Wire {
    cipher: Aes256Gcm,
    sender: bool,
    counter: u64,
    highest: Option<u64>,
    seen: [u64; 4],
}
impl Wire {
    pub fn new(key: &str, sender: bool) -> Result<Self, String> {
        if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Audio requires a fresh 256-bit session key.".into());
        }
        let mut bytes = [0; 32];
        for (i, value) in bytes.iter_mut().enumerate() {
            *value = u8::from_str_radix(&key[i * 2..i * 2 + 2], 16).map_err(|e| e.to_string())?;
        }
        Ok(Self {
            cipher: Aes256Gcm::new((&bytes).into()),
            sender,
            counter: 0,
            highest: None,
            seen: [0; 4],
        })
    }
    pub fn encode(&mut self, message: &Message) -> Result<Vec<u8>, String> {
        let mut body = Vec::with_capacity(1024);
        match message {
            Message::Ping { t1 } => {
                body.push(1);
                body.extend(t1.to_be_bytes());
            }
            Message::Pong { t1, t2, t3 } => {
                body.push(2);
                for t in [t1, t2, t3] {
                    body.extend(t.to_be_bytes());
                }
            }
            Message::Model { offset, rtt } => {
                body.push(3);
                body.extend(offset.to_be_bytes());
                body.extend(rtt.to_be_bytes());
            }
            Message::Ready => body.push(4),
            Message::Resync => body.push(5),
            Message::Timing {
                capture_age,
                output_horizon,
            } => {
                body.push(7);
                body.extend(capture_age.to_be_bytes());
                body.extend(output_horizon.to_be_bytes());
            }
            Message::Audio(audio) => {
                body.push(6);
                body.extend(audio.epoch.to_be_bytes());
                body.extend(audio.frame.to_be_bytes());
                body.extend(audio.capture_ns.to_be_bytes());
                body.extend(audio.play_ns.to_be_bytes());
                body.extend(audio.epoch_start_ns.to_be_bytes());
                for sample in audio.samples.iter().flatten() {
                    let value = if sample.is_finite() {
                        sample.clamp(-1.0, 1.0)
                    } else {
                        0.0
                    };
                    body.extend(((value * i16::MAX as f32).round() as i16).to_le_bytes());
                }
            }
        }
        let counter = self.counter;
        self.counter = self
            .counter
            .checked_add(1)
            .ok_or("Audio nonce exhausted. Restart sharing.")?;
        let mut packet = Vec::with_capacity(HEADER + body.len() + 16);
        packet.extend(if self.sender { b"CSS4" } else { b"CSR4" });
        packet.extend(counter.to_be_bytes());
        let tag = self
            .cipher
            .encrypt_in_place_detached(Nonce::from_slice(&packet), &packet, &mut body)
            .map_err(|e| e.to_string())?;
        packet.extend(body);
        packet.extend(tag);
        Ok(packet)
    }
    pub fn decode(&mut self, packet: &[u8]) -> Option<Message> {
        if packet.len() < HEADER + 17
            || packet.len() > MAX_PACKET
            || &packet[..4] != if self.sender { b"CSR4" } else { b"CSS4" }
        {
            return None;
        }
        let counter = u64::from_be_bytes(packet[4..12].try_into().ok()?);
        let distance = self.highest.map_or(0, |high| high.saturating_sub(counter));
        if self.highest.is_some_and(|high| counter <= high)
            && (distance >= 256
                || self.seen[(distance / 64) as usize] & (1 << (distance % 64)) != 0)
        {
            return None;
        }
        let mut body = packet[HEADER..packet.len() - 16].to_vec();
        self.cipher
            .decrypt_in_place_detached(
                Nonce::from_slice(&packet[..HEADER]),
                &packet[..HEADER],
                &mut body,
                Tag::from_slice(&packet[packet.len() - 16..]),
            )
            .ok()?;
        let int = |at: usize| -> Option<i64> {
            Some(i64::from_be_bytes(body.get(at..at + 8)?.try_into().ok()?))
        };
        let message = match (body[0], body.len()) {
            (1, 9) => Message::Ping { t1: int(1)? },
            (2, 25) => Message::Pong {
                t1: int(1)?,
                t2: int(9)?,
                t3: int(17)?,
            },
            (3, 17) => Message::Model {
                offset: int(1)?,
                rtt: int(9)?,
            },
            (4, 1) => Message::Ready,
            (5, 1) => Message::Resync,
            (7, 17) => {
                let capture_age = int(1)?;
                let output_horizon = int(9)?;
                if !(0..=500_000_000).contains(&capture_age)
                    || !(1..=500_000_000).contains(&output_horizon)
                {
                    return None;
                }
                Message::Timing {
                    capture_age,
                    output_horizon,
                }
            }
            (6, 997) => {
                let capture_ns = int(13)?;
                let play_ns = int(21)?;
                let epoch_start_ns = int(29)?;
                if capture_ns < 0
                    || epoch_start_ns < 0
                    || epoch_start_ns > play_ns
                    || !(super::latency::MIN_DELAY_NS..=super::latency::MAX_DELAY_NS)
                        .contains(&play_ns.checked_sub(capture_ns)?)
                {
                    return None;
                }
                let frame = u64::from_be_bytes(body[5..13].try_into().ok()?);
                if frame % FRAMES as u64 != 0 {
                    return None;
                }
                let mut samples = [[0.0; 2]; FRAMES];
                for (sample, bytes) in samples.iter_mut().flatten().zip(body[37..].chunks_exact(2))
                {
                    *sample = i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / i16::MAX as f32;
                }
                Message::Audio(Box::new(AudioPacket {
                    epoch: u32::from_be_bytes(body[1..5].try_into().ok()?),
                    frame,
                    capture_ns,
                    play_ns,
                    epoch_start_ns,
                    samples,
                }))
            }
            _ => return None,
        };
        if let Some(highest) = self.highest {
            if counter > highest {
                let shift = (counter - highest).min(256) as usize;
                let previous = self.seen;
                self.seen = [0; 4];
                for bit in 0..256 - shift {
                    if previous[bit / 64] & (1 << (bit % 64)) != 0 {
                        self.seen[(bit + shift) / 64] |= 1 << ((bit + shift) % 64);
                    }
                }
            }
        }
        let high = self.highest.unwrap_or(counter).max(counter);
        let bit = (high - counter) as usize;
        self.seen[bit / 64] |= 1 << (bit % 64);
        self.highest = Some(high);
        Some(message)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn timestamps_are_authenticated_and_directions_cannot_reuse_nonces_or_reflect() {
        let key = "42".repeat(32);
        let mut sender = Wire::new(&key, true).unwrap();
        let mut windows = Wire::new(&key, false).unwrap();
        let packet = sender
            .encode(&Message::Audio(Box::new(AudioPacket {
                epoch: 3,
                frame: 240,
                capture_ns: 1_000_000,
                play_ns: 151_000_000,
                epoch_start_ns: 146_000_000,
                samples: [[0.25, -0.5]; FRAMES],
            })))
            .unwrap();
        assert!(packet.len() < MAX_PACKET);
        assert!(sender.decode(&packet).is_none());
        let mut corrupt = packet.clone();
        corrupt[20] ^= 1;
        assert!(windows.decode(&corrupt).is_none());
        let Message::Audio(audio) = windows.decode(&packet).unwrap() else {
            panic!()
        };
        assert_eq!(audio.epoch, 3);
        assert_eq!(audio.play_ns, 151_000_000);
        assert!((audio.samples[0][0] - 0.25).abs() < 0.0001);
        assert!(windows.decode(&packet).is_none());
        let back = windows.encode(&Message::Ready).unwrap();
        assert_ne!(&back[..12], &packet[..12]);
        assert!(matches!(sender.decode(&back), Some(Message::Ready)));
    }
    #[test]
    fn replay_window_accepts_reordering_and_expires_old_counters() {
        let mut a = Wire::new(&"42".repeat(32), true).unwrap();
        let mut b = Wire::new(&"42".repeat(32), false).unwrap();
        let packets: Vec<_> = (0..300)
            .map(|_| a.encode(&Message::Ready).unwrap())
            .collect();
        assert!(b.decode(&packets[2]).is_some());
        assert!(b.decode(&packets[0]).is_some());
        assert!(b.decode(&packets[1]).is_some());
        assert!(b.decode(&packets[299]).is_some());
        assert!(b.decode(&packets[3]).is_none());
        assert!(b.decode(&packets[298]).is_some());
    }
    #[test]
    fn timing_feedback_and_low_latency_packets_are_authenticated_and_bounded() {
        let key = "42".repeat(32);
        let mut receiver = Wire::new(&key, false).unwrap();
        let mut sender = Wire::new(&key, true).unwrap();
        let report = receiver
            .encode(&Message::Timing {
                capture_age: 7_000_000,
                output_horizon: 12_000_000,
            })
            .unwrap();
        let mut corrupt = report.clone();
        corrupt[15] ^= 1;
        assert!(sender.decode(&corrupt).is_none());
        assert!(matches!(
            sender.decode(&report),
            Some(Message::Timing {
                capture_age: 7_000_000,
                output_horizon: 12_000_000
            })
        ));
        assert!(sender.decode(&report).is_none());
        for (age, horizon) in [(-1, 10), (500_000_001, 10), (1, 0), (1, 500_000_001)] {
            let invalid = receiver
                .encode(&Message::Timing {
                    capture_age: age,
                    output_horizon: horizon,
                })
                .unwrap();
            assert!(sender.decode(&invalid).is_none());
        }
        let audio = AudioPacket {
            epoch: 1,
            frame: 0,
            capture_ns: 1_000_000_000,
            play_ns: 1_010_000_000,
            epoch_start_ns: 1_010_000_000,
            samples: [[0.0; 2]; FRAMES],
        };
        let encoded = sender
            .encode(&Message::Audio(Box::new(audio.clone())))
            .unwrap();
        assert!(matches!(receiver.decode(&encoded), Some(Message::Audio(_))));
        let mut invalid = audio.clone();
        invalid.play_ns -= 1;
        invalid.epoch_start_ns -= 1;
        assert!(receiver
            .decode(&sender.encode(&Message::Audio(Box::new(invalid))).unwrap())
            .is_none());
        let mut invalid = audio;
        invalid.epoch_start_ns = invalid.play_ns + 1;
        assert!(receiver
            .decode(&sender.encode(&Message::Audio(Box::new(invalid))).unwrap())
            .is_none());
        let mut obsolete = report;
        obsolete[..4].copy_from_slice(b"CSR3");
        assert!(sender.decode(&obsolete).is_none());
    }
}
