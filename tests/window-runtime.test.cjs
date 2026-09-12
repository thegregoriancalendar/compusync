'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { geometryToVU, WindowHandoffRuntime } = require('../src/main/window-runtime.cjs');

test('native device-pixel window geometry converts to the shared VU placement', () => {
  assert.deepEqual(geometryToVU({ bounds: { x: 200, y: 100, width: 800, height: 600 } },
    { origin: { x: 1000, y: 50 }, size: { w: 1000, h: 800 }, scale: 2 }),
  { x: 1100, y: 100, w: 400, h: 300 });
});

test('native move events poll at the drag boundary and emit one Chrome offer', async () => {
  const native = new EventEmitter();
  let window = { id: 'hwnd', processName: 'chrome.exe', bounds: { x: 700, y: 100, width: 400, height: 300 } };
  native.enumerateWindows = () => [window];
  const sent = [], placement = { machineId: 'a', origin: { x: 0, y: 0 }, size: { w: 1000, h: 800 }, scale: 1 };
  const peer = { machineId: 'b', origin: { x: 1000, y: 0 }, size: { w: 1000, h: 800 }, scale: 1 };
  const input = new EventEmitter();
  input.machineId = 'a';
  input.cursor = { linked: true, placements: [placement, peer], virtualCursor: { x: 800, y: 100 }, placementFor: () => placement };
  input.send = (message) => { sent.push(message); return true; };
  input.setDragging = () => {};
  input.setWindowController = (value) => { input.windowController = value; };
  input.watchdog = { trigger() {} };
  const adapter = {
    async capture(_window, geometryVU) { return { schemaVersion: 1, id: 'window-stable', adapterId: 'chrome', origin: 'a', capturedAt: 1,
      geometryVU, state: 'normal', payload: { activeIdx: 0, tabs: [{ url: 'https://example.com', title: '', pinned: false, index: 0 }] } }; },
    async position() {}, async close() {},
  };
  const chrome = new EventEmitter();
  chrome.adapterForWindow = () => adapter;
  chrome.adapterForId = () => adapter;
  chrome.setLinked = () => {};
  chrome.stop = () => {};
  const runtime = new WindowHandoffRuntime({ input, native, chrome, frameMs: 100000 });
  runtime.start();
  assert.equal(await runtime.handleMoveStart('hwnd'), true);
  window = { ...window, bounds: { ...window.bounds, x: 810 } };
  await runtime.poll();
  assert.equal(sent.filter(({ type }) => type === 'window.offer').length, 1);
  await runtime.stop();
});
