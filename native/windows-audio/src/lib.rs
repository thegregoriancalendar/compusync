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
    for role in 0..3 {
        if system.current(role).ok().as_deref() != Some(&snapshot.originals[role]) {
            let _ = restore(system, snapshot);
            return Err("Windows output changed during setup. Retry sharing.".into());
        }
        if let Err(error) = system.set(role, &snapshot.bus) {
            let recovery = restore(system, snapshot);
            return Err(format!(
                "Could not route Windows audio: {error}. Recovery: {recovery:?}"
            ));
        }
    }
    Ok(())
}

/// Run the pipe protocol independently from Windows/COM, so cancellation,
/// heartbeat loss, and failed announcements exercise the same recovery path.
pub struct GuardOutcome {
    pub result: Result<(), String>,
    pub restored: bool,
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
    let mut attempted = false;
    let result = (|| {
        announce("READY")?;
        if commands.recv_timeout(watchdog).ok().as_deref() != Some("START") {
            return Err("Windows routing start was cancelled.".into());
        }
        attempted = true;
        apply(system, snapshot)?;
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
    let recovery = if attempted {
        restore(system, snapshot)
    } else {
        Ok(())
    };
    GuardOutcome {
        restored: recovery.is_ok(),
        result: recovery.and(result),
    }
}

#[cfg(windows)]
mod system;
#[cfg(windows)]
pub use system::*;

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
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
}
