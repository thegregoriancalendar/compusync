'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { initialState, reduce, disconnect, TOP_BAR_HEIGHT, DRAG_LEASE_MS } = require('../src/core/state.cjs');
const {
  normalizeLayout,
  buildTopology,
  viewportsForActor,
  intersectRect,
  ensureReachable,
} = require('../src/core/geometry.cjs');

const members = ['windows', 'mac'];
const apply = (state, actor, action, now = 10_000) => reduce(state, actor, action, members, now);

function hostLayout(revision = 1, edge = 'right') {
  return {
    revision,
    edge,
    activeDisplayId: 'win-display',
    displays: [{
      id: 'win-display',
      bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
      workArea: { x: -1920, y: 40, width: 1920, height: 1040 },
      scaleFactor: 1.25,
      primary: true,
    }],
  };
}

function peerLayout(revision = 1, edge = 'left') {
  return {
    revision,
    edge,
    activeDisplayId: 'mac-display',
    displays: [{
      id: 'mac-display',
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea: { x: 0, y: 25, width: 1440, height: 875 },
      scaleFactor: 2,
      primary: true,
    }],
  };
}

function pairedState() {
  return apply(initialState('windows', 1000, hostLayout()), 'mac', { type: 'layout', layout: peerLayout() });
}

function crossingState() {
  const state = pairedState();
  state.window.rect = { x: 1470, y: 100, width: 900, height: 600 };
  return state;
}

test('layout normalization retains validated optional full-desktop cursor metrics', () => {
  const layout = hostLayout();
  layout.platform = 'win32';
  layout.desktop = { widthVU: 3584, heightVU: 1440, scale: 1.25 };
  assert.equal(normalizeLayout(layout).platform, 'win32');
  assert.deepEqual(normalizeLayout(layout).desktop, layout.desktop);
  layout.desktop.widthVU = Infinity;
  assert.equal(normalizeLayout(layout), null);
});

test('state v2 starts as one host-placed logical window without mirrored presentation fields', () => {
  const state = initialState('windows', 1234, hostLayout());
  assert.equal(state.version, 2);
  assert.equal(state.scene.epoch, 1234);
  assert.deepEqual(state.window.rect, { x: 510, y: 220, width: 900, height: 600 });
  assert.equal('views' in state, false);
  assert.equal('size' in state, false);
  assert.equal('handoff' in state, false);
  assert.equal(viewportsForActor(state.window.rect, state.topology, 'windows').length, 1);
  assert.equal(viewportsForActor(state.window.rect, state.topology, 'mac').length, 0);
});

test('host edge creates adjacent mixed-scale work areas and peer layout cannot override it', () => {
  const layouts = { windows: normalizeLayout(hostLayout()), mac: normalizeLayout(peerLayout(1, 'top')) };
  const topology = buildTopology(layouts, members);
  assert.equal(topology.edge, 'right');
  assert.deepEqual(topology.displays[0].virtualWorkArea, { x: 0, y: 0, width: 1920, height: 1040 });
  assert.deepEqual(topology.displays[1].virtualWorkArea, { x: 1920, y: 83, width: 1440, height: 875 });
  assert.equal(topology.displays[0].scaleFactor, 1.25);
  assert.equal(topology.displays[1].scaleFactor, 2);
});

test('half-way crossing yields complementary crops and exact local native bounds', () => {
  const state = crossingState();
  const win = viewportsForActor(state.window.rect, state.topology, 'windows')[0];
  const mac = viewportsForActor(state.window.rect, state.topology, 'mac')[0];
  assert.deepEqual(win.viewport, { x: 0, y: 0, width: 450, height: 600 });
  assert.deepEqual(mac.viewport, { x: 450, y: 0, width: 450, height: 600 });
  assert.equal(win.viewport.width + mac.viewport.width, state.window.rect.width);
  assert.deepEqual(win.nativeBounds, { x: -450, y: 140, width: 450, height: 600 });
  assert.deepEqual(mac.nativeBounds, { x: 0, y: 42, width: 450, height: 600 });
  assert.deepEqual(mac.fullSize, { width: 900, height: 600 });
});

test('half-open intersections retain one-DIP fragments and omit empty fragments', () => {
  const topology = pairedState().topology;
  const sliver = { x: 1919, y: 100, width: 900, height: 600 };
  assert.equal(viewportsForActor(sliver, topology, 'windows')[0].viewport.width, 1);
  assert.equal(viewportsForActor({ ...sliver, x: 1920 }, topology, 'windows').length, 0);
  assert.equal(intersectRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 2, height: 2 }), null);
});

test('joining adds topology but never relocates or duplicates the host window', () => {
  const initial = initialState('windows', 1000, hostLayout());
  const state = apply(initial, 'mac', { type: 'layout', layout: peerLayout() });
  assert.deepEqual(state.window.rect, initial.window.rect);
  assert.equal(viewportsForActor(state.window.rect, state.topology, 'windows').length, 1);
  assert.equal(viewportsForActor(state.window.rect, state.topology, 'mac').length, 0);
});

