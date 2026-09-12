'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { DragController } = require('../src/main/drag.cjs');
const { RecoveryWatchdog } = require('../src/main/watchdog.cjs');
const { WindowHandoffRuntime } = require('../src/main/window-runtime.cjs');

const placements = [
  { machineId: 'source', origin: { x: 0, y: 0 }, size: { w: 1000, h: 800 }, scale: 1 },
  { machineId: 'destination', origin: { x: 1000, y: 0 }, size: { w: 1000, h: 800 }, scale: 1 },
];

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function chromeAdapter(role) {
  const adapter = {
    role,
    log: [],
    quitOnPosition: false,
    async capture(window, geometryVU) {
      this.log.push(['capture', window.id]);
      return {
        schemaVersion: 1,
        id: 'handoff-window',
        adapterId: 'chrome',
        origin: 'source',
        capturedAt: 1,
        geometryVU: { ...geometryVU },
        state: 'normal',
        payload: { activeIdx: 0, tabs: [{ url: 'https://example.test', title: '', pinned: false, index: 0 }] },
      };
    },
    async prepare() {
      this.log.push(['prepare']);
      return { id: 'prepared-window' };
    },
    async position(handle, origin) {
      if (this.quitOnPosition) {
        throw Object.assign(new Error(`${role} Chrome force-quit`), { code: 'CHROME_QUIT' });
      }
      this.log.push(['position', handle.id, { ...origin }]);
    },
    async focus(handle) { this.log.push(['focus', handle.id]); },
    async close(handle) { this.log.push(['close', handle.id]); },
  };
  return adapter;
}

function pairedDrags() {
  const queue = [];
  const sourceAdapter = chromeAdapter('source');
  const destinationAdapter = chromeAdapter('destination');
  const pair = { connected: true, queue, sourceAdapter, destinationAdapter };
  const send = (from, message) => {
    if (!pair.connected) return false;
    queue.push({ to: from === 'source' ? 'destination' : 'source', message });
    return true;
  };
  pair.source = new DragController({
    machineId: 'source',
    getPlacements: () => placements,
    adapterForWindow: () => sourceAdapter,
    send: (message) => send('source', message),
  });
  pair.destination = new DragController({
    machineId: 'destination',
    getPlacements: () => placements,
    adapterForId: () => destinationAdapter,
    send: (message) => send('destination', message),
  });
  pair.pump = async () => {
    while (queue.length) {
      const { to, message } = queue.shift();
      await pair[to].receive(message);
    }
  };
  pair.straddle = async () => {
    assert.equal(pair.source.begin({
      window: { id: 'source-window' },
      geometryVU: { x: 700, y: 100, w: 400, h: 300 },
      cursorVU: { x: 800, y: 180 },
    }), true);
    await pair.source.frame({
      geometryVU: { x: 700, y: 100, w: 400, h: 300 },
      cursorVU: { x: 910, y: 180 },
    });
    await pair.pump();
    assert.equal(pair.source.active?.phase, 'straddling');
    assert.equal(pair.destination.active?.phase, 'straddling');
  };
  return pair;
}

function recoveryNative() {
  const native = new EventEmitter();
  native.log = [];
  for (const name of ['installRecoveryGuard', 'emergencyRecover', 'showCursor', 'releaseCursor',
    'removeAllHooks', 'releaseInputState', 'removeRecoveryGuard', 'heartbeat']) {
    native[name] = () => native.log.push([name]);
  }
  native.setLinked = (value) => native.log.push(['setLinked', value]);
  return native;
}

function watchdogFor(drag, native = recoveryNative()) {
  const cursor = {
    linked: true,
    setLinked(value, reason) { this.linked = value; this.reason = reason; },
  };
  const watchdog = new RecoveryWatchdog({ native, cursor, drag });
  return { watchdog, native, cursor };
}

test('transport loss mid-straddle restores the local survivor on either role', async (t) => {
  for (const role of ['source', 'destination']) {
    await t.test(role, async () => {
      const pair = pairedDrags();
      await pair.straddle();
      const recovery = watchdogFor(pair[role]);
      recovery.watchdog.setPeerConnected(true);

      pair.connected = false;
      recovery.watchdog.setPeerConnected(false);
      await nextTurn();

      assert.equal(pair[role].active, null);
      assert.equal(recovery.cursor.linked, false);
      assert.equal(recovery.cursor.reason, 'transport-error');
      assert.ok(recovery.native.log.some(([name]) => name === 'emergencyRecover'));
      if (role === 'source') {
        assert.deepEqual(pair.sourceAdapter.log.filter(([name]) => name === 'position').at(-1),
          ['position', 'source-window', { x: 700, y: 100 }]);
        assert.ok(pair.sourceAdapter.log.some(([name]) => name === 'focus'));
      } else {
        assert.ok(pair.destinationAdapter.log.some(([name, id]) => name === 'close' && id === 'prepared-window'));
      }

      const other = role === 'source' ? pair.destination : pair.source;
      await other.abort('test-cleanup', false);
      recovery.watchdog.stop({ recover: false });
    });
  }
});

