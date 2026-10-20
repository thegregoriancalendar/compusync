'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { NativeAdapter, REQUIRED_SUBSTRATE_METHODS } = require('../native/index.cjs');
const { SharedInputRuntime } = require('../src/main/runtime.cjs');
const { sanitizePeerMessage, policyForMessage } = require('../src/main/messages.cjs');
const { TrackpadGestureRouter, MAX_GESTURE_BYTES } = require('../src/main/trackpad-gestures.cjs');

function nativeAdapter(platformName = 'darwin') {
  class Substrate {
    constructor() { this.platformName = platformName; this.injected = []; this.enabled = []; }
    setEventCallback(callback) { this.callback = callback; }
    cursorPosition() { return { x: 50, y: 50 }; }
    displayMetrics() { return [{ bounds: { x: 0, y: 0, width: 100, height: 100 }, scale: 1, primary: true }]; }
    synthesizeGesture(data) { this.injected.push(data); }
    setGestureForwarding(enabled) { this.enabled.push(enabled); }
  }
  for (const method of REQUIRED_SUBSTRATE_METHODS) Substrate.prototype[method] ||= () => {};
  return new NativeAdapter({ NativeSubstrate: Substrate }, 'test.node');
}

test('trackpad gesture phases cross native callbacks and runtime transport to whichever Mac owns the cursor', () => {
  const layouts = Object.fromEntries(['a', 'b'].map((id) => [id, {
    platform: 'darwin', displays: [{ bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 1, primary: true }],
  }]));
  const peers = {}, deliveries = [];
  let relay = false;
  for (const id of ['a', 'b']) {
    const otherId = id === 'a' ? 'b' : 'a';
    const native = nativeAdapter();
    const session = new EventEmitter();
    session.phase = 'connected';
    session.sendPeer = (message, options) => {
      if (!relay) return true;
      const wire = JSON.parse(JSON.stringify(message));
      deliveries.push({ from: id, message: wire, options });
      return peers[otherId].runtime.receive(wire, id);
    };
    peers[id] = { native, runtime: new SharedInputRuntime({
      machineId: id, hostId: 'a', peerId: otherId, layouts, session, native,
      settings: { linked: true, macPosition: 'right', displayOffset: 0 },
    }) };
  }
  const emit = (id, data) => peers[id].native.substrate.callback(null, JSON.stringify({ kind: 'trackpadGesture', data }));
  try {
    for (const id of ['a', 'b']) {
      peers[id].runtime.start();
      assert.equal(peers[id].native.substrate.enabled.at(-1), true);
      assert.equal(peers[id].runtime.receive({ type: 'cursor.mode', linked: true }, id === 'a' ? 'b' : 'a'), true);
      assert.equal(peers[id].runtime.cursor.linked, true);
    }
    relay = true;
    const phases = ['aa0100', 'aa02ff', 'aa0201', 'aa0800'];
    phases.forEach((data) => emit('b', data));
    assert.deepEqual(peers.a.native.substrate.injected, phases);
    assert.deepEqual(peers.b.native.substrate.injected, []);
    for (const delivery of deliveries) {
      assert.equal(delivery.message.type, 'gesture.trackpad');
      assert.equal(delivery.options.lossTolerant, false);
    }
    emit('a', 'bb01');
    assert.equal(deliveries.length, 4, 'owner input remains native and is not echoed');
    assert.equal(peers.a.runtime.receive({ type: 'gesture.trackpad', data: 'bb01' }, 'stranger'), false);

    assert.equal(peers.a.runtime.cursor.toggleOwnership(), true);
    assert.equal(peers.b.runtime.cursor.isOwner(), true);
    emit('a', 'bb0100');
    emit('a', 'bb0401');
    assert.deepEqual(peers.b.native.substrate.injected, ['bb0100', 'bb0401']);

    peers.a.runtime.setLinked(false, 'test-unlink');
    const count = deliveries.length;
    emit('a', 'cc01');
    assert.equal(deliveries.length, count);
    assert.equal(peers.b.runtime.receive({ type: 'gesture.trackpad', data: 'cc01' }, 'a'), false);
  } finally {
    for (const { runtime, native } of Object.values(peers)) {
      runtime.stop();
      assert.equal(native.listenerCount('gesture'), 0);
    }
  }
});

test('gesture messages are bounded, ordered, and cannot carry unrelated fields', () => {
  const message = { type: 'gesture.trackpad', data: 'aabb00', code: 4, down: true };
  assert.deepEqual(sanitizePeerMessage(message), { type: message.type, data: message.data });
  assert.deepEqual(policyForMessage(message.type), { reliable: true, ordered: true, priority: 'control' });
  assert.ok(sanitizePeerMessage({ ...message, data: '00'.repeat(MAX_GESTURE_BYTES) }));
  for (const data of [null, 1, [], {}, '', '0', 'zz', 'AA', '00\n', '00'.repeat(MAX_GESTURE_BYTES + 1)]) {
    assert.equal(sanitizePeerMessage({ ...message, data }), null);
  }
});

test('mixed-platform pairs and unlinked or inactive destinations cannot inject gestures', () => {
  for (const [source, destination] of [['darwin', 'win32'], ['win32', 'darwin'], ['darwin', undefined], ['darwin', 'darwin']]) {
    let owner = false, linked = true;
    const native = { enabled: [], injected: [],
      setGestureForwarding(value) { this.enabled.push(value); },
      synthesizeGesture(value) { this.injected.push(value); },
    };
    const sent = [];
    const router = new TrackpadGestureRouter({
      cursor: { get linked() { return linked; }, isOwner: () => owner }, native,
      platforms: () => ({ source, destination }), send: (message) => sent.push(message),
    });
    const supported = source === 'darwin' && destination === 'darwin';
    router.configure();
    assert.deepEqual(native.enabled, [supported]);
    assert.equal(router.localGesture('aa00'), supported);
    assert.equal(sent.length, supported ? 1 : 0);
    assert.equal(router.receive({ type: 'gesture.trackpad', data: 'aa00' }), false);
    owner = true;
    assert.equal(router.localGesture('aa00'), false);
    assert.equal(router.receive({ type: 'gesture.trackpad', data: 'aa00' }), supported);
    linked = false;
    assert.equal(router.localGesture('aa00'), false);
    assert.equal(router.receive({ type: 'gesture.trackpad', data: 'aa00' }), false);
    assert.equal(native.injected.length, supported ? 1 : 0);
  }
});
