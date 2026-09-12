'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAppleChromeAdapter } = require('../src/main/adapters/chrome/apple.cjs');

function resultFor(script, values) {
  if (script.includes('compusync:chrome:capture')) return JSON.stringify(values.capture);
  if (script.includes('compusync:chrome:prepare:create')) return JSON.stringify(values.prepare);
  if (script.includes('compusync:chrome:prepare:populate')) return JSON.stringify(values.prepare);
  if (script.includes('compusync:chrome:close')) return 'closed';
  throw new Error('unknown JXA program');
}

function execMock(values, calls = []) {
  return (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(null, resultFor(args[3], values), '');
  };
}

const capturedWindow = {
  chromeWindowId: '41', chromeWindowIndex: 1, title: 'Active', bounds: [10, 20, 810, 620], activeIdx: 1,
  tabs: [
    { url: 'https://first.example/', title: 'First', pinned: true, index: 0 },
    { url: 'https://active.example/', title: 'Active', pinned: false, index: 1 },
    { url: 'https://last.example/', title: 'Last', index: 2 },
  ],
};

test('Apple Chrome detection is native-only and ignores helpers and hidden windows', async () => {
  let automationCalls = 0;
  let scriptCalls = 0;
  const adapter = createAppleChromeAdapter({
    native: { enumerateWindows: () => [
      { id: 'chrome', processName: 'Google Chrome', visible: true },
      { id: 'helper', processName: 'Google Chrome Helper', visible: true },
      { id: 'hidden', bundleId: 'com.google.Chrome', visible: false },
    ] },
    requestAutomation: () => { automationCalls += 1; },
    execFile: () => { scriptCalls += 1; },
  });
  assert.equal(adapter.adapterId, 'chrome');
  assert.deepEqual((await adapter.detect()).map(({ id }) => id), ['chrome']);
  assert.equal(automationCalls, 0);
  assert.equal(scriptCalls, 0);
});

test('capture matches a native window, preserves tab data, and reuses prepared descriptor identity', async () => {
  const calls = [];
  let permissionRequests = 0;
  const adapter = createAppleChromeAdapter({
    machineId: 'mac-a', now: () => 1234, uuid: () => 'new-stable-id',
    native: { enumerateWindows: () => [] },
    requestAutomation: ({ appName, reason }) => {
      permissionRequests += 1;
      assert.equal(appName, 'Google Chrome');
      assert.equal(reason, 'window-handoff');
      return true;
    },
    execFile: execMock({ capture: [capturedWindow] }, calls),
  });
  const descriptor = await adapter.capture({
    nativeWindowId: 'ax:1:0', descriptorId: 'roundtrip-id', title: 'Active - Google Chrome',
    bounds: { x: 10, y: 20, width: 800, height: 600 }, maximized: false,
  }, { x: 100, y: 200, w: 800, h: 600 });
  assert.equal(descriptor.id, 'roundtrip-id');
  assert.equal(descriptor.origin, 'mac-a');
  assert.equal(descriptor.capturedAt, 1234);
  assert.equal(descriptor.payload.activeIdx, 1);
  assert.deepEqual(descriptor.payload.tabs.map(({ title, pinned, index }) => ({ title, pinned, index })), [
    { title: 'First', pinned: true, index: 0 },
    { title: 'Active', pinned: false, index: 1 },
    { title: 'Last', pinned: false, index: 2 },
  ]);
  assert.equal(permissionRequests, 1);
  assert.equal(calls[0].file, '/usr/bin/osascript');
  assert.deepEqual(calls[0].args.slice(0, 3), ['-l', 'JavaScript', '-e']);
});

