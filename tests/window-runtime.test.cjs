'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CursorController } = require('../src/main/cursor.cjs');
const { sanitizeHandoffLog, geometryToVU, processIdOf, cursorAtSharedEdge, WindowHandoffRuntime } = require('../src/main/window-runtime.cjs');

function runtimeFixture(options = {}) {
  const native = new EventEmitter();
  native.platformName = options.platformName || 'windows';
  let window = options.window || { id: 'hwnd', processName: 'chrome.exe', bounds: { x: 700, y: 100, width: 400, height: 300 } };
  native.enumerateWindows = () => window ? [window] : [];
  const nativeCalls = [];
  native.windowExists = () => Boolean(window);
  native.guardWindow = (id, bounds) => nativeCalls.push(['guard', id, bounds]);
  native.terminateMoveLoop = (id) => nativeCalls.push(['terminate', id]);
  native.releaseWindowGuard = (id) => nativeCalls.push(['release', id]);
  const sent = [];
  const placement = { machineId: 'a', origin: { x: 0, y: 0 }, size: { w: 1000, h: 800 }, scale: 1 };
  const peer = { machineId: 'b', origin: { x: 1000, y: 0 }, size: { w: 1000, h: 800 }, scale: 1 };
  const input = new EventEmitter();
  input.machineId = 'a';
  input.cursor = options.realCursor ? new CursorController({ machineId: 'a', native,
    placements: [placement, peer], initialPosition: { x: 800, y: 150 }, send: () => true })
    : { linked: true, placements: [placement, peer], virtualCursor: { x: 800, y: 150 }, placementFor: () => placement };
  input.send = (message) => { sent.push(message); return true; };
  input.setDragging = (dragging) => input.cursor.setDragging?.(dragging);
  input.setWindowController = (value) => { input.windowController = value; };
  input.watchdog = { trigger() {} };
  const positions = [];
  const adapter = {
    async capture(_window, geometryVU) {
      if (typeof options.capture === 'function') return options.capture(_window, geometryVU);
      return { schemaVersion: 1, id: 'window-stable', adapterId: 'chrome', origin: 'a', capturedAt: 1,
        geometryVU, state: 'normal', payload: { activeIdx: 0, tabs: [{ url: 'https://example.com', title: '', pinned: false, index: 0 }] } };
    },
    async position(handle, origin) { positions.push({ handle, origin: { ...origin } }); },
    async focus() {}, async close() {},
  };
  const chrome = new EventEmitter();
  chrome.adapterForWindow = () => adapter;
  chrome.adapterForId = () => adapter;
  chrome.setLinked = () => {};
  chrome.stop = () => {};
  const runtime = new WindowHandoffRuntime({
    input, native, chrome, frameMs: options.frameMs || 100000,
    setSeam: options.setSeam, showHint: options.showHint, logger: options.logger,
    processId: options.processId, livenessMs: 0,
  });
  runtime.start();
  return {
    runtime, native, nativeCalls, input, sent, positions,
    setWindow(value) { window = value; },
  };
}

test('pre-edge capture applies only along the laptops shared seam', () => {
  const source = { origin: { x: 0, y: 0 }, size: { w: 1000, h: 800 } };
  const target = { origin: { x: 1000, y: 200 }, size: { w: 900, h: 600 } };
  assert.equal(cursorAtSharedEdge({ x: 989, y: 300 }, source, target), true);
  assert.equal(cursorAtSharedEdge({ x: 989, y: 100 }, source, target), false);
  assert.equal(cursorAtSharedEdge({ x: 980, y: 300 }, source, target), false);
});

test('CompuSync never hands one of its own Electron windows to an adapter', async () => {
  const ownPid = 4242;
  const fixture = runtimeFixture({
    processId: ownPid,
    // Keep the adapter deliberately permissive: the runtime PID boundary must
    // protect settings even if a future native identity regression labels it
    // as Chrome.
    window: {
      id: 'settings-window', pid: ownPid, processName: 'Google Chrome',
      title: 'CompuSync · Connection',
      bounds: { x: 700, y: 100, width: 580, height: 780 },
    },
  });

  assert.equal(processIdOf({ owner_pid: ownPid }), ownPid);
  assert.equal(await fixture.runtime.handleMoveStart('settings-window'), false);
  assert.equal(fixture.runtime.drag.active, null);
  assert.equal(fixture.sent.length, 0);
  assert.equal(fixture.nativeCalls.length, 0);
  await fixture.runtime.stop();
});

