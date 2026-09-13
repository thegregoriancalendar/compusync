'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ChromeExtensionAdapter, joinNativeWindows } = require('../src/main/adapters/chrome/extension-adapter.cjs');

const source = {
  windowId: 7, left: 10, top: 20, width: 800, height: 600, state: 'normal',
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
