'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DragController, crossedFraction, offscreenOrigin } = require('../src/main/drag.cjs');

const placements = [
  { machineId: 'a', origin: { x: 0, y: 0 }, size: { w: 1000, h: 800 }, scale: 1 },
  { machineId: 'b', origin: { x: 1000, y: 0 }, size: { w: 1000, h: 800 }, scale: 2 },
];

function adapter(log, id = 'chrome') {
  return {
    adapterId: id,
    async capture(_window, geometryVU) {
      log.push('capture');
      return { schemaVersion: 1, id: 'stable-window-id', adapterId: id, origin: 'a', capturedAt: 1,
        geometryVU: { ...geometryVU }, state: 'normal', payload: { activeIdx: 0, tabs: [{ url: 'https://example.com', title: 'Example', pinned: false, index: 0 }] } };
    },
    async prepare(descriptor, options) { log.push(['prepare', options]); return { id: descriptor.id }; },
    async position(handle, origin) { log.push(['position', handle.id || handle, origin]); },
    async focus(handle) { log.push(['focus', handle.id]); },
    async close(handle) { log.push(['close', handle.id || handle]); },
  };
}

test('crossing math and offscreen prewarm are deterministic', () => {
  assert.equal(crossedFraction({ x: 800, y: 100, w: 400, h: 300 }, placements[1]), 0.5);
  assert.deepEqual(offscreenOrigin({ x: 800, y: 100, w: 400, h: 300 }, placements[0], placements[1]), { x: 2001, y: 100 });
});

test('source arms once only while moving toward the edge and never closes before committed', async () => {
  const log = [], sent = [];
  const chrome = adapter(log);
  const drag = new DragController({ machineId: 'a', getPlacements: () => placements,
    adapterForWindow: () => chrome, send: (message) => { sent.push(message); return true; } });
  drag.begin({ window: { id: 'source' }, geometryVU: { x: 700, y: 100, w: 400, h: 300 }, cursorVU: { x: 800, y: 100 } });
  await drag.frame({ geometryVU: { x: 750, y: 100, w: 400, h: 300 }, cursorVU: { x: 850, y: 100 } });
  await drag.frame({ geometryVU: { x: 810, y: 100, w: 400, h: 300 }, cursorVU: { x: 910, y: 100 } });
  assert.equal(log.filter((value) => value === 'capture').length, 1);
  assert.equal(sent[0].type, 'window.offer');
  await drag.receive({ type: 'window.ready', id: 'stable-window-id' });
  await drag.end({ geometryVU: { x: 810, y: 100, w: 400, h: 300 } });
  assert.equal(sent.at(-1).winner, 'destination');
  assert.equal(log.some((value) => Array.isArray(value) && value[0] === 'close'), false);
  await drag.receive({ type: 'window.committed', id: 'stable-window-id' });
  assert.equal(log.some((value) => Array.isArray(value) && value[0] === 'close'), true);
});

test('destination prepares a real handle offscreen and acknowledges either winner', async () => {
  const log = [], sent = [], chrome = adapter(log);
  const drag = new DragController({ machineId: 'b', getPlacements: () => placements,
    adapterForId: () => chrome, send: (message) => { sent.push(message); return true; } });
  const descriptor = await chrome.capture({}, { x: 810, y: 100, w: 400, h: 300 });
  assert.equal(await drag.receive({ type: 'window.offer', descriptor }), true);
  assert.equal(sent.at(-1).type, 'window.ready');
  assert.equal(await drag.receive({ type: 'window.commit', id: descriptor.id, winner: 'destination' }), true);
  assert.deepEqual(log.filter(Array.isArray).map((entry) => entry[0]), ['prepare', 'position', 'focus']);
  assert.equal(sent.at(-1).type, 'window.committed');
});

test('non-addressable windows show one hint and never offer', async () => {
  const sent = [], hints = [];
  const drag = new DragController({ machineId: 'a', getPlacements: () => placements,
    adapterForWindow: () => null, send: (message) => { sent.push(message); return true; } });
  drag.on('hint', (hint) => hints.push(hint));
  drag.begin({ window: { id: 'other' }, geometryVU: { x: 700, y: 0, w: 400, h: 300 }, cursorVU: { x: 0, y: 0 } });
  await drag.frame({ geometryVU: { x: 810, y: 0, w: 400, h: 300 } });
  await drag.frame({ geometryVU: { x: 820, y: 0, w: 400, h: 300 } });
  assert.equal(hints.length, 1);
  assert.equal(sent.length, 0);
});

test('failed offer send restores the source and clears the drag', async () => {
  const log = [], chrome = adapter(log);
  const drag = new DragController({ machineId: 'a', getPlacements: () => placements,
    adapterForWindow: () => chrome, send: () => false });
  drag.begin({ window: { id: 'source' }, geometryVU: { x: 700, y: 100, w: 400, h: 300 }, cursorVU: { x: 0, y: 0 } });
  await drag.frame({ geometryVU: { x: 810, y: 100, w: 400, h: 300 } });
  assert.equal(drag.active, null);
  assert.deepEqual(log.filter(Array.isArray).at(-1), ['position', 'source', { x: 700, y: 100 }]);
});
