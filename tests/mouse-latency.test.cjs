'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { MouseLatency, CLOCK_WINDOW_MS, WINDOW_MS } = require('../src/main/mouse-latency.cjs');
const { CursorController } = require('../src/main/cursor.cjs');
const { SharedInputRuntime } = require('../src/main/runtime.cjs');
const { sanitizePeerMessage, policyForMessage } = require('../src/main/messages.cjs');

function fixture(initialTime = 1000) {
  let time = initialTime;
  const sent = [];
  const latency = new MouseLatency({ now: () => time, send: (message) => { sent.push(message); return true; } });
  latency.setLinked(true);
  latency.setConnected(true);
  return { latency, sent, at(value) { time = value; } };
}

function calibrate(f, { offset = 4000, transit = 5, processing = 7 } = {}) {
  const probe = f.sent.filter(({ type }) => type === 'latency.probe').at(-1);
  f.at(1000 + transit * 2 + processing);
  assert.equal(f.latency.receive({ type: 'latency.reply', id: probe.id,
    receivedAt: 1000 + transit + offset, sentAt: 1000 + transit + offset + processing }), true);
}

test('one-way movement timing compensates unrelated clocks and excludes probe processing', () => {
  const f = fixture();
  calibrate(f);
  assert.equal(f.latency.state().networkRttMs, 10);
  f.latency.queueInput(5020);
  f.at(1047);
  f.latency.inputApplied();
  assert.deepEqual(f.latency.state().incoming, { medianMs: 27, p95Ms: 27, uncertaintyMs: 5, samples: 1 });
});

test('clock calibration uses the lowest recent RTT instead of a queued probe', () => {
  const f = fixture();
  calibrate(f);
  f.at(1300);
  f.latency.tick();
  const probe = f.sent.filter(({ type }) => type === 'latency.probe').at(-1);
  f.at(1400);
  f.latency.receive({ type: 'latency.reply', id: probe.id, receivedAt: 5320, sentAt: 5320 });
  f.latency.queueInput(5410);
  f.at(1430);
  f.latency.inputApplied();
  assert.equal(f.latency.state().networkRttMs, 10);
  assert.equal(f.latency.state().incoming.medianMs, 20);
});

test('unmatched, duplicate and impossible replies cannot change calibration', () => {
  const f = fixture();
  const probe = f.sent.find(({ type }) => type === 'latency.probe');
  assert.equal(f.latency.receive({ type: 'latency.reply', id: 999, receivedAt: 5000, sentAt: 5000 }), false);
  f.at(1001);
  assert.equal(f.latency.receive({ type: 'latency.reply', id: probe.id, receivedAt: 5000, sentAt: 5100 }), false);
  assert.equal(f.latency.state().networkRttMs, null);
  f.at(1300);
  f.latency.tick();
  const next = f.sent.filter(({ type }) => type === 'latency.probe').at(-1);
  f.at(1310);
  const reply = { type: 'latency.reply', id: next.id, receivedAt: 5305, sentAt: 5305 };
  assert.equal(f.latency.receive(reply), true);
  assert.equal(f.latency.receive(reply), false);
});

for (const [source, destination] of [['win', 'mac'], ['mac', 'win']]) {
  test(`${source} to ${destination} includes network, cursor-frame wait and native update time`, () => {
    let time = 1000;
    const sourceLatency = new MouseLatency({ now: () => time });
    const receiver = fixture();
    calibrate(receiver, { offset: 4000, processing: 0 });
    sourceLatency.setLinked(true);
    sourceLatency.setConnected(true);
    const placements = ['win', 'mac'].map((machineId, index) => ({ machineId,
      origin: { x: index * 1000, y: 0 }, size: { w: 1000, h: 800 }, scale: 1 }));
    const initialPosition = { x: destination === 'mac' ? 1400 : 400, y: 200 };
    const nativePositions = [];
    const destinationCursor = new CursorController({ machineId: destination, placements, initialPosition,
      ownerMachineId: destination, latency: receiver.latency, native: { warpCursor: (point) => {
        nativePositions.push(point);
        receiver.at(1047); // the native update itself takes two milliseconds
      } } });
    // Source clock is 4000 ms ahead of the receiver's clock.
    time = 5020;
    const sourceCursor = new CursorController({ machineId: source, placements, initialPosition,
      ownerMachineId: destination, latency: sourceLatency, now: () => time, send: (message) => {
        receiver.at(1025);
        return destinationCursor.receive(sanitizePeerMessage(message), source);
      } });
    sourceCursor.localDelta(10, 5, 16, 987654);
    assert.equal(receiver.latency.state().incoming, null, 'receiving is not applying');
    receiver.at(1045);
    destinationCursor.flush();
    assert.equal(nativePositions.length, 1);
    assert.equal(receiver.latency.state().incoming.medianMs, 27);
  });
}

