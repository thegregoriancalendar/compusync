#![cfg(windows)]

use compusync_windows_audio::{Defaults, System};
use std::{
    io::{BufRead, BufReader, Write},
    os::windows::process::CommandExt,
    process::{Command, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// Explicit opt-in: build the helper, set COMPUSYNC_TEST_AUDIO_GUARD to its
/// absolute path, then run `cargo test --test live_guard -- --ignored`.
/// The helper owns a durable journal and restores on EOF even if this test fails.
#[test]
#[ignore = "Requires VB-CABLE and temporarily changes actual Windows default outputs"]
fn live_helper_routes_all_roles_and_restores_original_defaults() {
    let system = System::new().unwrap();
    let snapshot = system.plan("", "").unwrap();
    let helper = std::env::var_os("COMPUSYNC_TEST_AUDIO_GUARD")
        .expect("Set COMPUSYNC_TEST_AUDIO_GUARD to the rebuilt recovery helper's absolute path");
    let root = std::env::temp_dir().join(format!(
        "compusync-audio-guard-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut child = Command::new(helper)
        .args([
            "--audio-route",
            &snapshot.bus,
            &snapshot.output,
            &std::process::id().to_string(),
        ])
        .env("LOCALAPPDATA", &root)
        .creation_flags(0x08000000)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut replies = BufReader::new(child.stdout.take().unwrap());
    let expect = |replies: &mut BufReader<std::process::ChildStdout>, expected| {
        let mut line = String::new();
        replies.read_line(&mut line).unwrap();
        assert_eq!(line.trim(), expected);
    };
    expect(&mut replies, "READY");
    writeln!(input, "START").unwrap();
    expect(&mut replies, "ROUTED");
    for role in 0..3 {
        assert_eq!(system.current(role).unwrap(), snapshot.bus);
    }
    // Stay routed past the two-second session-monitor grace period. Session
    // activity (including recorders) must remain advisory while heartbeats run.
    let heartbeat = std::thread::spawn(move || {
        for _ in 0..12 {
            writeln!(input, "HEARTBEAT").unwrap();
            std::thread::sleep(Duration::from_millis(250));
        }
        writeln!(input, "STOP").unwrap();
    });
    loop {
        let mut line = String::new();
        assert!(
            replies.read_line(&mut line).unwrap() > 0,
            "Helper exited before restoring outputs"
        );
        if line.trim() == "RESTORED" {
            break;
        }
        assert!(
            line.starts_with("WARNING "),
            "Unexpected helper reply: {line}"
        );
    }
    heartbeat.join().unwrap();
    assert!(child.wait().unwrap().success());
    for role in 0..3 {
        assert_eq!(system.current(role).unwrap(), snapshot.originals[role]);
    }
    assert!(!root.join("CompuSync/audio-route.json").exists());
    std::fs::remove_dir(root.join("CompuSync")).unwrap();
    std::fs::remove_dir(root).unwrap();
}
