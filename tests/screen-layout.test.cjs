'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  monitorGroup, arrangeDiagram, snapDragged, arrangementText,
} = require('../src/renderer/screen-layout.js');

test('screen layout editor preserves every monitor inside its computer group', () => {
  const group = monitorGroup({
    displays: [
      { id: 'left', bounds: { x: -1280, y: 0, width: 1280, height: 1024 } },
      { id: 'main', primary: true, bounds: { x: 0, y: -100, width: 1920, height: 1080 } },
    ],
  }, 1.6, { maxWidth: 160, maxHeight: 100 });
  assert.equal(group.monitors.length, 2);
  assert.equal(group.w, 160);
  assert.equal(group.h, 56.2);
  assert.deepEqual(group.monitors[0], {
    id: 'left', x: 0, y: 5, w: 64, h: 51.2, primary: false, index: 0,
  });
  assert.deepEqual(group.monitors[1], {
    id: 'main', x: 64, y: 0, w: 96, h: 54, primary: true, index: 1,
  });
});

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
