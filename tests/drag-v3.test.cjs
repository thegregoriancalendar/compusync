'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DragController, crossedFraction, offscreenOrigin, originDistanceToEdge, motionTowardEdge,
} = require('../src/main/drag.cjs');

const placements = [
  { machineId: 'a', origin: { x: 0, y: 0 }, size: { w: 1000, h: 800 }, scale: 1 },
  { machineId: 'b', origin: { x: 1000, y: 0 }, size: { w: 1000, h: 800 }, scale: 2 },
];

function descriptor(overrides = {}) {
  return {
    schemaVersion: 1, id: 'stable-window-id', adapterId: 'chrome', origin: 'a', capturedAt: 1,
    geometryVU: { x: 810, y: 100, w: 400, h: 300 }, state: 'normal',
    payload: { activeIdx: 0, tabs: [{ url: 'https://secret.example/path', title: 'Example', pinned: false, index: 0 }] },
    ...overrides,
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeClock() {
  let time = 0, next = 1;
  const tasks = new Map();
  return {
    now: () => time,
    setTimeout(fn, ms) { const id = next++; tasks.set(id, { at: time + ms, fn }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    async tick(ms) {
      time += ms;
      for (const [id, task] of [...tasks].sort((a, b) => a[1].at - b[1].at)) {
        if (task.at <= time && tasks.delete(id)) task.fn();
      }
      await Promise.resolve();
      await Promise.resolve();
    },
    get pending() { return tasks.size; },
  };
}

function adapter(log, options = {}) {
  return {
    adapterId: 'chrome',
    async capture(window, geometryVU) {
      log.push(['capture', window.id]);
      if (options.captureError) throw options.captureError;
      return descriptor({ geometryVU: { ...geometryVU }, state: options.state || 'normal' });
    },
    async prepare(value, prepareOptions) {
      log.push(['prepare', prepareOptions]);
      if (options.prepare) return options.prepare(value, prepareOptions);
      if (options.prepareError) throw options.prepareError;
      return { id: value.id };
    },
    async position(handle, origin) {
      log.push(['position', handle.id || handle, { ...origin }]);
      if (options.positionError) throw options.positionError;
    },
    async focus(handle) { log.push(['focus', handle.id || handle]); },
    async close(handle) { log.push(['close', handle.id || handle]); },
  };
}

function sourceController(options = {}) {
  const log = options.log || [], sent = options.sent || [], busy = options.busy || [];
  const chrome = options.adapter || adapter(log, options.adapterOptions);
  const drag = new DragController({
    machineId: 'a', getPlacements: () => placements, adapterForWindow: () => chrome,
    send: (message) => { sent.push(message); return options.sendResult?.(message) ?? true; },
    setBusy: (value) => busy.push(value), waitMs: options.waitMs,
    now: options.clock?.now, setTimeout: options.clock?.setTimeout, clearTimeout: options.clock?.clearTimeout,
    logger: options.logger,
  });
  return { drag, log, sent, busy, chrome };
}

async function armSource(setup, window = { id: 'source' }) {
  assert.equal(setup.drag.begin({ window, geometryVU: { x: 700, y: 100, w: 400, h: 300 },
    cursorVU: { x: 800, y: 180 } }), true);
  await setup.drag.frame({ geometryVU: { x: 9999, y: 100, w: 400, h: 300 }, cursorVU: { x: 910, y: 180 } });
  assert.equal(setup.sent.filter(({ type }) => type === 'window.offer').length, 1);
}

test('crossing math and seam-side offscreen prewarm are deterministic', () => {
  assert.equal(crossedFraction({ x: 800, y: 100, w: 400, h: 300 }, placements[1]), 0.5);
  assert.deepEqual(offscreenOrigin({ x: 800, y: 100, w: 400, h: 300 }, placements[0], placements[1]),
    { x: 599, y: 100 });
});

test('wide windows arm from their leading edge and vertical helpers support an upper peer', async () => {
  const setup = sourceController();
  assert.equal(setup.drag.begin({
    window: { id: 'wide' }, geometryVU: { x: 0, y: 100, w: 900, h: 300 },
    cursorVU: { x: 500, y: 180 },
  }), true);
  await setup.drag.frame({ geometryVU: { x: 0, y: 100, w: 900, h: 300 }, cursorVU: { x: 510, y: 180 } });
  assert.equal(setup.sent.filter(({ type }) => type === 'window.offer').length, 1);

  const source = { origin: { x: 0, y: 0 }, size: { w: 1000, h: 800 } };
  const above = { origin: { x: 0, y: -800 }, size: { w: 1000, h: 800 } };
  assert.equal(originDistanceToEdge({ x: 100, y: 50, w: 400, h: 300 }, source, above), 50);
  assert.equal(motionTowardEdge({ x: 100, y: 50 }, { x: 100, y: 40 }, source, above), true);
  assert.deepEqual(offscreenOrigin({ x: 100, y: -100, w: 400, h: 300 }, source, above),
    { x: 100, y: 1 });
});

test('fixed grab offset drives both copies from authoritative cursor and source closes only after ack', async () => {
  const setup = sourceController();
  await armSource(setup);
  assert.deepEqual(setup.drag.active.grabOffsetVU, { x: 100, y: 80 });
  assert.deepEqual(setup.drag.active.geometry, { x: 810, y: 100, w: 400, h: 300 });
  await setup.drag.receive({ type: 'window.ready', id: 'stable-window-id' });
  await setup.drag.frame({ geometryVU: { x: -500, y: -500, w: 400, h: 300 }, cursorVU: { x: 950, y: 230 } });
  assert.deepEqual(setup.drag.active.geometry, { x: 850, y: 150, w: 400, h: 300 });
  assert.deepEqual(setup.sent.filter(({ type }) => type === 'window.position').at(-1).originVU, { x: 850, y: 150 });
  assert.deepEqual(setup.log.filter(([type]) => type === 'position').at(-1), ['position', 'source', { x: 850, y: 150 }]);
  await setup.drag.end();
  assert.equal(setup.log.some(([type]) => type === 'close'), false);
  await setup.drag.receive({ type: 'window.committed', id: 'stable-window-id' });
  assert.equal(setup.log.some(([type]) => type === 'close'), true);
});

test('pointer movement and loss-tolerant position updates never wait for destination ready', async () => {
  const setup = sourceController();
  await armSource(setup);
  await setup.drag.frame({ geometryVU: { x: 0, y: 0, w: 400, h: 300 }, cursorVU: { x: 1200, y: 180 } });
  assert.equal(setup.drag.active.geometry.x, 1100);
  assert.deepEqual(setup.log.filter(([type]) => type === 'position').at(-1)[2], { x: 1100, y: 100 });
  assert.deepEqual(setup.sent.filter(({ type }) => type === 'window.position').at(-1).originVU, { x: 1100, y: 100 });
  await setup.drag.receive({ type: 'window.ready', id: 'stable-window-id' });
  assert.deepEqual(setup.sent.at(-1), { type: 'window.position', id: 'stable-window-id', originVU: { x: 1100, y: 100 } });
});

test('destination queues the latest position and reverse timeout while prepare is still in flight', async () => {
  const gate = deferred(), clock = fakeClock(), log = [], sent = [];
  const chrome = adapter(log, { prepare: () => gate.promise });
  const drag = new DragController({ machineId: 'b', getPlacements: () => placements,
    adapterForId: () => chrome, send: (message) => { sent.push(message); return true; },
    reverseKeepaliveMs: 3000, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const preparing = drag.receive({ type: 'window.offer', descriptor: descriptor() });
  await Promise.resolve();
  await drag.receive({ type: 'window.position', id: 'stable-window-id', originVU: { x: 900, y: 100 } });
  await drag.receive({ type: 'window.position', id: 'stable-window-id', originVU: { x: 500, y: 100 } });
  assert.equal(drag.active.phase, 'reverse-hold');
  gate.resolve({ id: 'queued-handle' });
  assert.equal(await preparing, true);
  assert.deepEqual(log.filter(([type]) => type === 'position').at(-1),
    ['position', 'queued-handle', { x: 500, y: 100 }]);
  await clock.tick(3000);
  assert.equal(drag.active, null);
  assert.deepEqual(sent.at(-1), { type: 'window.abort', id: 'stable-window-id', reason: 'reverse-timeout' });
});

test('mouse-up at or beyond 50 percent waits at most two seconds, shows busy, then commits', async () => {
  const clock = fakeClock(), setup = sourceController({ clock, waitMs: 2000 });
  await armSource(setup);
  const ending = setup.drag.end();
  await Promise.resolve();
  assert.equal(setup.sent.some(({ type }) => type === 'window.commit'), false);
  assert.equal(setup.busy.at(-1), true);
  await clock.tick(1999);
  assert.equal(setup.drag.active.phase, 'dropping');
  await setup.drag.receive({ type: 'window.ready', id: 'stable-window-id' });
  assert.equal(await ending, true);
  assert.deepEqual(setup.sent.find(({ type }) => type === 'window.commit'),
    { type: 'window.commit', id: 'stable-window-id', winner: 'destination' });
  assert.equal(setup.busy.at(-1), false);
});

test('prepare timeout restores source and a late ready is explicitly discarded', async () => {
  const clock = fakeClock(), setup = sourceController({ clock, waitMs: 2000 });
  await armSource(setup);
  const ending = setup.drag.end();
  await clock.tick(2000);
  assert.equal(await ending, true);
  assert.equal(setup.drag.active, null);
  assert.deepEqual(setup.log.filter(([type]) => type === 'position').at(-1), ['position', 'source', { x: 700, y: 100 }]);
  assert.equal(await setup.drag.receive({ type: 'window.ready', id: 'stable-window-id' }), true);
  assert.deepEqual(setup.sent.at(-1), { type: 'window.abort', id: 'stable-window-id', reason: 'late-ready' });
});

test('destination abort during prepare closes a handle that completes late', async () => {
  const gate = deferred(), log = [], sent = [];
  const chrome = adapter(log, { prepare: () => gate.promise });
  const drag = new DragController({ machineId: 'b', getPlacements: () => placements,
    adapterForId: () => chrome, send: (message) => { sent.push(message); return true; } });
  const receiving = drag.receive({ type: 'window.offer', descriptor: descriptor() });
  await Promise.resolve();
  await drag.receive({ type: 'window.abort', id: 'stable-window-id', reason: 'source-abort' });
  gate.resolve({ id: 'late-handle' });
  assert.equal(await receiving, false);
  assert.deepEqual(log.at(-1), ['close', 'late-handle']);
  assert.equal(drag.active, null);
});

test('reverse holds destination for three seconds, supports re-cross, then expires cleanly', async () => {
  const clock = fakeClock(), log = [], sent = [], chrome = adapter(log);
  const drag = new DragController({ machineId: 'b', getPlacements: () => placements,
    adapterForId: () => chrome, send: (message) => { sent.push(message); return true; },
    reverseKeepaliveMs: 3000, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  await drag.receive({ type: 'window.offer', descriptor: descriptor() });
  await drag.receive({ type: 'window.position', id: 'stable-window-id', originVU: { x: 900, y: 100 } });
  await drag.receive({ type: 'window.position', id: 'stable-window-id', originVU: { x: 500, y: 100 } });
  assert.equal(drag.active.phase, 'reverse-hold');
  await clock.tick(2999);
  await drag.receive({ type: 'window.position', id: 'stable-window-id', originVU: { x: 900, y: 100 } });
  assert.equal(drag.active.phase, 'straddling');
  assert.equal(log.some(([type]) => type === 'close'), false);
  await drag.receive({ type: 'window.position', id: 'stable-window-id', originVU: { x: 500, y: 100 } });
  await clock.tick(3000);
  assert.equal(drag.active, null);
  assert.deepEqual(log.at(-1), ['close', 'stable-window-id']);
  assert.deepEqual(sent.at(-1), { type: 'window.abort', id: 'stable-window-id', reason: 'reverse-timeout' });
});

test('a second concurrent offer is rejected busy without disturbing the first', async () => {
  const gate = deferred(), log = [], sent = [], chrome = adapter(log, { prepare: () => gate.promise });
  const drag = new DragController({ machineId: 'b', getPlacements: () => placements,
    adapterForId: () => chrome, send: (message) => { sent.push(message); return true; } });
  const first = drag.receive({ type: 'window.offer', descriptor: descriptor() });
  await Promise.resolve();
  assert.equal(await drag.receive({ type: 'window.offer', descriptor: descriptor({ id: 'second-id' }) }), false);
  assert.deepEqual(sent.at(-1), { type: 'window.abort', id: 'second-id', reason: 'busy' });
  gate.resolve({ id: 'first' });
  assert.equal(await first, true);
  assert.equal(drag.active.descriptor.id, 'stable-window-id');
});

test('prepare and mid-straddle Chrome failures abort so the peer can restore its survivor', async () => {
  const prepareSent = [], prepareDrag = new DragController({ machineId: 'b', getPlacements: () => placements,
    adapterForId: () => adapter([], { prepareError: Object.assign(new Error('gone'), { code: 'CHROME_QUIT' }) }),
    send: (message) => { prepareSent.push(message); return true; } });
  assert.equal(await prepareDrag.receive({ type: 'window.offer', descriptor: descriptor() }), false);
  assert.deepEqual(prepareSent.at(-1), { type: 'window.abort', id: 'stable-window-id', reason: 'CHROME_QUIT' });

  const source = sourceController();
  await armSource(source);
  await source.drag.receive({ type: 'window.ready', id: 'stable-window-id' });
  await source.drag.receive({ type: 'window.abort', id: 'stable-window-id', reason: 'CHROME_QUIT' });
  assert.equal(source.drag.active, null);
  assert.deepEqual(source.log.filter(([type]) => type === 'position').at(-1), ['position', 'source', { x: 700, y: 100 }]);
});

test('source Chrome exit promotes the prepared destination, including before ready', async () => {
  const gate = deferred(), destinationLog = [], destinationSent = [];
  const destinationAdapter = adapter(destinationLog, { prepare: () => gate.promise });
  const destination = new DragController({ machineId: 'b', getPlacements: () => placements,
    adapterForId: () => destinationAdapter,
    send: (message) => { destinationSent.push(message); return true; } });
  const source = sourceController();
  await armSource(source);
  const offer = source.sent.find(({ type }) => type === 'window.offer');
  const preparing = destination.receive(offer);
  await Promise.resolve();
  for (const position of source.sent.filter(({ type }) => type === 'window.position')) {
    await destination.receive(position);
  }

  assert.equal(await source.drag.sourceDisappeared('chrome-quit'), true);
  const commit = source.sent.at(-1);
  assert.deepEqual(commit, { type: 'window.commit', id: 'stable-window-id', winner: 'destination' });
  assert.equal(await destination.receive(commit), true);
  assert.equal(destination.active.pendingWinner, 'destination');

  gate.resolve({ id: 'only-survivor' });
  assert.equal(await preparing, true);
  assert.equal(destination.active, null);
  assert.equal(destinationLog.some(([type]) => type === 'close'), false);
  assert.deepEqual(destinationLog.filter(([type]) => type === 'position').at(-1),
    ['position', 'only-survivor', { x: 1000, y: 100 }]);
  assert.deepEqual(destinationLog.at(-1), ['focus', 'only-survivor']);

  for (const message of destinationSent) await source.drag.receive(message);
  assert.equal(source.drag.active, null);
  assert.equal(source.log.some(([type]) => type === 'close'), false);
});

test('destination Chrome exit aborts and restores the surviving source', async () => {
  const destinationLog = [], destinationSent = [];
  let failPosition = false;
  const destinationAdapter = adapter(destinationLog);
  const originalPosition = destinationAdapter.position;
  destinationAdapter.position = async (...args) => {
    if (failPosition) throw Object.assign(new Error('destination Chrome exited'), { code: 'CHROME_QUIT' });
    return originalPosition(...args);
  };
  const destination = new DragController({ machineId: 'b', getPlacements: () => placements,
    adapterForId: () => destinationAdapter,
    send: (message) => { destinationSent.push(message); return true; } });
  const source = sourceController();
  await armSource(source);
  await destination.receive(source.sent.find(({ type }) => type === 'window.offer'));
  await source.drag.receive(destinationSent.find(({ type }) => type === 'window.ready'));
  await source.drag.frame({ geometryVU: { x: 0, y: 0, w: 400, h: 300 }, cursorVU: { x: 950, y: 180 } });
  failPosition = true;
  assert.equal(await destination.receive(source.sent.filter(({ type }) => type === 'window.position').at(-1)), true);
  assert.equal(destination.active, null);
  const abort = destinationSent.at(-1);
  assert.deepEqual(abort, { type: 'window.abort', id: 'stable-window-id', reason: 'CHROME_QUIT' });
  await source.drag.receive(abort);
  assert.equal(source.drag.active, null);
  assert.deepEqual(source.log.filter(([type]) => type === 'position').at(-1),
    ['position', 'source', { x: 700, y: 100 }]);
  assert.equal(source.log.some(([type]) => type === 'close'), false);
});

test('a source-winning commit may arrive before prepare and is applied once ready', async () => {
  const gate = deferred(), log = [], sent = [], chrome = adapter(log, { prepare: () => gate.promise });
  const drag = new DragController({ machineId: 'b', getPlacements: () => placements,
    adapterForId: () => chrome, send: (message) => { sent.push(message); return true; } });
  const preparing = drag.receive({ type: 'window.offer', descriptor: descriptor() });
  await Promise.resolve();
  assert.equal(await drag.receive({ type: 'window.commit', id: 'stable-window-id', winner: 'source' }), true);
  assert.equal(log.some(([type]) => type === 'close'), false);
  gate.resolve({ id: 'prepared' });
  assert.equal(await preparing, true);
  assert.deepEqual(log.at(-1), ['close', 'prepared']);
  assert.equal(sent.at(-1).type, 'window.committed');
});

test('maximized and fullscreen windows instant-commit without entering straddle', async () => {
  for (const [window, state] of [[{ id: 'max', state: 'maximized' }, 'maximized'], [{ id: 'full', fullscreen: true }, 'normal']]) {
    const events = [], setup = sourceController({ adapterOptions: { state } });
    setup.drag.on('straddle', () => events.push('straddle'));
    await armSource(setup, window);
    assert.equal(setup.log.some(([type]) => type === 'position'), false);
    await setup.drag.receive({ type: 'window.ready', id: 'stable-window-id' });
    assert.equal(events.length, 0);
    assert.deepEqual(setup.sent.at(-1), { type: 'window.commit', id: 'stable-window-id', winner: 'destination' });
  }
});

test('undersized and non-addressable windows never offer and show one hint', async () => {
  for (const mode of ['small', 'unavailable']) {
    const sent = [], hints = [], log = [], chrome = adapter(log);
    const drag = new DragController({ machineId: 'a', getPlacements: () => placements,
      adapterForWindow: () => mode === 'unavailable' ? null : chrome,
      send: (message) => { sent.push(message); return true; } });
    const size = mode === 'small' ? { w: 199, h: 149 } : { w: 400, h: 300 };
    drag.on('hint', (value) => hints.push(value));
    drag.begin({ window: { id: mode }, geometryVU: { x: 700, y: 100, ...size }, cursorVU: { x: 800, y: 180 } });
    await drag.frame({ geometryVU: { x: 999, y: 0, ...size }, cursorVU: { x: 910, y: 180 } });
    await drag.frame({ geometryVU: { x: 999, y: 0, ...size }, cursorVU: { x: 920, y: 180 } });
    assert.equal(sent.length, 0);
    assert.equal(hints.length, 1);
  }
});

test('structured lifecycle and timing telemetry contains no tab URL data', async () => {
  let now = 0;
  const logs = [], lifecycle = [], timing = [];
  const setup = sourceController({ now: undefined, logger: (event, details) => logs.push({ event, details }) });
  setup.drag.now = () => ++now;
  setup.drag.on('lifecycle', (value) => lifecycle.push(value));
  setup.drag.on('timing', (value) => timing.push(value));
  await armSource(setup);
  await setup.drag.receive({ type: 'window.ready', id: 'stable-window-id' });
  assert.ok(lifecycle.some(({ event, phase, id }) => event === 'offer-sent' && phase === 'preparing' && id === 'stable-window-id'));
  assert.ok(timing.some(({ name, durationMs, status }) => name === 'capture' && durationMs >= 0 && status === 'ok'));
  assert.ok(logs.some(({ event }) => event === 'drag.timing'));
  assert.equal(JSON.stringify(logs).includes('secret.example'), false);
});
