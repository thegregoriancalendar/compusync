'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runMacPermissionPreflight } = require('../src/main/macos-permissions.cjs');

test('macOS first-run preflight requests every required TCC permission once', async () => {
  const calls = [];
  const notices = [];
  const cleared = [];
  const result = await runMacPermissionPreflight({
    platform: 'darwin', firstRun: true,
    systemPreferences: { isTrustedAccessibilityClient: (request) => { calls.push(['accessibility', request]); return false; } },
    native: {
      inputMonitoringAccess: (request) => { calls.push(['input', request]); return false; },
      chromeAutomationAccess: (request) => { calls.push(['automation', request]); return 'denied'; },
    },
    onNotice: (notice) => notices.push(notice), clearNotice: (id) => cleared.push(id),
  });
  assert.deepEqual(calls, [['accessibility', true], ['input', true], ['automation', true]]);
  assert.deepEqual(result, { accessibility: false, inputMonitoring: false, automation: 'denied' });
  assert.deepEqual(notices.map(({ id }) => id), [
    'accessibility-permission', 'input-monitoring-permission', 'chrome-automation-permission',
  ]);
  assert.deepEqual(cleared, []);
});

test('later preflight checks state without asking again and clears resolved notices', async () => {
  const requests = [];
  const cleared = [];
  const result = await runMacPermissionPreflight({
    platform: 'darwin', firstRun: false,
    systemPreferences: { isTrustedAccessibilityClient: (request) => { requests.push(request); return true; } },
    native: {
      inputMonitoringAccess: (request) => { requests.push(request); return true; },
      chromeAutomationAccess: (request) => { requests.push(request); return 'granted'; },
    },
    clearNotice: (id) => cleared.push(id),
  });
  assert.deepEqual(requests, [false, false, false]);
  assert.deepEqual(result, { accessibility: true, inputMonitoring: true, automation: 'granted' });
  assert.deepEqual(cleared, [
    'accessibility-permission', 'input-monitoring-permission', 'chrome-automation-permission',
  ]);
});

test('preflight is inert away from macOS', async () => {
  let called = false;
  const result = await runMacPermissionPreflight({
    platform: 'win32', firstRun: true,
    systemPreferences: { isTrustedAccessibilityClient: () => { called = true; } },
  });
  assert.deepEqual(result, { skipped: true });
  assert.equal(called, false);
});

test('permission probe failures become actionable notices instead of blocking startup', async () => {
  const notices = [];
  const result = await runMacPermissionPreflight({
    platform: 'darwin', firstRun: true,
    systemPreferences: { isTrustedAccessibilityClient: () => { throw new Error('TCC unavailable'); } },
    native: {
      inputMonitoringAccess: () => { throw new Error('old addon'); },
      chromeAutomationAccess: () => { throw new Error('old addon'); },
    },
    onNotice: (notice) => notices.push(notice.id),
  });
  assert.deepEqual(result, {
    accessibility: false, inputMonitoring: false, automation: 'unavailable',
  });
  assert.deepEqual(notices, [
    'accessibility-permission', 'input-monitoring-permission', 'chrome-automation-permission',
  ]);
});
