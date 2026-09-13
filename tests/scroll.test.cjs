'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NativeAdapter, REQUIRED_SUBSTRATE_METHODS } = require('../native/index.cjs');
const { ScrollRouter } = require('../src/main/scroll.cjs');
const { sanitizePeerMessage, policyForMessage } = require('../src/main/messages.cjs');
const { routePeerInput } = require('../src/main/input-runtime.cjs');

test('scroll from the non-owner is sent to the laptop that owns the cursor', () => {
  const sent = [];
  const cursor = { linked: true, owner: false, isOwner() { return this.owner; } };
  const scroll = new ScrollRouter({ cursor, send: (message) => sent.push(message) });
  assert.equal(scroll.localScroll(3), true);
  assert.deepEqual(sent, [{ type: 'scroll.delta', dy: 3 }]);
  cursor.owner = true;
  assert.equal(scroll.localScroll(-2), false);
});

test('the cursor owner injects peer scroll without sending it back', () => {
  const calls = [];
  const cursor = { linked: true, owner: true, isOwner() { return this.owner; } };
  const scroll = new ScrollRouter({ cursor, native: { synthesizeScroll: (dy) => calls.push(dy) } });
  assert.equal(routePeerInput({ scroll }, { type: 'scroll.delta', dy: -1.5 }), true);
  assert.deepEqual(calls, [-1.5]);
  cursor.owner = false;
  assert.equal(scroll.receive({ type: 'scroll.delta', dy: 1 }), false);
  assert.deepEqual(calls, [-1.5]);
});

test('scroll messages are bounded and loss tolerant', () => {
  assert.deepEqual(sanitizePeerMessage({ type: 'scroll.delta', dy: 2.5, junk: true }), {
    type: 'scroll.delta', dy: 2.5,
  });
  assert.equal(sanitizePeerMessage({ type: 'scroll.delta', dy: 0 }), null);
  assert.equal(sanitizePeerMessage({ type: 'scroll.delta', dy: Infinity }), null);
  assert.equal(sanitizePeerMessage({ type: 'scroll.delta', dy: 1001 }), null);
  assert.equal(policyForMessage('scroll.delta').reliable, false);
});

test('native adapter bridges captured and synthesized scroll deltas', () => {
  class NativeSubstrate {
    constructor() { NativeSubstrate.instance = this; }
    setEventCallback(callback) { this.callback = callback; }
    startCapture() {}
    synthesizeScroll(dy) { this.synthesized = dy; }
  }
  const adapter = new NativeAdapter({ NativeSubstrate }, '/tmp/compusync-native.node');
  const captured = [];
  adapter.on('scroll', (event) => captured.push(event.dy));
  adapter.startCursorCapture();
  NativeSubstrate.instance.callback(null, JSON.stringify({ kind: 'scrollDelta', dy: -1.25 }));
  adapter.synthesizeScroll('2.5');

  assert.deepEqual(captured, [-1.25]);
  assert.equal(NativeSubstrate.instance.synthesized, 2.5);
  assert.equal(REQUIRED_SUBSTRATE_METHODS.includes('synthesizeScroll'), true);
});
