#[cfg(any(target_os = "macos", test))]
use super::buffer::Resampler;
use super::{
    buffer::JitterBuffer,
    packet::{self, FRAMES},
    Stats,
};
use aes_gcm::Aes256Gcm;
#[cfg(any(target_os = "macos", test))]
use rtrb::Consumer;
use rtrb::Producer;
use std::{
    io::ErrorKind,
    net::{IpAddr, UdpSocket},
    sync::{atomic::Ordering, Arc},
    thread,
    time::{Duration, Instant},
};

const TICK: Duration = Duration::from_millis(5);

#[cfg(any(target_os = "macos", test))]
pub fn send(
    socket: UdpSocket,
    cipher: Aes256Gcm,
    mut input: Consumer<[f32; 2]>,
    rate: u32,
    stats: Arc<Stats>,
) {
    let mut resampler = Resampler::new(rate, packet::RATE);
    let mut sequence = 0u64;
    let mut deadline = Instant::now() + Duration::from_millis(20);
    while !stats.stopped.load(Ordering::Acquire) {
        while let Ok(frame) = input.pop() {
            resampler.push(frame);
        }
        if Instant::now() < deadline {
            thread::sleep(Duration::from_millis(1));
            continue;
        }
        let mut audio = [[0.0f32; 2]; FRAMES];
        for frame in &mut audio {
            *frame = resampler.next().unwrap_or([0.0; 2]);
        }
        let packet = packet::encode(&cipher, sequence, &audio);
        match socket.send(&packet) {
            Ok(_) => stats.packet(),
            Err(error) if error.kind() == ErrorKind::WouldBlock => {}
            Err(error) => {
                stats.fail(format!("Audio could not reach Windows: {error}"));
                break;
            }
        }
        let Some(next) = sequence.checked_add(1) else {
            stats.fail("Audio session sequence exhausted. Start a new session.");
            break;
        };
        sequence = next;
        deadline += TICK;
        // Do not burst old packets after sleep or a long scheduling stall.
        if deadline + Duration::from_millis(30) < Instant::now() {
            stats.fail("Audio paused while the Mac was sleeping or busy. Start sharing again.");
        }
    }
}

pub fn receive(
    socket: UdpSocket,
    peer: IpAddr,
    cipher: Aes256Gcm,
    mut output: Producer<[f32; 2]>,
    stats: Arc<Stats>,
) {
    let mut packet = [0u8; 1200];
    let mut jitter = JitterBuffer::new();
    let mut deadline: Option<Instant> = None;
    let mut source = None;
    let mut last_packet = Instant::now();
    while !stats.stopped.load(Ordering::Acquire) {
        // Bound work per iteration even when the socket is flooded.
        for _ in 0..64 {
            match socket.recv_from(&mut packet) {
                Ok((length, from)) => {
                    if from.ip() != peer || source.is_some_and(|address| from != address) {
                        continue;
                    }
                    if let Some((sequence, audio)) = packet::decode(&cipher, &packet[..length]) {
                        if jitter.push(sequence, audio) {
                            source = Some(from); // Pin the endpoint only after successful authentication.
                            stats.packet();
                            last_packet = Instant::now();
                            deadline
                                .get_or_insert_with(|| Instant::now() + Duration::from_millis(40));
                        }
                    }
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                Err(error) => {
                    stats.fail(format!("The audio connection stopped: {error}"));
                    return;
                }
            }
        }
        if last_packet.elapsed() > Duration::from_secs(if source.is_some() { 5 } else { 90 }) {
            stats.fail("No Mac audio is arriving. Check the connection and firewall, then start sharing again.");
            break;
        }
        if let Some(next) = deadline.as_mut() {
            while *next <= Instant::now() {
                if *next + Duration::from_millis(100) < Instant::now() {
                    stats.fail(
                        "Audio paused while Windows was sleeping or busy. Start sharing again.",
                    );
                    return;
                }
                let audio = jitter.next();
                if output.slots() >= FRAMES {
                    for frame in audio {
                        let _ = output.push(frame);
                    }
                }
                *next += TICK;
            }
        }
        thread::sleep(Duration::from_millis(1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_udp_stream_delivers_samples_without_javascript_or_audio_hardware() {
        let receiver = UdpSocket::bind("127.0.0.1:0").unwrap();
        receiver.set_nonblocking(true).unwrap();
        let address = receiver.local_addr().unwrap();
        let stats = Arc::new(Stats::new());
        let worker_stats = stats.clone();
        let (output, mut input) = rtrb::RingBuffer::new(9_600);
        let worker = thread::spawn(move || {
            receive(
                receiver,
                "127.0.0.1".parse().unwrap(),
                packet::cipher(&"42".repeat(32)).unwrap(),
                output,
                worker_stats,
            )
        });
        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        let cipher = packet::cipher(&"42".repeat(32)).unwrap();
        for sequence in [0, 2, 1, 3, 4, 5, 6, 7, 8, 9] {
            sender
                .send_to(
                    &packet::encode(&cipher, sequence, &[[0.25, -0.5]; FRAMES]),
                    address,
                )
                .unwrap();
        }
        let wait = Instant::now();
        while input.slots() < FRAMES && wait.elapsed() < Duration::from_secs(2) {
            thread::sleep(TICK);
        }
        stats.stopped.store(true, Ordering::Release);
        worker.join().unwrap();
        assert_eq!(stats.packets.load(Ordering::Relaxed), 10);
        let frame = input.pop().expect("native receiver produced no frames");
        assert!((frame[0] - 0.25).abs() < 0.0001);
        assert!((frame[1] + 0.5).abs() < 0.0001);
    }

    #[test]
    fn native_sender_packetizes_and_resamples_capture_frames() {
        let receiver = UdpSocket::bind("127.0.0.1:0").unwrap();
        receiver
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        sender.connect(receiver.local_addr().unwrap()).unwrap();
        let stats = Arc::new(Stats::new());
        let worker_stats = stats.clone();
        let (mut capture, input) = rtrb::RingBuffer::new(4_800);
        for _ in 0..4_410 {
            capture.push([0.25, -0.5]).unwrap();
        }
        let worker = thread::spawn(move || {
            send(
                sender,
                packet::cipher(&"42".repeat(32)).unwrap(),
                input,
                44_100,
                worker_stats,
            )
        });
        let mut raw = [0u8; 1200];
        let (length, _) = receiver.recv_from(&mut raw).unwrap();
        stats.stopped.store(true, Ordering::Release);
        worker.join().unwrap();
        let (sequence, decoded) =
            packet::decode(&packet::cipher(&"42".repeat(32)).unwrap(), &raw[..length]).unwrap();
        assert_eq!(sequence, 0);
        assert!((decoded[100][0] - 0.25).abs() < 0.0001);
        assert!((decoded[100][1] + 0.5).abs() < 0.0001);
    }
}
