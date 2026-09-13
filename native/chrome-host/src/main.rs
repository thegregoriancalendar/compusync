//! Chrome native-messaging relay for the CompuSync desktop process.
//!
//! Chrome owns stdin/stdout, so this process must never write diagnostics to
//! stdout. Both sides use Chrome's four-byte little-endian length framing,
//! which lets the relay validate frame sizes without inspecting messages.

use std::{
    io::{self, Read, Write},
    process::ExitCode,
};

const ALLOWED_ORIGIN: &str = "chrome-extension://fpafmookkejpkjlegeppoecbhbgbogcp/";
const MAX_CHROME_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_EXTENSION_MESSAGE_BYTES: usize = 5 * 1024 * 1024;

fn relay_frames<R: Read, W: Write>(
    mut reader: R,
    mut writer: W,
    max_message_bytes: usize,
) -> io::Result<()> {
    loop {
        let mut header = [0_u8; 4];
        match reader.read(&mut header)? {
            0 => return Ok(()),
            count => read_remainder(&mut reader, &mut header[count..])?,
        }

        let length = u32::from_le_bytes(header) as usize;
        if length > max_message_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "native-messaging frame exceeds the configured limit",
            ));
        }

        let mut payload = vec![0_u8; length];
        read_remainder(&mut reader, &mut payload)?;
        writer.write_all(&header)?;
        writer.write_all(&payload)?;
        writer.flush()?;
    }
}

fn read_remainder<R: Read>(reader: &mut R, buffer: &mut [u8]) -> io::Result<()> {
    reader.read_exact(buffer).map_err(|error| {
        if error.kind() == io::ErrorKind::UnexpectedEof {
            io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "truncated native-messaging frame",
            )
        } else {
            error
        }
    })
}

fn main() -> ExitCode {
    if std::env::args().nth(1).as_deref() != Some(ALLOWED_ORIGIN) {
        return ExitCode::from(2);
    }
    platform::run()
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{relay_frames, MAX_CHROME_MESSAGE_BYTES, MAX_EXTENSION_MESSAGE_BYTES};
    use std::{
        ffi::c_void,
        io,
        os::windows::ffi::OsStrExt,
        process::ExitCode,
        ptr::{null, null_mut},
        sync::{mpsc, Arc},
        thread,
        time::{Duration, Instant},
    };

    const PIPE_NAME: &str = r"\\.\pipe\compusync-chrome-v3";
    const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
    const RETRY_DELAY: Duration = Duration::from_millis(50);

    type Handle = *mut c_void;
    const INVALID_HANDLE_VALUE: Handle = usize::MAX as Handle;
    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
    const ERROR_BROKEN_PIPE: u32 = 109;
    const ERROR_IO_PENDING: u32 = 997;

    #[repr(C)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        event: Handle,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share_mode: u32,
            security: *mut c_void,
            creation: u32,
            flags: u32,
            template: Handle,
        ) -> Handle;
        fn CreateEventW(
            attributes: *mut c_void,
            manual_reset: i32,
            initial_state: i32,
            name: *const u16,
        ) -> Handle;
        fn ReadFile(
            file: Handle,
            buffer: *mut c_void,
            bytes_to_read: u32,
            bytes_read: *mut u32,
            overlapped: *mut Overlapped,
        ) -> i32;
        fn WriteFile(
            file: Handle,
            buffer: *const c_void,
            bytes_to_write: u32,
            bytes_written: *mut u32,
            overlapped: *mut Overlapped,
        ) -> i32;
        fn GetOverlappedResult(
            file: Handle,
            overlapped: *mut Overlapped,
            bytes_transferred: *mut u32,
            wait: i32,
        ) -> i32;
        fn GetLastError() -> u32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    struct PipeHandle(Handle);

    unsafe impl Send for PipeHandle {}
    unsafe impl Sync for PipeHandle {}

    impl Drop for PipeHandle {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    struct PipeReader(Arc<PipeHandle>);
    struct PipeWriter(Arc<PipeHandle>);

    impl io::Read for PipeReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            overlapped_io(self.0 .0, buffer.as_mut_ptr().cast(), buffer.len(), false)
        }
    }

    impl io::Write for PipeWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            overlapped_io(
                self.0 .0,
                buffer.as_ptr() as *mut c_void,
                buffer.len(),
                true,
            )
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    pub fn run() -> ExitCode {
        let Ok(pipe) = connect_pipe() else {
            return ExitCode::from(3);
        };
        let pipe = Arc::new(pipe);

        // End the host when either Chrome or the desktop bridge disconnects.
        // Detached relay threads are stopped by process teardown.
        let (finished_tx, finished_rx) = mpsc::channel();
        let input_finished = finished_tx.clone();
        let pipe_writer = PipeWriter(Arc::clone(&pipe));
        thread::spawn(move || {
            let result = relay_frames(io::stdin().lock(), pipe_writer, MAX_EXTENSION_MESSAGE_BYTES);
            let _ = input_finished.send((5, result));
        });
        let pipe_reader = PipeReader(pipe);
        thread::spawn(move || {
            let result = relay_frames(pipe_reader, io::stdout().lock(), MAX_CHROME_MESSAGE_BYTES);
            let _ = finished_tx.send((6, result));
        });

        match finished_rx.recv() {
            Ok((_, Ok(()))) => ExitCode::SUCCESS,
            Ok((direction, Err(error))) => {
                eprintln!("CompuSync native relay error: {error}");
                ExitCode::from(direction)
            }
            Err(_) => ExitCode::from(4),
        }
    }

    fn connect_pipe() -> io::Result<PipeHandle> {
        let pipe_name: Vec<u16> = std::ffi::OsStr::new(PIPE_NAME)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let started = Instant::now();
        loop {
            let handle = unsafe {
                CreateFileW(
                    pipe_name.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    null_mut(),
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED,
                    null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                return Ok(PipeHandle(handle));
            }
            let error = io::Error::last_os_error();
            if started.elapsed() < CONNECT_TIMEOUT {
                thread::sleep(RETRY_DELAY);
            } else {
                return Err(error);
            }
        }
    }

    fn overlapped_io(
        handle: Handle,
        buffer: *mut c_void,
        length: usize,
        writing: bool,
    ) -> io::Result<usize> {
        let length = u32::try_from(length)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "I/O buffer is too large"))?;
        let event = unsafe { CreateEventW(null_mut(), 0, 0, null()) };
        if event.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut operation = Overlapped {
            internal: 0,
            internal_high: 0,
            offset: 0,
            offset_high: 0,
            event,
        };
        let mut transferred = 0_u32;
        let started = unsafe {
            if writing {
                WriteFile(
                    handle,
                    buffer.cast_const(),
                    length,
                    &mut transferred,
                    &mut operation,
                )
            } else {
                ReadFile(handle, buffer, length, &mut transferred, &mut operation)
            }
        };
        let result = if started != 0 {
            Ok(transferred as usize)
        } else {
            let code = unsafe { GetLastError() };
            if code == ERROR_BROKEN_PIPE && !writing {
                Ok(0)
            } else if code == ERROR_IO_PENDING {
                let completed =
                    unsafe { GetOverlappedResult(handle, &mut operation, &mut transferred, 1) };
                if completed != 0 {
                    Ok(transferred as usize)
                } else {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) && !writing {
                        Ok(0)
                    } else {
                        Err(error)
                    }
                }
            } else {
                Err(io::Error::from_raw_os_error(code as i32))
            }
        };
        unsafe { CloseHandle(event) };
        result
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use std::process::ExitCode;

    pub fn run() -> ExitCode {
        ExitCode::from(3)
    }
}

