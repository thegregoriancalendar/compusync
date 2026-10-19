'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { ChromeCapture, DescriptorIdentityCache } = require('../src/main/adapters/chrome/capture.cjs');
const { ChromePrepare, boundsFromVU } = require('../src/main/adapters/chrome/prepare.cjs');
const { createChromeHandoffAdapter } = require('../src/main/adapters/chrome/index.cjs');
const { NativeAdapter } = require('../native/index.cjs');
const { geometryToVU } = require('../src/main/window-runtime.cjs');
const { sanitizePeerMessage } = require('../src/main/messages.cjs');
const { createChromeExtensionAdapter } = require('../src/main/adapters/chrome/extension-adapter.cjs');

function descriptor(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'stable-handoff-id',
    adapterId: 'chrome',
    origin: 'mac-a',
    capturedAt: 10,
    geometryVU: { x: 100, y: 50, w: 800, h: 600 },
    state: 'normal',
    payload: {
      activeIdx: 1,
      tabs: [
        { url: 'https://first.example/private?a=secret', title: 'First', pinned: true, index: 0 },
        {
          url: 'https://active.example/watch?token=secret', title: 'Active', pinned: false, index: 1,
          history: { currentIndex: 1, entries: ['https://active.example/one', 'https://active.example/two'] },
        },
        { url: 'https://last.example/', title: 'Last', pinned: true, index: 2 },
      ],
    },
    ...overrides,
  };
}

test('CDP capture emits ordered/pinned tabs, every tab history, VU geometry, and host-only logs', async () => {
  const logs = [];
  const selected = {
    id: 'hwnd-9', processName: 'chrome.exe', visible: true, maximized: true,
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  };
  const rawTabs = [
    { id: 'last', type: 'page', title: 'Last', url: 'https://last.example/full/path' },
    { id: 'active', type: 'page', title: 'Active', url: 'https://active.example/watch?token=do-not-log' },
    { id: 'first', type: 'page', title: 'First', url: 'https://first.example/private' },
  ];
  const cdp = {
    async connect() {},
    async windows() {
      return [{
        windowId: 9, tabs: rawTabs, nativeWindow: selected,
        bounds: { left: 10, top: 20, width: 800, height: 600, windowState: 'maximized' },
      }];
    },
    async withPage(targetId, callback) {
      return callback(async (method) => {
        if (method === 'Runtime.evaluate') return { result: { value: targetId === 'active' ? 'visible' : 'hidden' } };
        if (method === 'Page.getNavigationHistory') return {
          currentIndex: 1,
          entries: [
            { id: 4, url: 'https://active.example/one' },
            { id: 5, url: 'https://active.example/two?credential=hidden' },
          ],
        };
        throw new Error(`unexpected method ${method}`);
      });
    },
  };
  const capture = new ChromeCapture({
    cdp,
    machineId: 'win-b',
    now: () => 123,
    uuid: () => 'fresh-id',
    native: { enumerateWindows: () => [selected] },
    logger: (event, details) => logs.push({ event, details }),
    tabControl: { captureWindow: () => [
      { targetId: 'first', index: 0, pinned: true },
      { targetId: 'active', index: 1, pinned: false },
      { targetId: 'last', index: 2, pinned: true },
    ] },
  });
  const result = await capture.capture(selected, { x: 101.5, y: 52, w: 400, h: 300 });
  assert.equal(result.id, 'fresh-id');
  assert.equal(result.state, 'maximized');
  assert.deepEqual(result.geometryVU, { x: 101.5, y: 52, w: 400, h: 300 });
  assert.deepEqual(result.payload.tabs.map((tab) => [tab.title, tab.pinned, tab.index]), [
    ['First', true, 0], ['Active', false, 1], ['Last', true, 2],
  ]);
  assert.equal(result.payload.activeIdx, 1);
  assert.deepEqual(result.payload.tabs[1].history, {
    currentIndex: 1,
    entries: ['https://active.example/one', 'https://active.example/two?credential=hidden'],
  });
  assert.ok(result.payload.tabs.every((tab) => tab.history?.entries.length === 2));
  assert.equal(logs[0].details.host, 'active.example');
  assert.doesNotMatch(JSON.stringify(logs), /do-not-log|credential|\/watch|\/two/);
});

