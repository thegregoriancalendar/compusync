//! Windows services for dragging and copy/pasting files between computers.
//!
//! Windows has no public "current drag" pasteboard: an OLE drag's data object
//! is only handed to the drop target under the pointer. While the left button
//! is held on the computer that owns the pointer, JavaScript shows a thin,
//! practically invisible topmost window (the "strip") along the screen seam.
//! It is registered with `RegisterDragDrop`, so when a drag reaches the seam
//! OLE calls our `DragEnter` with the `IDataObject`; we copy its `CF_HDROP`
//! file list and bump a generation counter. The strip always answers
//! `DROPEFFECT_NONE`, so even a release on it moves nothing; the source app
//! sees the drag cancelled (JavaScript also posts Escape).
//!
//! The folder under a drop point is the Explorer window there (matched in
//! `IShellWindows` by window handle and, for Windows 11 tabs, by the active
//! tab) or the Desktop. Anything else, or any ambiguity, returns `None`.
//!
//! Copied files are read from and written to the clipboard as `CF_HDROP`
//! (plus "Preferred DropEffect: copy" when writing), with the clipboard
//! sequence number as the change generation.

use crate::{Point, Rect};
use parking_lot::Mutex;
use std::{
    ffi::c_void,
    ptr::null_mut,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};
use windows::{
    core::{implement, w, Interface, Ref, Result as WinResult, PCWSTR},
    Win32::{
        Foundation::{
            GlobalFree, COLORREF, HANDLE, HGLOBAL, HWND, LPARAM, LRESULT, POINT, POINTL, WPARAM,
        },
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IDataObject,
                IServiceProvider, CLSCTX_ALL, COINIT_APARTMENTTHREADED, DVASPECT_CONTENT,
                FORMATETC, TYMED_HGLOBAL,
            },
            DataExchange::{
                CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber,
                IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW,
                SetClipboardData,
            },
            LibraryLoader::GetModuleHandleW,
            Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
            Ole::{
                IDropTarget, IDropTarget_Impl, OleInitialize, RegisterDragDrop, ReleaseStgMedium,
                CF_HDROP, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE,
            },
            SystemServices::MODIFIERKEYS_FLAGS,
            Variant::VARIANT,
        },
        UI::{
            Shell::{
                DragQueryFileW, FOLDERID_Desktop, IFolderView, IPersistFolder2, IShellBrowser,
                IShellWindows, IWebBrowserApp, SHGetKnownFolderPath, SHGetPathFromIDListEx,
                SID_STopLevelBrowser, ShellWindows, DROPFILES, GPFIDL_DEFAULT, HDROP,
                KF_FLAG_DEFAULT,
            },
            WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DispatchMessageW, FindWindowExW, GetAncestor,
                GetClassNameW, GetMessageW, GetWindowThreadProcessId, RegisterClassW,
                SetLayeredWindowAttributes, SetWindowPos, TranslateMessage, WindowFromPoint,
                GA_ROOT, HWND_TOPMOST, LWA_ALPHA, MA_NOACTIVATE, MSG, SWP_ASYNCWINDOWPOS,
                SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
                SWP_SHOWWINDOW, WM_MOUSEACTIVATE, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE,
                WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
            },
        },
    },
};

const FOLDER_LOOKUP_TIMEOUT: Duration = Duration::from_millis(1500);

static GENERATION: AtomicU64 = AtomicU64::new(0);
static FILES: Mutex<Vec<String>> = Mutex::new(Vec::new());
// The strip window handle (as usize: HWND is not Send), created on first use
// by a dedicated OLE (single-threaded apartment) thread that lives for the
// rest of the process.
static STRIP: Mutex<Option<usize>> = Mutex::new(None);

pub fn drag_generation() -> f64 {
    GENERATION.load(Ordering::Acquire) as f64
}

pub fn drag_files() -> Result<Vec<String>, String> {
    Ok(FILES.lock().clone())
}

pub fn set_drag_capture_region(region: Option<Rect>) -> Result<(), String> {
    if region.is_none() && STRIP.lock().is_none() {
        return Ok(());
    }
    let hwnd = strip_window()?;
    // Asynchronous: the strip's thread applies it; the JS thread never waits.
    let result = unsafe {
        match region {
            Some(rect) => SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                rect.x.floor() as i32,
                rect.y.floor() as i32,
                rect.width.ceil().max(1.0) as i32,
                rect.height.ceil().max(1.0) as i32,
                SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_ASYNCWINDOWPOS,
            ),
            None => SetWindowPos(
                hwnd,
                None,
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE
                    | SWP_HIDEWINDOW
                    | SWP_NOMOVE
                    | SWP_NOSIZE
                    | SWP_NOZORDER
                    | SWP_ASYNCWINDOWPOS,
            ),
        }
    };
    result.map_err(|error| format!("SetWindowPos(drop strip): {error}"))
}