test('sample timestamps preserve source batching time and diagnostics are capped at 20 Hz', () => {
  let now = 1000;
  const sent = [];
  const latency = new MouseLatency({ now: () => now });
  latency.setConnected(true);
  latency.setLinked(true);
  const cursor = new CursorController({ machineId: 'source', latency, now: () => now,
    ownerMachineId: 'peer', placements: [{ machineId: 'peer', origin: { x: 0, y: 0 }, size: { w: 1000, h: 800 }, scale: 1 }],
    send: (message) => { sent.push(message); return true; } });
  cursor.localDelta(1, 0);
  now = 1048;
  cursor.localDelta(1, 0);
  now = 1051;
  cursor.localDelta(1, 0);
  assert.equal(sent.length, 2);
  now = 1054;
  cursor.flush();
  assert.equal(sent.at(-1).sampledAt, 1051);
  let count = 0;
  for (now = 1100; now < 2100; now += 1) if (latency.captureInput() !== null) count += 1;
  assert.equal(count, 20);
});

test('failed native movement, handoff and cancelled movement never produce applied samples', () => {
  for (const mode of ['failure', 'handoff', 'cancel']) {
    const f = fixture();
    calibrate(f);
    const cursor = new CursorController({ machineId: 'local', latency: f.latency,
      placements: [{ machineId: 'local', origin: { x: 0, y: 0 }, size: { w: 1000, h: 800 }, scale: 1 },
        { machineId: 'peer', origin: { x: 1000, y: 0 }, size: { w: 1000, h: 800 }, scale: 1 }],
      initialPosition: { x: mode === 'handoff' ? 999 : 500, y: 100 }, ownerMachineId: 'local',
      send: () => true, native: { warpCursor() { if (mode === 'failure') throw new Error('unavailable'); } } });
    cursor.receive({ type: 'cursor.delta', dx: 10, dy: 0, sampledAt: 5020 }, 'peer');
    if (mode === 'cancel') cursor.receive({ type: 'cursor.delta', dx: -10, dy: 0 }, 'peer');
    f.at(1040);
    cursor.flush();
    assert.equal(f.latency.state().incoming, null, mode);
    assert.equal(f.latency.pending.length, 0, mode);
  }
});

test('rolling percentiles expose stalls and stale readings and clock estimates expire', () => {
  const f = fixture();
  calibrate(f);
  for (let i = 0; i < 20; i += 1) {
    f.at(1100 + i * 50);
    f.latency.queueInput(1100 + i * 50 + 4000 - (i === 19 ? 120 : i === 18 ? 60 : 12));
    f.latency.inputApplied();
  }
  assert.equal(f.latency.state().incoming.medianMs, 12);
  assert.equal(f.latency.state().incoming.p95Ms, 60);
  f.latency.receive({ type: 'latency.report', samples: 20, medianMs: 13, p95Ms: 50, uncertaintyMs: 5 });
  assert.equal(f.latency.state().outgoing.medianMs, 13);
  f.at(5051);
  assert.equal(f.latency.state().outgoing, null);
  f.at(2051 + WINDOW_MS);
  assert.equal(f.latency.state().incoming, null);
  f.at(2051 + CLOCK_WINDOW_MS);
  assert.equal(f.latency.state().calibrating, true);
});