test('close clears global input and open or place-here creates only one actor-local placement', () => {
  let state = crossingState();
  state = apply(state, 'windows', { type: 'enter', x: .2, y: .3 });
  state = apply(state, 'windows', { type: 'button', buttons: 1 });
  state = apply(state, 'mac', { type: 'close' });
  assert.equal(state.open, false);
  assert.equal(state.drag, null);
  assert.deepEqual(state.cursor.active, []);
  assert.deepEqual(state.cursor.buttons, {});
  state = apply(state, 'mac', { type: 'open' });
  assert.equal(state.open, true);
  assert.deepEqual(state.window.rect, { x: 2190, y: 221, width: 900, height: 600 });
  assert.equal(viewportsForActor(state.window.rect, state.topology, 'windows').length, 0);
  assert.equal(viewportsForActor(state.window.rect, state.topology, 'mac').length, 1);
  state = apply(state, 'windows', { type: 'place-here' });
  assert.deepEqual(state.window.rect, { x: 510, y: 220, width: 900, height: 600 });
  assert.equal(viewportsForActor(state.window.rect, state.topology, 'mac').length, 0);
});

test('both visible interior crops contribute to one normalized cursor without entry jumps', () => {
  let state = crossingState();
  state = apply(state, 'windows', { type: 'enter', x: .5, y: .5 });
  state = apply(state, 'mac', { type: 'enter', x: .9, y: .1 });
  assert.deepEqual(state.cursor.active, members);
  assert.equal(state.cursor.x, .5);
  state = apply(state, 'windows', { type: 'move', dx: .1, dy: -.2 }, 10_024);
  state = apply(state, 'mac', { type: 'move', dx: .2, dy: .1 }, 10_048);
  assert.ok(Math.abs(state.cursor.x - .8) < 1e-12);
  assert.ok(Math.abs(state.cursor.y - .4) < 1e-12);
  assert.equal(state.cursor.trail.length, 2);
});

test('drag ownership uses a token and monotonic sequence and survives loss of the owner crop', () => {
  let state = crossingState();
  state = apply(state, 'windows', { type: 'drag-start', id: 'drag-win-1', offsetX: 100, offsetY: 10 }, 20_000);
  assert.equal(state.drag.owner, 'windows');
  assert.equal(state.drag.leaseUntil, 20_000 + DRAG_LEASE_MS);
  state = apply(state, 'windows', { type: 'drag-move', id: 'drag-win-1', seq: 1, dx: 500, dy: 0 }, 20_100);
  assert.equal(viewportsForActor(state.window.rect, state.topology, 'windows').length, 0);
  const afterLeaving = state;
  state = apply(state, 'windows', { type: 'drag-move', id: 'drag-win-1', seq: 2, dx: 100, dy: 0 }, 20_200);
  assert.notEqual(state, afterLeaving);
  assert.equal(state.window.rect.x, 2070);
  state = apply(state, 'windows', { type: 'drag-end', id: 'drag-win-1' });
  assert.equal(state.drag, null);
  assert.equal(viewportsForActor(state.window.rect, state.topology, 'mac').length, 1);
});

test('the peer can reverse a crossing and Escape-style cancel restores its starting rectangle', () => {
  let state = crossingState();
  state = apply(state, 'mac', { type: 'drag-start', id: 'drag-mac-1', offsetX: 700, offsetY: 12 });
  const start = structuredClone(state.window.rect);
  state = apply(state, 'mac', { type: 'drag-move', id: 'drag-mac-1', seq: 1, dx: -500, dy: 0 });
  state = apply(state, 'mac', { type: 'drag-move', id: 'drag-mac-1', seq: 2, dx: -500, dy: 0 });
  assert.equal(viewportsForActor(state.window.rect, state.topology, 'mac').length, 0);
  state = apply(state, 'mac', { type: 'drag-cancel', id: 'drag-mac-1' });
  assert.deepEqual(state.window.rect, start);
  assert.equal(state.drag, null);
});

test('simultaneous grabs, stale tokens, skipped sequences, and malformed deltas are rejected', () => {
  let state = crossingState();
  const untouched = state;
  for (const action of [
    { type: 'drag-start', id: 'short', offsetX: 10, offsetY: 10 },
    { type: 'drag-start', id: 'valid-id-1', offsetX: 500, offsetY: TOP_BAR_HEIGHT },
    { type: 'drag-start', id: 'valid-id-1', offsetX: NaN, offsetY: 10 },
  ]) assert.equal(apply(state, 'windows', action), untouched);
  state = apply(state, 'windows', { type: 'drag-start', id: 'valid-id-1', offsetX: 100, offsetY: 10 });
  const owned = state;
  assert.equal(apply(state, 'mac', { type: 'drag-start', id: 'valid-id-2', offsetX: 700, offsetY: 10 }), owned);
  for (const action of [
    { type: 'drag-move', id: 'wrong-id', seq: 1, dx: 1, dy: 0 },
    { type: 'drag-move', id: 'valid-id-1', seq: 2, dx: 1, dy: 0 },
    { type: 'drag-move', id: 'valid-id-1', seq: 1, dx: 513, dy: 0 },
    { type: 'drag-move', id: 'valid-id-1', seq: 1, dx: .5, dy: 0 },
  ]) assert.equal(apply(state, 'windows', action), owned);
  assert.equal(apply(state, 'mac', { type: 'drag-end', id: 'valid-id-1' }), owned);
});

