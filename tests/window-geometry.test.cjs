'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { destinationGeometry, inverseGeometry, physicalDisplaysFromMetrics, scaleForPlacements, seamAnchors } = require('../src/main/window-geometry.cjs');
const { normalizePlacement } = require('../src/main/virtualspace.cjs');
const { normalizeLayout } = require('../src/core/geometry.cjs');
const { placementForLayout, derivePairPlacements } = require('../src/main/runtime.cjs');

function placement(id, x, y, w, h, mmW, mmH) {
  return { machineId: id, origin: { x, y }, size: { w, h }, scale: id === 'mac' ? 2 : 1.25,
    physicalDisplays: [{ id: `${id}-display`, origin: { x: 0, y: 0 }, size: { w, h }, physicalSizeMm: { w: mmW, h: mmH } }] };
}
function near(actual, expected) {
  if (typeof expected === 'number') assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} should equal ${expected}`);
  else for (const key of Object.keys(expected)) near(actual[key], expected[key]);
}

test('physical inches, rather than monitor resolution ratios, determine window size', () => {
  const source = placement('win', 0, 0, 3000, 2000, 600, 400);
  const target = placement('mac', 3000, 500, 1500, 1000, 300, 200);
  const rect = { x: 2800, y: 800, w: 800, h: 600 };
  assert.equal(scaleForPlacements(source, target, rect), 1);
  assert.deepEqual(destinationGeometry(rect, source, target), rect);
  // Both have five VU/mm: the 800-wide window remains 160mm wide.
  assert.equal(destinationGeometry(rect, source, target).w / 5, 160);
});

for (const direction of ['left', 'right', 'top', 'bottom']) {
  test(`${direction} physical-size mapping keeps the seam fixed and reverses without shrinkage`, () => {
    const source = placement('win', 0, 0, 1000, 800, 254, 203.2);
    const origins = { left: [-600, 200], right: [1000, 200], top: [200, -400], bottom: [200, 800] };
    const [x, y] = origins[direction];
    const target = placement('mac', x, y, 600, 400, 76.2, 50.8);
    const rect = { x: direction === 'left' ? -50 : direction === 'right' ? 950 : 450,
      y: direction === 'top' ? -50 : direction === 'bottom' ? 750 : 350, w: 200, h: 100 };
    const anchors = seamAnchors(source, target, rect);
    near(scaleForPlacements(source, target, rect), 2);
    const rendered = destinationGeometry(rect, source, target);
    near(rendered.w, 400);
    near(rendered.h, 200);
    near(rendered.w / rendered.h, rect.w / rect.h);
    near(rendered.w / 200, rect.w / 100);
    near(destinationGeometry({ ...rect, x: anchors.source.x, y: anchors.source.y }, source, target, rect),
      { ...anchors.target, w: 400, h: 200 });
    near(inverseGeometry(rendered, source, target, rect), rect);
    near(destinationGeometry(rendered, target, source), rect);
    const moved = destinationGeometry({ ...rect, x: rect.x + 50, y: rect.y + 20 }, source, target, rect);
    near(moved.x - rendered.x, 100);
    near(moved.y - rendered.y, 40);
  });
}

test('original window geometry locks the physical source display during a long drag', () => {
  const source = placement('win', 0, 0, 3000, 1000, 600, 200);
  source.physicalDisplays = [
    { id: 'large', origin: { x: 0, y: 0 }, size: { w: 2000, h: 1000 }, physicalSizeMm: { w: 600, h: 300 } },
    { id: 'dense', origin: { x: 2000, y: 0 }, size: { w: 1000, h: 1000 }, physicalSizeMm: { w: 200, h: 200 } },
  ];
  const target = placement('mac', -1500, 0, 1500, 1000, 300, 200);
  const original = { x: 2100, y: 100, w: 600, h: 500 };
  assert.equal(scaleForPlacements(source, target, original), 1);
  const moved = { ...original, x: -800 };
  assert.equal(scaleForPlacements(source, target, moved), 1.5);
  assert.equal(destinationGeometry(moved, source, target, original).w, 600);
  near(inverseGeometry(destinationGeometry(moved, source, target, original), source, target, original), moved);
});

test('missing hardware dimensions preserve existing VU size and alignment', () => {
  const source = placement('win', 0, 0, 1920, 1080, 500, 281.25);
  const target = placement('mac', -1512, 200, 1512, 982, 300, 194.84);
  delete target.physicalDisplays;
  const rect = { x: -200, y: 300, w: 800, h: 600 };
  assert.equal(scaleForPlacements(source, target, rect), 1);
  assert.deepEqual(destinationGeometry(rect, source, target), rect);
  source.physicalDisplays[0].size.w = 1000;
  source.physicalDisplays.push({ id: 'unknown', origin: { x: 1000, y: 0 }, size: { w: 920, h: 1080 } });
  target.physicalDisplays = placement('mac', -1512, 200, 1512, 982, 300, 194.84).physicalDisplays;
  assert.equal(scaleForPlacements(source, target, { x: 1200, y: 100, w: 500, h: 500 }), 1,
    'a monitor without physical size cannot inherit another monitor density');
});

test('native physical measurements use existing normalized VU coordinates at mixed Windows and Retina scales', () => {
  const windows = physicalDisplaysFromMetrics([
    { id: 'external', bounds: { x: -3840, y: -963, width: 3840, height: 2160 }, physicalWidthMm: 600, physicalHeightMm: 337.5 },
    { id: 'laptop', bounds: { x: 0, y: 0, width: 1920, height: 1200 }, physicalWidthMm: 345, physicalHeightMm: 215.625 },
    { id: 'unknown', bounds: { x: 1920, y: 0, width: 1000, height: 1000 } },
  ], { x: -3840, y: -963, scale: 1 }, 1.25);
  assert.deepEqual(windows[0], { id: 'external', origin: { x: 0, y: 0 }, size: { w: 3072, h: 1728 }, physicalSizeMm: { w: 600, h: 337.5 } });
  assert.deepEqual(windows[1].origin, { x: 3072, y: 770.4000000000001 });
  assert.equal(windows.length, 3);
  assert.equal(windows[2].physicalSizeMm, undefined);
  assert.deepEqual(physicalDisplaysFromMetrics([
    { id: 'retina', bounds: { x: -1512, y: 0, width: 1512, height: 982 }, physicalWidthMm: 300, physicalHeightMm: 194.84 },
  ], { x: -1512, y: 0, scale: 2 }, 2)[0].size, { w: 1512, h: 982 });
});

test('hardware metadata survives layout validation, runtime placement, and negotiated layout positioning', () => {
  const physicalDisplays = placement('win', 0, 0, 1920, 1080, 500, 281.25).physicalDisplays;
  const layout = normalizeLayout({ revision: 1, platform: 'win32', edge: 'left', activeDisplayId: 'one',
    displays: [{ id: 'one', primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1.25 }],
    desktop: { widthVU: 1920, heightVU: 1080, scale: 1.25, physicalDisplays } });
  assert.deepEqual(layout.desktop.physicalDisplays, physicalDisplays);
  assert.deepEqual(placementForLayout('win', layout).physicalDisplays, physicalDisplays);
  const pair = derivePairPlacements({ win: layout, mac: { ...layout, platform: 'darwin' } }, 'win', 'mac', { macPosition: 'left' });
  assert.deepEqual(pair[1].physicalDisplays, physicalDisplays);
  const invalid = normalizePlacement({ ...pair[0], physicalDisplays: [{ ...physicalDisplays[0], physicalSizeMm: { w: 0, h: 100 } }] });
  assert.equal(invalid.physicalDisplays, undefined);
  assert.equal(normalizePlacement(pair[0]).physicalDisplays === physicalDisplays, false, 'validation returns independent metadata');
});