test('unlink and reconnect clear old measurements; dropped diagnostics never break input', () => {
  const f = fixture();
  calibrate(f);
  f.latency.queueInput(5020);
  f.at(1040);
  f.latency.inputApplied();
  f.latency.setLinked(false);
  assert.equal(f.latency.state().incoming, null);
  f.latency.setLinked(true);
  assert.equal(f.latency.captureInput(), 1040);
  f.latency.setConnected(false);
  assert.equal(f.latency.state().networkRttMs, null);
  assert.equal(f.latency.captureInput(), null);
  const failed = new MouseLatency({ send() { throw new Error('backpressure'); } });
  assert.doesNotThrow(() => failed.setConnected(true));
  assert.equal(failed.probes.size, 0);
});

test('timing message validation is bounded and optional metadata preserves old cursor packets', () => {
  const delta = { type: 'cursor.delta', dx: 1, dy: 2, t: 123 };
  assert.deepEqual(sanitizePeerMessage(delta), delta);
  assert.deepEqual(sanitizePeerMessage({ ...delta, sampledAt: 5.25 }), { ...delta, sampledAt: 5.25 });
  for (const sampledAt of [-1, NaN, Infinity, '5', Number.MAX_VALUE]) {
    assert.deepEqual(sanitizePeerMessage({ ...delta, sampledAt }), delta);
  }
  assert.equal(sanitizePeerMessage({ type: 'latency.probe', id: 0 }), null);
  assert.equal(sanitizePeerMessage({ type: 'latency.reply', id: 1, receivedAt: 20, sentAt: 19 }), null);
  assert.equal(sanitizePeerMessage({ type: 'latency.reply', id: 1, receivedAt: 20, sentAt: Infinity }), null);
  assert.equal(sanitizePeerMessage({ type: 'latency.report', samples: 201, medianMs: 1, p95Ms: 2, uncertaintyMs: 1 }), null);
  assert.equal(sanitizePeerMessage({ type: 'latency.report', samples: 1, medianMs: 20, p95Ms: 2, uncertaintyMs: 1 }), null);
  for (const type of ['latency.probe', 'latency.reply', 'latency.report']) {
    assert.equal(policyForMessage(type).reliable, false);
  }
});

test('runtime authenticates timing traffic and applies samples through the native cursor path', () => {
  let now = 1000;
  const session = new EventEmitter();
  const sent = [];
  session.phase = 'connected';
  session.sendPeer = (message, options) => { sent.push({ message, options }); return true; };
  const native = { available: true, warpCursor() { now += 2; } };
  const displays = [{ bounds: { x: 0, y: 0, width: 1000, height: 800 }, scaleFactor: 1 }];
  const runtime = new SharedInputRuntime({ session, native, machineId: 'win', hostId: 'win', peerId: 'mac',
    layouts: { win: { platform: 'win32', displays }, mac: { platform: 'darwin', displays } },
    settings: { linked: false }, latencyNow: () => now });
  runtime.setPeerConnected(true);
  const probe = sent.find(({ message }) => message.type === 'latency.probe').message;
  const reply = { type: 'latency.reply', id: probe.id, receivedAt: 5005, sentAt: 5005 };
  now = 1010;
  assert.equal(runtime.receive(reply, 'stranger'), false);
  assert.equal(runtime.receive(reply, 'mac'), true);
  runtime.cursor.setLinked(true);
  now = 1030;
  runtime.receive({ type: 'cursor.delta', dx: 1, dy: 1, t: 987654, sampledAt: 5020 }, 'mac');
  assert.equal(runtime.latency.state().incoming, null);
  now = 1040;
  runtime.cursor.flush();
  assert.equal(runtime.latency.state().incoming.medianMs, 22);
  now = 2100;
  runtime.latency.tick();
  const report = sent.filter(({ message }) => message.type === 'latency.report').at(-1);
  assert.equal(report.options.lossTolerant, true);
  assert.equal(report.message.medianMs, 22);
});