// The strip window also owns clipboard writes: SetClipboardData fails when
// the clipboard was opened without an owner window.
fn strip_window() -> Result<HWND, String> {
    let mut strip = STRIP.lock();
    if strip.is_none() {
        *strip = Some(start_strip()?);
    }
    Ok(HWND(strip.expect("strip handle") as *mut c_void))
}

struct OpenClipboardGuard;

impl Drop for OpenClipboardGuard {
    fn drop(&mut self) {
        let _ = unsafe { CloseClipboard() };
    }
}

fn open_clipboard(owner: Option<HWND>) -> Result<OpenClipboardGuard, String> {
    // Another application may hold the clipboard for a moment.
    for _ in 0..10 {
        if unsafe { OpenClipboard(owner) }.is_ok() {
            return Ok(OpenClipboardGuard);
        }
        thread::sleep(Duration::from_millis(10));
    }
    Err("the clipboard is in use by another application".into())
}

pub fn clipboard_generation() -> f64 {
    f64::from(unsafe { GetClipboardSequenceNumber() })
}

pub fn clipboard_files() -> Result<Vec<String>, String> {
    if unsafe { IsClipboardFormatAvailable(u32::from(CF_HDROP.0)) }.is_err() {
        return Ok(vec![]);
    }
    let _clipboard = open_clipboard(None)?;
    let handle = unsafe { GetClipboardData(u32::from(CF_HDROP.0)) }
        .map_err(|error| format!("GetClipboardData(CF_HDROP): {error}"))?;
    Ok(hdrop_paths(HDROP(handle.0)))
}

/// CF_HDROP plus "Preferred DropEffect: copy", as Explorer's Copy writes.
pub fn set_clipboard_files(paths: &[String]) -> Result<(), String> {
    let mut list: Vec<u16> = vec![];
    for path in paths {
        if !std::path::Path::new(path).is_absolute() || path.contains('\0') {
            return Err("clipboard paths must be absolute".into());
        }
        list.extend(path.encode_utf16());
        list.push(0);
    }
    list.push(0);
    let header = size_of::<DROPFILES>();
    let files = global_bytes(header + list.len() * 2, |memory| unsafe {
        memory.cast::<DROPFILES>().write(DROPFILES {
            pFiles: header as u32,
            pt: POINT::default(),
            fNC: false.into(),
            fWide: true.into(),
        });
        std::ptr::copy_nonoverlapping(list.as_ptr(), memory.add(header).cast::<u16>(), list.len());
    })?;
    let effect = global_bytes(4, |memory| unsafe {
        memory.cast::<u32>().write_unaligned(DROPEFFECT_COPY.0)
    });
    let effect = match effect {
        Ok(effect) => effect,
        Err(error) => {
            let _ = unsafe { GlobalFree(Some(files)) };
            return Err(error);
        }
    };
    let preferred = unsafe { RegisterClipboardFormatW(w!("Preferred DropEffect")) };
    let owner = strip_window();
    let opened = owner.and_then(|owner| open_clipboard(Some(owner)));
    let result = opened.and_then(|_clipboard| unsafe {
        EmptyClipboard().map_err(|error| format!("EmptyClipboard: {error}"))?;
        // On success the clipboard owns each memory block.
        SetClipboardData(u32::from(CF_HDROP.0), Some(HANDLE(files.0)))
            .map_err(|error| format!("SetClipboardData(CF_HDROP): {error}"))?;
        if preferred != 0 && SetClipboardData(preferred, Some(HANDLE(effect.0))).is_ok() {
            return Ok(true);
        }
        Ok(false)
    });
    match result {
        Ok(true) => Ok(()),
        Ok(false) => {
            let _ = unsafe { GlobalFree(Some(effect)) };
            Ok(())
        }
        Err(error) => {
            unsafe {
                let _ = GlobalFree(Some(files));
                let _ = GlobalFree(Some(effect));
            }
            Err(error)
        }
    }
}

fn global_bytes(size: usize, fill: impl FnOnce(*mut u8)) -> Result<HGLOBAL, String> {
    let memory = unsafe { GlobalAlloc(GMEM_MOVEABLE, size) }
        .map_err(|error| format!("GlobalAlloc: {error}"))?;
    let pointer = unsafe { GlobalLock(memory) };
    if pointer.is_null() {
        let _ = unsafe { GlobalFree(Some(memory)) };
        return Err("GlobalLock failed".into());
    }
    fill(pointer.cast::<u8>());
    // Returns an "error" of NO_ERROR once the lock count reaches zero.
    let _ = unsafe { GlobalUnlock(memory) };
    Ok(memory)
}

#[implement(IDropTarget)]
struct DropStrip;

