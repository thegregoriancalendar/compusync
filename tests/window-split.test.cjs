'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DragController, renderedGeometry, cursorDeltaInSource } = require('../src/main/drag.cjs');
const { sanitizePeerMessage, policyForMessage } = require('../src/main/messages.cjs');

const screens = [
  { machineId: 'a', origin: { x: 0, y: 0 }, size: { w: 1000, h: 800 }, scale: 1 },
  { machineId: 'b', origin: { x: 1000, y: 0 }, size: { w: 1000, h: 800 }, scale: 2 },
];

function pair(options = {}) {
  const queue = [], log = [], controllers = {}, dragging = {};
  const placements = options.placements || screens;
  for (const machineId of ['a', 'b']) {
    const adapter = {
      async capture(window, geometryVU) {
        log.push({ machineId, action: 'capture', window });
        return { schemaVersion: 1, id: 'split-window', adapterId: 'chrome', origin: machineId,
          capturedAt: 1, state: 'normal', geometryVU: { ...geometryVU },
          payload: { activeIdx: 0, tabs: [{ index: 0, url: 'https://example.com', title: '', pinned: false }] } };
      },
      async prepare(descriptor, prepareOptions) {
        log.push({ machineId, action: 'prepare', descriptor, options: prepareOptions });
        const handle = { id: `${machineId}-window`, geometryVU: descriptor.geometryVU };
        await prepareOptions.onPrepared?.(handle);
        if (options.prepareGate) await options.prepareGate;
        return handle;
      },
      async position(handle, origin) { log.push({ machineId, action: 'position', handle, origin: { ...origin } }); },
      async focus() { log.push({ machineId, action: 'focus' }); },
      async close(handle) { log.push({ machineId, action: 'close', handle }); },
    };
    if (options.pageState) {
      adapter.captureState = async () => options.pageState(machineId);
      adapter.syncState = async (handle, payload) => { log.push({ machineId, action: 'sync', handle, payload }); };
    }
    controllers[machineId] = new DragController({ machineId, getPlacements: () => placements,
      adapterForWindow: () => adapter, adapterForId: () => adapter,
      setDragging: (value) => { dragging[machineId] = value; },
      send: (message) => {
        const clean = sanitizePeerMessage(message);
        assert.ok(clean, `invalid ${message.type}`);
        queue.push({ from: machineId, message: clean });
        return true;
      },
    });
  }
  async function pump() {
    let steps = 0;
    while (queue.length) {
      assert.ok(++steps < 100, 'message loop');
      const { from, message } = queue.shift();
      await controllers[from === 'a' ? 'b' : 'a'].receive(message);
    }
  }
  return { ...controllers, queue, log, dragging, pump };
}

async function start(pairing) {
  assert.equal(pairing.a.begin({ window: { id: 'a-window' }, geometryVU: { x: 700, y: 100, w: 400, h: 300 },
    cursorVU: { x: 800, y: 150 } }), true);
  await pairing.a.frame({ cursorVU: { x: 910, y: 150 } });
  await pairing.pump();
}

test('release refreshes page state before parking and resuming updates the existing peer window', async () => {
  const payload = (machineId) => ({ activeIdx: 0, tabs: [{ index: 0, url: `https://${machineId}.example/`, title: '', pinned: false }] });
  const pairing = pair({ pageState: payload });
  await start(pairing);
  await pairing.a.end();
  assert.deepEqual(pairing.queue.slice(-2).map(({ message }) => message.type), ['window.state', 'window.pause']);
  await pairing.pump();
  assert.deepEqual(pairing.log.find(({ action }) => action === 'sync').payload, payload('a'));
  assert.equal(pairing.b.parked.get('split-window').descriptor.payload.tabs[0].url, 'https://a.example/');
  const parked = pairing.b.parked.get('split-window');
  pairing.b.begin({ window: { id: 'b-window' }, geometryVU: parked.geometryVU, cursorVU: { x: 1100, y: 150 } });
  await pairing.b.frame({ cursorVU: { x: 1080, y: 150 } });
  await pairing.pump();
  assert.equal(pairing.log.filter(({ action }) => action === 'prepare').length, 1);
  assert.equal(pairing.log.filter(({ machineId, action }) => machineId === 'a' && action === 'sync').length, 1);
  await pairing.b.end();
  await pairing.pump();
  assert.deepEqual(pairing.log.filter(({ machineId, action }) => machineId === 'a' && action === 'sync').at(-1).payload, payload('b'));
});