test('native device-pixel window geometry converts to the shared VU placement', () => {
  assert.deepEqual(geometryToVU({ bounds: { x: 200, y: 100, width: 800, height: 600 } },
    { origin: { x: 1000, y: 50 }, size: { w: 1000, h: 800 }, scale: 2 }),
  { x: 1100, y: 100, w: 400, h: 300 });
  assert.deepEqual(geometryToVU({
    bounds: { x: -1800, y: 50, width: 800, height: 600 },
    normalizedBounds: { x: 120, y: 50, width: 800, height: 600 },
  }, { origin: { x: 0, y: 0 }, size: { w: 3584, h: 1440 }, scale: 1.25 }),
  { x: 96, y: 40, w: 640, h: 480 });
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
  input.cursor.virtualCursor = { x: 910, y: 100 };
  await runtime.poll();
  assert.equal(sent.filter(({ type }) => type === 'window.offer').length, 1);
  await runtime.stop();
});

test('physical mouse-up waits for an in-flight capture instead of discarding the offer', async () => {
  let resolveCapture;
  const capture = new Promise((resolve) => { resolveCapture = resolve; });
  const fixture = runtimeFixture({ capture: () => capture });
  assert.equal(await fixture.runtime.handleMoveStart('hwnd'), true);
  fixture.input.cursor.virtualCursor = { x: 850, y: 150 };
  const polling = fixture.runtime.poll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.runtime.drag.active?.phase, 'capturing');

  const ending = fixture.runtime.handleMoveEnd('hwnd', { physical: true });
  resolveCapture({
    schemaVersion: 1, id: 'window-stable', adapterId: 'chrome', origin: 'a', capturedAt: 1,
    geometryVU: { x: 750, y: 100, w: 400, h: 300 }, state: 'normal',
    payload: { activeIdx: 0, tabs: [{ url: 'https://example.com', title: '', pinned: false, index: 0 }] },
  });
  await Promise.all([polling, ending]);

  assert.equal(fixture.sent.filter(({ type }) => type === 'window.offer').length, 1);
  assert.deepEqual(fixture.sent.at(-1), { type: 'window.commit', id: 'window-stable', winner: 'source' });
  await fixture.runtime.stop();
});

test('a vanished source window commits the destination survivor instead of aborting it', async () => {
  const fixture = runtimeFixture();
  assert.equal(await fixture.runtime.handleMoveStart('hwnd'), true);
  fixture.input.cursor.virtualCursor = { x: 1010, y: 150 };
  await fixture.runtime.poll();
  assert.equal(fixture.sent.some(({ type }) => type === 'window.offer'), true);

  fixture.setWindow(null);
  assert.equal(await fixture.runtime.poll(), false);
  assert.deepEqual(fixture.sent.at(-1), {
    type: 'window.commit', id: 'window-stable', winner: 'destination',
  });
  assert.equal(fixture.sent.some(({ type }) => type === 'window.abort'), false);
  assert.equal(fixture.runtime.drag.active.phase, 'committing');
  assert.equal(fixture.nativeCalls.some(([type]) => type === 'release'), true);
  await fixture.runtime.stop();
});

test('source edge contact terminates the Windows native move loop exactly once and keeps polling', async () => {
  const fixture = runtimeFixture({ window: {
    id: 'hwnd', processName: 'chrome.exe',
    bounds: { x: -1220, y: -800, width: 400, height: 300 },
    normalizedBounds: { x: 700, y: 100, width: 400, height: 300 },
  } });
  const { runtime, input, native, nativeCalls } = fixture;
  assert.equal(await runtime.handleMoveStart('hwnd'), true);

  input.cursor.virtualCursor = { x: 900, y: 150 };
  await runtime.poll();
  // Capture slightly before the physical edge so Windows Snap never takes
  // ownership of the native drag.
  input.cursor.virtualCursor = { x: 989, y: 150 };
  await runtime.poll();
  assert.deepEqual(nativeCalls.slice(0, 2), [
    ['guard', 'hwnd', { x: -1220, y: -800, width: 400, height: 300 }],
    ['terminate', 'hwnd'],
  ]);

  // The synthetic up ends only the OS modal loop. It must not end Compusync's
  // drag while the low-level hook still reports the physical button held.
  native.emit('moveSizeEnd', 'hwnd');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.drag.active?.role, 'source');
  input.cursor.virtualCursor = { x: 1100, y: 150 };
  await runtime.poll();
  assert.equal(nativeCalls.filter(([kind]) => kind === 'terminate').length, 1);
  await runtime.stop();
});

test('synchronous MOVESIZEEND from terminating the modal drag cannot roll back the prepared peer', async () => {
  const fixture = runtimeFixture();
  const { runtime, input, native } = fixture;
  native.terminateMoveLoop = (id) => native.emit('moveSizeEnd', id);
  assert.equal(await runtime.handleMoveStart('hwnd'), true);
  input.cursor.virtualCursor = { x: 989, y: 150 };
  await runtime.poll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.drag.active?.role, 'source');
  assert.notEqual(runtime.drag.active?.phase, 'dropping');
  await runtime.stop();
});

