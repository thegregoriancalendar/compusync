'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  defaultCursorSettings,
  cursorSettingsFromSaved,
  validateCursorSettings,
} = require('../src/core/cursor-preferences.cjs');

test('cursor settings use one canonical Mac-relative arrangement on both platforms', () => {
  assert.equal(defaultCursorSettings('darwin').macPosition, 'left');
  assert.equal(defaultCursorSettings('win32').macPosition, 'left');
  assert.equal(cursorSettingsFromSaved({ screenSide: 'right' }, 'darwin').macPosition, 'right');
  assert.equal(cursorSettingsFromSaved({ screenSide: 'right' }, 'win32').macPosition, 'left');
  assert.equal(cursorSettingsFromSaved({ screenSide: 'bottom' }, 'darwin').macPosition, 'top');
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
    macPosition: 'left',
    displayOffset: 0,
    acceleration: { base: 1.4, threshold: 0.5, slope: 0.02 },
    edgeResistanceVU: 0,
    linked: false,
  });
});

test('renderer cursor settings are strictly validated', () => {
  const settings = validateCursorSettings({
    macPosition: 'right', displayOffset: -.4,
    acceleration: { base: 1, threshold: 0.7, slope: 0.01 },
    edgeResistanceVU: 50, linked: true,
  });
  assert.equal(settings.edgeResistanceVU, 50);
  assert.throws(() => validateCursorSettings({ ...settings, edgeResistanceVU: 1001 }), /between 0 and 1000/);
  assert.equal(settings.displayOffset, -.4);
  assert.throws(() => validateCursorSettings({ ...settings, macPosition: 'bottom' }), /valid arrangement/);
  assert.throws(() => validateCursorSettings({ ...settings, displayOffset: 1.1 }), /between -1 and 1/);
});
