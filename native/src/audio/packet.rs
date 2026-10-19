use aes_gcm::{
    aead::{AeadInPlace, KeyInit},
    Aes256Gcm, Nonce, Tag,
};

pub const RATE: u32 = 48_000;
pub const FRAMES: usize = 240; // 5 ms; stays below the LAN MTU without fragmentation.
pub const HEADER: usize = 12;
pub const PAYLOAD: usize = FRAMES * 2 * 2;
pub const PACKET: usize = HEADER + PAYLOAD + 16;

pub fn cipher(key: &str) -> Result<Aes256Gcm, String> {
    if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Audio requires a fresh 256-bit session key.".into());
    }
    let mut bytes = [0u8; 32];
    for (i, value) in bytes.iter_mut().enumerate() {
        *value = u8::from_str_radix(&key[i * 2..i * 2 + 2], 16).map_err(|e| e.to_string())?;
    }
    Ok(Aes256Gcm::new((&bytes).into()))
}

#[cfg(any(target_os = "macos", test))]
pub fn encode(cipher: &Aes256Gcm, sequence: u64, samples: &[[f32; 2]; FRAMES]) -> [u8; PACKET] {
    let mut packet = [0u8; PACKET];
    packet[..4].copy_from_slice(b"CSA1");
    packet[4..HEADER].copy_from_slice(&sequence.to_be_bytes());
    for (sample, bytes) in samples
        .iter()
        .flatten()
        .zip(packet[HEADER..HEADER + PAYLOAD].chunks_exact_mut(2))
    {
        let sample = if sample.is_finite() {
            sample.clamp(-1.0, 1.0)
        } else {
            0.0
        };
        bytes.copy_from_slice(&((sample * i16::MAX as f32) as i16).to_le_bytes());
    }
    let (header, body) = packet.split_at_mut(HEADER);
    let (audio, tag_bytes) = body.split_at_mut(PAYLOAD);
    // The header is also the nonce. Keys are random per route and used in only
    // one direction, and the sender never resets its sequence within a route.
    let tag = cipher
        .encrypt_in_place_detached(Nonce::from_slice(header), header, audio)
        .expect("fixed-size audio packet encryption cannot fail");
    tag_bytes.copy_from_slice(&tag);
    packet
}

pub fn decode(cipher: &Aes256Gcm, packet: &[u8]) -> Option<(u64, [[f32; 2]; FRAMES])> {
    if packet.len() != PACKET || &packet[..4] != b"CSA1" {
        return None;
    }
    let header = &packet[..HEADER];
    let mut audio = [0u8; PAYLOAD];
    audio.copy_from_slice(&packet[HEADER..HEADER + PAYLOAD]);
    cipher
        .decrypt_in_place_detached(
            Nonce::from_slice(header),
            header,
            &mut audio,
            Tag::from_slice(&packet[HEADER + PAYLOAD..]),
        )
        .ok()?;
    let mut samples = [[0.0; 2]; FRAMES];
    for (sample, bytes) in samples.iter_mut().flatten().zip(audio.chunks_exact(2)) {
        *sample = i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / i16::MAX as f32;
    }
    Some((u64::from_be_bytes(header[4..].try_into().ok()?), samples))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authenticated_audio_round_trip_rejects_tampering_and_wrong_keys() {
        let key = cipher(&"42".repeat(32)).unwrap();
        let other = cipher(&"43".repeat(32)).unwrap();
        let samples = [[0.25, -0.5]; FRAMES];
        let mut packet = encode(&key, 98, &samples);
        let (sequence, decoded) = decode(&key, &packet).unwrap();
        assert_eq!(sequence, 98);
        assert!((decoded[0][0] - 0.25).abs() < 0.0001);
        assert!((decoded[0][1] + 0.5).abs() < 0.0001);
        assert!(decode(&other, &packet).is_none());
        packet[4] ^= 1;
        assert!(decode(&key, &packet).is_none());
        packet[4] ^= 1;
        packet[HEADER] ^= 1;
        assert!(decode(&key, &packet).is_none());
        assert!(decode(&key, &packet[..PACKET - 1]).is_none());
        assert!(PACKET < 1200);
    }
}