test('native fullscreen Chrome is serialized onto the non-straddling state path', async () => {
  const nativeWindow = { id: 'fullscreen', processName: 'chrome.exe', visible: true, fullscreen: true };
  const capture = new ChromeCapture({
    machineId: 'win-b', native: { enumerateWindows: () => [nativeWindow] },
    cdp: {
      async connect() {},
      async windows() { return [{ windowId: 1, nativeWindow, tabs: [
        { id: 'tab', type: 'page', title: '', url: 'https://example.com', active: true },
      ], bounds: { windowState: 'normal' } }]; },
      async withPage(_id, callback) { return callback(async (method) => method === 'Page.getNavigationHistory'
        ? { currentIndex: 0, entries: [{ id: 1, url: 'https://example.com' }] }
        : { result: { value: 'visible' } }); },
    },
  });
  const result = await capture.capture(nativeWindow, { x: 0, y: 0, w: 800, h: 600 });
  assert.equal(result.state, 'maximized');
});

test('history capture never exceeds four concurrent CDP pages', async () => {
  let active = 0;
  let peak = 0;
  const targets = Array.from({ length: 12 }, (_, index) => ({
    id: `tab-${index}`, type: 'page', title: `${index}`, url: `https://example.com/${index}`,
    index, active: index === 0,
  }));
  const nativeWindow = { id: 'bounded-window', processName: 'chrome.exe', visible: true };
  const capture = new ChromeCapture({
    machineId: 'win-b', native: { enumerateWindows: () => [nativeWindow] },
    cdp: {
      async connect() {},
      async windows() { return [{ windowId: 1, nativeWindow, tabs: targets }]; },
      async withPage(targetId, callback) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        try {
          return await callback(async (method) => method === 'Page.getNavigationHistory'
            ? { currentIndex: 0, entries: [{ id: 1, url: `https://example.com/${targetId}` }] }
            : { result: { value: targetId === 'tab-0' ? 'visible' : 'hidden' } });
        } finally { active -= 1; }
      },
    },
  });
  const result = await capture.capture(nativeWindow, { x: 0, y: 0, w: 800, h: 600 });
  assert.equal(result.payload.tabs.filter((tab) => tab.history).length, 12);
  assert.equal(peak, 4);
});

