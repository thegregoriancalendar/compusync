//! macOS services for dragging and copy/pasting files between computers.
//!
//! AppKit publishes the payload of every drag session on the shared drag
//! pasteboard (`NSPasteboardNameDrag`). The pasteboard keeps the last drag's
//! contents after it ends, so callers pair `drag_files` with
//! `drag_generation` (its `changeCount`) sampled at button-down to know that
//! the files belong to the current press.
//!
//! The general pasteboard (the clipboard) is read and written the same way
//! for copied files: `clipboard_generation` is its `changeCount`.

use crate::{Point, Rect, ScreenWindow};
use objc2::{
    class, msg_send,
    rc::{autoreleasepool, Retained},
    runtime::{AnyClass, AnyObject},
};
use objc2_foundation::NSString;
use std::{ffi::c_void, ptr::null};

type CfType = *const c_void;
type CfArray = *const c_void;
type CfString = *const c_void;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CgPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CgSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CgRect {
    origin: CgPoint,
    size: CgSize,
}

const CG_WINDOW_LIST_ON_SCREEN_ONLY: u32 = 1;
const CF_NUMBER_SINT64: i32 = 4;
const CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

// AppKit, CoreFoundation and ApplicationServices are linked by build.rs.
unsafe extern "C" {
    static NSPasteboardNameDrag: *const AnyObject;
}

unsafe extern "C" {
    static kCGWindowNumber: CfString;
    static kCGWindowOwnerPID: CfString;
    static kCGWindowOwnerName: CfString;
    static kCGWindowLayer: CfString;
    static kCGWindowBounds: CfString;
    fn CFRelease(value: CfType);
    fn CFArrayGetCount(array: CfArray) -> isize;
    fn CFArrayGetValueAtIndex(array: CfArray, index: isize) -> CfType;
    fn CFDictionaryGetValue(dictionary: CfType, key: CfType) -> CfType;
    fn CFNumberGetValue(number: CfType, kind: i32, value: *mut c_void) -> bool;
    fn CFStringGetCString(string: CfString, buffer: *mut i8, size: isize, encoding: u32) -> bool;
    fn CGWindowListCopyWindowInfo(options: u32, relative: u32) -> CfArray;
    fn CGRectMakeWithDictionaryRepresentation(dictionary: CfType, rect: *mut CgRect) -> bool;
}

fn drag_pasteboard() -> Option<Retained<AnyObject>> {
    // SAFETY: AppKit's exported constant is an immutable NSString.
    let name = unsafe { NSPasteboardNameDrag };
    if name.is_null() {
        return None;
    }
    // SAFETY: +[NSPasteboard pasteboardWithName:] takes an NSString and
    // returns an autoreleased (retained by msg_send!) pasteboard.
    unsafe { msg_send![class!(NSPasteboard), pasteboardWithName: name] }
}

fn general_pasteboard() -> Option<Retained<AnyObject>> {
    // SAFETY: +[NSPasteboard generalPasteboard] returns the shared clipboard.
    unsafe { msg_send![class!(NSPasteboard), generalPasteboard] }
}

fn change_count(pasteboard: Option<Retained<AnyObject>>) -> f64 {
    pasteboard
        // SAFETY: -changeCount returns NSInteger.
        .map(|pasteboard| unsafe { msg_send![&*pasteboard, changeCount] })
        .map(|count: isize| count as f64)
        .unwrap_or(0.0)
}

fn file_paths(pasteboard: &AnyObject) -> Result<Vec<String>, String> {
    let url_class: &AnyClass = class!(NSURL);
    let url_class = url_class as *const AnyClass as *const AnyObject;
    // SAFETY: NSArray holds the NSURL class object; readObjectsForClasses
    // returns only NSURL instances (or nil when nothing can be read).
    let classes: Option<Retained<AnyObject>> =
        unsafe { msg_send![class!(NSArray), arrayWithObject: url_class] };
    let classes = classes.ok_or("could not build the pasteboard class list")?;
    let none: *const AnyObject = null();
    let urls: Option<Retained<AnyObject>> =
        unsafe { msg_send![pasteboard, readObjectsForClasses: &*classes, options: none] };
    let Some(urls) = urls else {
        return Ok(vec![]);
    };
    let count: usize = unsafe { msg_send![&*urls, count] };
    let mut paths = Vec::with_capacity(count);
    for index in 0..count {
        let url: *mut AnyObject = unsafe { msg_send![&*urls, objectAtIndex: index] };
        if url.is_null() || !unsafe { msg_send![url, isFileURL] } {
            continue;
        }
        // Finder publishes file reference URLs (file:///.file/id=…);
        // filePathURL resolves them to a path, nil if the item vanished.
        let path_url: Option<Retained<AnyObject>> = unsafe { msg_send![url, filePathURL] };
        let Some(path_url) = path_url else { continue };
        let path: Option<Retained<NSString>> = unsafe { msg_send![&*path_url, path] };
        if let Some(path) = path {
            let path = path.to_string();
            if path.starts_with('/') {
                paths.push(path);
            }
        }
    }
    Ok(paths)
}

pub fn drag_generation() -> f64 {
    autoreleasepool(|_| change_count(drag_pasteboard()))
}

