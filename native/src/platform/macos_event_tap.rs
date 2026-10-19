// Keep callback routing independent of CoreGraphics so recovery can be tested
// on either development platform without installing a global input hook.
#[cfg(target_os = "macos")]
pub(super) const CG_HID_EVENT_TAP: u32 = 0;
pub(super) const CG_EVENT_TAP_DISABLED_TIMEOUT: u32 = 0xFFFF_FFFE;
pub(super) const CG_EVENT_TAP_DISABLED_USER: u32 = 0xFFFF_FFFF;

pub(super) fn dispatch<T>(
    kind: u32,
    event: *mut T,
    reenable: impl FnOnce(),
    handle_input: impl FnOnce() -> *mut T,
) -> *mut T {
    // Disabled-tap notifications need not carry a CGEvent. Process them before
    // rejecting null input, or one timeout can leave capture disabled forever.
    if kind == CG_EVENT_TAP_DISABLED_TIMEOUT || kind == CG_EVENT_TAP_DISABLED_USER {
        reenable();
        return event;
    }
    if event.is_null() {
        return event;
    }
    handle_input()
}

#[cfg(test)]
mod tests {
    use super::{dispatch, CG_EVENT_TAP_DISABLED_TIMEOUT, CG_EVENT_TAP_DISABLED_USER};
    use std::ptr::null_mut;

    #[test]
    fn disabled_tap_recovers_with_or_without_an_event_payload() {
        for kind in [CG_EVENT_TAP_DISABLED_TIMEOUT, CG_EVENT_TAP_DISABLED_USER] {
            let mut payload = 0u8;
            for event in [null_mut(), &mut payload as *mut u8] {
                let mut enabled = false;
                let returned = dispatch(
                    kind,
                    event,
                    || enabled = true,
                    || panic!("a disabled-tap notification is not physical input"),
                );
                assert!(enabled);
                assert_eq!(returned, event);
            }
        }
    }

    #[test]
    fn null_physical_input_does_not_reenable_or_dispatch() {
        assert!(dispatch::<u8>(
            5,
            null_mut(),
            || panic!("ordinary input must not reenable the tap"),
            || panic!("null input must not be inspected"),
        )
        .is_null());
    }

    #[test]
    fn physical_input_can_pass_through_or_be_suppressed() {
        let mut payload = 0u8;
        let event = &mut payload as *mut u8;
        for owner in [true, false] {
            let mut forwarded = false;
            let returned = dispatch(
                5,
                event,
                || panic!("ordinary input must not reenable the tap"),
                || {
                    // Raw motion still reaches the shared cursor even when
                    // the non-owner Mac suppresses local OS delivery.
                    forwarded = true;
                    if owner {
                        event
                    } else {
                        null_mut()
                    }
                },
            );
            assert!(forwarded);
            assert_eq!(returned, if owner { event } else { null_mut() });
        }
    }
}