test('prepare creates active first, bounds it before staggered background tabs, pins, reactivates, restores history, and waits for load', async () => {
  const calls = [];
  const sleeps = [];
  const page = new EventEmitter();
  const cdp = {
    async connect() { calls.push(['connect']); },
    async createWindow(url, bounds) {
      calls.push(['createWindow', url, bounds]);
      return { targetId: 'target-active', windowId: 77 };
    },
    async createTarget(url, options) {
      const id = `target-${calls.filter(([name]) => name === 'createTarget').length}`;
      calls.push(['createTarget', url, options, id]);
      return id;
    },
    async windows(windows) {
      calls.push(['joinNative']);
      return [{ windowId: 77, nativeWindow: windows[0], tabs: [] }];
    },
    async focusTarget(targetId, nativeWindow) { calls.push(['focus', targetId, nativeWindow.id]); },
    async withPage(targetId, callback) {
      calls.push(['withPage', targetId]);
      return callback(async (method, params) => {
        calls.push([method, params]);
        if (method === 'Page.getNavigationHistory') return {
          currentIndex: 2,
          entries: [{ id: 20 }, { id: 21 }, { id: 22 }],
        };
        if (method === 'Runtime.evaluate') return { result: { value: 'complete' } };
        return {};
      }, page);
    },
    async closeTarget(targetId) { calls.push(['close', targetId]); },
  };
  const pinCalls = [];
  const prepare = new ChromePrepare({
    cdp,
    native: {
      enumerateWindows: () => [{ id: 'hwnd-new', processName: 'chrome.exe', visible: true }],
      toPlatformBounds: (bounds) => ({ ...bounds, x: bounds.x - 1920, y: bounds.y - 200 }),
    },
    tabControl: { setPinned: (request) => { pinCalls.push(request); } },
    random: () => 0.5,
    sleep: async (ms) => { sleeps.push(ms); calls.push(['sleep', ms]); },
  });
  const result = await prepare.prepare(descriptor(), {
    originVU: { x: 2001, y: 20 },
    targetPlacement: { machineId: 'win-b', origin: { x: 1000, y: 0 }, size: { w: 1000, h: 800 }, scale: 2 },
    onPrepared: (handle) => { calls.push(['early', handle]); return true; },
  });
  assert.deepEqual(calls.find(([name]) => name === 'createWindow').slice(1), [
    'https://active.example/watch?token=secret',
    { x: 82, y: -160, width: 1600, height: 1200 },
  ]);
  const backgrounds = calls.filter(([name]) => name === 'createTarget');
  assert.deepEqual(backgrounds.map((call) => call[1]), [
    'https://first.example/private?a=secret', 'https://last.example/',
  ]);
  assert.ok(backgrounds.every((call) => call[2].background === true));
  assert.ok(calls.findIndex(([name]) => name === 'early') < calls.findIndex(([name]) => name === 'createTarget'));
  assert.equal(calls.find(([name]) => name === 'early')[1].windowId, 77);
  assert.deepEqual(sleeps, [100, 100]);
  assert.deepEqual(pinCalls.map(({ pinned, index }) => [pinned, index]), [[true, 0], [false, 1], [true, 2]]);
  assert.ok(calls.findIndex(([name]) => name === 'focus') > calls.findLastIndex(([name]) => name === 'createTarget'));
  assert.deepEqual(calls.filter(([name]) => name === 'Page.navigate').map((call) => call[1].url), [
    'https://active.example/one', 'https://active.example/two',
  ]);
  assert.deepEqual(calls.find(([name]) => name === 'Page.navigateToHistoryEntry')[1], { entryId: 22 });
  assert.equal(result.descriptorId, 'stable-handoff-id');
  assert.equal(result.nativeWindowId, 'hwnd-new');
  assert.equal(result.instantCommit, false);
});

test('prepared native-window metadata/cache preserves one descriptor UUID across the next capture', async () => {
  const identities = new DescriptorIdentityCache({ uuid: () => 'must-not-be-used' });
  const records = new Map();
  const nativeWindow = { id: 'hwnd-roundtrip', processName: 'chrome.exe', visible: true, bounds: { x: 0, y: 0, width: 800, height: 600 } };
  const closed = [];
  const cdp = {
    async connect() {},
    async createWindow() { return { targetId: 'active', windowId: 12 }; },
    async createTarget(url) { return url.includes('first') ? 'first' : 'last'; },
    async focusTarget() {},
    async setWindowBounds() {},
    async closeTarget(id) { closed.push(id); },
    async windows() {
      return [{
        windowId: 12, nativeWindow,
        bounds: { left: 0, top: 0, width: 800, height: 600, windowState: 'normal' },
        tabs: [
          { id: 'first', type: 'page', url: 'https://first.example/', title: 'First', pinned: true, index: 0 },
          { id: 'active', type: 'page', url: 'https://active.example/', title: 'Active', active: true, index: 1 },
          { id: 'added', type: 'page', url: 'https://added.example/', title: 'Added', index: 2 },
        ],
      }];
    },
    async withPage(targetId, callback) {
      const page = new EventEmitter();
      return callback(async (method) => {
        if (method === 'Runtime.evaluate') return { result: { value: 'complete' } };
        if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [{ id: 1, url: 'https://active.example/' }] };
        return {};
      }, page);
    },
  };
  let nativeCloseCalls = 0;
  const native = { enumerateWindows: () => [nativeWindow], closeWindow: () => { nativeCloseCalls += 1; } };
  const adapter = createChromeHandoffAdapter({
    platform: 'win32', cdp, native, identities, records,
    machineId: 'win-b', sleep: async () => {}, tabControl: { setPinned() {} }, loadCapMs: 5,
  });
  const prepared = await adapter.prepare(descriptor(), { x: -1000, y: 20, width: 800, height: 600 });
  assert.equal(prepared.descriptorId, 'stable-handoff-id');
  // Simulate a fresh object returned by a later native enumeration.
  delete nativeWindow.descriptorId;
  const roundTrip = await adapter.capture({ ...nativeWindow }, { x: 0, y: 0, w: 800, h: 600 });
  assert.equal(roundTrip.id, 'stable-handoff-id');
  assert.equal(roundTrip.payload.tabs.length, 3);
  await adapter.close({ ...nativeWindow });
  assert.deepEqual(closed, ['added', 'first', 'active']);
  assert.equal(nativeCloseCalls, 0);
});