test('page-state capture failure still completes the native window transfer', async () => {
  const pairing = pair({ pageState: async () => { throw new Error('page-unavailable'); } });
  await start(pairing);
  await pairing.a.frame({ cursorVU: { x: 1300, y: 150 } });
  await pairing.pump();
  await pairing.a.end();
  await pairing.pump();
  assert.equal(pairing.a.active, null);
  assert.equal(pairing.b.active, null);
  assert.deepEqual(pairing.log.filter(({ action }) => action === 'close').map(({ machineId }) => machineId), ['a']);
});

for (const cursorX of [750, 900, 1080]) {
  test(`release at x=${cursorX} retains both visible halves without choosing a winner`, async () => {
    const pairing = pair();
    await start(pairing);
    await pairing.a.frame({ cursorVU: { x: cursorX, y: 150 } });
    await pairing.a.end();
    assert.equal(pairing.queue.at(-1).message.type, 'window.pause');
    assert.equal(policyForMessage('window.pause').reliable, true);
    await pairing.pump();
    assert.equal(pairing.a.active, null);
    assert.equal(pairing.b.active, null);
    assert.equal(pairing.a.parked.size, 1);
    assert.equal(pairing.b.parked.size, 1);
    assert.equal(pairing.log.some(({ action }) => action === 'close'), false);
    assert.deepEqual(pairing.dragging, { a: false, b: false });
    assert.equal(await pairing.a.end(), false);
    assert.equal(await pairing.b.receive({ type: 'window.position', id: 'split-window', sequence: 999,
      originVU: { x: 0, y: 0 } }), false);
  });
}

for (const side of ['left', 'right', 'top', 'bottom']) {
  test(`split release keeps the window on both desktops at the ${side} seam`, async () => {
    const peerOrigin = side === 'left' ? { x: -1000, y: 0 } : side === 'right' ? { x: 1000, y: 0 }
      : side === 'top' ? { x: 0, y: -800 } : { x: 0, y: 800 };
    const pairing = pair({ placements: [screens[0], { ...screens[1], origin: peerOrigin }] });
    const geometryVU = { x: side === 'right' ? 500 : 100, y: side === 'bottom' ? 400 : 100, w: 400, h: 300 };
    const cursorVU = { x: geometryVU.x + 100, y: geometryVU.y + 50 };
    pairing.a.begin({ window: { id: 'a-window' }, geometryVU, cursorVU });
    const next = { x: cursorVU.x + (side === 'left' ? -110 : side === 'right' ? 110 : 0),
      y: cursorVU.y + (side === 'top' ? -110 : side === 'bottom' ? 110 : 0) };
    await pairing.a.frame({ cursorVU: next });
    await pairing.pump();
    await pairing.a.end();
    await pairing.pump();
    assert.equal(pairing.a.parked.size, 1);
    assert.equal(pairing.b.parked.size, 1);
    assert.equal(pairing.log.some(({ action }) => action === 'close'), false);
  });
}

for (const pickedUpOn of ['a', 'b']) for (const finalLaptop of ['a', 'b']) {
  test(`a split can be picked up on ${pickedUpOn} and moved fully onto ${finalLaptop} using the existing windows`, async () => {
    const pairing = pair();
    await start(pairing);
    await pairing.a.end();
    await pairing.pump();
    const mover = pairing[pickedUpOn];
    const parked = mover.parked.get('split-window');
    const cursorX = pickedUpOn === 'a' ? 900 : 1100;
    assert.equal(mover.begin({ window: { id: `${pickedUpOn}-window` }, geometryVU: parked.geometryVU,
      cursorVU: { x: cursorX, y: 150 } }), true);
    const finalX = finalLaptop === 'a' ? 400 : 1200;
    await mover.frame({ cursorVU: { x: finalX + cursorX - parked.geometryVU.x, y: 150 } });
    await pairing.pump();
    await mover.end();
    await pairing.pump();
    assert.equal(pairing.log.filter(({ action }) => action === 'prepare').length, 1);
    assert.deepEqual(pairing.log.filter(({ action }) => action === 'close').map(({ machineId }) => machineId),
      [finalLaptop === 'a' ? 'b' : 'a']);
    assert.equal(pairing.a.parked.size + pairing.b.parked.size, 0);
    assert.equal(pairing.a.active, null);
    assert.equal(pairing.b.active, null);
  });
}

