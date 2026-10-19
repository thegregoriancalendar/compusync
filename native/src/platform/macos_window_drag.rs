use crate::Rect;

/// Geometry polling must remain usable without AX notification subscriptions.
/// All observations are made on the AX worker, after checking the held gesture.
pub(super) struct GeometryWatch {
    initial: Option<Rect>,
    active: bool,
}

impl GeometryWatch {
    pub(super) fn new(initial: Option<Rect>) -> Self {
        Self {
            initial,
            active: false,
        }
    }

    pub(super) fn active(&self) -> bool {
        self.active
    }

    pub(super) fn notify(&mut self, current_gesture: bool) -> bool {
        if !current_gesture || self.active {
            return false;
        }
        self.active = true;
        true
    }

    pub(super) fn observe(&mut self, current: Option<Rect>, current_gesture: bool) -> bool {
        if !current_gesture || self.active {
            return false;
        }
        let Some(current) = current else { return false };
        let Some(initial) = self.initial else {
            // A transient AX query failure must not disable the whole gesture.
            self.initial = Some(current);
            return false;
        };
        const EPSILON: f64 = 0.5;
        let changed = (initial.x - current.x).abs() >= EPSILON
            || (initial.y - current.y).abs() >= EPSILON
            || (initial.width - current.width).abs() >= EPSILON
            || (initial.height - current.height).abs() >= EPSILON;
        changed && self.notify(current_gesture)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds(x: f64) -> Rect {
        Rect {
            x,
            y: 40.0,
            width: 900.0,
            height: 700.0,
        }
    }

    #[test]
    fn polling_starts_once_without_any_notification() {
        let mut watch = GeometryWatch::new(Some(bounds(100.0)));
        assert!(!watch.observe(Some(bounds(100.25)), true));
        assert!(watch.observe(Some(bounds(102.0)), true));
        assert!(!watch.observe(Some(bounds(104.0)), true));
        assert!(!watch.notify(true));
        assert!(watch.active());
    }

    #[test]
    fn transient_geometry_failure_recovers_during_the_same_drag() {
        let mut watch = GeometryWatch::new(None);
        assert!(!watch.observe(None, true));
        assert!(!watch.observe(Some(bounds(100.0)), true));
        assert!(!watch.observe(None, true));
        assert!(watch.observe(Some(bounds(102.0)), true));
    }

    #[test]
    fn released_or_replaced_gesture_cannot_activate_an_old_watch() {
        let mut watch = GeometryWatch::new(Some(bounds(100.0)));
        assert!(!watch.observe(Some(bounds(110.0)), false));
        assert!(!watch.notify(false));
        assert!(!watch.active());
    }

    #[test]
    fn notification_and_geometry_polling_share_one_start() {
        let mut watch = GeometryWatch::new(Some(bounds(100.0)));
        assert!(watch.notify(true));
        assert!(!watch.notify(true));
        assert!(!watch.observe(Some(bounds(110.0)), true));
    }

    #[test]
    fn resizing_is_detected_without_position_changes() {
        let initial = bounds(100.0);
        let mut watch = GeometryWatch::new(Some(initial));
        assert!(!watch.observe(Some(initial), true));
        assert!(watch.observe(
            Some(Rect {
                width: 920.0,
                ..initial
            }),
            true
        ));
    }
}