test('failed CDP target closure falls back to the native Chrome window', async () => {
  const closed = [];
  const adapter = createChromeHandoffAdapter({
    platform: 'win32',
    cdp: { closeTarget: async () => false },
    native: { closeWindow: async (id) => closed.push(id) },
  });
  await adapter.close({ id: 'hwnd-fallback', targetIds: ['target-a'], activeTargetId: 'target-a' });
  assert.deepEqual(closed, ['hwnd-fallback']);

  const unavailable = createChromeHandoffAdapter({
    platform: 'win32', cdp: { closeTarget: async () => false }, native: {},
  });
  await assert.rejects(
    () => unavailable.close({ targetIds: ['target-a'], activeTargetId: 'target-a' }),
    { code: 'CHROME_CLOSE_FAILED' },
  );
});

test('high-level adapter delegates Apple operations and marks maximized windows for instant commit', async () => {
  const calls = [];
  const apple = {
    async capture(window, geometry, stable) {
      calls.push(['capture', window, geometry, stable]);
      return descriptor({ id: stable.id, geometryVU: geometry, state: 'maximized' });
    },
    async prepare(value, bounds, options) {
      calls.push(['prepare', value.id, bounds]);
      const early = { nativeWindowId: 'ax-window', chromeWindowId: '42' };
      if (options.onPrepared) await options.onPrepared(early);
      return early;
    },
    async position(handle, bounds) { calls.push(['position', handle.nativeWindowId, bounds]); },
    async focus(handle) { calls.push(['focus', handle.nativeWindowId]); },
    async close(handle) { calls.push(['close', handle.nativeWindowId]); },
  };
  const adapter = createChromeHandoffAdapter({
    platform: 'darwin', appleAdapter: apple,
    uuid: () => 'apple-stable-id',
    placement: { machineId: 'mac-b', origin: { x: 1000, y: 0 }, size: { w: 1000, h: 800 }, scale: 2 },
  });
  const source = { id: 'ax-source', bundleId: 'com.google.Chrome', visible: true };
  assert.equal(adapter.isAddressable(source), true);
  assert.equal(adapter.isAddressable({ id: 'notes', processName: 'Notes' }), false);
  const captured = await adapter.capture(source, { x: 0, y: 0, w: 400, h: 300 });
  assert.equal(captured.id, 'apple-stable-id');
  let earlyHandle = null;
  const handle = await adapter.prepare(captured, {
    originVU: { x: 2001, y: 20 },
    targetPlacement: adapter.placement,
    onPrepared: (value) => { earlyHandle = value; return true; },
  });
  assert.equal(handle.instantCommit, true);
  assert.equal(earlyHandle.instantCommit, true);
  assert.deepEqual(earlyHandle.geometryVU, captured.geometryVU);
  await adapter.position(handle, { x: 1100, y: 50 });
  await adapter.focus(handle);
  await adapter.close(handle);
  assert.deepEqual(calls.find(([name]) => name === 'prepare')[2], { x: 2002, y: 40, width: 800, height: 600 });
  assert.deepEqual(calls.find(([name]) => name === 'position')[2], { x: 200, y: 100, width: 800, height: 600 });
});

