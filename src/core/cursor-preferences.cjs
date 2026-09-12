'use strict';

const SCREEN_SIDES = Object.freeze(['left', 'right', 'bottom']);
const LIMITS = Object.freeze({
  verticalOffsetVU: Object.freeze({ min: -10000, max: 10000 }),
  base: Object.freeze({ min: 0.05, max: 8 }),
  threshold: Object.freeze({ min: 0, max: 20 }),
  slope: Object.freeze({ min: 0, max: 1 }),
  edgeResistanceVU: Object.freeze({ min: 0, max: 1000 }),
});

function defaultCursorSettings(platform = process.platform) {
  return {
    screenSide: platform === 'darwin' ? 'left' : 'right',
    verticalOffsetVU: 0,
    acceleration: { base: 1, threshold: 0.5, slope: 0.015 },
    edgeResistanceVU: 0,
    linked: true,
  };
}

function bounded(value, fallback, limits) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= limits.min && number <= limits.max ? number : fallback;
}

function cursorSettingsFromSaved(saved = {}, platform = process.platform) {
  const defaults = defaultCursorSettings(platform);
  const acceleration = saved.acceleration && typeof saved.acceleration === 'object' ? saved.acceleration : {};
  return {
    screenSide: SCREEN_SIDES.includes(saved.screenSide) ? saved.screenSide : defaults.screenSide,
    verticalOffsetVU: bounded(saved.verticalOffsetVU, defaults.verticalOffsetVU, LIMITS.verticalOffsetVU),
    acceleration: {
      base: bounded(acceleration.base, defaults.acceleration.base, LIMITS.base),
      threshold: bounded(acceleration.threshold, defaults.acceleration.threshold, LIMITS.threshold),
      slope: bounded(acceleration.slope, defaults.acceleration.slope, LIMITS.slope),
    },
    edgeResistanceVU: bounded(saved.edgeResistanceVU, defaults.edgeResistanceVU, LIMITS.edgeResistanceVU),
    linked: saved.linked !== false,
  };
}

function assertNumber(name, value, limits) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < limits.min || value > limits.max) {
    throw new Error(`${name} must be between ${limits.min} and ${limits.max}.`);
  }
  return value;
}

function validateCursorSettings(value) {
  if (!value || typeof value !== 'object' || !SCREEN_SIDES.includes(value.screenSide)) {
    throw new Error('Choose whether this laptop is on the left, right, or bottom.');
  }
  if (!value.acceleration || typeof value.acceleration !== 'object') throw new Error('Enter valid pointer acceleration settings.');
  return {
    screenSide: value.screenSide,
    verticalOffsetVU: assertNumber('Vertical offset', value.verticalOffsetVU, LIMITS.verticalOffsetVU),
    acceleration: {
      base: assertNumber('Base acceleration', value.acceleration.base, LIMITS.base),
      threshold: assertNumber('Acceleration threshold', value.acceleration.threshold, LIMITS.threshold),
      slope: assertNumber('Acceleration slope', value.acceleration.slope, LIMITS.slope),
    },
    edgeResistanceVU: assertNumber('Edge resistance', value.edgeResistanceVU, LIMITS.edgeResistanceVU),
    linked: value.linked !== false,
  };
}

module.exports = { SCREEN_SIDES, LIMITS, defaultCursorSettings, cursorSettingsFromSaved, validateCursorSettings };