test('a partial release during slow preparation survives and the reliable pause fixes the final origin', async () => {
  let finish;
  const pairing = pair({ prepareGate: new Promise((resolve) => { finish = resolve; }) });
  pairing.a.begin({ window: { id: 'a-window' }, geometryVU: { x: 700, y: 100, w: 400, h: 300 },
    cursorVU: { x: 800, y: 150 } });
  await pairing.a.frame({ cursorVU: { x: 910, y: 150 } });
  const offer = pairing.queue.find(({ message }) => message.type === 'window.offer').message;
  pairing.queue.length = 0;
  const preparing = pairing.b.receive(offer);
  await new Promise((resolve) => setImmediate(resolve));
  await pairing.a.frame({ cursorVU: { x: 980, y: 160 } });
  pairing.queue.length = 0; // The final realtime position is lost.
  assert.equal(await pairing.a.end(), true);
  assert.equal(pairing.a.parked.size, 1);
  const pause = pairing.queue.shift().message;
  await pairing.b.receive(pause);
  await pairing.b.receive({ type: 'window.position', id: 'split-window', sequence: 9999,
    originVU: { x: 50, y: 50 } });
  assert.equal(pairing.log.some(({ action }) => action === 'close'), false);
  finish();
  await preparing;
  await pairing.pump();
  assert.equal(pairing.b.parked.size, 1);
  assert.deepEqual(pairing.log.filter(({ machineId, action }) => machineId === 'b' && action === 'position').at(-1).origin,
    { x: 880, y: 110 });
  assert.equal(pairing.log.some(({ action }) => action === 'close'), false);
});

test('unlink restores parked halves locally without destroying either browser window', async () => {
  const pairing = pair();
  await start(pairing);
  await pairing.a.end();
  await pairing.pump();
  await pairing.a.restoreOnScreen('unlinked');
  await pairing.b.restoreOnScreen('unlinked');
  assert.equal(pairing.a.parked.size + pairing.b.parked.size, 0);
  assert.equal(pairing.log.some(({ action }) => action === 'close'), false);
  assert.deepEqual(pairing.log.filter(({ machineId, action }) => machineId === 'a' && action === 'position').at(-1).origin,
    { x: 600, y: 100 });
  assert.deepEqual(pairing.log.filter(({ machineId, action }) => machineId === 'b' && action === 'position').at(-1).origin,
    { x: 1000, y: 100 });
});

test('re-grabbing before cold preparation finishes reuses the in-flight window and retains the new split', async () => {
  let finish;
  const pairing = pair({ prepareGate: new Promise((resolve) => { finish = resolve; }) });
  pairing.a.begin({ window: { id: 'a-window' }, geometryVU: { x: 700, y: 100, w: 400, h: 300 },
    cursorVU: { x: 800, y: 150 } });
  await pairing.a.frame({ cursorVU: { x: 910, y: 150 } });
  const preparing = pairing.b.receive(pairing.queue.shift().message);
  await new Promise((resolve) => setImmediate(resolve));
  await pairing.pump();
  await pairing.a.end();
  await pairing.pump();
  const geometryVU = pairing.a.parked.get('split-window').geometryVU;
  pairing.a.begin({ window: { id: 'a-window' }, geometryVU, cursorVU: { x: 900, y: 150 } });
  await pairing.a.frame({ cursorVU: { x: 950, y: 150 } });
  await pairing.pump();
  assert.equal(pairing.b.active.pendingPause, null);
  await pairing.a.end();
  await pairing.pump();
  finish();
  await preparing;
  await pairing.pump();
  assert.equal(pairing.log.filter(({ action }) => action === 'prepare').length, 1);
  assert.equal(pairing.log.some(({ action }) => action === 'close'), false);
  assert.equal(pairing.a.parked.get('split-window').geometryVU.x, 860);
  assert.equal(pairing.b.parked.get('split-window').geometryVU.x, 860);
});

