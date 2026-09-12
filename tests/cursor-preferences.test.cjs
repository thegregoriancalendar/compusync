'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  defaultCursorSettings,
  cursorSettingsFromSaved,
  validateCursorSettings,
} = require('../src/core/cursor-preferences.cjs');

test('cursor settings default to Mac left, Windows right, linked, and no edge resistance', () => {
  assert.equal(defaultCursorSettings('darwin').screenSide, 'left');
  assert.equal(defaultCursorSettings('win32').screenSide, 'right');
  assert.equal(cursorSettingsFromSaved({ screenSide: 'bottom' }).screenSide, 'bottom');
  assert.equal(defaultCursorSettings('win32').edgeResistanceVU, 0);
  assert.equal(defaultCursorSettings('win32').linked, true);
});

test('saved cursor settings retain valid tuning and replace invalid values with defaults', () => {
  const settings = cursorSettingsFromSaved({
    screenSide: 'above',
    verticalOffsetVU: 125,
    acceleration: { base: 1.4, threshold: 'bad', slope: 0.02 },
    edgeResistanceVU: -1,
    linked: false,
  }, 'win32');
  assert.deepEqual(settings, {
    screenSide: 'right',
    verticalOffsetVU: 125,
    acceleration: { base: 1.4, threshold: 0.5, slope: 0.02 },
    edgeResistanceVU: 0,
    linked: false,
  });
});

test('renderer cursor settings are strictly validated', () => {
  const settings = validateCursorSettings({
    screenSide: 'left', verticalOffsetVU: -20,
    acceleration: { base: 1, threshold: 0.7, slope: 0.01 },
    edgeResistanceVU: 50, linked: true,
  });
  assert.equal(settings.edgeResistanceVU, 50);
  assert.throws(() => validateCursorSettings({ ...settings, edgeResistanceVU: 1001 }), /between 0 and 1000/);
  assert.throws(() => validateCursorSettings({ ...settings, screenSide: 'top' }), /left, right, or bottom/);
});
