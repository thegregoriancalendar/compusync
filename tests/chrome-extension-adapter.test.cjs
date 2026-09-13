'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ChromeExtensionAdapter, joinNativeWindows } = require('../src/main/adapters/chrome/extension-adapter.cjs');

const source = {
  windowId: 7, left: 10, top: 20, width: 800, height: 600, state: 'normal',
  focused: true,
  tabs: [{ tabId: 11, index: 0, url: 'https://example.test/a', title: 'A', pinned: true, active: true,
    history: { currentIndex: 1, entries: ['https://example.test/', 'https://example.test/a'] } }],
};

test('extension adapter joins Chrome IDs to native HWNDs and captures the wire descriptor', async () => {
  const requests = [];
  const bridge = { connected: true, async request(method) {
    requests.push(method);
    return method === 'windows.list' ? { windows: [source] } : source;
  } };
  const nativeWindow = { id: '0x7', processName: 'chrome.exe', bounds: { x: 10, y: 20, width: 800, height: 600 } };
  const adapter = new ChromeExtensionAdapter({ bridge, native: { enumerateWindows: () => [nativeWindow] }, machineId: 'win', now: () => 9 });
  const descriptor = await adapter.capture(nativeWindow, { x: 1, y: 2, w: 800, h: 600 });
  assert.equal(descriptor.origin, 'win');
  assert.equal(descriptor.payload.tabs[0].pinned, true);
  assert.deepEqual(descriptor.payload.tabs[0].history.entries, ['https://example.test/', 'https://example.test/a']);
  assert.deepEqual(requests, ['windows.list', 'window.capture']);
  await adapter.close(nativeWindow);
  assert.equal(requests.at(-1), 'window.close');
});

test('native join does not attach a far-away unrelated Chrome window', () => {
  const groups = [{ windowId: 1, bounds: { left: 0, top: 0, width: 800, height: 600 }, tabs: [] }];
  const joined = joinNativeWindows(groups, [{ id: 'x', processName: 'chrome.exe', bounds: { x: 2000, y: 0, width: 800, height: 600 } }]);
  assert.equal(joined[0].nativeWindow, null);
});

test('focused Chrome identity survives physical-DPI and live-drag bounds mismatch', async () => {
  const capturedIds = [];
  const distractor = { ...source, windowId: 8, focused: false, left: 500, top: 300, width: 1000, height: 750 };
  const bridge = { connected: true, async request(method, params) {
    if (method === 'windows.list') return { windows: [source, distractor] };
    capturedIds.push(params.windowId);
    return source;
  } };
  const dragged = {
    id: 'hwnd:scaled', processName: 'chrome.exe', visible: true,
    bounds: { x: 500, y: 300, width: 1000, height: 750 },
  };
  const adapter = new ChromeExtensionAdapter({
    bridge, native: { enumerateWindows: () => [dragged] }, machineId: 'win', now: () => 9,
  });
  const descriptor = await adapter.capture(dragged, { x: 400, y: 240, w: 800, h: 600 });
  assert.equal(descriptor.payload.tabs[0].url, 'https://example.test/a');
  assert.deepEqual(capturedIds, [7]);
});

test('unsupported tabs remain matchable and report their real capture error', async () => {
  const unsupported = {
    ...source,
    tabs: [{ tabId: 11, index: 0, url: 'chrome://newtab/', title: 'New Tab', active: true }],
  };
  const bridge = { connected: true, async request(method) {
    if (method === 'windows.list') return { windows: [unsupported] };
    throw Object.assign(new Error('Unsupported tab.'), { code: 'UNSUPPORTED_TABS' });
  } };
  const dragged = { id: 'hwnd:newtab', processName: 'chrome.exe', visible: true, bounds: { x: 10, y: 20, width: 800, height: 600 } };
  const adapter = new ChromeExtensionAdapter({ bridge, native: { enumerateWindows: () => [dragged] }, machineId: 'win' });
  await assert.rejects(() => adapter.capture(dragged, { x: 10, y: 20, w: 800, h: 600 }),
    ({ code }) => code === 'CHROME_UNSUPPORTED_TABS');
});

test('extension prepare exposes a movable window before slow tab restoration finishes', async () => {
  const requests = [];
  let finish;
  const finishing = new Promise((resolve) => { finish = resolve; });
  const bridge = { connected: true, async request(method, params) {
    requests.push([method, params]);
    if (method === 'window.prepare.begin') {
      return { windowId: 44, tabs: [{ tabId: 100, index: 0, active: true }] };
    }
    if (method === 'window.prepare.finish') {
      await finishing;
      return { windowId: 44, tabs: [
        { tabId: 100, index: 0, active: true },
        { tabId: 101, index: 1, active: false },
      ] };
    }
    if (method === 'window.position') return { windowId: params.windowId };
    throw new Error(`unexpected ${method}`);
  } };
  const adapter = new ChromeExtensionAdapter({ bridge, sleep: async () => {} });
  const descriptor = {
    schemaVersion: 1, id: 'handoff', adapterId: 'chrome', origin: 'peer', capturedAt: 1,
    geometryVU: { x: 10, y: 20, w: 800, h: 600 }, state: 'normal',
    payload: {
      activeIdx: 0,
      tabs: [
        { url: 'https://one.example/', title: 'One', pinned: false, index: 0 },
        { url: 'https://two.example/', title: 'Two', pinned: false, index: 1 },
      ],
    },
  };
  let earlyHandle;
  const targetPlacement = {
    machineId: 'local', platform: 'win32', origin: { x: 0, y: 0 },
    size: { w: 1920, h: 1080 }, scale: 1,
  };
  const preparing = adapter.prepare(descriptor, {
    originVU: { x: -900, y: 20 }, targetPlacement,
    onPrepared: async (handle) => {
      earlyHandle = handle;
      await adapter.position(handle, { x: 300, y: 200 });
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(earlyHandle.windowId, 44);
  assert.deepEqual(requests.slice(0, 3).map(([method]) => method), [
    'window.prepare.begin', 'window.position', 'window.prepare.finish',
  ]);
  finish();
  const handle = await preparing;
  assert.equal(handle.windowId, 44);
  assert.deepEqual(handle.tabIds, [100, 101]);
});
