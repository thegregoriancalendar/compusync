#![deny(unsafe_op_in_unsafe_fn)]
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub bus: String,
    pub output: String,
    pub originals: [String; 3],
}

pub trait Defaults {
    fn current(&self, role: usize) -> Result<String, String>;
    fn set(&self, role: usize, id: &str) -> Result<(), String>;
    fn active(&self, id: &str) -> bool;
}

/// Restore only defaults still owned by this route. A user changing a default
/// is authoritative. A missing original falls back to the selected output.
pub fn restore(system: &impl Defaults, snapshot: &Snapshot) -> Result<(), String> {
    let mut errors = vec![];
    for role in 0..3 {
        match system.current(role) {
            Ok(id) if id == snapshot.bus => (),
            Ok(_) => continue,
            Err(error) => {
                errors.push(error);
                continue;
            }
        }
        let original = &snapshot.originals[role];
        let target = if system.active(original) {
            original
        } else {
            &snapshot.output
        };
        if !system.active(target) {
            errors.push("Previous Windows output is disconnected. Choose an output in Windows Sound settings.".into());
            continue;
        }
        if let Err(error) = system.set(role, target) {
            errors.push(error);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join(" "))
    }
}

pub fn apply(system: &impl Defaults, snapshot: &Snapshot) -> Result<(), String> {
    apply_with_recovery(system, snapshot).result
}

/// Run the pipe protocol independently from Windows/COM, so cancellation,
/// heartbeat loss, and failed announcements exercise the same recovery path.
pub struct GuardOutcome {
    pub result: Result<(), String>,
    pub restored: bool,
}

fn current(system: &impl Defaults, role: usize) -> Result<String, String> {
    let name = ["console", "multimedia", "communications"][role];
    system
        .current(role)
        .map_err(|error| format!("Could not read the Windows {name} output during setup: {error}"))
}
fn changed(role: usize) -> String {
    let name = ["console", "multimedia", "communications"][role];
    format!("Windows {name} output changed during setup. Retry sharing.")
}
fn finish_recovery(
    system: &impl Defaults,
    snapshot: &Snapshot,
    result: Result<(), String>,
) -> GuardOutcome {
    let recovery = restore(system, snapshot);
    GuardOutcome {
        restored: recovery.is_ok(),
        result: recovery.and(result),
    }
}
fn apply_with_recovery(system: &impl Defaults, snapshot: &Snapshot) -> GuardOutcome {
    let mut attempted = false;
    let result = (|| {
        // Validate the whole snapshot before our first write. A change before
        // START belongs to the user and must not be "recovered" by this route.
        for role in 0..3 {
            if current(system, role)? != snapshot.originals[role] {
                return Err(changed(role));
            }
        }
        for role in 0..3 {
            let id = current(system, role)?;
            // Windows can link console and multimedia defaults: writing the
            // first role can already move the second role to our bus. Accept
            // that side effect, but never replace an unrelated new selection.
            if id != snapshot.originals[role] && id != snapshot.bus {
                return Err(changed(role));
            }
            attempted = true; // A failing setter may still have changed Windows.
            system
                .set(role, &snapshot.bus)
                .map_err(|error| format!("Could not route Windows audio: {error}"))?;
        }
        // A later setter or external change must not undo an earlier role.
        for role in 0..3 {
            if current(system, role)? != snapshot.bus {
                return Err(changed(role));
            }
        }
        Ok(())
    })();
    if result.is_err() && attempted {
        finish_recovery(system, snapshot, result)
    } else {
        GuardOutcome {
            result,
            restored: !attempted,
        }
    }
}
pub fn guard_defaults(
    system: &impl Defaults,
    snapshot: &Snapshot,
    commands: std::sync::mpsc::Receiver<String>,
    mut announce: impl FnMut(&str) -> Result<(), String>,
    mut monitor: impl FnMut() -> Result<(), String>,
    watchdog: std::time::Duration,
) -> GuardOutcome {
    use std::{
        sync::mpsc::RecvTimeoutError,
        time::{Duration, Instant},
    };
    let start = (|| {
        announce("READY")?;
        if commands.recv_timeout(watchdog).ok().as_deref() != Some("START") {
            return Err("Windows routing start was cancelled.".into());
        }
        Ok(())
    })();
    if start.is_err() {
        return GuardOutcome {
            result: start,
            restored: true,
        };
    }
    let applied = apply_with_recovery(system, snapshot);
    if applied.result.is_err() {
        return applied;
    }
    let result = (|| {
        announce("ROUTED")?;
        let mut heartbeat = Instant::now();
        loop {
            match commands.recv_timeout(watchdog.min(Duration::from_millis(200))) {
                Ok(command) if command == "HEARTBEAT" => heartbeat = Instant::now(),
                Ok(_) | Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => (),
            }
            if heartbeat.elapsed() >= watchdog {
                break;
            }
            monitor()?;
        }
        Ok(())
    })();
    finish_recovery(system, snapshot, result)
}

