//! Source-owned latency budget. Recoveries never add an arbitrary delay.
use super::clock::MS;

pub const MIN_DELAY_NS: i64 = 10 * MS;
pub const MAX_DELAY_NS: i64 = 500 * MS;
pub const MARGIN_NS: i64 = 5 * MS;

/// A bounded two-second peak window, including callback scheduling variation.
/// Buckets expire using host time, so past stalls cannot permanently add delay.
pub struct RecentPeak {
    buckets: [(i64, i64); 8],
}
impl RecentPeak {
    pub fn new() -> Self {
        Self {
            buckets: [(-1, 0); 8],
        }
    }
    pub fn observe(&mut self, now: i64, value: i64) {
        let tick = now / (250 * MS);
        let bucket = &mut self.buckets[(tick % 8) as usize];
        if bucket.0 != tick {
            *bucket = (tick, 0);
        }
        bucket.1 = bucket.1.max(value.max(0));
    }
    pub fn value(&self, now: i64) -> i64 {
        let tick = now / (250 * MS);
        self.buckets
            .iter()
            .filter(|(at, _)| *at >= 0 && *at <= tick && tick - *at < 8)
            .map(|(_, value)| *value)
            .max()
            .unwrap_or(0)
    }
}

pub struct DelayController {
    current: Option<i64>,
    lower_since: Option<i64>,
    last_decrease: i64,
}
impl DelayController {
    pub fn new() -> Self {
        Self {
            current: None,
            lower_since: None,
            last_decrease: 0,
        }
    }
    /// All inputs are measured in nanoseconds. The receiver's capture-to-arrival
    /// age includes actual capture/processing/network costs. RTT/2 is only a
    /// startup/fallback prediction; clock uncertainty protects against asymmetry.
    pub fn update(
        &mut self,
        now: i64,
        capture_age: i64,
        local_output: i64,
        remote_age: i64,
        remote_output: i64,
        rtt: i64,
        uncertainty: i64,
    ) -> Result<i64, String> {
        let local = capture_age.saturating_add(local_output);
        let remote = remote_age
            .max(capture_age.saturating_add(rtt / 2))
            .saturating_add(remote_output)
            .saturating_add(uncertainty);
        let required = local.max(remote).saturating_add(MARGIN_NS);
        if required > MAX_DELAY_NS {
            return Err("Measured audio timing needs more than 500 ms. Choose a faster output or a more stable connection.".into());
        }
        let target = ((required.max(MIN_DELAY_NS) + MS - 1) / MS) * MS;
        let current = self.current.unwrap_or(target);
        let next = if target >= current + 2 * MS {
            self.lower_since = None;
            target
        } else if target < current {
            let since = *self.lower_since.get_or_insert(now);
            if now - since >= 3_000 * MS && now - self.last_decrease >= 500 * MS {
                self.last_decrease = now;
                (current - 5 * MS).max(target)
            } else {
                current
            }
        } else {
            self.lower_since = None;
            current
        };
        self.current = Some(next);
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn measured_slowest_path_sets_latency_instead_of_a_fixed_floor() {
        let mut delay = DelayController::new();
        assert_eq!(
            delay
                .update(0, 8 * MS, 12 * MS, 0, 20 * MS, 4 * MS, 2 * MS)
                .unwrap(),
            37 * MS
        );
        // Extra capture + actual network delivery costs dominate the estimate.
        assert_eq!(
            delay
                .update(MS, 8 * MS, 12 * MS, 60 * MS, 20 * MS, 4 * MS, 2 * MS)
                .unwrap(),
            87 * MS
        );
        // The source's own slow output can instead be the limiting device.
        assert_eq!(
            DelayController::new()
                .update(0, 10 * MS, 80 * MS, 12 * MS, 10 * MS, 2 * MS, MS)
                .unwrap(),
            95 * MS
        );
    }
    #[test]
    fn unchanged_measurements_never_ratchet_and_stable_improvements_reduce_delay() {
        let mut delay = DelayController::new();
        let high = delay
            .update(0, 10 * MS, 10 * MS, 80 * MS, 20 * MS, 4 * MS, 2 * MS)
            .unwrap();
        assert_eq!(high, 107 * MS);
        for step in 1..100 {
            assert_eq!(
                delay
                    .update(
                        step * MS,
                        10 * MS,
                        10 * MS,
                        80 * MS,
                        20 * MS,
                        4 * MS,
                        2 * MS
                    )
                    .unwrap(),
                high
            );
        }
        assert_eq!(
            delay
                .update(100 * MS, 10 * MS, 10 * MS, 12 * MS, 20 * MS, 4 * MS, 2 * MS)
                .unwrap(),
            high
        );
        assert_eq!(
            delay
                .update(
                    3_099 * MS,
                    10 * MS,
                    10 * MS,
                    12 * MS,
                    20 * MS,
                    4 * MS,
                    2 * MS
                )
                .unwrap(),
            high
        );
        for step in 0..40 {
            delay
                .update(
                    (3_100 + step * 500) * MS,
                    10 * MS,
                    10 * MS,
                    12 * MS,
                    20 * MS,
                    4 * MS,
                    2 * MS,
                )
                .unwrap();
        }
        assert_eq!(delay.current, Some(39 * MS));
    }
    #[test]
    fn expired_spikes_and_missing_buckets_do_not_pin_latency_forever() {
        let mut peak = RecentPeak::new();
        peak.observe(0, 100 * MS);
        peak.observe(1_000 * MS, 8 * MS);
        assert_eq!(peak.value(1_999 * MS), 100 * MS);
        assert_eq!(peak.value(2_000 * MS), 8 * MS);
        assert_eq!(peak.value(4_000 * MS), 0);
        peak.observe(10_000 * MS, 9 * MS);
        assert_eq!(peak.value(10_000 * MS), 9 * MS);
    }
}