test('prepare creates active URL first, finds the real native window, and moves it offscreen', async () => {
  const calls = [];
  const boundsCalls = [];
  let enumerations = 0;
  const adapter = createAppleChromeAdapter({
    machineId: 'mac-b', sleep: async () => {},
    native: {
      enumerateWindows: () => {
        enumerations += 1;
        const oldBefore = { id: 'ax:2:0', processName: 'Google Chrome', visible: true, title: 'Old', bounds: { x: 0, y: 0, width: 500, height: 500 } };
        const fresh = { id: 'ax:2:0', processName: 'Google Chrome', visible: true, title: 'Active', bounds: { x: 10, y: 20, width: 800, height: 600 } };
        const oldAfter = { ...oldBefore, id: 'ax:2:1' };
        return enumerations === 1 ? [oldBefore] : [fresh, oldAfter];
      },
      setWindowBounds: (id, bounds) => boundsCalls.push({ id, bounds }),
      focusWindow: (id) => boundsCalls.push({ focus: id }),
    },
    requestAutomation: () => true,
    execFile: execMock({ prepare: { chromeWindowId: '99', chromeWindowIndex: 1, title: 'Active', bounds: [10, 20, 810, 620] } }, calls),
  });
  const descriptor = {
    schemaVersion: 1, id: 'stable-id', adapterId: 'chrome', origin: 'mac-a', capturedAt: 4,
    geometryVU: { x: 1, y: 2, w: 800, h: 600 }, state: 'normal',
    payload: {
      activeIdx: 1,
      tabs: [
        { url: 'https://first.example/?value=\";Application(\"Finder\")', title: 'First', pinned: true, index: 0 },
        { url: 'https://active.example/', title: 'Active', pinned: false, index: 1 },
      ],
    },
  };
  const handle = await adapter.prepare(descriptor, { x: -900, y: 20, width: 800, height: 600 });
  assert.deepEqual(handle, {
    id: 'stable-id', descriptorId: 'stable-id', nativeWindowId: 'ax:2:0', chromeWindowId: '99', chromeWindowIndex: 1,
  });
  assert.deepEqual(boundsCalls[0], { id: 'ax:2:0', bounds: { x: -900, y: 20, width: 800, height: 600 } });
  const createSource = calls.find(({ args }) => args[3].includes('compusync:chrome:prepare:create')).args[3];
  const populateSource = calls.find(({ args }) => args[3].includes('compusync:chrome:prepare:populate')).args[3];
  assert.ok(createSource.indexOf('active.example') < createSource.indexOf('win.activeTab().url'));
  assert.equal(createSource.includes('first.example'), false);
  assert.match(populateSource, /\\\";Application\(\\\"Finder/);
  assert.equal(calls[0].options.shell, undefined);
  await adapter.position(handle, { x: -500, y: 30, w: 800, h: 600 });
  await adapter.focus(handle);
  assert.deepEqual(boundsCalls.slice(-2), [
    { id: 'ax:2:0', bounds: { x: -500, y: 30, width: 800, height: 600 } },
    { focus: 'ax:2:0' },
  ]);
});

test('close uses Chrome Automation identity and requests Automation only once', async () => {
  const calls = [];
  let permissionRequests = 0;
  const adapter = createAppleChromeAdapter({
    requestAutomation: () => { permissionRequests += 1; return true; },
    execFile: execMock({ capture: [capturedWindow] }, calls),
  });
  await adapter.capture({ chromeWindowIndex: 1 }, { x: 0, y: 0, w: 800, h: 600 });
  await adapter.close({ nativeWindowId: 'ax:1:0', chromeWindowId: '41', chromeWindowIndex: 1 });
  assert.equal(permissionRequests, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].args[3].includes('compusync:chrome:close'));
});

test('Automation denial is actionable, typed, and cached without repeated prompts', async () => {
  let scriptCalls = 0;
  let requests = 0;
  const denied = Object.assign(new Error('osascript failed: Not authorized to send Apple events. (-1743)'), { code: 1 });
  const adapter = createAppleChromeAdapter({
    requestAutomation: () => { requests += 1; return true; },
    execFile: (_file, _args, _options, callback) => { scriptCalls += 1; callback(denied); },
  });
  const attempt = () => adapter.capture({}, { x: 0, y: 0, w: 100, h: 100 });
  await assert.rejects(attempt, (error) => error.code === 'CHROME_AUTOMATION_DENIED' && /System Settings/.test(error.message));
  await assert.rejects(attempt, { code: 'CHROME_AUTOMATION_DENIED' });
  assert.equal(requests, 1);
  assert.equal(scriptCalls, 1);
});
