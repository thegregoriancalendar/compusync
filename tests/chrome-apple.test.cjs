'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAX_PREPARED_DESCRIPTORS,
  createAppleChromeAdapter,
  rememberPreparedDescriptor,
} = require('../src/main/adapters/chrome/apple.cjs');

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

test('Apple capture carries page state and shows a useful notice when Chrome disallows page access', async () => {
  const state = { version: 1, url: 'https://active.example/', viewport: { w: 800, h: 500 },
    scroll: { x: 0, y: 900 }, fields: [], scrollers: [], details: [] };
  let permitted = true;
  const notices = [];
  const adapter = createAppleChromeAdapter({
    onNotice: (notice) => notices.push(notice),
    execFile(file, args, options, callback) {
      const script = args[3];
      if (script.includes('compusync:chrome:page-state')) {
        assert.equal(options.timeout, 1500);
        callback(null, JSON.stringify(permitted ? state : { unavailable: true, needsJavaScript: true }), '');
      } else callback(null, JSON.stringify([capturedWindow]), '');
    },
  });
  const window = { nativeWindowId: 'ax:1', chromeWindowId: '41' };
  const geometry = { x: 10, y: 20, w: 800, h: 600 };
  const descriptor = await adapter.capture(window, geometry);
  assert.deepEqual(descriptor.payload.tabs[1].pageState, state);
  permitted = false;
  assert.equal((await adapter.capture(window, geometry)).payload.tabs[1].pageState, undefined);
  await adapter.capture(window, geometry);
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /Allow JavaScript from Apple Events/);
});

function handoffDescriptor(id = 'cold-handoff') {
  return {
    schemaVersion: 1, id, adapterId: 'chrome', origin: 'win-a', capturedAt: 1,
    geometryVU: { x: 0, y: 0, w: 800, h: 600 }, state: 'normal',
    payload: { activeIdx: 0, tabs: [
      { url: 'https://active.example/', title: 'Active', pinned: false, index: 0 },
      { url: 'https://background.example/', title: 'Background', pinned: true, index: 1 },
    ] },
  };
}

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
  assert.doesNotMatch(calls[0].args[3], /\.execute\s*\(|javascript\s*:/i);
});

test('a background New Tab blocks fresh Mac capture with an actionable explanation', async () => {
  const adapter = createAppleChromeAdapter({
    execFile: execMock({ capture: [{ ...capturedWindow, activeIdx: 0, tabs: [
      { index: 0, url: 'https://example.com/', title: 'Website' },
      { index: 1, url: 'chrome://newtab/', title: 'New Tab' },
    ] }] }),
  });
  await assert.rejects(() => adapter.capture({
    id: 'ax:fresh', title: capturedWindow.title, bounds: { x: 10, y: 20, width: 800, height: 600 },
  }, { x: 10, y: 20, w: 800, h: 600 }), (error) => {
    assert.equal(error.code, 'CHROME_UNSUPPORTED_TABS');
    assert.match(error.message, /every tab/);
    assert.match(error.message, /New Tab/);
    return true;
  });
});

test('prepared Apple window retains received all-tab history for an unchanged round trip', async () => {
  const nativeWindow = {
    id: 'ax:prepared', processName: 'Google Chrome', visible: true,
    title: 'Active', bounds: { x: 10, y: 20, width: 800, height: 600 },
  };
  let captureValue = capturedWindow;
  const calls = [];
  const adapter = createAppleChromeAdapter({
    machineId: 'mac-b', sleep: async () => {},
    native: {
      enumerateWindows: () => [nativeWindow],
      setWindowBoundsNormalized() {},
    },
    requestAutomation: () => true,
    execFile: (file, args, options, callback) => {
      calls.push({ file, args, options });
      const script = args[3];
      callback(null, resultFor(script, {
        capture: [captureValue],
        prepare: { chromeWindowId: '41', chromeWindowIndex: 1, title: 'Active', bounds: [10, 20, 810, 620] },
      }), '');
    },
  });
  const histories = [
    { currentIndex: 1, entries: ['https://before-first.example/', 'https://first.example/'] },
    { currentIndex: 1, entries: ['https://before-active.example/', 'https://active.example/'] },
    { currentIndex: 1, entries: ['https://before-last.example/', 'https://last.example/'] },
  ];
  const descriptor = {
    schemaVersion: 1, id: 'round-trip-history', adapterId: 'chrome', origin: 'win-a', capturedAt: 1,
    geometryVU: { x: 0, y: 0, w: 800, h: 600 }, state: 'normal',
    payload: {
      activeIdx: 1,
      tabs: capturedWindow.tabs.map((tab, index) => ({ ...tab, pinned: Boolean(tab.pinned), history: histories[index] })),
    },
  };
  await adapter.prepare(descriptor, { x: -900, y: 20, width: 800, height: 600 });
  const unchanged = await adapter.capture(nativeWindow, descriptor.geometryVU);
  assert.equal(unchanged.id, descriptor.id);
  assert.deepEqual(unchanged.payload.tabs.map(({ history }) => history), histories);

  // Matching by both canonical index and URL is intentionally conservative:
  // navigation or pinned-tab reordering invalidates only the stale entries.
  captureValue = {
    ...capturedWindow,
    tabs: capturedWindow.tabs.map((tab, index) => index === 1
      ? { ...tab, url: 'https://navigated.example/' } : tab),
  };
  const navigated = await adapter.capture(nativeWindow, descriptor.geometryVU);
  assert.equal('history' in navigated.payload.tabs[1], false);
  assert.deepEqual(navigated.payload.tabs[0].history, histories[0]);
});

