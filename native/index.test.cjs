'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createNativeAdapter, NativeAdapter } = require('./index.cjs');

test('loader has a behavior-compatible fallback when the binary is absent', () => {
  const adapter = createNativeAdapter();
  assert.equal(typeof adapter.startCursorCapture, 'function');
  assert.equal(typeof adapter.emergencyRecover, 'function');
  adapter.warpCursor({ x: 12, y: -3 });
  if (!adapter.available) assert.deepEqual(adapter.cursorPosition(), { x: 12, y: -3 });
});

test('required mode reports a stable addon-unavailable error', () => {
  if (createNativeAdapter().available) return;
  assert.throws(() => createNativeAdapter({ required: true }), { code: 'COMPUSYNC_NATIVE_UNAVAILABLE' });
});

test('native JSON events normalize Rust snake-case window ids', () => {
  class Substrate {
    setEventCallback(callback) { this.callback = callback; }
    startCapture() {}
    get platformName() { return 'test'; }
  }
  const binding = { NativeSubstrate: Substrate };
  const adapter = new NativeAdapter(binding, 'test.node');
  let started;
  adapter.on('moveSizeStart', (id) => { started = id; });
  adapter.startCursorCapture({});
  adapter.substrate.callback(JSON.stringify({ kind: 'moveSizeStart', window_id: 'hwnd:42' }));
  assert.equal(started, 'hwnd:42');
});