test('a Chrome window created on Mac can be captured and prepared on Windows without prior handoff records', async () => {
  const geometry = { x: -900, y: 50, w: 800, h: 600 };
  const source = { id: 'ax:9:0', processName: 'Google Chrome', visible: true,
    title: 'Mac page', bounds: { x: 100, y: 50, width: 800, height: 600 } };
  const tabs = [{ index: 0, url: 'https://example.com/mac-created', title: 'Mac page', pinned: false }];
  const mac = createChromeHandoffAdapter({
    platform: 'darwin', machineId: 'mac', uuid: () => 'new-mac-window',
    placement: { machineId: 'mac', origin: { x: -1000, y: 0 }, size: { w: 1000, h: 800 }, scale: 2 },
    execFile(_file, args, _options, callback) {
      if (args[3].includes('compusync:chrome:capture')) callback(null, JSON.stringify([{
        chromeWindowId: '91', chromeWindowIndex: 1, title: source.title,
        bounds: [100, 50, 900, 650], activeIdx: 0, tabs,
      }]), '');
      else callback(null, JSON.stringify({ unavailable: true }), '');
    },
  });
  const captured = await mac.capture(source, geometry);
  const offer = sanitizePeerMessage({ type: 'window.offer', descriptor: captured });
  assert.ok(offer);
  assert.equal(offer.descriptor.origin, 'mac');
  assert.equal(offer.descriptor.id, 'new-mac-window');
  assert.deepEqual(offer.descriptor.payload.tabs, tabs);
  assert.equal(offer.descriptor.payload.tabs[0].history, undefined);

  const calls = [];
  const win = createChromeExtensionAdapter({
    machineId: 'win', native: { enumerateWindows: () => [] },
    bridge: { request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'windows.list') return { windows: [] };
      assert.ok(['window.prepare.begin', 'window.prepare.finish'].includes(method));
      return { windowId: 92, tabs: [{ tabId: 93, index: 0, url: tabs[0].url, active: true }] };
    } },
  });
  const handle = await win.prepare(offer.descriptor, { originVU: { x: 10, y: 50 },
    targetPlacement: { machineId: 'win', origin: { x: 0, y: 0 }, size: { w: 1920, h: 1080 }, scale: 1.25 } });
  assert.equal(handle.windowId, 92);
  const prepared = calls.find(({ method }) => method === 'window.prepare.begin').params;
  assert.deepEqual(prepared.tabs, tabs);
  assert.deepEqual(prepared.bounds, { x: 13, y: 63, width: 1000, height: 750 });
});

test('VU-derived Windows CDP positions are converted back to OS-global coordinates', async () => {
  const calls = [];
  const adapter = createChromeHandoffAdapter({
    platform: 'win32',
    cdp: { setWindowBounds: (id, bounds) => calls.push({ id, bounds }) },
    native: { toPlatformBounds: (bounds) => ({ ...bounds, x: bounds.x - 1920, y: bounds.y - 900 }) },
    placement: { machineId: 'win', origin: { x: 0, y: 0 }, size: { w: 3584, h: 1440 }, scale: 1.25 },
  });
  await adapter.position({ windowId: 77, geometryVU: { x: 0, y: 0, w: 640, h: 480 } }, { x: 96, y: 40 });
  assert.deepEqual(calls, [{ id: 77, bounds: { x: -1800, y: -850, width: 800, height: 600 } }]);
});

