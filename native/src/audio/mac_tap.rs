//! A private, device-scoped tap. Muting belongs to the tap, not the user's
//! volume/default-device settings. Excluding this process prevents feedback.
use super::{buffer::CapturedFrame, clock, Stats};
use cpal::traits::DeviceTrait;
use objc2::AnyThread;
use objc2_core_audio::*;
use objc2_core_audio_types::{
    kAudioFormatFlagIsBigEndian, kAudioFormatFlagIsFloat, kAudioFormatFlagIsNonInterleaved,
    kAudioFormatLinearPCM, AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp,
    AudioTimeStampFlags,
};
use objc2_core_foundation::{
    kCFAllocatorDefault, kCFTypeArrayCallBacks, kCFTypeDictionaryKeyCallBacks,
    kCFTypeDictionaryValueCallBacks, CFArray, CFDictionary, CFMutableDictionary, CFRetained,
    CFString,
};
use objc2_foundation::{NSArray, NSNumber, NSString};
use std::{
    cell::UnsafeCell,
    ffi::{c_void, CStr},
    ptr::NonNull,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    },
};
static INSTANCE: AtomicU32 = AtomicU32::new(0);

struct CaptureContext {
    producer: rtrb::Producer<CapturedFrame>,
    stats: Arc<Stats>,
    rate: u32,
}

unsafe extern "C-unwind" fn capture_callback(
    _device: u32,
    _now: NonNull<AudioTimeStamp>,
    input: NonNull<AudioBufferList>,
    input_time: NonNull<AudioTimeStamp>,
    _output: NonNull<AudioBufferList>,
    _output_time: NonNull<AudioTimeStamp>,
    context: *mut c_void,
) -> i32 {
    // Core Audio owns the buffers and calls this IOProc serially. The boxed
    // context remains stable until AudioDeviceStop/DestroyIOProcID completes.
    let context = unsafe { &mut *context.cast::<CaptureContext>() };
    if context.stats.stopped.load(Ordering::Relaxed) {
        return 0;
    }
    let timestamp = unsafe { input_time.as_ref() };
    if !timestamp
        .mFlags
        .contains(AudioTimeStampFlags::HostTimeValid)
    {
        context
            .stats
            .device_clock_invalid
            .store(true, Ordering::Relaxed);
        return 0;
    }
    let list = unsafe { input.as_ref() };
    if list.mNumberBuffers == 0 || list.mNumberBuffers > 64 {
        return 0;
    }
    let buffers =
        unsafe { std::slice::from_raw_parts(list.mBuffers.as_ptr(), list.mNumberBuffers as usize) };
    let Some(first) = buffers
        .first()
        .filter(|b| !b.mData.is_null() && b.mNumberChannels > 0)
    else {
        return 0;
    };
    let samples = unsafe {
        std::slice::from_raw_parts(first.mData.cast::<f32>(), first.mDataByteSize as usize / 4)
    };
    let stride = first.mNumberChannels as usize;
    let right = if stride >= 2 {
        Some((samples.get(1..).unwrap_or(&[]), stride))
    } else {
        buffers
            .get(1)
            .filter(|b| !b.mData.is_null() && b.mNumberChannels > 0)
            .map(|b| {
                (
                    unsafe {
                        std::slice::from_raw_parts(
                            b.mData.cast::<f32>(),
                            b.mDataByteSize as usize / 4,
                        )
                    },
                    b.mNumberChannels as usize,
                )
            })
    };
    let (count, overflow) = super::buffer::push_capture_block(
        (samples, stride),
        right,
        clock::mac_host_ns(timestamp.mHostTime),
        context.rate,
        &mut context.producer,
    );
    context
        .stats
        .captured
        .fetch_add(count as u64, Ordering::Relaxed);
    if overflow {
        context
            .stats
            .resync_requested
            .store(true, Ordering::Release);
    }
    0
}

pub struct MutedTap {
    tap: u32,
    aggregate: u32,
    io: AudioDeviceIOProcID,
    context: Option<Box<UnsafeCell<CaptureContext>>>,
}
// Only Core Audio's serial IO callback accesses context while running. Drop
// stops and destroys that callback before releasing context or the device.
unsafe impl Send for MutedTap {}
impl MutedTap {
    pub fn new(
        output: &cpal::Device,
        producer: rtrb::Producer<CapturedFrame>,
        stats: Arc<Stats>,
    ) -> Result<(Self, u32), String> {
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
        let mut guard = Self {
            tap,
            aggregate: 0,
            io: None,
            context: None,
        };
        let format_property = AudioObjectPropertyAddress {
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        // ASBD contains only scalar numeric fields; all-zero is a valid initial value.
        let mut format: AudioStreamBasicDescription = unsafe { std::mem::zeroed() };
        let mut size = std::mem::size_of_val(&format) as u32;
        check(
            unsafe {
                AudioObjectGetPropertyData(
                    tap,
                    NonNull::from(&format_property),
                    0,
                    std::ptr::null(),
                    NonNull::from(&mut size),
                    NonNull::from(&mut format).cast(),
                )
            },
            "read system audio tap format",
        )?;
        if format.mFormatID != kAudioFormatLinearPCM
            || format.mBitsPerChannel != 32
            || format.mFormatFlags & kAudioFormatFlagIsFloat == 0
            || format.mFormatFlags & kAudioFormatFlagIsBigEndian != 0
            || !format.mSampleRate.is_finite()
            || !(8_000.0..=192_000.0).contains(&format.mSampleRate)
            || format.mSampleRate.fract() != 0.0
            || format.mChannelsPerFrame == 0
            || format.mBytesPerFrame
                != if format.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0 {
                    4
                } else {
                    format.mChannelsPerFrame.saturating_mul(4)
                }
        {
            return Err("The Mac tap requires native 32-bit float PCM. Choose built-in or wired speakers and retry.".into());
        }
        let rate = format.mSampleRate as u32;
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
        // A private aggregate is absent from CPAL's public enumeration. Use
        // the AudioDeviceID returned by Core Audio directly; never publish it.
        guard.context = Some(Box::new(UnsafeCell::new(CaptureContext {
            producer,
            stats,
            rate,
        })));
        let context = guard.context.as_ref().unwrap().get().cast();
        check(
            unsafe {
                AudioDeviceCreateIOProcID(
                    guard.aggregate,
                    Some(capture_callback),
                    context,
                    NonNull::from(&mut guard.io),
                )
            },
            "register system audio capture callback",
        )?;
        check(unsafe { AudioDeviceStart(guard.aggregate, guard.io) },
            "start system audio capture (allow System Audio Recording for CompuSync or Electron, then restart after a denial)")?;
        Ok((guard, rate))
    }
}
impl Drop for MutedTap {
    fn drop(&mut self) {
        // Stop IO before freeing its context or tap. Destroy even partially-
        // created resources, restoring normal sound after any start failure.
        unsafe {
            if self.io.is_some() {
                AudioDeviceStop(self.aggregate, self.io);
                AudioDeviceDestroyIOProcID(self.aggregate, self.io);
            }
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
    put(&properties, kAudioAggregateDeviceIsPrivateKey, &*yes);
    unsafe { CFRetained::cast_unchecked(properties) }
}
