//! One host monotonic clock for sockets and device timestamps, never wall time.
#[cfg(any(target_os = "macos", target_os = "windows", test))]
use std::collections::VecDeque;
pub const MS: i64 = 1_000_000;
pub fn now_ns() -> i64 {
    #[cfg(target_os = "windows")]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn QueryPerformanceCounter(value: *mut i64) -> i32;
            fn QueryPerformanceFrequency(value: *mut i64) -> i32;
        }
        static FREQUENCY: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
        let frequency = *FREQUENCY.get_or_init(|| {
            let mut value = 0;
            assert_ne!(unsafe { QueryPerformanceFrequency(&mut value) }, 0);
            value
        });
        let mut ticks = 0;
        unsafe { QueryPerformanceCounter(&mut ticks) };
        (ticks as i128 * 1_000_000_000 / frequency as i128) as i64
    }
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn mach_absolute_time() -> u64;
        }
        mac_host_ns(unsafe { mach_absolute_time() })
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        START
            .get_or_init(std::time::Instant::now)
            .elapsed()
            .as_nanos() as i64
    }
}
#[cfg(target_os = "macos")]
pub fn mac_host_ns(ticks: u64) -> i64 {
    #[repr(C)]
    struct Timebase {
        numer: u32,
        denom: u32,
    }
    extern "C" {
        fn mach_timebase_info(info: *mut Timebase) -> i32;
    }
    static SCALE: std::sync::OnceLock<(u32, u32)> = std::sync::OnceLock::new();
    let (numer, denom) = *SCALE.get_or_init(|| {
        let mut info = Timebase { numer: 0, denom: 0 };
        assert_eq!(unsafe { mach_timebase_info(&mut info) }, 0);
        (info.numer, info.denom)
    });
    (ticks as u128 * numer as u128 / denom as u128) as i64
}
#[derive(Clone, Copy, Debug)]
#[cfg(any(target_os = "macos", target_os = "windows", test))]
pub struct Estimate {
    /// Receiver host time minus Mac host time.
    pub offset: i64,
    pub rtt: i64,
}
/// NTP four-timestamp estimator; retain a bounded, recent low-delay window.
#[cfg(any(target_os = "macos", target_os = "windows", test))]
pub struct ClockFilter {
    samples: VecDeque<(i64, Estimate)>,
}
#[cfg(any(target_os = "macos", target_os = "windows", test))]
impl ClockFilter {
    pub fn new() -> Self {
        Self {
            samples: VecDeque::with_capacity(32),
        }
    }
    pub fn observe(&mut self, t1: i64, t2: i64, t3: i64, t4: i64) -> Option<Estimate> {
        if t1 < 0 || t2 < 0 || t3 < t2 || t4 < t1 {
            return None;
        }
        let rtt = (t4 as i128 - t1 as i128) - (t3 as i128 - t2 as i128);
        if !(0..=100 * MS as i128).contains(&rtt) {
            return None;
        }
        let offset = ((t2 as i128 - t1 as i128) + (t3 as i128 - t4 as i128)) / 2;
        let estimate = Estimate {
            offset: i64::try_from(offset).ok()?,
            rtt: rtt as i64,
        };
        self.samples.push_back((t4, estimate));
        while self.samples.len() > 32
            || self
                .samples
                .front()
                .is_some_and(|(t, _)| t4 - *t > 5_000 * MS)
        {
            self.samples.pop_front();
        }
        self.best()
    }
    pub fn best(&self) -> Option<Estimate> {
        self.samples
            .iter()
            .min_by_key(|(_, e)| e.rtt)
            .map(|(_, e)| *e)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn estimates_offset_in_either_direction_and_filters_congestion() {
        for offset in [-9_000 * MS, 9_000 * MS] {
            let mut filter = ClockFilter::new();
            let a = 20_000 * MS;
            let first = filter
                .observe(a, a + offset + MS, a + offset + 2 * MS, a + 3 * MS)
                .unwrap();
            assert_eq!(first.offset, offset);
            assert_eq!(first.rtt, 2 * MS);
            let next = filter
                .observe(
                    a + 10 * MS,
                    a + offset + 20 * MS,
                    a + offset + 21 * MS,
                    a + 25 * MS,
                )
                .unwrap();
            assert_eq!(next.offset, offset);
            assert!(filter.observe(3, 5, 4, 6).is_none());
        }
    }
}
