'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assessRecoveryProbe } = require('../scripts/probe-recovery-guard.cjs');

test('crash probe requires an observable cursor to recover and records hide visibility', () => {
  const result = assessRecoveryProbe({
    BaselineCursorVisible: true,
    ArmedCursorVisible: false,
    RecoveredCursorVisible: true,
    ArmedClipReleased: false,
    RecoveredClipReleased: true,
  });
  assert.equal(result.CursorVisibilityObservable, true);
  assert.equal(result.CursorHideObserved, true);
  assert.equal(result.CursorVisibilityRecovered, true);
  assert.equal(result.Passed, true);

  assert.equal(assessRecoveryProbe({ ...result, RecoveredCursorVisible: false }).Passed, false);
  const hideNotObservable = assessRecoveryProbe({ ...result, ArmedCursorVisible: true });
  assert.equal(hideNotObservable.CursorHideObserved, false);
  assert.equal(hideNotObservable.Passed, true);
});

test('headless crash probe relies on exercised clip recovery when no cursor is observable', () => {
  const result = assessRecoveryProbe({
    BaselineCursorVisible: false,
    ArmedCursorVisible: false,
    RecoveredCursorVisible: false,
    ArmedClipReleased: false,
    RecoveredClipReleased: true,
  });
  assert.equal(result.CursorVisibilityObservable, false);
  assert.equal(result.CursorVisibilityRecovered, true);
  assert.equal(result.Passed, true);

  assert.equal(assessRecoveryProbe({ ...result, ArmedClipReleased: true }).Passed, false);
  assert.equal(assessRecoveryProbe({ ...result, RecoveredClipReleased: false }).Passed, false);
});