pub fn drag_files() -> Result<Vec<String>, String> {
    autoreleasepool(|_| {
        let pasteboard = drag_pasteboard().ok_or("the drag pasteboard is unavailable")?;
        file_paths(&pasteboard)
    })
}

/// Changes whenever anything is copied (the general pasteboard changeCount).
pub fn clipboard_generation() -> f64 {
    autoreleasepool(|_| change_count(general_pasteboard()))
}

/// Files and folders currently on the clipboard (copied in Finder, …).
pub fn clipboard_files() -> Result<Vec<String>, String> {
    autoreleasepool(|_| {
        let pasteboard = general_pasteboard().ok_or("the clipboard is unavailable")?;
        file_paths(&pasteboard)
    })
}

/// Replaces the clipboard with these files, as Finder's Copy would.
pub fn set_clipboard_files(paths: &[String]) -> Result<(), String> {
    autoreleasepool(|_| {
        let pasteboard = general_pasteboard().ok_or("the clipboard is unavailable")?;
        let urls: Option<Retained<AnyObject>> =
            unsafe { msg_send![class!(NSMutableArray), arrayWithCapacity: paths.len()] };
        let urls = urls.ok_or("could not build the URL list")?;
        for path in paths {
            if !path.starts_with('/') {
                return Err("clipboard paths must be absolute".into());
            }
            let path = NSString::from_str(path);
            let url: Option<Retained<AnyObject>> =
                unsafe { msg_send![class!(NSURL), fileURLWithPath: &*path] };
            let url = url.ok_or("could not build a file URL")?;
            let _: () = unsafe { msg_send![&*urls, addObject: &*url] };
        }
        let _: isize = unsafe { msg_send![&*pasteboard, clearContents] };
        let written: bool = unsafe { msg_send![&*pasteboard, writeObjects: &*urls] };
        written
            .then_some(())
            .ok_or_else(|| "the clipboard refused the files".into())
    })
}

fn dictionary_i64(dictionary: CfType, key: CfString) -> Option<i64> {
    let number = unsafe { CFDictionaryGetValue(dictionary, key) };
    if number.is_null() {
        return None;
    }
    let mut value = 0i64;
    unsafe { CFNumberGetValue(number, CF_NUMBER_SINT64, (&mut value as *mut i64).cast()) }
        .then_some(value)
}

fn dictionary_string(dictionary: CfType, key: CfString) -> String {
    let value = unsafe { CFDictionaryGetValue(dictionary, key) };
    if value.is_null() {
        return String::new();
    }
    let mut buffer = [0i8; 512];
    if !unsafe {
        CFStringGetCString(
            value,
            buffer.as_mut_ptr(),
            buffer.len() as isize,
            CF_STRING_ENCODING_UTF8,
        )
    } {
        return String::new();
    }
    // SAFETY: CFStringGetCString NUL-terminates on success.
    unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) }
        .to_string_lossy()
        .into_owned()
}

/// On-screen windows whose bounds contain `point` (CoreGraphics global
/// points, top-left origin), ordered front to back. Includes desktop
/// elements such as Finder's desktop-icon window.
pub fn windows_at_point(point: Point) -> Result<Vec<ScreenWindow>, String> {
    if !point.x.is_finite() || !point.y.is_finite() {
        return Err("point must be finite".into());
    }
    let list = unsafe { CGWindowListCopyWindowInfo(CG_WINDOW_LIST_ON_SCREEN_ONLY, 0) };
    if list.is_null() {
        return Err("CGWindowListCopyWindowInfo failed".into());
    }
    let mut result = vec![];
    for index in 0..unsafe { CFArrayGetCount(list) } {
        let window = unsafe { CFArrayGetValueAtIndex(list, index) };
        let bounds_dictionary = unsafe { CFDictionaryGetValue(window, kCGWindowBounds) };
        let mut bounds = CgRect::default();
        if bounds_dictionary.is_null()
            || !unsafe { CGRectMakeWithDictionaryRepresentation(bounds_dictionary, &mut bounds) }
        {
            continue;
        }
        let inside = point.x >= bounds.origin.x
            && point.y >= bounds.origin.y
            && point.x < bounds.origin.x + bounds.size.width
            && point.y < bounds.origin.y + bounds.size.height;
        if !inside {
            continue;
        }
        let (Some(id), Some(pid), Some(layer)) = (
            dictionary_i64(window, unsafe { kCGWindowNumber }),
            dictionary_i64(window, unsafe { kCGWindowOwnerPID }),
            dictionary_i64(window, unsafe { kCGWindowLayer }),
        ) else {
            continue;
        };
        result.push(ScreenWindow {
            id: id.to_string(),
            pid: pid.clamp(0, u32::MAX as i64) as u32,
            owner_name: dictionary_string(window, unsafe { kCGWindowOwnerName }),
            layer: layer.clamp(i32::MIN as i64, i32::MAX as i64) as i32,
            bounds: Rect {
                x: bounds.origin.x,
                y: bounds.origin.y,
                width: bounds.size.width,
                height: bounds.size.height,
            },
        });
    }
    unsafe { CFRelease(list) };
    Ok(result)
}