#[cfg(test)]
mod tests {
    use super::{relay_frames, MAX_CHROME_MESSAGE_BYTES, MAX_EXTENSION_MESSAGE_BYTES};
    use std::io::{self, Cursor};

    fn frame(payload: &[u8]) -> Vec<u8> {
        let mut framed = (payload.len() as u32).to_le_bytes().to_vec();
        framed.extend_from_slice(payload);
        framed
    }

    #[test]
    fn relays_multiple_frames_without_changing_bytes() {
        let mut input = frame(br#"{"type":"hello"}"#);
        input.extend(frame(br#"{"id":7}"#));
        let mut output = Vec::new();
        relay_frames(Cursor::new(&input), &mut output, MAX_CHROME_MESSAGE_BYTES).unwrap();
        assert_eq!(output, input);
    }

    #[test]
    fn rejects_oversized_frames_before_allocating_payload() {
        let input = ((MAX_CHROME_MESSAGE_BYTES + 1) as u32).to_le_bytes();
        let error =
            relay_frames(Cursor::new(input), Vec::new(), MAX_CHROME_MESSAGE_BYTES).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);

        let accepted = vec![0_u8; MAX_CHROME_MESSAGE_BYTES + 1];
        relay_frames(
            Cursor::new(frame(&accepted)),
            Vec::new(),
            MAX_EXTENSION_MESSAGE_BYTES,
        )
        .unwrap();

        let extension_input = ((MAX_EXTENSION_MESSAGE_BYTES + 1) as u32).to_le_bytes();
        let extension_error = relay_frames(
            Cursor::new(extension_input),
            Vec::new(),
            MAX_EXTENSION_MESSAGE_BYTES,
        )
        .unwrap_err();
        assert_eq!(extension_error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn rejects_truncated_headers_and_payloads() {
        let header_error =
            relay_frames(Cursor::new([1_u8, 0]), Vec::new(), MAX_CHROME_MESSAGE_BYTES).unwrap_err();
        assert_eq!(header_error.kind(), io::ErrorKind::UnexpectedEof);

        let payload_error = relay_frames(
            Cursor::new([4_u8, 0, 0, 0, 1, 2]),
            Vec::new(),
            MAX_CHROME_MESSAGE_BYTES,
        )
        .unwrap_err();
        assert_eq!(payload_error.kind(), io::ErrorKind::UnexpectedEof);
    }
}