fn refuse(effect: *mut DROPEFFECT) {
    if !effect.is_null() {
        unsafe { *effect = DROPEFFECT_NONE };
    }
}

impl IDropTarget_Impl for DropStrip_Impl {
    fn DragEnter(
        &self,
        data: Ref<IDataObject>,
        _: MODIFIERKEYS_FLAGS,
        _: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> WinResult<()> {
        let files = data.ok().map(hdrop_files).unwrap_or_default();
        *FILES.lock() = files;
        GENERATION.fetch_add(1, Ordering::AcqRel);
        refuse(effect);
        Ok(())
    }

    fn DragOver(
        &self,
        _: MODIFIERKEYS_FLAGS,
        _: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> WinResult<()> {
        refuse(effect);
        Ok(())
    }

    fn DragLeave(&self) -> WinResult<()> {
        Ok(())
    }

    fn Drop(
        &self,
        _: Ref<IDataObject>,
        _: MODIFIERKEYS_FLAGS,
        _: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> WinResult<()> {
        refuse(effect);
        Ok(())
    }
}

fn hdrop_files(data: &IDataObject) -> Vec<String> {
    let format = FORMATETC {
        cfFormat: CF_HDROP.0,
        ptd: null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    let Ok(mut medium) = (unsafe { data.GetData(&format) }) else {
        // Virtual items (zip contents, mail attachments) carry no CF_HDROP.
        return vec![];
    };
    let paths = if medium.tymed == TYMED_HGLOBAL.0 as u32 {
        hdrop_paths(HDROP(unsafe { medium.u.hGlobal.0 }))
    } else {
        vec![]
    };
    unsafe { ReleaseStgMedium(&mut medium) };
    paths
}

fn hdrop_paths(hdrop: HDROP) -> Vec<String> {
    let mut files = vec![];
    let count = unsafe { DragQueryFileW(hdrop, u32::MAX, None) };
    for index in 0..count {
        let length = unsafe { DragQueryFileW(hdrop, index, None) } as usize;
        let mut buffer = vec![0u16; length + 1];
        let copied = unsafe { DragQueryFileW(hdrop, index, Some(&mut buffer)) } as usize;
        if copied > 0 {
            files.push(String::from_utf16_lossy(&buffer[..copied.min(length)]));
        }
    }
    files
}

unsafe extern "system" fn strip_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_MOUSEACTIVATE {
        return LRESULT(MA_NOACTIVATE as isize);
    }
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

fn start_strip() -> Result<usize, String> {
    let (sender, receiver) = mpsc::channel::<Result<usize, String>>();
    thread::Builder::new()
        .name("compusync-drop-strip".into())
        .spawn(move || {
            let created = unsafe { create_strip() };
            let ok = created.is_ok();
            let _ = sender.send(created);
            if !ok {
                return;
            }
            let mut message = MSG::default();
            unsafe {
                while GetMessageW(&mut message, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
        })
        .map_err(|error| format!("drop strip thread: {error}"))?;
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "drop strip did not start".to_string())?
}

unsafe fn create_strip() -> Result<usize, String> {
    // OLE drag and drop requires an OLE-initialized STA thread.
    unsafe { OleInitialize(None) }.map_err(|error| format!("OleInitialize: {error}"))?;
    let instance = unsafe { GetModuleHandleW(PCWSTR::null()) }
        .map_err(|error| format!("GetModuleHandleW: {error}"))?;
    let class_name = w!("CompuSyncDropStrip");
    let class = WNDCLASSW {
        lpfnWndProc: Some(strip_proc),
        hInstance: instance.into(),
        lpszClassName: class_name,
        ..Default::default()
    };
    if unsafe { RegisterClassW(&class) } == 0 {
        return Err(format!(
            "RegisterClassW(drop strip): {}",
            std::io::Error::last_os_error()
        ));
    }
    // No title: Chrome window enumeration skips untitled windows.
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED,
            class_name,
            PCWSTR::null(),
            WS_POPUP,
            0,
            0,
            1,
            1,
            None,
            None,
            Some(instance.into()),
            None,
        )
    }
    .map_err(|error| format!("CreateWindowExW(drop strip): {error}"))?;
    // Alpha 1 of 255: invisible in practice, yet still hit-tested by OLE
    // (fully transparent layered windows are skipped).
    unsafe { SetLayeredWindowAttributes(hwnd, COLORREF(0), 1, LWA_ALPHA) }
        .map_err(|error| format!("SetLayeredWindowAttributes(drop strip): {error}"))?;
    let target: IDropTarget = DropStrip.into();
    unsafe { RegisterDragDrop(hwnd, &target) }
        .map_err(|error| format!("RegisterDragDrop(drop strip): {error}"))?;
    Ok(hwnd.0 as usize)
}

pub fn folder_at_point(point: Point) -> Result<Option<String>, String> {
    if !point.x.is_finite() || !point.y.is_finite() {
        return Err("point must be finite".into());
    }
    // Shell COM calls cross into Explorer and can block; give them their own
    // apartment thread and stop waiting after a bound.
    let (sender, receiver) = mpsc::channel();
    thread::Builder::new()
        .name("compusync-folder-at-point".into())
        .spawn(move || {
            let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
                .ok()
                .map_err(|error| format!("CoInitializeEx: {error}"))
                .map(|()| {
                    let folder = folder_under(POINT {
                        x: point.x.round() as i32,
                        y: point.y.round() as i32,
                    });
                    unsafe { CoUninitialize() };
                    folder
                });
            let _ = sender.send(result);
        })
        .map_err(|error| format!("folder lookup thread: {error}"))?;
    match receiver.recv_timeout(FOLDER_LOOKUP_TIMEOUT) {
        Ok(result) => result,
        Err(_) => Ok(None),
    }
}

fn class_name(hwnd: HWND) -> String {
    let mut buffer = [0u16; 256];
    let length = unsafe { GetClassNameW(hwnd, &mut buffer) }.max(0) as usize;
    String::from_utf16_lossy(&buffer[..length])
}

fn folder_under(point: POINT) -> Option<String> {
    // WindowFromPoint honours hit-testing, so click-through overlays and
    // cloaked windows on other virtual desktops are skipped.
    let hit = unsafe { WindowFromPoint(point) };
    if hit.is_invalid() {
        return None;
    }
    let root = unsafe { GetAncestor(hit, GA_ROOT) };
    if root.is_invalid() {
        return None;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(root, Some(&mut pid)) };
    if pid == std::process::id() {
        return None;
    }
    match class_name(root).as_str() {
        "Progman" | "WorkerW" => desktop_folder(),
        "CabinetWClass" => explorer_folder(root),
        _ => None,
    }
}

fn desktop_folder() -> Option<String> {
    let path = unsafe { SHGetKnownFolderPath(&FOLDERID_Desktop, KF_FLAG_DEFAULT, None) }.ok()?;
    let folder = unsafe { path.to_string() }.ok();
    unsafe { CoTaskMemFree(Some(path.0 as *const c_void)) };
    folder
}

fn explorer_folder(root: HWND) -> Option<String> {
    let windows: IShellWindows =
        unsafe { CoCreateInstance(&ShellWindows, None, CLSCTX_ALL) }.ok()?;
    // Windows 11 hosts several tabs in one frame; the first tab child is the
    // one on screen. Windows 10 frames have none and hold a single browser.
    let active_tab =
        unsafe { FindWindowExW(Some(root), None, w!("ShellTabWindowClass"), PCWSTR::null()) }.ok();
    let count = unsafe { windows.Count() }.ok()?;
    let mut matches = vec![];
    for index in 0..count {
        let Ok(dispatch) = (unsafe { windows.Item(&VARIANT::from(index)) }) else {
            continue;
        };
        let Ok(browser) = dispatch.cast::<IWebBrowserApp>() else {
            continue;
        };
        let Ok(frame) = (unsafe { browser.HWND() }) else {
            continue;
        };
        if frame.0 != root.0 as isize {
            continue;
        }
        let Ok(provider) = browser.cast::<IServiceProvider>() else {
            continue;
        };
        let Ok(shell) = (unsafe { provider.QueryService::<IShellBrowser>(&SID_STopLevelBrowser) })
        else {
            continue;
        };
        if let Some(tab) = active_tab {
            match unsafe { shell.GetWindow() } {
                Ok(window) if window == tab => {}
                _ => continue,
            }
        }
        if let Some(folder) = browser_folder(&shell) {
            matches.push(folder);
        }
    }
    // Never guess between several candidates.
    (matches.len() == 1).then(|| matches.remove(0))
}

fn browser_folder(shell: &IShellBrowser) -> Option<String> {
    let view = unsafe { shell.QueryActiveShellView() }.ok()?;
    let folder_view: IFolderView = view.cast().ok()?;
    let persist: IPersistFolder2 = unsafe { folder_view.GetFolder() }.ok()?;
    let pidl = unsafe { persist.GetCurFolder() }.ok()?;
    let mut buffer = vec![0u16; 32_768];
    // Fails for virtual folders (This PC, Recycle Bin, Home): not real paths.
    let ok = unsafe { SHGetPathFromIDListEx(pidl, &mut buffer, GPFIDL_DEFAULT) }.as_bool();
    unsafe { CoTaskMemFree(Some(pidl as *const c_void)) };
    if !ok {
        return None;
    }
    let length = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    (length > 0).then(|| String::from_utf16_lossy(&buffer[..length]))
}
