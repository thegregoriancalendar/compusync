'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { arrangeDiagram, snapDragged, arrangementText } = require('../src/renderer/screen-layout.js');

test('screen layout editor snaps either display to the three safe Mac-relative seams', () => {
  const sizes = { mac: { w: 120, h: 75 }, windows: { w: 130, h: 80 } };
  let rects = arrangeDiagram(400, 240, 'left', 0, sizes);
  assert.equal(rects.mac.x + rects.mac.w, rects.windows.x);
  assert.equal(snapDragged('mac', { x: 390, y: 120 }, rects).macPosition, 'right');
  assert.equal(snapDragged('mac', { x: 200, y: 0 }, rects).macPosition, 'top');

  rects = arrangeDiagram(400, 240, 'right', .5, sizes);
  assert.equal(rects.windows.x + rects.windows.w, rects.mac.x);
  assert.equal(snapDragged('windows', { x: 0, y: 120 }, rects).macPosition, 'right');
  assert.equal(snapDragged('windows', { x: 200, y: 239 }, rects).macPosition, 'top');
  assert.match(arrangementText('right'), /Mac left ↔ Windows right/);
});

test('screen layout editor clamps sliding to retain a usable shared edge', () => {
  const rects = arrangeDiagram(400, 240, 'left', 0, {
    mac: { w: 120, h: 70 }, windows: { w: 130, h: 90 },
  });
  const snapped = snapDragged('mac', { x: rects.windows.x - 600, y: -100 }, rects);
  assert.equal(snapped.macPosition, 'left');
  assert.equal(snapped.displayOffset, -1);
});
