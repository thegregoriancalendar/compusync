'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { initialState, reduce, disconnect } = require('../src/core/state.cjs');
const { edgeCrossing, arrivalBounds } = require('../src/core/geometry.cjs');

const members = ['windows', 'mac'];
const apply = (state, actor, action) => reduce(state, actor, action, members);
function pointing() {
  let state = apply(initialState('windows'), 'mac', { type: 'show' });
  state = apply(state, 'windows', { type: 'enter', x: .5, y: .5 });
  return apply(state, 'mac', { type: 'enter', x: .1, y: .1 });
}

test('both trackpads add relative movement to one cursor without jumping on entry', () => {
  let state = pointing();
  assert.equal(state.cursor.x, .5);
  state = apply(state, 'windows', { type: 'move', dx: .1, dy: -.2 });
  state = apply(state, 'mac', { type: 'move', dx: .2, dy: .1 });
  assert.equal(state.cursor.x, .8);
  assert.equal(state.cursor.y, .4);
  assert.equal(state.cursor.active.length, 2);
});

test('closing and reopening from either laptop synchronizes visibility', () => {
  let state = pointing();
  state = apply(state, 'mac', { type: 'close' });
  assert.equal(state.open, false);
  assert.deepEqual(state.views, []);
  assert.deepEqual(state.cursor.active, []);
  const closed = state;
  assert.equal(apply(state, 'windows', { type: 'move', dx: .1, dy: 0 }), closed);
  state = apply(state, 'windows', { type: 'open' });
  assert.equal(state.open, true);
  assert.deepEqual(state.views, members);
});

test('handoff transfers presentation and releases input; show restores simultaneous control', () => {
  let state = pointing();
  state = apply(state, 'windows', { type: 'button', buttons: 1 });
  state = apply(state, 'windows', { type: 'handoff', edge: 'right', ratio: .3 });
  assert.deepEqual(state.views, ['mac']);
  assert.equal(state.handoff.to, 'mac');
  assert.equal(state.cursor.buttons.windows, undefined);
  assert.deepEqual(state.cursor.active, ['mac']);
  state = apply(state, 'windows', { type: 'show' });
  assert.deepEqual(state.views, ['mac', 'windows']);
});

test('independent button ownership and disconnect recovery prevent a stuck cursor', () => {
  let state = pointing();
  for (const actor of members) state = apply(state, actor, { type: 'button', buttons: 1 });
  state = apply(state, 'windows', { type: 'leave' });
  assert.equal(state.cursor.buttons.mac, 1);
  state = apply(state, 'windows', { type: 'handoff', edge: 'right', ratio: .5 });
  state = disconnect(state, 'mac', ['windows']);
  assert.deepEqual(state.views, ['windows']);
  assert.deepEqual(state.cursor.active, []);
  assert.deepEqual(state.cursor.buttons, {});
});

test('rejects unauthorized and malformed input, clamps cursor and dimensions', () => {
  const state = pointing();
  for (const action of [{ type: 'move', dx: NaN, dy: 0 }, { type: 'move', dx: 99, dy: 0 }, { type: 'button', buttons: -1 }, { type: 'resize', width: '100', height: 500 }, { type: 'handoff', edge: 'bogus', ratio: 0 }, { type: 'unknown' }]) assert.equal(apply(state, 'windows', action), state);
  assert.equal(apply(state, 'stranger', { type: 'close' }), state);
  assert.equal(apply(state, 'mac', { type: 'move', dx: 1, dy: 0 }).cursor.x, 1);
  assert.deepEqual(apply(state, 'mac', { type: 'resize', width: 10, height: 10000 }).size, { width: 360, height: 1600 });
});

test('detects physical screen edges with negative display coordinates', () => {
  const display = { x: -1920, y: 0, width: 1920, height: 1080 };
  const bounds = { x: -700, y: 80, width: 900, height: 600 };
  assert.deepEqual(edgeCrossing(bounds, { x: -2, y: 540 }, display, 'right'), { edge: 'right', ratio: .5 });
  assert.equal(edgeCrossing(bounds, { x: -30, y: 540 }, display, 'right'), null);
  assert.equal(edgeCrossing(bounds, { x: -2, y: 540 }, display, 'left'), null);
});

test('arrival scales to a smaller screen and remains in its work area on every edge', () => {
  const area = { x: -1280, y: 25, width: 1280, height: 695 };
  for (const edge of ['left', 'right', 'top', 'bottom']) {
    for (const ratio of [0, .5, 1]) {
      const result = arrivalBounds({ width: 1600, height: 900 }, area, { edge, ratio });
      assert.equal(result.width, 1280);
      assert.equal(result.height, 695);
      assert.equal(result.x, -1280);
      assert.equal(result.y, 25);
    }
  }
});
