//! Out-of-process last-resort cursor recovery.
//!
//! This binary intentionally has no network, renderer, or addon dependency. It
//! owns only a process-liveness handle and performs idempotent recovery after an
//! exit which cannot run Rust destructors or `atexit` handlers.

use compusync_native::{recover_external_state, RecoveryGuardState};
use std::process::ExitCode;

fn main() -> ExitCode {
    let Some(pid) = std::env::args()
        .nth(1)
        .and_then(|value| value.parse::<u32>().ok())
    else {
        return ExitCode::from(2);
    };
    let state_path = std::env::args().nth(2);
    if wait_for_exit(pid) {
        let state = state_path
            .as_deref()
            .and_then(read_state)
            .unwrap_or_default();
        recover_external_state(&state);
        if let Some(path) = state_path {
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_file(std::path::Path::new(&path).with_extension("next"));
        }
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

fn read_state(path: &str) -> Option<RecoveryGuardState> {
    let path = std::path::Path::new(path);
    [path.with_extension("next"), path.to_path_buf()]
        .into_iter()
        .find_map(|candidate| {
            std::fs::read(candidate)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        })
}

#[cfg(target_os = "windows")]
fn wait_for_exit(pid: u32) -> bool {
    type Handle = *mut std::ffi::c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn CloseHandle(handle: Handle) -> i32;
    }
    const SYNCHRONIZE: u32 = 0x0010_0000;
    let process = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
    if process.is_null() {
        return false;
    }
    let result = unsafe { WaitForSingleObject(process, u32::MAX) };
    unsafe { CloseHandle(process) };
    result == 0
}

#[cfg(target_os = "macos")]
fn wait_for_exit(pid: u32) -> bool {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
        fn usleep(microseconds: u32) -> i32;
    }
    loop {
        if unsafe { kill(pid as i32, 0) } != 0 {
            return true;
        }
        unsafe { usleep(50_000) };
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn wait_for_exit(_: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::read_state;
    use compusync_native::{GuardedWindowState, RecoveryGuardState, Rect};

    #[test]
    fn recovery_state_prefers_complete_journal_and_falls_back_after_torn_write() {
        let path = std::env::temp_dir().join(format!(
            "compusync-guard-test-{}-{:?}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let committed = RecoveryGuardState {
            windows: vec![GuardedWindowState {
                id: "0x123".into(),
                bounds: Rect {
                    x: -10.0,
                    y: 20.0,
                    width: 800.0,
                    height: 600.0,
                },
            }],
            buttons: 1,
            modifiers: 2,
        };
        std::fs::write(&path, serde_json::to_vec(&committed).unwrap()).unwrap();
        let journal = RecoveryGuardState {
            buttons: 3,
            ..committed.clone()
        };
        std::fs::write(
            path.with_extension("next"),
            serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();
        assert_eq!(read_state(path.to_str().unwrap()).unwrap().buttons, 3);
        std::fs::write(path.with_extension("next"), b"{").unwrap();
        let fallback = read_state(path.to_str().unwrap()).unwrap();
        assert_eq!(fallback.buttons, 1);
        assert_eq!(fallback.modifiers, 2);
        assert_eq!(fallback.windows[0].id, "0x123");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("next"));
    }
}
