'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { SharedInputRuntime, derivePairPlacements } = require('../src/main/runtime.cjs');

function layout(width, height, scaleFactor) {
  return { displays: [{ bounds: { x: 0, y: 0, width, height }, scaleFactor, primary: true }] };
}

class FakeSession extends EventEmitter {
  constructor() { super(); this.phase = 'connected'; this.sent = []; }
  sendPeer(message, options) { this.sent.push({ message, options }); return true; }
}

class FakeNative extends EventEmitter {
  constructor() { super(); this.available = true; this.calls = []; }
  call(name, ...args) { this.calls.push([name, ...args]); }
  configureAcceleration(value) { this.call('configureAcceleration', value); }
  startCursorCapture(value) { this.handlers = value; this.call('startCursorCapture'); }
  stopCursorCapture() { this.call('stopCursorCapture'); }
  setLinked(value) { this.call('setLinked', value); }
  heartbeat() {}
  releaseInputState() {}
  showCursor() {}
  hideCursor() {}
  parkCursor() {}
  releaseCursor() {}
  warpCursor() {}
  emergencyRecover() {}
  removeAllHooks() {}
  installRecoveryGuard() {}
}

const settings = {
  screenSide: 'right', verticalOffsetVU: 10,
  acceleration: { base: 1, threshold: 0.5, slope: 0.015 },
  edgeResistanceVU: 0, linked: true,
};

test('host layout configuration produces one adjacent, mixed-DPI VU pair', () => {
  const placements = derivePairPlacements({ win: layout(1920, 1080, 1.25), mac: layout(1440, 900, 2) }, 'win', 'mac', settings);
  assert.deepEqual(placements[0].size, { w: 1920, h: 1080 });
  assert.equal(placements[0].scale, 1.25);
  assert.equal(placements[1].origin.x, -1440);
  assert.equal(placements[1].origin.y, 100);
});

test('v3 desktop metrics override the active-display DIP size for multi-monitor cursor placement', () => {
  const win = { ...layout(2048, 1152, 1.25), desktop: { widthVU: 3584, heightVU: 1440, scale: 1.25 } };
  const mac = { ...layout(1512, 982, 2), desktop: { widthVU: 2792, heightVU: 1080, scale: 2 } };
  const placements = derivePairPlacements({ win, mac }, 'win', 'mac', settings);
  assert.deepEqual(placements[0].size, { w: 3584, h: 1440 });
  assert.equal(placements[0].scale, 1.25);
  assert.deepEqual(placements[1].size, { w: 2792, h: 1080 });
});

test('runtime sanitizes traffic, agrees layout, links only with peer and native support, then recovers', () => {
  const session = new FakeSession();
  const native = new FakeNative();
  const modes = [];
  const runtime = new SharedInputRuntime({
    session, native, machineId: 'win', hostId: 'win', peerId: 'mac', settings,
    layouts: { win: layout(1920, 1080, 1), mac: layout(1440, 900, 2) },
    onModeChange: (linked, reason) => modes.push([linked, reason]),
  });
  runtime.start();
  assert.equal(runtime.cursor.linked, true);
  assert.equal(session.sent.some(({ message }) => message.type === 'layout.update'), true);
  assert.equal(runtime.receive({ type: 'cursor.delta', dx: Infinity, dy: 0, t: 1 }, 'mac'), false);
  assert.equal(runtime.receive({ type: 'heartbeat', t: 1 }, 'stranger'), false);
  runtime.watchdog.trigger('test-failure');
  assert.equal(runtime.cursor.linked, false);
  assert.deepEqual(modes.at(-1), [false, 'test-failure']);
  runtime.stop();
});

test('production native owns fail-safe hotkeys without Electron registration conflicts', () => {
  const session = new FakeSession(), native = new FakeNative(), registered = [];
  const runtime = new SharedInputRuntime({
    session, native, machineId: 'win', hostId: 'win', peerId: 'mac', settings,
    layouts: { win: layout(1920, 1080, 1), mac: layout(1440, 900, 2) },
    globalShortcut: { register: (key) => { registered.push(key); return true; }, unregister() {} },
  });
  runtime.start();
  assert.deepEqual(registered, []);
  runtime.stop();
});
