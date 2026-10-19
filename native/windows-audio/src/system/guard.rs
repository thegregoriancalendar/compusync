use super::*;
use crate::restore;
use std::{
    fs,
    io::{BufRead, Write},
    path::PathBuf,
    sync::mpsc,
    time::{Duration, Instant},
};
use windows::{
    core::w,
    Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE},
        System::Threading::CreateMutexW,
    },
};

struct Lock(HANDLE);
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}
fn lock() -> Result<Lock, String> {
    let handle = unsafe { CreateMutexW(None, false, w!("Local\\CompuSyncWindowsAudioRoute")) }
        .map_err(|e| e.to_string())?;
    let lock = Lock(handle);
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        return Err("Another Windows audio route is already active.".into());
    }
    Ok(lock)
}
fn journal() -> Result<PathBuf, String> {
    let root = std::env::var_os("LOCALAPPDATA").ok_or("Windows local app data is unavailable.")?;
    let path = PathBuf::from(root).join("CompuSync");
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path.join("audio-route.json"))
}
fn say(message: &str) -> Result<(), String> {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{message}")
        .and_then(|_| out.flush())
        .map_err(|e| e.to_string())
}

pub fn recover_previous() -> Result<(), String> {
    let _lock = lock()?;
    let mut system = System::new()?;
    system.enable_policy()?;
    restore_journal(&system, &journal()?)
}
fn restore_journal(system: &System, path: &std::path::Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() > 16_384 {
        return Err("Windows audio recovery journal is invalid.".into());
    }
    let old: Snapshot = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    restore(system, &old)?;
    fs::remove_file(path).map_err(|e| e.to_string())
}

/// The helper owns every default change. EOF, lost native heartbeats, or a
/// changed/unplugged device restores defaults independently of Electron.
pub fn run_guard(bus: &str, output: &str, owner: u32) -> Result<(), String> {
    let _lock = lock()?;
    let mut system = System::new()?;
    system.enable_policy()?;
    let path = journal()?;
    restore_journal(&system, &path)?;
    let snapshot = system.plan(bus, output)?;
    let mut file = fs::File::create(path.with_extension("next")).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(path.with_extension("next"), &path).map_err(|e| e.to_string())?;
    let (tx, rx) = mpsc::sync_channel(16);
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            match line {
                Ok(line) if line.len() <= 64 => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
                _ => break,
            }
        }
    });
    let mut next_bypass_check = None;
    let mut last_warning = None;
    let outcome = crate::guard_defaults(
        &system,
        &snapshot,
        rx,
        say,
        || {
            if !system.active(&snapshot.bus)
                || !system.active(&snapshot.output)
                || (0..3).any(|role| system.current(role).ok().as_deref() != Some(&snapshot.bus))
            {
                return Err("Windows audio output changed or disconnected. Sharing stopped; select outputs and retry.".into());
            }
            let next =
                next_bypass_check.get_or_insert_with(|| Instant::now() + Duration::from_secs(2));
            if Instant::now() >= *next {
                let warning = system.bypass_warning(owner).unwrap_or_else(|error| {
                    Some(format!("Could not inspect other Windows audio sessions. Sharing continues: {error}"))
                });
                if warning != last_warning {
                    say(&format!(
                        "WARNING {}",
                        warning.as_deref().unwrap_or("").replace(['\r', '\n'], " ")
                    ))?;
                    last_warning = warning;
                }
                *next = Instant::now() + Duration::from_millis(500);
            }
            Ok(())
        },
        Duration::from_secs(3),
    );
    // Keep the journal if restoration fails, so the next helper retries it.
    if outcome.restored {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    outcome.result?;
    say("RESTORED")
}