test('prepared history metadata cache evicts oldest identities at its fixed bound', () => {
  const records = new Map();
  for (let index = 0; index <= MAX_PREPARED_DESCRIPTORS; index += 1) {
    rememberPreparedDescriptor(records, `window-${index}`, { id: `window-${index}` });
  }
  assert.equal(records.size, MAX_PREPARED_DESCRIPTORS);
  assert.equal(records.has('window-0'), false);
  assert.equal(records.has('window-1'), true);
  rememberPreparedDescriptor(records, 'window-1', { id: 'window-1', refreshed: true });
  rememberPreparedDescriptor(records, 'window-final', { id: 'window-final' });
  assert.equal(records.has('window-2'), false);
  assert.equal(records.get('window-1').refreshed, true);
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
      setWindowBounds: () => { throw new Error('raw setter must not receive VU-derived bounds'); },
      setWindowBoundsNormalized: (id, bounds) => boundsCalls.push({ id, bounds }),
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
  assert.equal(calls.some(({ file }) => file === '/usr/bin/open'), false);
  await adapter.position(handle, { x: -500, y: 30, w: 800, h: 600 });
  await adapter.focus(handle);
  assert.deepEqual(boundsCalls.slice(-2), [
    { id: 'ax:2:0', bounds: { x: -500, y: 30, width: 800, height: 600 } },
    { focus: 'ax:2:0' },
  ]);
});

test('cold destination launch opens normal-profile Chrome once, then preloads the handoff window', async () => {
  const calls = [];
  let createAttempts = 0;
  let enumerations = 0;
  const preparedNative = {
    id: 'ax:9:0', processName: 'Google Chrome', visible: true, title: 'Active',
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  };
  const adapter = createAppleChromeAdapter({
    machineId: 'mac-b', sleep: async () => {}, requestAutomation: () => true,
    native: {
      enumerateWindows: () => (++enumerations < 3 ? [] : [preparedNative]),
      setWindowBoundsNormalized() {},
    },
    execFile: (file, args, options, callback) => {
      calls.push({ file, args, options });
      if (file === '/usr/bin/open') { callback(null, '', ''); return; }
      const script = args[3];
      if (script.includes('compusync:chrome:prepare:create') && ++createAttempts === 1) {
        callback(Object.assign(new Error('Chrome is not running'), { stderr: 'COMPUSYNC_CHROME_NOT_RUNNING' }));
        return;
      }
      callback(null, resultFor(script, {
        prepare: { chromeWindowId: '90', chromeWindowIndex: 1, title: 'Active', bounds: [10, 20, 810, 620] },
      }), '');
    },
  });

  const handle = await adapter.prepare(handoffDescriptor(), { x: -900, y: 20, width: 800, height: 600 });
  assert.equal(handle.nativeWindowId, 'ax:9:0');
  assert.equal(createAttempts, 2);
  const launch = calls.find(({ file }) => file === '/usr/bin/open');
  assert.deepEqual(launch.args, [
    '-g', '-a', 'Google Chrome', '--args', '--no-startup-window', '--no-first-run', '--no-default-browser-check',
  ]);
  assert.equal(launch.options.shell, undefined);
  assert.doesNotMatch(launch.args.join(' '), /user-data-dir|profile-directory/i);
  const programs = calls.map(({ file, args }) => file === '/usr/bin/open'
    ? 'launch' : (args[3].includes('prepare:populate') ? 'populate' : 'create'));
  assert.deepEqual(programs, ['create', 'launch', 'create', 'populate']);
  assert.match(calls.filter(({ file, args }) => file === '/usr/bin/osascript'
    && args[3].includes('prepare:create'))[1].args[3], /chromeLaunchDeadline = Date\.now\(\) \+ 5000/);
});

