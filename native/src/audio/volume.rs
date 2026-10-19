//! Output-device volume, independent of the lifetime of an audio sharing route.
use super::AudioVolume;

#[cfg(target_os = "windows")]
mod platform {
    use super::AudioVolume;
    use cpal::traits::DeviceTrait;
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::RPC_E_CHANGED_MODE,
            Media::Audio::{
                Endpoints::IAudioEndpointVolume, IMMDeviceEnumerator, MMDeviceEnumerator,
            },
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
            },
        },
    };

    struct Apartment(bool);
    impl Drop for Apartment {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    fn with_endpoint(id: &str, level: Option<u32>) -> Result<AudioVolume, String> {
        let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if initialized != RPC_E_CHANGED_MODE {
            initialized.ok().map_err(|e| e.to_string())?;
        }
        let _apartment = Apartment(initialized != RPC_E_CHANGED_MODE);
        let device = super::super::device::output_device(id)?;
        let label = device
            .description()
            .map_err(|e| e.to_string())?
            .name()
            .to_string();
        let device_id = device.id().map_err(|e| e.to_string())?;
        let wide: Vec<u16> = device_id.id().encode_utf16().chain(Some(0)).collect();
        // Keep COM interfaces inside the apartment and on the calling thread.
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                    .map_err(|e| e.to_string())?;
            let endpoint = enumerator
                .GetDevice(PCWSTR(wide.as_ptr()))
                .map_err(|e| e.to_string())?;
            let volume: IAudioEndpointVolume = endpoint
                .Activate(CLSCTX_ALL, None)
                .map_err(|e| e.to_string())?;
            if let Some(level) = level {
                volume
                    .SetMasterVolumeLevelScalar(level as f32 / 100.0, std::ptr::null())
                    .map_err(|e| e.to_string())?;
                volume
                    .SetMute(level == 0, std::ptr::null())
                    .map_err(|e| e.to_string())?;
            }
            Ok(AudioVolume {
                level: (volume
                    .GetMasterVolumeLevelScalar()
                    .map_err(|e| e.to_string())?
                    * 100.0)
                    .round()
                    .clamp(0.0, 100.0) as u32,
                muted: volume.GetMute().map_err(|e| e.to_string())?.as_bool(),
                label,
            })
        }
    }
    pub fn get(id: &str) -> Result<AudioVolume, String> {
        with_endpoint(id, None)
    }
    pub fn set(id: &str, level: u32) -> Result<AudioVolume, String> {
        with_endpoint(id, Some(level))
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::AudioVolume;
    use cpal::traits::DeviceTrait;
    use objc2_core_audio::*;
    use objc2_core_foundation::CFString;
    use std::ptr::NonNull;

    fn address(selector: u32, element: u32) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: element,
        }
    }
    fn check(status: i32) -> Result<(), String> {
        if status == 0 {
            Ok(())
        } else {
            Err(format!(
                "Could not access output volume (Core Audio {status})."
            ))
        }
    }
    fn read<T: Default>(device: u32, property: &AudioObjectPropertyAddress) -> Result<T, String> {
        let mut value = T::default();
        let mut size = std::mem::size_of::<T>() as u32;
        check(unsafe {
            AudioObjectGetPropertyData(
                device,
                NonNull::from(property),
                0,
                std::ptr::null(),
                NonNull::from(&mut size),
                NonNull::from(&mut value).cast(),
            )
        })?;
        Ok(value)
    }
    fn write<T>(
        device: u32,
        property: &AudioObjectPropertyAddress,
        value: &T,
    ) -> Result<(), String> {
        check(unsafe {
            AudioObjectSetPropertyData(
                device,
                NonNull::from(property),
                0,
                std::ptr::null(),
                std::mem::size_of::<T>() as u32,
                NonNull::from(value).cast(),
            )
        })
    }
    fn controls(device: u32, selector: u32) -> Vec<AudioObjectPropertyAddress> {
        let mut properties = vec![];
        // Some outputs expose a master control; built-in speakers often expose
        // individual channels instead. Fixed-volume outputs expose neither.
        for element in 0..=32 {
            let property = address(selector, element);
            let mut settable = 0;
            if unsafe { AudioObjectHasProperty(device, NonNull::from(&property)) }
                && unsafe {
                    AudioObjectIsPropertySettable(
                        device,
                        NonNull::from(&property),
                        NonNull::from(&mut settable),
                    )
                } == 0
                && settable != 0
            {
                properties.push(property);
                if element == 0 {
                    break;
                }
            }
        }
        properties
    }
    fn with_output(id: &str, level: Option<u32>) -> Result<AudioVolume, String> {
        let output = super::super::device::output_device(id)?;
        let label = output
            .description()
            .map_err(|e| e.to_string())?
            .name()
            .to_string();
        let device_id = output.id().map_err(|e| e.to_string())?;
        let uid = CFString::from_str(device_id.id());
        let uid_pointer = NonNull::from(&*uid).as_ptr();
        let mut device = 0u32;
        let mut size = std::mem::size_of_val(&device) as u32;
        let property = AudioObjectPropertyAddress {
            mSelector: kAudioHardwarePropertyTranslateUIDToDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        check(unsafe {
            AudioObjectGetPropertyData(
                kAudioObjectSystemObject as u32,
                NonNull::from(&property),
                std::mem::size_of_val(&uid_pointer) as u32,
                std::ptr::from_ref(&uid_pointer).cast(),
                NonNull::from(&mut size),
                NonNull::from(&mut device).cast(),
            )
        })?;
        if device == 0 {
            return Err("The selected output is unavailable.".into());
        }
        let volumes = controls(device, kAudioDevicePropertyVolumeScalar);
        if volumes.is_empty() {
            return Err("Adjust this output's volume on the device itself.".into());
        }
        let mutes = controls(device, kAudioDevicePropertyMute);
        if let Some(level) = level {
            for property in &volumes {
                write(device, property, &(level as f32 / 100.0))?;
            }
            for property in &mutes {
                write(device, property, &u32::from(level == 0))?;
            }
        }
        let mut scalar = 0.0;
        for property in &volumes {
            scalar += read::<f32>(device, property)?;
        }
        let mut muted = false;
        for property in &mutes {
            muted |= read::<u32>(device, property)? != 0;
        }
        Ok(AudioVolume {
            level: (scalar / volumes.len() as f32 * 100.0)
                .round()
                .clamp(0.0, 100.0) as u32,
            muted,
            label,
        })
    }
    pub fn get(id: &str) -> Result<AudioVolume, String> {
        with_output(id, None)
    }
    pub fn set(id: &str, level: u32) -> Result<AudioVolume, String> {
        with_output(id, Some(level))
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod platform {
    use super::AudioVolume;
    pub fn get(_id: &str) -> Result<AudioVolume, String> {
        Err("Output volume is available on Mac and Windows.".into())
    }
    pub fn set(id: &str, _level: u32) -> Result<AudioVolume, String> {
        get(id)
    }
}

pub use platform::{get, set};