test('arming takes over the native drag before either copy is positioned', async () => {
  const fixture = runtimeFixture();
  const { runtime, input, native, nativeCalls } = fixture;
  native.terminateMoveLoop = (id) => {
    assert.equal(fixture.positions.length, 0);
    nativeCalls.push(['terminate', id]);
    native.emit('moveSizeEnd', id);
  };
  await runtime.handleMoveStart('hwnd');
  input.cursor.virtualCursor = { x: 900, y: 150 };
  await runtime.poll();
  assert.equal(runtime.nativeLoopTerminated, true);
  assert.equal(nativeCalls.filter(([kind]) => kind === 'terminate').length, 1);
  assert.ok(fixture.positions.length > 0);
  await runtime.stop();
});

test('a drag restored from maximized captures the restored size and grab offset', async () => {
  const fixture = runtimeFixture({ window: { id: 'hwnd', processName: 'chrome.exe', maximized: true,
    bounds: { x: 0, y: 0, width: 1000, height: 800 } } });
  const { runtime, input } = fixture;
  input.cursor.virtualCursor = { x: 800, y: 20 };
  await runtime.handleMoveStart('hwnd');
  fixture.setWindow({ id: 'hwnd', processName: 'chrome.exe', maximized: false,
    bounds: { x: 500, y: 70, width: 600, height: 400 } });
  input.cursor.virtualCursor = { x: 810, y: 90 };
  await runtime.poll();
  const offer = fixture.sent.find(({ type }) => type === 'window.offer');
  assert.deepEqual(offer.descriptor.geometryVU, { x: 500, y: 70, w: 600, h: 400 });
  assert.deepEqual(runtime.drag.active.grabOffsetVU, { x: 310, y: 20 });
  assert.equal(runtime.drag.active.instant, false);
  input.cursor.virtualCursor = { x: 850, y: 110 };
  await runtime.poll();
  assert.deepEqual(fixture.positions.at(-1).origin, { x: 540, y: 90 });
  assert.deepEqual(fixture.sent.filter(({ type }) => type === 'window.position').at(-1).originVU,
    { x: 540, y: 90 });
  await runtime.stop();
});

for (const platformName of ['windows', 'darwin']) {
  test(`a transported button release completes a managed ${platformName} source without a native drag-end`, async () => {
    const fixture = runtimeFixture({ platformName, realCursor: true });
    const { runtime, input, native, sent } = fixture;
    const injected = [];
    native.synthesizeButton = (...args) => injected.push(args);
    input.cursor.receive({ type: 'cursor.button', button: 'left', down: true }, 'b');
    await runtime.handleMoveStart('hwnd');
    input.cursor.virtualCursor = { x: 900, y: 150 };
    await runtime.poll();
    await runtime.drag.receive({ type: 'window.ready', id: 'window-stable' });
    input.cursor.virtualCursor = { x: 1100, y: 150 };
    await runtime.poll();
    if (platformName === 'darwin') input.cursor.ownerMachineId = 'b';
    injected.length = 0;
    input.cursor.receive({ type: 'cursor.button', button: 'left', down: false }, 'b');
    assert.equal(input.cursor.state().buttons, 0);
    assert.deepEqual(injected, []);
    // Cursor frames continue after release even though managed dragging
    // deliberately suppresses native injection and its drag-end event.
    const cursorFrame = () => input.cursor.isOwner() ? input.cursor.flush()
      : input.cursor.receive({ type: 'cursor.position', x: 1100, y: 150 }, 'b');
    cursorFrame();
    cursorFrame();
    await new Promise((resolve) => setImmediate(resolve));
    cursorFrame();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.filter(({ type }) => type === 'window.commit'), [
      { type: 'window.commit', id: 'window-stable', winner: 'destination' },
    ]);
    await runtime.stop();
    assert.equal(input.cursor.listenerCount('position'), 0);
  });
}

test('terminating a Mac native drag cannot be mistaken for the physical drop', async () => {
  const fixture = runtimeFixture({ platformName: 'darwin', realCursor: true });
  const { runtime, input, native, sent } = fixture;
  input.cursor.localButton('left', true);
  native.terminateMoveLoop = (id) => native.emit('moveSizeEnd', id);
  await runtime.handleMoveStart('hwnd');
  input.cursor.virtualCursor = { x: 900, y: 150 };
  await runtime.poll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.drag.active?.role, 'source');
  assert.equal(runtime.drag.active?.phase, 'preparing');
  assert.ok(runtime.pollTimer);
  assert.equal(sent.some(({ type }) => type === 'window.commit'), false);
  assert.equal(input.cursor.state().buttons, 1);
  await runtime.stop();
});