test('source Chrome force-quit commits the prepared destination survivor through the window runtime', async () => {
  const queue = [];
  let sourceWindow = {
    id: 'source-window', processName: 'chrome.exe',
    bounds: { x: 700, y: 100, width: 400, height: 300 },
  };
  const native = new EventEmitter();
  native.platformName = 'windows';
  native.guardLog = [];
  native.enumerateWindows = () => sourceWindow ? [sourceWindow] : [];
  native.guardWindow = (id, bounds) => native.guardLog.push(['guard', id, bounds]);
  native.terminateMoveLoop = (id) => native.guardLog.push(['terminate', id]);
  native.releaseWindowGuard = (id) => native.guardLog.push(['release', id]);

  const sourceAdapter = chromeAdapter('source');
  const destinationAdapter = chromeAdapter('destination');
  const input = new EventEmitter();
  input.machineId = 'source';
  input.cursor = {
    linked: true, placements, virtualCursor: { x: 800, y: 180 },
    placementFor: (machineId) => placements.find((placement) => placement.machineId === machineId),
  };
  input.send = (message) => { queue.push({ to: 'destination', message }); return true; };
  input.setDragging = () => {};
  input.setWindowController = (controller) => { input.windowController = controller; };
  input.watchdog = { trigger() {} };
  const chrome = new EventEmitter();
  chrome.adapterForWindow = () => sourceAdapter;
  chrome.adapterForId = () => sourceAdapter;
  chrome.setLinked = () => {};
  chrome.stop = () => {};
  const runtime = new WindowHandoffRuntime({ input, native, chrome, frameMs: 100000 });
  const destination = new DragController({
    machineId: 'destination', getPlacements: () => placements,
    adapterForId: () => destinationAdapter,
    send: (message) => { queue.push({ to: 'source', message }); return true; },
  });
  const pump = async () => {
    while (queue.length) {
      const { to, message } = queue.shift();
      await (to === 'source' ? runtime.drag : destination).receive(message);
    }
  };

  runtime.start();
  assert.equal(await runtime.handleMoveStart('source-window'), true);
  input.cursor.virtualCursor = { x: 1010, y: 180 };
  await runtime.poll();
  await pump();
  assert.equal(destination.active?.role, 'destination');

  sourceWindow = null;
  assert.equal(await runtime.poll(), false);
  await pump();

  assert.equal(runtime.drag.active, null);
  assert.equal(destination.active, null);
  assert.ok(destinationAdapter.log.some(([name, id]) => name === 'focus' && id === 'prepared-window'));
  assert.equal(destinationAdapter.log.some(([name]) => name === 'close'), false);
  assert.equal(sourceAdapter.log.some(([name]) => name === 'close'), false);
  assert.deepEqual(native.guardLog.at(-1), ['release', 'source-window']);
  await runtime.stop();
});

test('destination Chrome force-quit aborts the peer and restores the source survivor', async () => {
  const pair = pairedDrags();
  await pair.straddle();
  pair.destinationAdapter.quitOnPosition = true;

  await pair.source.frame({
    geometryVU: { x: 810, y: 100, w: 400, h: 300 },
    cursorVU: { x: 1020, y: 180 },
  });
  await pair.pump();

  assert.equal(pair.destination.active, null);
  assert.equal(pair.source.active, null);
  assert.ok(pair.destinationAdapter.log.some(([name, id]) => name === 'close' && id === 'prepared-window'));
  assert.deepEqual(pair.sourceAdapter.log.filter(([name]) => name === 'position').at(-1),
    ['position', 'source-window', { x: 700, y: 100 }]);
  assert.equal(pair.sourceAdapter.log.some(([name]) => name === 'close'), false);
});

test('suspend and wake while linked and straddling restore locally and remain safely unlinked', async () => {
  const pair = pairedDrags();
  await pair.straddle();
  const native = recoveryNative();
  const { watchdog, cursor } = watchdogFor(pair.source, native);
  const power = new EventEmitter();
  let layoutRefreshes = 0;
  watchdog.onResume = () => { layoutRefreshes += 1; };
  watchdog.bindPowerMonitor(power);

  pair.connected = false;
  power.emit('suspend');
  await nextTurn();
  assert.equal(pair.source.active, null);
  assert.equal(cursor.linked, false);
  assert.equal(cursor.reason, 'system-suspend');
  assert.deepEqual(pair.sourceAdapter.log.filter(([name]) => name === 'position').at(-1),
    ['position', 'source-window', { x: 700, y: 100 }]);

  const beforeWake = native.log.length;
  power.emit('resume');
  assert.deepEqual(native.log.slice(beforeWake), [
    ['setLinked', false], ['showCursor'], ['releaseCursor'], ['releaseInputState'],
  ]);
  assert.equal(layoutRefreshes, 1);
  assert.equal(cursor.linked, false);

  await pair.destination.abort('test-cleanup', false);
  watchdog.stop({ recover: false });
});

test('daemon exit and native panic both recover an active straddle to fail-closed state', async (t) => {
  for (const failure of ['daemon-exit', 'native-panic']) {
    await t.test(failure, async () => {
      const pair = pairedDrags();
      await pair.straddle();
      pair.connected = false;
      const native = recoveryNative();
      const { watchdog, cursor } = watchdogFor(pair.source, native);

      if (failure === 'native-panic') {
        watchdog.start();
        native.emit('panic', new Error('native addon panic'));
      } else {
        const daemon = new EventEmitter();
        watchdog.bindProcess(daemon);
        daemon.emit('exit', 1);
      }
      await nextTurn();

      assert.equal(watchdog.recovered, true);
      assert.equal(pair.source.active, null);
      assert.equal(cursor.linked, false);
      assert.equal(cursor.reason, failure === 'native-panic' ? 'addon-panic' : 'process-exit');
      for (const operation of ['emergencyRecover', 'showCursor', 'releaseCursor', 'removeAllHooks', 'releaseInputState']) {
        assert.ok(native.log.some(([name]) => name === operation), `${failure} missed ${operation}`);
      }
      assert.deepEqual(pair.sourceAdapter.log.filter(([name]) => name === 'position').at(-1),
        ['position', 'source-window', { x: 700, y: 100 }]);

      await pair.destination.abort('test-cleanup', false);
      watchdog.stop({ recover: false });
    });
  }
});