#[cfg(windows)]
mod system;
#[cfg(windows)]
pub use system::*;

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    #[cfg(windows)]
    #[test]
    fn missing_bus_preflight_leaves_real_windows_defaults_unchanged() {
        let mut system = System::new().unwrap();
        system.enable_policy().unwrap(); // Activation only; never calls SetDefaultEndpoint.
        let originals: Vec<_> = (0..3).map(|role| system.current(role).unwrap()).collect();
        assert!(system
            .plan("compusync-nonexistent-test-bus", &originals[1])
            .is_err());
        assert_eq!(
            (0..3)
                .map(|role| system.current(role).unwrap())
                .collect::<Vec<_>>(),
            originals
        );
    }
    struct Fake {
        current: RefCell<[String; 3]>,
        fail: Option<usize>,
        missing: Vec<String>,
    }
    impl Defaults for Fake {
        fn current(&self, role: usize) -> Result<String, String> {
            Ok(self.current.borrow()[role].clone())
        }
        fn active(&self, id: &str) -> bool {
            !self.missing.iter().any(|v| v == id)
        }
        fn set(&self, role: usize, id: &str) -> Result<(), String> {
            if self.fail == Some(role) && id == "bus" {
                return Err("injected failure".into());
            }
            self.current.borrow_mut()[role] = id.into();
            Ok(())
        }
    }
    fn snapshot() -> Snapshot {
        Snapshot {
            bus: "bus".into(),
            output: "speakers".into(),
            originals: [
                "speakers".into(),
                "headphones".into(),
                "communications".into(),
            ],
        }
    }
    // Reproduce Windows linking eConsole and eMultimedia, rather than assuming
    // that setting one ERole only affects that one ERole.
    struct Linked(Fake);
    impl Defaults for Linked {
        fn current(&self, role: usize) -> Result<String, String> {
            self.0.current(role)
        }
        fn active(&self, id: &str) -> bool {
            self.0.active(id)
        }
        fn set(&self, role: usize, id: &str) -> Result<(), String> {
            self.0.set(role, id)?;
            if role < 2 {
                self.0.current.borrow_mut()[1 - role] = id.into();
            }
            Ok(())
        }
    }
    fn linked(fail: Option<usize>) -> (Snapshot, Linked) {
        let mut s = snapshot();
        s.originals[1] = s.originals[0].clone();
        let f = Linked(Fake {
            current: RefCell::new(s.originals.clone()),
            fail,
            missing: vec![],
        });
        (s, f)
    }
    #[test]
    fn linked_console_and_multimedia_roles_route_and_restore() {
        let (s, f) = linked(None);
        apply(&f, &s).unwrap();
        assert_eq!(*f.0.current.borrow(), ["bus", "bus", "bus"]);
        restore(&f, &s).unwrap();
        assert_eq!(*f.0.current.borrow(), s.originals);
    }
    #[test]
    fn linked_roles_roll_back_after_a_later_switch_failure() {
        for failed in 1..3 {
            let (s, f) = linked(Some(failed));
            assert!(apply(&f, &s).is_err());
            assert_eq!(*f.0.current.borrow(), s.originals);
        }
    }
    #[test]
    fn linked_roles_preserve_a_later_user_selection() {
        let (s, f) = linked(None);
        apply(&f, &s).unwrap();
        f.set(1, "user-choice").unwrap();
        restore(&f, &s).unwrap();
        assert_eq!(
            *f.0.current.borrow(),
            ["user-choice", "user-choice", "communications"]
        );
    }
    #[test]
    fn unrelated_changes_during_switch_still_abort_and_preserve_user_choice() {
        struct Changing(Fake, usize, usize);
        impl Defaults for Changing {
            fn current(&self, role: usize) -> Result<String, String> {
                self.0.current(role)
            }
            fn active(&self, id: &str) -> bool {
                self.0.active(id)
            }
            fn set(&self, role: usize, id: &str) -> Result<(), String> {
                self.0.set(role, id)?;
                if id == "bus" && role == self.1 {
                    self.0.set(self.2, "user-choice")?;
                }
                Ok(())
            }
        }
        // Changes to both a pending role and an already-switched role.
        for (after, changed) in [(0, 2), (2, 0)] {
            let s = snapshot();
            let f = Changing(
                Fake {
                    current: RefCell::new(s.originals.clone()),
                    fail: None,
                    missing: vec![],
                },
                after,
                changed,
            );
            assert!(apply(&f, &s).is_err());
            for role in 0..3 {
                assert_eq!(
                    f.current(role).unwrap(),
                    if role == changed {
                        "user-choice"
                    } else {
                        &s.originals[role]
                    }
                );
            }
        }
    }
    #[test]
    fn pre_start_user_selection_of_bus_is_not_claimed_or_restored() {
        let s = snapshot();
        let f = Fake {
            current: RefCell::new(s.originals.clone()),
            fail: None,
            missing: vec![],
        };
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send("START".into()).unwrap();
        let outcome = guard_defaults(
            &f,
            &s,
            rx,
            |event| {
                assert_eq!(event, "READY");
                f.set(1, "bus")
            },
            || panic!("route must not start"),
            std::time::Duration::from_secs(1),
        );
        assert!(outcome.result.is_err());
        assert!(outcome.restored);
        assert_eq!(*f.current.borrow(), ["speakers", "bus", "communications"]);
    }
    #[test]
    fn partial_switch_rolls_back_every_changed_role() {
        for failed in 0..3 {
            let s = snapshot();
            let f = Fake {
                current: RefCell::new(s.originals.clone()),
                fail: Some(failed),
                missing: vec![],
            };
            assert!(apply(&f, &s).is_err());
            assert_eq!(*f.current.borrow(), s.originals);
        }
    }
    #[test]
    fn restores_distinct_roles_and_preserves_user_changes() {
        let s = snapshot();
        let f = Fake {
            current: RefCell::new(s.originals.clone()),
            fail: None,
            missing: vec![],
        };
        apply(&f, &s).unwrap();
        f.set(1, "user-choice").unwrap();
        restore(&f, &s).unwrap();
        assert_eq!(
            *f.current.borrow(),
            ["speakers", "user-choice", "communications"]
        );
    }
    #[test]
    fn unplugged_original_uses_pinned_output() {
        let s = snapshot();
        let f = Fake {
            current: RefCell::new(["bus".into(), "bus".into(), "bus".into()]),
            fail: None,
            missing: vec!["headphones".into()],
        };
        restore(&f, &s).unwrap();
        assert_eq!(f.current(1).unwrap(), "speakers");
    }
    #[test]
    fn changed_default_during_start_rolls_back_preceding_roles() {
        let s = snapshot();
        let f = Fake {
            current: RefCell::new(s.originals.clone()),
            fail: None,
            missing: vec![],
        };
        f.set(1, "user-choice").unwrap();
        assert!(apply(&f, &s).is_err());
        assert_eq!(
            *f.current.borrow(),
            ["speakers", "user-choice", "communications"]
        );
    }
    #[test]
    fn missing_outputs_report_failure_without_losing_other_roles() {
        let s = snapshot();
        let f = Fake {
            current: RefCell::new(["bus".into(), "bus".into(), "bus".into()]),
            fail: None,
            missing: vec!["speakers".into(), "headphones".into()],
        };
        assert!(restore(&f, &s).is_err());
        assert_eq!(f.current(2).unwrap(), "communications");
        assert_eq!(f.current(0).unwrap(), "bus");
    }
    #[test]
    fn read_failure_keeps_recovery_pending_and_still_restores_other_roles() {
        struct Unreadable(Fake);
        impl Defaults for Unreadable {
            fn current(&self, role: usize) -> Result<String, String> {
                if role == 1 {
                    Err("endpoint lookup failed".into())
                } else {
                    self.0.current(role)
                }
            }
            fn set(&self, role: usize, id: &str) -> Result<(), String> {
                self.0.set(role, id)
            }
            fn active(&self, id: &str) -> bool {
                self.0.active(id)
            }
        }
        let s = snapshot();
        let f = Unreadable(Fake {
            current: RefCell::new(["bus".into(), "bus".into(), "bus".into()]),
            fail: None,
            missing: vec![],
        });
        assert!(restore(&f, &s).is_err());
        assert_eq!(f.0.current(0).unwrap(), "speakers");
        assert_eq!(f.0.current(2).unwrap(), "communications");
    }
    #[test]
    fn guard_eof_stop_and_heartbeat_loss_restore_defaults() {
        for mode in ["eof", "stop", "timeout"] {
            let s = snapshot();
            let f = Fake {
                current: RefCell::new(s.originals.clone()),
                fail: None,
                missing: vec![],
            };
            let (tx, rx) = std::sync::mpsc::channel();
            tx.send("START".into()).unwrap();
            if mode == "stop" {
                tx.send("STOP".into()).unwrap();
            }
            let held = if mode == "eof" {
                drop(tx);
                None
            } else {
                Some(tx)
            };
            let mut events = vec![];
            let result = guard_defaults(
                &f,
                &s,
                rx,
                |event| {
                    events.push(event.to_owned());
                    Ok(())
                },
                || Ok(()),
                std::time::Duration::from_millis(15),
            );
            assert!(result.restored);
            assert!(result.result.is_ok());
            assert_eq!(events, ["READY", "ROUTED"]);
            assert_eq!(*f.current.borrow(), s.originals);
            drop(held);
        }
    }
    #[test]
    fn guard_cancellation_before_start_never_changes_defaults() {
        let s = snapshot();
        let f = Fake {
            current: RefCell::new(s.originals.clone()),
            fail: None,
            missing: vec![],
        };
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send("STOP".into()).unwrap();
        let result = guard_defaults(
            &f,
            &s,
            rx,
            |_| Ok(()),
            || panic!("monitor before start"),
            std::time::Duration::from_millis(15),
        );
        assert!(result.restored);
        assert!(result.result.is_err());
        assert_eq!(*f.current.borrow(), s.originals);
    }
    #[test]
    fn guard_failed_pipe_or_device_monitor_restores_before_returning_error() {
        for pipe_failure in [false, true] {
            let s = snapshot();
            let f = Fake {
                current: RefCell::new(s.originals.clone()),
                fail: None,
                missing: vec![],
            };
            let (tx, rx) = std::sync::mpsc::channel();
            tx.send("START".into()).unwrap();
            tx.send("HEARTBEAT".into()).unwrap();
            let result = guard_defaults(
                &f,
                &s,
                rx,
                |event| {
                    if pipe_failure && event == "ROUTED" {
                        Err("broken pipe".into())
                    } else {
                        Ok(())
                    }
                },
                || Err("device disappeared".into()),
                std::time::Duration::from_secs(1),
            );
            assert!(result.restored);
            assert!(result.result.is_err());
            assert_eq!(*f.current.borrow(), s.originals);
        }
    }
    #[test]
    fn guard_marks_failed_restoration_for_journal_retention() {
        let s = snapshot();
        let f = Fake {
            current: RefCell::new(s.originals.clone()),
            fail: None,
            missing: vec!["speakers".into(), "headphones".into()],
        };
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send("START".into()).unwrap();
        tx.send("STOP".into()).unwrap();
        let outcome = guard_defaults(
            &f,
            &s,
            rx,
            |_| Ok(()),
            || Ok(()),
            std::time::Duration::from_secs(1),
        );
        assert!(!outcome.restored);
        assert!(outcome.result.is_err());
        assert_eq!(f.current(2).unwrap(), "communications");
    }
}
