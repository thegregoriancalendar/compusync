'use strict';

const MAC_POSITIONS = Object.freeze(['left', 'right', 'top']);
const LIMITS = Object.freeze({
  displayOffset: Object.freeze({ min: -1, max: 1 }),
  base: Object.freeze({ min: 0.05, max: 8 }),
  threshold: Object.freeze({ min: 0, max: 20 }),
  slope: Object.freeze({ min: 0, max: 1 }),
  edgeResistanceVU: Object.freeze({ min: 0, max: 1000 }),
});

function defaultCursorSettings(platform = process.platform) {
  return {
    macPosition: 'left',
    displayOffset: 0,
    acceleration: { base: 1, threshold: 0.5, slope: 0.015 },
    edgeResistanceVU: 0,
    linked: true,
  };
}

function legacyMacPosition(screenSide, platform) {
  if (screenSide === 'bottom') return platform === 'darwin' ? 'top' : 'left';
  if (screenSide !== 'left' && screenSide !== 'right') return 'left';
  return platform === 'darwin'
    ? screenSide
    : screenSide === 'left' ? 'right' : 'left';
}

function bounded(value, fallback, limits) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= limits.min && number <= limits.max ? number : fallback;
}

function cursorSettingsFromSaved(saved = {}, platform = process.platform) {
  const defaults = defaultCursorSettings(platform);
  const acceleration = saved.acceleration && typeof saved.acceleration === 'object' ? saved.acceleration : {};
  return {
    macPosition: MAC_POSITIONS.includes(saved.macPosition)
      ? saved.macPosition : legacyMacPosition(saved.screenSide, platform),
    displayOffset: bounded(saved.displayOffset, defaults.displayOffset, LIMITS.displayOffset),
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
  if (!value || typeof value !== 'object' || !MAC_POSITIONS.includes(value.macPosition)) {
    throw new Error('Choose a valid arrangement for the two laptops.');
  }
  if (!value.acceleration || typeof value.acceleration !== 'object') throw new Error('Enter valid pointer acceleration settings.');
  return {
    macPosition: value.macPosition,
    displayOffset: assertNumber('Display offset', value.displayOffset, LIMITS.displayOffset),
    acceleration: {
      base: assertNumber('Base acceleration', value.acceleration.base, LIMITS.base),
      threshold: assertNumber('Acceleration threshold', value.acceleration.threshold, LIMITS.threshold),
      slope: assertNumber('Acceleration slope', value.acceleration.slope, LIMITS.slope),
    },
    edgeResistanceVU: assertNumber('Edge resistance', value.edgeResistanceVU, LIMITS.edgeResistanceVU),
    linked: value.linked !== false,
  };
}

module.exports = { MAC_POSITIONS, LIMITS, defaultCursorSettings, cursorSettingsFromSaved, validateCursorSettings };
