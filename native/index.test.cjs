'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  createNativeAdapter,
  loadBinding,
  NativeAdapter,
  nativeCandidates,
  REQUIRED_SUBSTRATE_METHODS,
} = require('./index.cjs');

function compatibleBinding(omittedMethod) {
  class NativeSubstrate {}
  for (const method of REQUIRED_SUBSTRATE_METHODS) {
    if (method !== omittedMethod) NativeSubstrate.prototype[method] = () => {};
  }
  return { NativeSubstrate };
}

test('development loader prefers the platform-qualified addon over stale generic builds', () => {
  const nativeDirectory = path.join('checkout', 'native');
  const candidates = nativeCandidates({
    envPath: null,
    resourcesPath: null,
    platform: 'win32',
    arch: 'x64',
    nativeDirectory,
  });
  assert.equal(candidates[0], path.join(nativeDirectory, 'compusync-native.win32-x64.node'));
  assert.equal(candidates[1], path.join(nativeDirectory, 'compusync-native.node'));
});

test('loader skips an obsolete addon that lacks the recovery guard API', () => {
  const obsolete = compatibleBinding('installRecoveryGuard');
  const current = compatibleBinding();
  const loaded = loadBinding({
    candidates: ['obsolete.node', 'current.node'],
    requireBinding: (candidate) => candidate === 'obsolete.node' ? obsolete : current,
  });

  assert.equal(loaded.binding, current);
  assert.equal(loaded.path, 'current.node');
  assert.equal(loaded.failures.length, 1);
  assert.equal(loaded.failures[0].code, 'COMPUSYNC_NATIVE_INCOMPATIBLE');
  assert.match(loaded.failures[0].message, /installRecoveryGuard/);
});

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
