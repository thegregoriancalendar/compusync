#[cfg(any(target_os = "macos", target_os = "windows", test))]
use super::buffer::{CapturedFrame, Resampler};
#[cfg(any(target_os = "macos", target_os = "windows", test))]
use super::{clock::ClockFilter, packet::FRAMES};
use super::{
    clock::{self, MS},
    packet::{AudioPacket, Message, Wire, BLOCK_NS, MAX_PACKET},
    Stats,
};
#[cfg(any(target_os = "macos", target_os = "windows", test))]
use rtrb::Consumer;
use rtrb::Producer;
#[cfg(any(target_os = "macos", target_os = "windows", test))]
use std::{collections::VecDeque, time::Instant};
use std::{
    io::ErrorKind,
    net::{IpAddr, UdpSocket},
    sync::{atomic::Ordering, Arc},
    thread,
    time::Duration,
};

fn transmit(socket: &UdpSocket, wire: &mut Wire, message: &Message) -> Result<(), String> {
    let packet = wire.encode(message)?;
    match socket.send(&packet) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == ErrorKind::WouldBlock => Ok(()),
        Err(error) => Err(format!("Audio connection stopped: {error}")),
    }
}
#[cfg(any(target_os = "macos", target_os = "windows", test))]
fn receive_one(
    socket: &UdpSocket,
    wire: &mut Wire,
    buffer: &mut [u8],
) -> Result<Option<Message>, String> {
    match socket.recv(buffer) {
        Ok(length) => Ok(wire.decode(&buffer[..length])),
        Err(error) if error.kind() == ErrorKind::WouldBlock => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}
fn publish_estimate(stats: &Stats, offset: i64, rtt: i64) {
    let previous = stats.clock_offset_ns.load(Ordering::Acquire);
    let delta = offset.saturating_sub(previous);
    let first = !stats.clock_ready.load(Ordering::Acquire);
    let updated = if first || delta.saturating_abs() > 5 * MS {
        offset
    } else {
        previous + delta.clamp(-100_000, 100_000)
    };
    if !first && delta.saturating_abs() > 5 * MS {
        stats.resync_requested.store(true, Ordering::Release);
    }
    stats.clock_offset_ns.store(updated, Ordering::Release);
    stats.clock_rtt_ns.store(rtt, Ordering::Relaxed);
    stats.clock_ready.store(true, Ordering::Release);
}

/// Complete clock agreement before opening the muted Mac tap. After this
/// handshake the sender worker keeps clocks alive while the OS asks permission.
#[cfg(any(target_os = "macos", target_os = "windows", test))]
pub fn synchronize(
    socket: &UdpSocket,
    wire: &mut Wire,
    stats: &Stats,
    cancelled: impl Fn() -> bool,
) -> Result<ClockFilter, String> {
    let mut filter = ClockFilter::new();
    let start = Instant::now();
    let mut next_ping = 0;
    let mut pending = VecDeque::new();
    let mut count = 0;
    let mut raw = [0; MAX_PACKET];
    while start.elapsed() < Duration::from_secs(8) {
        if cancelled() || stats.stopped.load(Ordering::Acquire) {
            return Err("Audio start cancelled.".into());
        }
        let now = clock::now_ns();
        if now >= next_ping {
            transmit(socket, wire, &Message::Ping { t1: now })?;
            pending.push_back(now);
            if pending.len() > 32 {
                pending.pop_front();
            }
            next_ping = now + 20 * MS;
            if count >= 8 {
                if let Some(estimate) = filter.best().filter(|e| e.rtt <= 10 * MS) {
                    transmit(
                        socket,
                        wire,
                        &Message::Model {
                            offset: estimate.offset,
                            rtt: estimate.rtt,
                        },
                    )?;
                }
            }
        }
        for _ in 0..64 {
            let Some(message) = receive_one(socket, wire, &mut raw)? else {
                break;
            };
            match message {
                Message::Pong { t1, t2, t3 } => {
                    if let Some(index) = pending.iter().position(|time| *time == t1) {
                        pending.remove(index);
                        if filter.observe(t1, t2, t3, clock::now_ns()).is_some() {
                            count += 1;
                        }
                    }
                }
                Message::Ready if count >= 8 && filter.best().is_some_and(|e| e.rtt <= 10 * MS) => {
                    let best = filter.best().unwrap();
                    stats.clock_rtt_ns.store(best.rtt, Ordering::Relaxed);
                    stats.clock_ready.store(true, Ordering::Release);
                    stats.delay_ns.store(
                        (120 * MS + best.rtt * 4).clamp(150 * MS, 500 * MS),
                        Ordering::Relaxed,
                    );
                    return Ok(filter);
                }
                _ => {}
            }
        }
        thread::sleep(Duration::from_millis(1));
    }
    Err("Audio clocks could not synchronize within 5 ms estimated uncertainty. Check the connection and firewall, then retry.".into())
}

#[cfg(any(target_os = "macos", target_os = "windows", test))]
pub fn send(
    socket: UdpSocket,
    mut wire: Wire,
    mut filter: ClockFilter,
    mut input: Consumer<CapturedFrame>,
    rate: u32,
    mut local: Producer<AudioPacket>,
    stats: Arc<Stats>,
) {
    let result = (|| -> Result<(), String> {
        let mut resampler = Resampler::new(rate);
        let mut epoch = 1u32;
        let mut frame_index = 0u64;
        let mut partial = [[0.0; 2]; FRAMES];
        let mut used = 0;
        let mut capture_ns = 0;
        let mut expected_capture: Option<i64> = None;
        let mut previous_input: Option<i64> = None;
        let mut raw = [0; MAX_PACKET];
        let mut pending = VecDeque::new();
        let mut next_ping = 0;
        let mut last_reply = clock::now_ns();
        let mut last_input = clock::now_ns();
        while !stats.stopped.load(Ordering::Acquire) {
            let now = clock::now_ns();
            if stats.device_clock_invalid.load(Ordering::Relaxed) {
                return Err("The source output cannot provide a supported playback timestamp. Choose built-in or wired speakers.".into());
            }
            if now >= next_ping {
                transmit(&socket, &mut wire, &Message::Ping { t1: now })?;
                pending.push_back(now);
                if pending.len() > 32 {
                    pending.pop_front();
                }
                next_ping = now + 250 * MS;
            }
            for _ in 0..64 {
                let Some(message) = receive_one(&socket, &mut wire, &mut raw)? else {
                    break;
                };
                match message {
                    Message::Pong { t1, t2, t3 } => {
                        if let Some(index) = pending.iter().position(|time| *time == t1) {
                            pending.remove(index);
                            if let Some(estimate) = filter.observe(t1, t2, t3, clock::now_ns()) {
                                if estimate.rtt > 10 * MS {
                                    return Err("Audio clock uncertainty grew beyond 5 ms. Reconnect on a more stable network.".into());
                                }
                                last_reply = now;
                                stats.clock_rtt_ns.store(estimate.rtt, Ordering::Relaxed);
                                transmit(
                                    &socket,
                                    &mut wire,
                                    &Message::Model {
                                        offset: estimate.offset,
                                        rtt: estimate.rtt,
                                    },
                                )?;
                            }
                        }
                    }
                    Message::Resync => {
                        stats.resync_requested.store(true, Ordering::Release);
                    }
                    _ => {}
                }
            }
            if now - last_reply > 3_000 * MS {
                return Err("Audio clock synchronization was lost. Start sharing again.".into());
            }
            if now - last_input > 90_000 * MS {
                return Err(
                    "No source audio samples were captured. Check the audio devices and permissions.".into(),
                );
            }
            if stats.resync_requested.swap(false, Ordering::AcqRel) {
                epoch = epoch.checked_add(1).ok_or("Audio epoch exhausted.")?;
                frame_index = 0;
                used = 0;
                resampler.clear();
                expected_capture = None;
                previous_input = None;
                for _ in 0..24_000 {
                    if input.pop().is_err() {
                        break;
                    }
                }
                stats.resyncs.fetch_add(1, Ordering::Relaxed);
                let delay = (stats.delay_ns.load(Ordering::Relaxed) + 25 * MS).min(500 * MS);
                stats.delay_ns.store(delay, Ordering::Relaxed);
            }
            for _ in 0..4096 {
                let Ok(frame) = input.pop() else {
                    break;
                };
                last_input = now;
                // A capture discontinuity starts a fresh shared epoch; never
                // join samples across a missing hardware callback.
                if previous_input.is_some_and(|t| {
                    (frame.time_ns - t - 1_000_000_000 / rate as i64).abs() > 2 * MS
                }) {
                    epoch = epoch.checked_add(1).ok_or("Audio epoch exhausted.")?;
                    frame_index = 0;
                    used = 0;
                    resampler.clear();
                    expected_capture = None;
                    stats.resyncs.fetch_add(1, Ordering::Relaxed);
                }
                previous_input = Some(frame.time_ns);
                resampler.push(frame);
                while let Some(sample) = resampler.next() {
                    if used == 0 {
                        capture_ns = sample.time_ns;
                    }
                    partial[used] = sample.samples.map(|s| {
                        if s.is_finite() {
                            (s.clamp(-1.0, 1.0) * 32767.0).round() / 32767.0
                        } else {
                            0.0
                        }
                    });
                    used += 1;
                    if used != FRAMES {
                        continue;
                    }
                    used = 0;
                    if expected_capture.is_some_and(|t| (capture_ns - t).abs() > 2 * MS) {
                        epoch = epoch.checked_add(1).ok_or("Audio epoch exhausted.")?;
                        frame_index = 0;
                        stats.resyncs.fetch_add(1, Ordering::Relaxed);
                    }
                    expected_capture = Some(capture_ns + BLOCK_NS);
                    let play_ns = capture_ns + stats.delay_ns.load(Ordering::Relaxed);
                    if play_ns < clock::now_ns() + 20 * MS {
                        stats.resync_requested.store(true, Ordering::Release);
                        continue;
                    }
                    let audio = AudioPacket {
                        epoch,
                        frame: frame_index,
                        capture_ns,
                        play_ns,
                        samples: partial,
                    };
                    transmit(&socket, &mut wire, &Message::Audio(Box::new(audio.clone())))?;
                    if local.push(audio).is_err() {
                        stats.resync_requested.store(true, Ordering::Release);
                    }
                    frame_index = frame_index
                        .checked_add(FRAMES as u64)
                        .ok_or("Audio frame counter exhausted.")?;
                    stats.packet();
                }
            }
            thread::sleep(Duration::from_millis(1));
        }
        Ok(())
    })();
    if let Err(error) = result {
        stats.fail(error);
    }
}

pub fn receive(
    socket: UdpSocket,
    peer: IpAddr,
    mut wire: Wire,
    mut output: Producer<AudioPacket>,
    stats: Arc<Stats>,
) {
    let result = (|| -> Result<(), String> {
        let mut raw = [0; MAX_PACKET];
        let mut source = None;
        let start = clock::now_ns();
        let mut last_clock = start;
        let mut last_audio = start;
        let mut has_audio = false;
        let mut last_model = None;
        let mut last_model_counter = 0u64;
        let mut last_resync = 0;
        let mut late_streak = 0;
        let mut epoch = 0;
        while !stats.stopped.load(Ordering::Acquire) {
            let now = clock::now_ns();
            if stats.device_clock_invalid.load(Ordering::Relaxed) {
                return Err("This output cannot provide a supported playback timestamp. Choose built-in or wired speakers.".into());
            }
            for _ in 0..64 {
                let (length, from) = match socket.recv_from(&mut raw) {
                    Ok(result) => result,
                    Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                    Err(e) => return Err(e.to_string()),
                };
                let received = clock::now_ns();
                if from.ip() != peer || source.is_some_and(|address| address != from) {
                    continue;
                }
                let Some(message) = wire.decode(&raw[..length]) else {
                    continue;
                };
                if source.is_none() {
                    if !matches!(message, Message::Ping { .. }) {
                        continue;
                    }
                    socket.connect(from).map_err(|e| e.to_string())?;
                    source = Some(from);
                }
                match message {
                    Message::Ping { t1 } if t1 >= 0 => {
                        transmit(
                            &socket,
                            &mut wire,
                            &Message::Pong {
                                t1,
                                t2: received,
                                t3: clock::now_ns(),
                            },
                        )?;
                        last_clock = received;
                    }
                    Message::Model { offset, rtt }
                        if (0..=10 * MS).contains(&rtt)
                            && stats.output_clock_ready.load(Ordering::Acquire) =>
                    {
                        // Clock models must advance even though audio packets may reorder.
                        let counter = u64::from_be_bytes(raw[4..12].try_into().unwrap());
                        if counter <= last_model_counter {
                            continue;
                        }
                        last_model_counter = counter;
                        publish_estimate(&stats, offset, rtt);
                        last_clock = received;
                        last_model = Some(received);
                        transmit(&socket, &mut wire, &Message::Ready)?;
                    }
                    Message::Audio(audio) if stats.clock_ready.load(Ordering::Acquire) => {
                        let master_now =
                            received.saturating_sub(stats.clock_offset_ns.load(Ordering::Acquire));
                        if audio.epoch < epoch
                            || audio.play_ns.saturating_sub(master_now) > 600 * MS
                        {
                            continue;
                        }
                        if audio.epoch > epoch {
                            if epoch != 0 {
                                stats.resyncs.fetch_add(1, Ordering::Relaxed);
                            }
                            epoch = audio.epoch;
                        }
                        stats.packet();
                        last_audio = received;
                        has_audio = true;
                        stats
                            .delay_ns
                            .store(audio.play_ns - audio.capture_ns, Ordering::Relaxed);
                        let lead = stats.output_lead_ns.load(Ordering::Relaxed);
                        if audio.play_ns + BLOCK_NS < master_now + lead {
                            stats.late_packets.fetch_add(1, Ordering::Relaxed);
                            late_streak += 1;
                        } else {
                            late_streak = 0;
                            if output.push(*audio).is_err() {
                                stats.resync_requested.store(true, Ordering::Release);
                            }
                        }
                        if late_streak >= 8 {
                            stats.resync_requested.store(true, Ordering::Release);
                            late_streak = 0;
                        }
                    }
                    _ => {}
                }
            }
            if source.is_some() && now - last_clock > 3_000 * MS {
                return Err("Audio clock synchronization was lost. Start sharing again.".into());
            }
            if last_model.is_some_and(|time| now - time > 3_000 * MS) {
                return Err("The playback clock model expired. Start sharing again.".into());
            }
            if now - last_audio > (if has_audio { 5_000 } else { 90_000 }) * MS {
                return Err(
                    "No source audio is arriving. Check permissions, connection, and firewall."
                        .into(),
                );
            }
            if stats.resync_requested.load(Ordering::Acquire)
                && now - last_resync > 250 * MS
                && source.is_some()
            {
                stats.resync_requested.store(false, Ordering::Release);
                transmit(&socket, &mut wire, &Message::Resync)?;
                last_resync = now;
            }
            thread::sleep(Duration::from_millis(1));
        }
        Ok(())
    })();
    if let Err(error) = result {
        stats.fail(error);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_peers_agree_on_clock_and_deliver_timestamped_audio_with_identical_local_deadlines() {
        let receiver = UdpSocket::bind("127.0.0.1:0").unwrap();
        receiver.set_nonblocking(true).unwrap();
        let address = receiver.local_addr().unwrap();
        let receive_stats = Arc::new(Stats::new());
        // This transport-only test has no physical device callback.
        receive_stats
            .output_clock_ready
            .store(true, Ordering::Release);
        let worker_stats = receive_stats.clone();
        let key = "42".repeat(32);
        let (output, mut received) = rtrb::RingBuffer::new(128);
        let receiver_key = key.clone();
        let receiver_thread = thread::spawn(move || {
            receive(
                receiver,
                "127.0.0.1".parse().unwrap(),
                Wire::new(&receiver_key, false).unwrap(),
                output,
                worker_stats,
            )
        });
        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        sender.connect(address).unwrap();
        sender.set_nonblocking(true).unwrap();
        let stats = Arc::new(Stats::new());
        let mut wire = Wire::new(&key, true).unwrap();
        let filter = synchronize(&sender, &mut wire, &stats, || false).unwrap();
        assert!(receive_stats.clock_ready.load(Ordering::Acquire));
        assert!(filter.best().unwrap().offset.abs() < 5 * MS);
        let (mut capture, input) = rtrb::RingBuffer::new(4800);
        let start = clock::now_ns();
        for frame in 0..4410 {
            capture
                .push(CapturedFrame {
                    samples: [0.25, -0.5],
                    time_ns: start + frame * 1_000_000_000 / 44_100,
                })
                .unwrap();
        }
        let (local, mut local_audio) = rtrb::RingBuffer::new(128);
        let worker_stats = stats.clone();
        let sender_thread =
            thread::spawn(move || send(sender, wire, filter, input, 44_100, local, worker_stats));
        let deadline = Instant::now() + Duration::from_secs(2);
        while received.slots() == 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(1));
        }
        let remote = received.pop().unwrap();
        let local = local_audio.pop().unwrap();
        assert_eq!(remote.frame, local.frame);
        assert_eq!(remote.play_ns, local.play_ns);
        assert_eq!(remote.capture_ns, local.capture_ns);
        assert!(remote.play_ns - remote.capture_ns >= 150 * MS);
        assert!((remote.samples[0][0] - local.samples[0][0]).abs() < 0.0001);

        // A receiver scheduling discontinuity asks the source to choose a new
        // epoch. Both outputs must receive identical new future deadlines.
        receive_stats
            .resync_requested
            .store(true, Ordering::Release);
        let deadline = Instant::now() + Duration::from_secs(2);
        while stats.resyncs.load(Ordering::Relaxed) == 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(1));
        }
        assert!(stats.resyncs.load(Ordering::Relaxed) > 0);
        let restart_capture = clock::now_ns();
        for frame in 0..882 {
            capture
                .push(CapturedFrame {
                    samples: [0.5, -0.25],
                    time_ns: restart_capture + frame * 1_000_000_000 / 44_100,
                })
                .unwrap();
        }
        let mut remote_restart = None;
        let mut local_restart = None;
        while Instant::now() < deadline && (remote_restart.is_none() || local_restart.is_none()) {
            while let Ok(packet) = received.pop() {
                if packet.epoch > remote.epoch && remote_restart.is_none() {
                    remote_restart = Some(packet);
                }
            }
            while let Ok(packet) = local_audio.pop() {
                if packet.epoch > local.epoch && local_restart.is_none() {
                    local_restart = Some(packet);
                }
            }
            thread::sleep(Duration::from_millis(1));
        }
        stats.stopped.store(true, Ordering::Release);
        receive_stats.stopped.store(true, Ordering::Release);
        sender_thread.join().unwrap();
        receiver_thread.join().unwrap();
        let remote_restart = remote_restart.unwrap();
        let local_restart = local_restart.unwrap();
        assert_eq!(remote_restart.epoch, local_restart.epoch);
        assert_eq!(remote_restart.play_ns, local_restart.play_ns);
        assert!(remote_restart.play_ns - remote_restart.capture_ns >= 175 * MS);
    }

    #[test]
    fn cancelling_clock_agreement_never_waits_for_the_network_or_permission_prompt() {
        let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
        socket.set_nonblocking(true).unwrap();
        let mut wire = Wire::new(&"42".repeat(32), true).unwrap();
        let result = synchronize(&socket, &mut wire, &Stats::new(), || true);
        assert!(result.err().unwrap().contains("cancelled"));
    }
}
