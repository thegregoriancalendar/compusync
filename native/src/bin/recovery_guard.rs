//! Out-of-process last-resort cursor recovery.
//!
//! This binary intentionally has no network, renderer, or addon dependency. It
//! owns only a process-liveness handle and performs idempotent recovery after an
//! exit which cannot run Rust destructors or `atexit` handlers.

use std::process::ExitCode;

fn main() -> ExitCode {
    let Some(pid) = std::env::args()
        .nth(1)
        .and_then(|value| value.parse::<u32>().ok())
    else {
        return ExitCode::from(2);
    };
    if wait_for_exit(pid) {
        recover_cursor();
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
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

#[cfg(target_os = "windows")]
fn recover_cursor() {
    #[repr(C)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[link(name = "user32")]
    unsafe extern "system" {
        fn ClipCursor(rect: *const Rect) -> i32;
        fn ShowCursor(show: i32) -> i32;
    }
    unsafe {
        ClipCursor(std::ptr::null());
        for _ in 0..32 {
            if ShowCursor(1) >= 0 {
                break;
            }
        }
    }
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

#[cfg(target_os = "macos")]
fn recover_cursor() {
    unsafe extern "C" {
        fn CGMainDisplayID() -> u32;
        fn CGDisplayShowCursor(display: u32) -> i32;
        fn CGAssociateMouseAndMouseCursorPosition(connected: bool) -> i32;
    }
    unsafe {
        CGAssociateMouseAndMouseCursorPosition(true);
        // Balance a bounded number of nested hide calls. Compusync itself uses
        // idempotent hiding, but this also handles a panic during transition.
        for _ in 0..4 {
            CGDisplayShowCursor(CGMainDisplayID());
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn wait_for_exit(_: u32) -> bool {
    false
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn recover_cursor() {}
