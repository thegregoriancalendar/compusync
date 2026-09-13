use napi_derive::napi;
use serde::{Deserialize, Serialize};

#[napi(object)]
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct AccelerationConfig {
    pub base: f64,
    pub threshold: f64,
    pub slope: f64,
}

impl Default for AccelerationConfig {
    fn default() -> Self {
        Self {
            base: 1.0,
            threshold: 0.5,
            slope: 0.015,
        }
    }
}

impl AccelerationConfig {
    pub fn validate(self) -> Result<Self, &'static str> {
        if !self.base.is_finite() || !(0.0..=20.0).contains(&self.base) {
            return Err("acceleration base must be between 0 and 20");
        }
        if !self.threshold.is_finite() || !(0.0..=100_000.0).contains(&self.threshold) {
            return Err("acceleration threshold must be between 0 and 100000");
        }
        if !self.slope.is_finite() || !(0.0..=20.0).contains(&self.slope) {
            return Err("acceleration slope must be between 0 and 20");
        }
        Ok(self)
    }
}

#[napi(object)]
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
pub struct AppliedDelta {
    pub dx: f64,
    pub dy: f64,
    pub gain: f64,
}

const MAX_RAW_DELTA: f64 = 8_192.0;
const MAX_APPLIED_DELTA: f64 = 512.0;

fn limit_vector(dx: f64, dy: f64, limit: f64) -> (f64, f64) {
    let magnitude = dx.hypot(dy);
    if magnitude <= limit {
        (dx, dy)
    } else {
        let scale = limit / magnitude;
        (dx * scale, dy * scale)
    }
}

pub fn apply(config: AccelerationConfig, dx: f64, dy: f64, dt_ms: f64) -> AppliedDelta {
    if !dx.is_finite() || !dy.is_finite() || !dt_ms.is_finite() {
        return AppliedDelta::default();
    }
    let (dx, dy) = limit_vector(dx, dy, MAX_RAW_DELTA);
    let dt = dt_ms.clamp(0.1, 250.0);
    let speed = dx.hypot(dy) / dt;
    let gain = if speed < config.threshold {
        config.base
    } else {
        config.base + (speed - config.threshold) * config.slope
    }
    .clamp(0.0, 100.0);
    let (dx, dy) = limit_vector(dx * gain, dy * gain, MAX_APPLIED_DELTA);
    AppliedDelta { dx, dy, gain }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_segment_curve_is_continuous() {
        let c = AccelerationConfig {
            base: 1.2,
            threshold: 100.0,
            slope: 0.01,
        };
        let below = apply(c, 0.999, 0.0, 10.0);
        let at = apply(c, 1.0, 0.0, 10.0);
        assert!((below.gain - at.gain).abs() < 0.002);
        assert_eq!(at.gain, 1.2);
    }

    #[test]
    fn faster_input_gets_more_gain() {
        let c = AccelerationConfig::default();
        assert!(apply(c, 20.0, 0.0, 10.0).gain > apply(c, 1.0, 0.0, 10.0).gain);
    }

    #[test]
    fn bad_values_cannot_escape_to_the_cursor() {
        let d = apply(AccelerationConfig::default(), f64::NAN, 2.0, 0.0);
        assert_eq!((d.dx, d.dy), (0.0, 0.0));
        assert!(AccelerationConfig {
            base: -1.0,
            ..Default::default()
        }
        .validate()
        .is_err());
        let bad_time = apply(AccelerationConfig::default(), 2.0, 1.0, f64::NAN);
        assert_eq!((bad_time.dx, bad_time.dy), (0.0, 0.0));
    }

    #[test]
    fn one_corrupt_sample_cannot_cross_an_entire_display() {
        let d = apply(AccelerationConfig::default(), 100_000.0, -50_000.0, 0.1);
        assert!(d.dx.hypot(d.dy) <= MAX_APPLIED_DELTA + f64::EPSILON);
        assert!(d.dx > 0.0 && d.dy < 0.0);
    }
}