test('cold destination launch failure is typed and capture never launches Chrome', async () => {
  const notRunning = () => Object.assign(new Error('Chrome is not running'), { stderr: 'COMPUSYNC_CHROME_NOT_RUNNING' });
  const prepareCalls = [];
  const prepareAdapter = createAppleChromeAdapter({
    native: { enumerateWindows: () => [] }, requestAutomation: () => true,
    execFile: (file, args, options, callback) => {
      prepareCalls.push({ file, args, options });
      if (file === '/usr/bin/open') callback(new Error('LaunchServices rejected Chrome'));
      else callback(notRunning());
    },
  });
  await assert.rejects(
    () => prepareAdapter.prepare(handoffDescriptor('launch-failure'), { x: -900, y: 20, width: 800, height: 600 }),
    { code: 'CHROME_LAUNCH_FAILED' },
  );
  assert.deepEqual(prepareCalls.map(({ file }) => file), ['/usr/bin/osascript', '/usr/bin/open']);

  const captureCalls = [];
  const captureAdapter = createAppleChromeAdapter({
    requestAutomation: () => true,
    execFile: (file, args, options, callback) => {
      captureCalls.push({ file, args, options });
      callback(notRunning());
    },
  });
  await assert.rejects(
    () => captureAdapter.capture({}, { x: 0, y: 0, w: 800, h: 600 }),
    { code: 'CHROME_NOT_RUNNING' },
  );
  assert.deepEqual(captureCalls.map(({ file }) => file), ['/usr/bin/osascript']);
});

test('prepare exposes and positions the native Apple window before tab population finishes', async () => {
  let releasePopulate;
  const populateGate = new Promise((resolve) => { releasePopulate = resolve; });
  const boundsCalls = [];
  let populateStarted = false;
  const nativeWindow = {
    id: 'ax:8:0', processName: 'Google Chrome', visible: true, title: 'Active',
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  };
  let enumerations = 0;
  const adapter = createAppleChromeAdapter({
    machineId: 'mac-b', sleep: async () => {}, requestAutomation: () => true,
    native: {
      enumerateWindows: () => (++enumerations === 1 ? [] : [nativeWindow]),
      setWindowBoundsNormalized: (id, bounds) => boundsCalls.push({ id, bounds }),
    },
    execFile: (file, args, options, callback) => {
      const script = args[3];
      if (script.includes('compusync:chrome:prepare:create')) {
        callback(null, JSON.stringify({ chromeWindowId: '88', chromeWindowIndex: 1, title: 'Active', bounds: [10, 20, 810, 620] }), '');
        return;
      }
      if (script.includes('compusync:chrome:prepare:populate')) {
        populateStarted = true;
        void populateGate.then(() => callback(null, '{}', ''));
        return;
      }
      callback(new Error(`unexpected JXA program: ${file} ${options}`));
    },
  });
  let earlyHandle = null;
  const descriptor = {
    schemaVersion: 1, id: 'early-apple', adapterId: 'chrome', origin: 'win-a', capturedAt: 1,
    geometryVU: { x: 0, y: 0, w: 800, h: 600 }, state: 'normal',
    payload: { activeIdx: 0, tabs: [{ url: 'https://active.example/', title: 'Active', pinned: false, index: 0 }] },
  };
  let settled = false;
  const preparing = adapter.prepare(descriptor, { x: -900, y: 20, width: 800, height: 600 }, {
    onPrepared: async (handle) => {
      earlyHandle = handle;
      await adapter.position(handle, { x: -400, y: 30, width: 800, height: 600 });
      return true;
    },
  }).then((value) => { settled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(populateStarted, true);
  assert.equal(settled, false);
  assert.equal(earlyHandle.nativeWindowId, 'ax:8:0');
  assert.deepEqual(boundsCalls, [
    { id: 'ax:8:0', bounds: { x: -900, y: 20, width: 800, height: 600 } },
    { id: 'ax:8:0', bounds: { x: -400, y: 30, width: 800, height: 600 } },
  ]);

  releasePopulate();
  assert.equal((await preparing).nativeWindowId, 'ax:8:0');
  assert.equal(settled, true);
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
  assert.equal(calls.length, 3);
  assert.ok(calls[2].args[3].includes('compusync:chrome:close'));
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