test('60Hz runtime frames position from authoritative cursor and propagate the same origin', async () => {
  const { runtime, input, sent, positions } = runtimeFixture();
  await runtime.handleMoveStart('hwnd');
  input.cursor.virtualCursor = { x: 900, y: 150 };
  await runtime.poll();
  await runtime.drag.receive({ type: 'window.ready', id: 'window-stable' });

  input.cursor.virtualCursor = { x: 1000, y: 150 };
  await runtime.poll();
  input.cursor.virtualCursor = { x: 1040, y: 180 };
  await runtime.poll();

  assert.deepEqual(positions.slice(-2).map(({ origin }) => origin), [
    { x: 900, y: 100 },
    { x: 940, y: 130 },
  ]);
  assert.deepEqual(sent.filter(({ type }) => type === 'window.position').slice(-2).map(({ originVU }) => originVU), [
    { x: 900, y: 100 },
    { x: 940, y: 130 },
  ]);
  await runtime.stop();
});

test('recovery guard remains armed through straddle and is released only after settle', async () => {
  const { runtime, input, nativeCalls, setWindow } = runtimeFixture();
  await runtime.handleMoveStart('hwnd');
  input.cursor.virtualCursor = { x: 900, y: 150 };
  await runtime.poll();
  input.cursor.virtualCursor = { x: 1000, y: 150 };
  await runtime.poll();
  assert.equal(nativeCalls.some(([kind]) => kind === 'release'), false);

  setWindow(null);
  assert.equal(await runtime.poll(), false);
  assert.equal(runtime.drag.active.phase, 'committing');
  assert.equal(runtime.drag.active.winner, 'destination');
  assert.deepEqual(nativeCalls.at(-1), ['release', 'hwnd']);
  await runtime.stop();
});

test('a native display change aborts the straddle and releases its recovery guard', async () => {
  const { runtime, input, native, nativeCalls } = runtimeFixture();
  await runtime.handleMoveStart('hwnd');
  input.cursor.virtualCursor = { x: 1000, y: 150 };
  await runtime.poll();

  native.emit('displayChanged');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.drag.active, null);
  assert.deepEqual(nativeCalls.at(-1), ['release', 'hwnd']);
  await runtime.stop();
});

test('authoritative position drives the seam overlay and recovery clears it', async () => {
  const seamStates = [];
  const { runtime, input, setWindow } = runtimeFixture({ setSeam: (state) => seamStates.push(state) });
  await runtime.handleMoveStart('hwnd');
  input.cursor.virtualCursor = { x: 900, y: 150 };
  await runtime.poll();
  await runtime.drag.receive({ type: 'window.ready', id: 'window-stable' });
  input.cursor.virtualCursor = { x: 1040, y: 180 };
  await runtime.poll();
  assert.equal(seamStates.at(-1).geometry.x, 940);

  setWindow(null);
  await runtime.poll();
  assert.equal(seamStates.at(-1), null);
  await runtime.stop();
});

test('runtime forwards structured timing records without URL-bearing fields', async () => {
  const logs = [];
  const { runtime, input } = runtimeFixture({ logger: (event, details) => logs.push({ event, details }) });
  await runtime.handleMoveStart('hwnd');
  input.cursor.virtualCursor = { x: 900, y: 150 };
  await runtime.poll();
  assert.ok(logs.some(({ event, details }) => event === 'drag.timing'
    && details.name === 'capture' && details.durationMs >= 0));
  assert.ok(logs.some(({ event, details }) => event === 'drag.lifecycle'
    && details.event === 'offer-sent' && details.id === 'window-stable'));
  assert.doesNotMatch(JSON.stringify(logs), /https?:\/\//);
  assert.deepEqual(sanitizeHandoffLog({
    type: 'drag.lifecycle', reason: 'failed at https://example.test/private?token=secret',
    url: 'https://example.test/private', payload: { tabs: [] },
  }), { type: 'drag.lifecycle', reason: 'failed at [redacted-url]' });
  await runtime.stop();
});

test('transport unlink and suspend-style mode recovery clear the seam immediately', async () => {
  const seamStates = [];
  const { runtime, input } = runtimeFixture({ setSeam: (state) => seamStates.push(state) });
  await runtime.handleMoveStart('hwnd');
  input.cursor.virtualCursor = { x: 900, y: 150 };
  await runtime.poll();
  await runtime.drag.receive({ type: 'window.ready', id: 'window-stable' });
  input.cursor.virtualCursor = { x: 1040, y: 180 };
  await runtime.poll();
  assert.ok(seamStates.at(-1));

  input.emit('mode', { linked: false, reason: 'system-suspend' });
  assert.equal(seamStates.at(-1), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.drag.active, null);
  await runtime.stop();
});
