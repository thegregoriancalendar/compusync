//! A private, device-scoped tap. Muting belongs to the tap, not the user's
//! volume/default-device settings. Excluding this process prevents feedback.
use cpal::traits::{DeviceTrait, HostTrait};
use objc2::AnyThread;
use objc2_core_audio::*;
use objc2_core_foundation::{
    kCFAllocatorDefault, kCFTypeArrayCallBacks, kCFTypeDictionaryKeyCallBacks,
    kCFTypeDictionaryValueCallBacks, CFArray, CFDictionary, CFMutableDictionary, CFRetained,
    CFString,
};
use objc2_foundation::{NSArray, NSNumber, NSString};
use std::{
    ffi::{c_void, CStr},
    ptr::NonNull,
    sync::atomic::{AtomicU32, Ordering},
};
static INSTANCE: AtomicU32 = AtomicU32::new(0);

pub struct MutedTap {
    tap: u32,
    aggregate: u32,
}
impl MutedTap {
    pub fn new(output: &cpal::Device) -> Result<(Self, cpal::Device), String> {
        let device_id = output.id().map_err(|e| e.to_string())?;
        let property = AudioObjectPropertyAddress {
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        let pid = std::process::id() as i32;
        let mut process = 0u32;
        let mut size = 4u32;
        // The local playback stream is opened before this lookup so Core Audio
        // has registered the process. Never continue without excluding ourselves.
        check(
            unsafe {
                AudioObjectGetPropertyData(
                    kAudioObjectSystemObject as u32,
                    NonNull::from(&property),
                    4,
                    &pid as *const _ as *const c_void,
                    NonNull::from(&mut size),
                    NonNull::from(&mut process).cast(),
                )
            },
            "look up CompuSync's audio process",
        )?;
        if process == 0 {
            return Err(
                "Core Audio did not register CompuSync's playback process. Restart sharing.".into(),
            );
        }
        let excluded = NSArray::from_retained_slice(&[NSNumber::new_u32(process)]);
        let description = unsafe {
            CATapDescription::initExcludingProcesses_andDeviceUID_withStream(
                CATapDescription::alloc(),
                &excluded,
                &NSString::from_str(device_id.id()),
                0,
            )
        };
        unsafe {
            description.setName(&NSString::from_str("CompuSync synchronized audio"));
            description.setPrivate(true);
            description.setMuteBehavior(CATapMuteBehavior::MutedWhenTapped);
        }
        let mut tap = 0;
        check(
            unsafe { AudioHardwareCreateProcessTap(Some(&description), &mut tap) },
            "create muted system audio tap (check System Audio Recording permission)",
        )?;
        let mut guard = Self { tap, aggregate: 0 };
        let uid = format!(
            "app.compusync.audio.{}.{}",
            pid,
            INSTANCE.fetch_add(1, Ordering::Relaxed)
        );
        let tap_uid = unsafe { description.UUID().UUIDString() };
        let properties = aggregate_properties(&tap_uid, &uid);
        check(
            unsafe {
                AudioHardwareCreateAggregateDevice(&properties, NonNull::from(&mut guard.aggregate))
            },
            "create audio tap device",
        )?;
        let id = cpal::DeviceId::new(cpal::HostId::CoreAudio, &uid);
        let device = cpal::default_host()
            .device_by_id(&id)
            .ok_or("Core Audio tap device is unavailable.")?;
        Ok((guard, device))
    }
}
impl Drop for MutedTap {
    fn drop(&mut self) {
        // Input stream must be dropped first. Destroy even partially-created
        // resources, restoring normal local sound after any start failure.
        unsafe {
            if self.aggregate != 0 {
                AudioHardwareDestroyAggregateDevice(self.aggregate);
            }
            if self.tap != 0 {
                AudioHardwareDestroyProcessTap(self.tap);
            }
        }
    }
}
fn check(status: i32, operation: &str) -> Result<(), String> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!("Could not {operation}: Core Audio error {status}."))
    }
}
fn key(value: &'static CStr) -> CFRetained<CFString> {
    unsafe { CFString::with_c_string(kCFAllocatorDefault, value.as_ptr(), 0x08000100) }
        .expect("static UTF-8 Core Audio key")
}
fn dict() -> CFRetained<CFMutableDictionary> {
    unsafe {
        CFMutableDictionary::new(
            kCFAllocatorDefault,
            6,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        )
    }
    .expect("Core Audio dictionary allocation")
}
fn put<T>(dictionary: &CFMutableDictionary, name: &'static CStr, value: &T) {
    unsafe {
        CFMutableDictionary::set_value(
            Some(dictionary),
            &*key(name) as *const _ as *const c_void,
            value as *const T as *const c_void,
        )
    }
}
fn aggregate_properties(tap_uid: &NSString, uid: &str) -> CFRetained<CFDictionary> {
    let yes = NSNumber::new_bool(true);
    let tap = dict();
    put(&tap, kAudioSubTapUIDKey, tap_uid);
    put(&tap, kAudioSubTapDriftCompensationKey, &*yes);
    let values = [&*tap as *const _ as *const c_void];
    let taps = unsafe {
        CFArray::new(
            kCFAllocatorDefault,
            values.as_ptr() as *mut *const c_void,
            1,
            &kCFTypeArrayCallBacks,
        )
    }
    .expect("Core Audio tap array");
    let properties = dict();
    put(
        &properties,
        kAudioAggregateDeviceNameKey,
        &*CFString::from_str("CompuSync private synchronized capture"),
    );
    put(
        &properties,
        kAudioAggregateDeviceUIDKey,
        &*CFString::from_str(uid),
    );
    put(&properties, kAudioAggregateDeviceTapListKey, &*taps);
    put(&properties, kAudioAggregateDeviceTapAutoStartKey, &*yes);
    put(&properties, kAudioEndPointDeviceIsPrivateKey, &*yes);
    unsafe { CFRetained::cast_unchecked(properties) }
}