test('a full transfer uses the reliable commit origin when the last realtime positions are lost', async () => {
  const pairing = pair();
  await start(pairing);
  await pairing.a.frame({ cursorVU: { x: 1250, y: 160 } });
  pairing.queue.length = 0;
  await pairing.a.end();
  await pairing.pump();
  assert.deepEqual(pairing.log.filter(({ machineId, action }) => machineId === 'b' && action === 'position').at(-1).origin,
    { x: 1150, y: 110 });
  assert.deepEqual(pairing.log.filter(({ action }) => action === 'close').map(({ machineId }) => machineId), ['a']);
});

test('physical size is applied before prepare and survives live positioning and a split release', async () => {
  const placements = [
    { machineId: 'a', origin: { x: 0, y: 0 }, size: { w: 3000, h: 1800 }, scale: 1.25,
      physicalDisplays: [{ id: 'large', origin: { x: 0, y: 0 }, size: { w: 3000, h: 1800 }, physicalSizeMm: { w: 600, h: 360 } }] },
    { machineId: 'b', origin: { x: 3000, y: 450 }, size: { w: 1500, h: 900 }, scale: 2,
      physicalDisplays: [{ id: 'small', origin: { x: 0, y: 0 }, size: { w: 1500, h: 900 }, physicalSizeMm: { w: 500, h: 300 } }] },
  ];
  const pairing = pair({ placements });
  pairing.a.begin({ window: { id: 'a-window' }, geometryVU: { x: 1900, y: 600, w: 1200, h: 600 },
    cursorVU: { x: 2000, y: 650 } });
  await pairing.a.frame({ cursorVU: { x: 2010, y: 650 } });
  await pairing.pump();
  const prepared = pairing.log.find(({ action }) => action === 'prepare').descriptor.geometryVU;
  assert.equal(prepared.w, 720);
  assert.equal(prepared.h, 360);
  assert.equal(prepared.w / 3, 1200 / 5); // Same millimeters on each display.
  await pairing.a.end();
  await pairing.pump();
  const handle = pairing.b.parked.get('split-window').handle;
  assert.equal(handle.geometryVU.w, 720);
  assert.equal(handle.geometryVU.h, 360);
});

test('only physically oversized windows are reduced, leaving a receiving-screen margin', () => {
  assert.equal(renderedGeometry({ x: 900, y: 100, w: 400, h: 300 }, ...screens).w, 400);
  const oversized = renderedGeometry({ x: 900, y: 100, w: 2000, h: 1000 }, ...screens);
  assert.equal(oversized.w, 900);
  assert.equal(oversized.h, 450);
});

test('cursor speed changes continuously across the seam and matches the receiving rendering', () => {
  assert.deepEqual(cursorDeltaInSource({ x: 990, y: 200 }, { x: 1010, y: 200 }, screens[1], 0.5), { x: 30, y: 0 });
  assert.deepEqual(cursorDeltaInSource({ x: 1010, y: 200 }, { x: 1030, y: 200 }, screens[1], 0.5), { x: 40, y: 0 });
  assert.deepEqual(cursorDeltaInSource({ x: 1010, y: 200 }, { x: 990, y: 200 }, screens[1], 0.5), { x: -30, y: 0 });
});

test('pause transport rejects invalid IDs, non-finite origins, and oversized coordinates', () => {
  for (const value of [
    { id: '../bad', originVU: { x: 0, y: 0 } },
    { id: 'split-window', originVU: { x: Infinity, y: 0 } },
    { id: 'split-window', originVU: { x: 1e7, y: 0 } },
  ]) assert.equal(sanitizePeerMessage({ type: 'window.pause', ...value }), null);
});