test('layout validation rejects malformed, stale, oversized, duplicate, and out-of-bounds displays', () => {
  const state = pairedState();
  const invalid = [
    { ...peerLayout(2), edge: 'diagonal' },
    { ...peerLayout(2), activeDisplayId: 'missing' },
    { ...peerLayout(2), displays: [{ ...peerLayout().displays[0], scaleFactor: 9 }] },
    { ...peerLayout(2), displays: Array.from({ length: 9 }, (_, index) => ({ ...peerLayout().displays[0], id: `d${index}` })), activeDisplayId: 'd0' },
    { ...peerLayout(2), displays: [peerLayout().displays[0], peerLayout().displays[0]] },
    { ...peerLayout(2), displays: [{ ...peerLayout().displays[0], workArea: { x: -1, y: 0, width: 1440, height: 900 } }] },
  ];
  for (const layout of invalid) assert.equal(apply(state, 'mac', { type: 'layout', layout }), state);
  assert.equal(apply(state, 'mac', { type: 'layout', layout: peerLayout(1) }), state);
});

test('a hotplug layout update cancels a drag, rebuilds topology, and keeps the bar reachable', () => {
  let state = crossingState();
  state = apply(state, 'mac', { type: 'drag-start', id: 'hotplug-1', offsetX: 700, offsetY: 10 });
  state = apply(state, 'mac', { type: 'drag-move', id: 'hotplug-1', seq: 1, dx: 400, dy: 300 });
  const changed = peerLayout(2);
  changed.displays[0].bounds = { x: 100, y: -900, width: 1280, height: 800 };
  changed.displays[0].workArea = { x: 100, y: -875, width: 1280, height: 775 };
  state = apply(state, 'mac', { type: 'layout', layout: changed });
  assert.equal(state.drag, null);
  assert.equal(state.topology.displays[1].localWorkArea.x, 100);
  assert.equal(state.topology.displays[1].virtualWorkArea.width, 1280);
  assert.deepEqual(state.window.rect, { x: 1470, y: 100, width: 900, height: 600 });
  assert.equal(viewportsForActor(state.window.rect, state.topology, 'windows').length, 1);
});

test('disconnect cancels capture, clears buttons, removes the display, and recovers a peer-only window', () => {
  let state = pairedState();
  state.window.rect = { x: 2200, y: 200, width: 900, height: 600 };
  state = apply(state, 'mac', { type: 'enter', x: .5, y: .5 });
  state = apply(state, 'mac', { type: 'button', buttons: 1 });
  state = apply(state, 'mac', { type: 'drag-start', id: 'disconnect-1', offsetX: 200, offsetY: 10 });
  state = apply(state, 'mac', { type: 'drag-move', id: 'disconnect-1', seq: 1, dx: 300, dy: 0 });
  state = disconnect(state, 'mac', ['windows']);
  assert.equal(state.drag, null);
  assert.deepEqual(state.cursor.active, []);
  assert.deepEqual(state.cursor.buttons, {});
  assert.equal(state.topology.displays.length, 1);
  assert.equal(state.layouts.mac, undefined);
  assert.deepEqual(state.window.rect, { x: 510, y: 220, width: 900, height: 600 });
});

test('logical resize clamps independently from one-DIP fragments and rejects malformed pointer input', () => {
  let state = crossingState();
  state.window.rect.x = 1919;
  state = apply(state, 'windows', { type: 'resize', width: 10, height: 10000 });
  assert.equal(state.window.rect.width, 360);
  assert.equal(state.window.rect.height, 1600);
  assert.equal(viewportsForActor(state.window.rect, state.topology, 'windows')[0].viewport.width, 1);
  const unchanged = state;
  for (const action of [
    { type: 'enter', x: NaN, y: 0 },
    { type: 'move', dx: 99, dy: 0 },
    { type: 'button', buttons: -1 },
    { type: 'resize', width: '900', height: 600 },
    { type: 'unknown' },
  ]) assert.equal(apply(state, 'windows', action), unchanged);
  assert.equal(apply(state, 'stranger', { type: 'close' }), state);
});

test('recovery leaves an already grabbable partial bar in place and centers a stranded window', () => {
  const state = pairedState();
  const partial = { x: -836, y: 100, width: 900, height: 600 };
  assert.deepEqual(ensureReachable(partial, state.topology, 'windows'), partial);
  assert.deepEqual(
    ensureReachable({ x: -5000, y: -5000, width: 900, height: 600 }, state.topology, 'mac'),
    { x: 2190, y: 221, width: 900, height: 600 },
  );
});