test('125% Windows capture prepares an 800x600 point Retina window and preserves logical drag distance', async () => {
  const windowsPlacement = { machineId: 'win', origin: { x: 0, y: 0 }, size: { w: 2560, h: 1440 }, scale: 1.25 };
  const geometry = geometryToVU({
    normalizedBounds: { x: 125, y: 75, width: 1000, height: 750 },
  }, windowsPlacement);
  assert.deepEqual(geometry, { x: 100, y: 60, w: 800, h: 600 });
  let created = false;
  const nativeCalls = [];
  class NativeSubstrate {
    constructor() { this.platformName = 'darwin'; }
    displayMetrics() { return [{ bounds: { x: 0, y: 0, width: 1512, height: 982 }, scale: 2, primary: true }]; }
    enumerateWindows() {
      return created ? [{
        id: 'ax-created', processName: 'Google Chrome', title: 'A', visible: true,
        bounds: { x: 10, y: 30, width: 800, height: 600 },
      }] : [];
    }
    setWindowBounds(id, bounds) { nativeCalls.push({ id, bounds }); }
  }
  const native = new NativeAdapter({ NativeSubstrate }, 'native.node');
  const macPlacement = { machineId: 'mac', origin: { x: -1512, y: 0 }, size: { w: 1512, h: 982 }, scale: 2 };
  const adapter = createChromeHandoffAdapter({
    platform: 'darwin', native, placement: macPlacement,
    execFile(_file, _args, _options, callback) {
      created = true;
      callback(null, JSON.stringify({ chromeWindowId: '42', chromeWindowIndex: 1, title: 'A', bounds: [10, 30, 810, 630] }), '');
    },
  });
  const handle = await adapter.prepare(descriptor({ geometryVU: geometry }), {
    originVU: { x: -1600, y: 30 }, targetPlacement: macPlacement,
  });
  assert.deepEqual(nativeCalls.at(-1), {
    id: 'ax-created', bounds: { x: -88, y: 30, width: 800, height: 600 },
  });
  await adapter.position(handle, { x: -1000, y: 130 });
  const before = nativeCalls.at(-1).bounds;
  await adapter.position(handle, { x: -900, y: 230 });
  const after = nativeCalls.at(-1).bounds;
  assert.deepEqual(after, { x: 612, y: 230, width: 800, height: 600 });
  assert.equal(after.x - before.x, 100);
  assert.equal(after.y - before.y, 100);
  await adapter.position({ ...handle, geometryVU: { ...geometry, w: 400, h: 300 } }, { x: -900, y: 230 });
  assert.deepEqual(nativeCalls.at(-1).bounds, { x: 612, y: 230, width: 400, height: 300 });
});

test('descriptor validation rejects unsafe input before any Chrome side effect', async () => {
  let calls = 0;
  const prepare = new ChromePrepare({ cdp: {
    connect() { calls += 1; },
    createWindow() { calls += 1; },
  } });
  await assert.rejects(() => prepare.prepare(descriptor({
    payload: { activeIdx: 0, tabs: [{ url: 'file:///secret', title: '', pinned: false, index: 0 }] },
  }), { x: 0, y: 0, width: 800, height: 600 }), { code: 'CHROME_INVALID_DESCRIPTOR' });
  assert.equal(calls, 0);
  assert.deepEqual(boundsFromVU(
    { x: 5, y: 5 }, { w: 100, h: 50 },
    { machineId: 'b', origin: { x: 0, y: 0 }, size: { w: 1000, h: 800 }, scale: 1.5 },
  ), { x: 8, y: 8, width: 150, height: 75 });
});

test('factory accepts the endpoint returned by Chrome detection without probing or connecting', () => {
  const adapter = createChromeHandoffAdapter({
    platform: 'win32',
    native: {},
    detection: { endpoint: {
      port: 9222,
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/local-browser',
    } },
  });
  assert.equal(adapter.cdp.constructor.name, 'ChromeCdp');
  assert.equal(adapter.isAddressable({ processName: 'chrome.exe', visible: true }), true);
});
