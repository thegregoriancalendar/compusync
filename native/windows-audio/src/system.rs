use crate::{Defaults, Snapshot};
use std::ffi::c_void;
pub use windows;
use windows::{
    core::{IUnknown_Vtbl, Interface, GUID, PCWSTR, PWSTR},
    Win32::{
        Devices::FunctionDiscovery::{
            PKEY_DeviceInterface_FriendlyName, PKEY_Device_DeviceDesc, PKEY_Device_FriendlyName,
        },
        Foundation::{PROPERTYKEY, RPC_E_CHANGED_MODE},
        Media::Audio::*,
        System::Com::{
            StructuredStorage::{PropVariantClear, PropVariantToStringAlloc},
            *,
        },
    },
};

windows::core::define_interface!(Policy, PolicyVtbl, 0xf8679f50_850a_41cf_9c72_430f290290c8);
#[repr(C)]
pub struct PolicyVtbl {
    base: IUnknown_Vtbl,
    // IPolicyConfig: GetMixFormat through SetPropertyValue. These entries are
    // never invoked; SetDefaultEndpoint is the following COM vtable slot.
    unused: [usize; 10],
    set_default: unsafe extern "system" fn(*mut c_void, PCWSTR, ERole) -> windows::core::HRESULT,
}

pub struct Apartment(bool);
impl Apartment {
    pub fn new() -> Result<Self, String> {
        let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if result == RPC_E_CHANGED_MODE {
            return Ok(Self(false));
        }
        result.ok().map_err(|e| e.to_string())?;
        Ok(Self(true))
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

pub struct System {
    pub enumerator: IMMDeviceEnumerator,
    policy: Option<Policy>,
    _com: Apartment,
}
#[derive(Clone, Debug)]
pub struct Endpoint {
    pub id: String,
    pub label: String,
    pub bus: bool,
}
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
fn owned_string(value: PWSTR) -> String {
    let result = unsafe { value.to_string() }.unwrap_or_default();
    unsafe { CoTaskMemFree(Some(value.0.cast())) };
    result
}
fn property(device: &IMMDevice, key: &PROPERTYKEY) -> Result<String, String> {
    let store = unsafe { device.OpenPropertyStore(STGM_READ) }.map_err(|e| e.to_string())?;
    let mut value = unsafe { store.GetValue(key) }.map_err(|e| e.to_string())?;
    let result = unsafe { PropVariantToStringAlloc(&value) }
        .map(owned_string)
        .map_err(|e| e.to_string());
    let _ = unsafe { PropVariantClear(&mut value) };
    result
}
impl System {
    pub fn new() -> Result<Self, String> {
        let com = Apartment::new()?;
        let enumerator = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|e| e.to_string())?;
        Ok(Self {
            enumerator,
            policy: None,
            _com: com,
        })
    }
    pub fn enable_policy(&mut self) -> Result<(), String> {
        self.policy = Some(
            unsafe {
                CoCreateInstance(
                    &GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9),
                    None,
                    CLSCTX_ALL,
                )
            }
            .map_err(|e| {
                format!("Windows default-output routing is unavailable on this system: {e}")
            })?,
        );
        Ok(())
    }
    pub fn device(&self, id: &str) -> Result<IMMDevice, String> {
        unsafe { self.enumerator.GetDevice(PCWSTR(wide(id).as_ptr())) }.map_err(|e| e.to_string())
    }
    pub fn endpoints(&self) -> Result<Vec<Endpoint>, String> {
        let devices = unsafe {
            self.enumerator
                .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
        }
        .map_err(|e| e.to_string())?;
        let count = unsafe { devices.GetCount() }
            .map_err(|e| e.to_string())?
            .min(100);
        (0..count)
            .map(|i| {
                let device = unsafe { devices.Item(i) }.map_err(|e| e.to_string())?;
                let id = owned_string(unsafe { device.GetId() }.map_err(|e| e.to_string())?);
                let label = property(&device, &PKEY_Device_FriendlyName)?;
                // Verify the driver interface and endpoint description, rather than
                // trusting an editable display name or accepting physical speakers.
                let bus = property(&device, &PKEY_DeviceInterface_FriendlyName)
                    .ok()
                    .as_deref()
                    == Some("VB-Audio Virtual Cable")
                    && property(&device, &PKEY_Device_DeviceDesc).ok().as_deref()
                        == Some("CABLE Input");
                Ok(Endpoint { id, label, bus })
            })
            .collect()
    }
    pub fn plan(&self, bus_id: &str, output_id: &str) -> Result<Snapshot, String> {
        let endpoints = self.endpoints()?;
        let buses: Vec<_> = endpoints
            .iter()
            .filter(|d| d.bus && (bus_id.is_empty() || d.id == bus_id))
            .collect();
        if buses.len() != 1 {
            return Err("Windows sharing needs the standard VB-CABLE driver. Install it from vb-audio.com/Cable, reboot, then refresh audio devices.".into());
        }
        let bus = buses[0].id.clone();
        let output = if output_id.is_empty() {
            self.current(1)?
        } else {
            output_id.to_owned()
        };
        if !endpoints.iter().any(|d| d.id == output && !d.bus) || output == bus {
            return Err("Choose physical Windows speakers or headphones for delayed playback. The capture bus cannot also be the playback output.".into());
        }
        let originals = [self.current(0)?, self.current(1)?, self.current(2)?];
        if originals.iter().any(|id| id == &bus) {
            return Err("Before starting, choose physical speakers as the default and default communications output in Windows Sound settings. CompuSync will temporarily route them through VB-CABLE and restore them afterward.".into());
        }
        Ok(Snapshot {
            bus,
            output,
            originals,
        })
    }
    pub fn check_bypass(&self, owner: u32) -> Result<(), String> {
        for endpoint in self.endpoints()?.into_iter().filter(|d| !d.bus) {
            let device = self.device(&endpoint.id)?;
            let manager: IAudioSessionManager2 =
                unsafe { device.Activate(CLSCTX_ALL, None) }.map_err(|e| e.to_string())?;
            let sessions = unsafe { manager.GetSessionEnumerator() }.map_err(|e| e.to_string())?;
            for index in 0..unsafe { sessions.GetCount() }
                .map_err(|e| e.to_string())?
                .min(1000)
            {
                let session = unsafe { sessions.GetSession(index) }.map_err(|e| e.to_string())?;
                if unsafe { session.GetState() }.map_err(|e| e.to_string())?
                    != AudioSessionStateActive
                {
                    continue;
                }
                let control: IAudioSessionControl2 = session.cast().map_err(|e| e.to_string())?;
                if unsafe { control.GetProcessId() }.map_err(|e| e.to_string())? != owner {
                    return Err(format!("An app is still using {} directly. Set that app's output to System default (shared mode), restart its playback, and retry sharing.", endpoint.label));
                }
            }
        }
        Ok(())
    }
}
impl Defaults for System {
    fn current(&self, role: usize) -> Result<String, String> {
        let device = unsafe {
            self.enumerator
                .GetDefaultAudioEndpoint(eRender, ERole(role as i32))
        }
        .map_err(|e| e.to_string())?;
        Ok(owned_string(
            unsafe { device.GetId() }.map_err(|e| e.to_string())?,
        ))
    }
    fn set(&self, role: usize, id: &str) -> Result<(), String> {
        let policy = self
            .policy
            .as_ref()
            .ok_or("Windows routing policy is not initialized.")?;
        unsafe {
            (policy.vtable().set_default)(
                policy.as_raw(),
                PCWSTR(wide(id).as_ptr()),
                ERole(role as i32),
            )
        }
        .ok()
        .map_err(|e| e.to_string())?;
        if self.current(role)? != id {
            return Err("Windows did not accept the requested output.".into());
        }
        Ok(())
    }
    fn active(&self, id: &str) -> bool {
        self.device(id)
            .ok()
            .and_then(|d| unsafe { d.GetState() }.ok())
            == Some(DEVICE_STATE_ACTIVE)
    }
}

mod guard;
pub use guard::{recover_previous, run_guard};
