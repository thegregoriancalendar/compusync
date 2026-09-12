'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NativeAdapter,
  FallbackNativeAdapter,
  coordinateSpace,
  toNormalizedBounds,
  toPlatformBounds,
} = require('../native/index.cjs');

function bindingFor({ platformName, displays, cursor, windows = [] }) {
  class NativeSubstrate {
    constructor() {
      this.platformName = platformName;
      this.lastWarp = null;
      this.lastBounds = null;
      this.metricsCalls = 0;
    }
    displayMetrics() { this.metricsCalls += 1; return displays; }
    cursorPosition() { return cursor; }
    warpCursor(point) { this.lastWarp = point; }
    enumerateWindows() { return windows; }
    setWindowBounds(id, bounds) { this.lastBounds = { id, bounds }; }
  }
  return { NativeSubstrate };
}

test('negative and above-primary monitor origins normalize into one zero-based Windows desktop', () => {
  const displays = [
    { id: 'left', bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scale: 1, primary: false },
    { id: 'main', bounds: { x: 0, y: -900, width: 2560, height: 1440 }, scale: 1.25, primary: true },
  ];
  const space = coordinateSpace(displays, 'windows');
  assert.deepEqual(space, { x: -1920, y: -900, width: 4480, height: 1980, scale: 1 });
  const normalized = toNormalizedBounds({ x: -1800, y: -850, width: 800, height: 600 }, space);
  assert.deepEqual(normalized, { x: 120, y: 50, width: 800, height: 600 });
  assert.deepEqual(toPlatformBounds(normalized, space), { x: -1800, y: -850, width: 800, height: 600 });
});

test('Retina CoreGraphics points round-trip as normalized local device pixels', () => {
  const displays = [
    { id: 'left', bounds: { x: -1512, y: 0, width: 1512, height: 982 }, scale: 2, primary: false },
    { id: 'main', bounds: { x: 0, y: -100, width: 1512, height: 982 }, scale: 2, primary: true },
  ];
  const space = coordinateSpace(displays, 'darwin');
  assert.deepEqual(space, { x: -1512, y: -100, width: 3024, height: 1082, scale: 2 });
  const normalized = toNormalizedBounds({ x: -1400, y: 50, width: 800, height: 600 }, space);
  assert.deepEqual(normalized, { x: 224, y: 300, width: 1600, height: 1200 });
  assert.deepEqual(toPlatformBounds(normalized, space), { x: -1400, y: 50, width: 800, height: 600 });
});

test('native adapter hardens cursor coordinates without changing raw bounds used for CDP matching', () => {
  const displays = [
    { id: 'left', bounds: { x: -1512, y: 0, width: 1512, height: 982 }, scale: 2, primary: false },
    { id: 'main', bounds: { x: 0, y: 0, width: 1512, height: 982 }, scale: 2, primary: true },
  ];
  const rawWindow = { id: 'ax:1:0', bounds: { x: -1400, y: 50, width: 800, height: 600 } };
  const adapter = new NativeAdapter(bindingFor({
    platformName: 'darwin', displays, cursor: { x: -1400, y: 50 }, windows: [rawWindow],
  }), 'C:\\native\\compusync-native.node');

  assert.deepEqual(adapter.cursorPosition(), { x: 224, y: 100 });
  adapter.warpCursor({ x: 224, y: 100 });
  assert.deepEqual(adapter.substrate.lastWarp, { x: -1400, y: 50 });
  adapter.warpCursor({ x: 424, y: 300 });
  assert.equal(adapter.substrate.metricsCalls, 1, 'hot-path cursor transforms reuse display metrics');
  displays[0].bounds = { x: -1600, y: 0, width: 1600, height: 982 };
  adapter.refreshCoordinateSpace();
  assert.equal(adapter.substrate.metricsCalls, 2);
  adapter.warpCursor({ x: 224, y: 100 });
  assert.deepEqual(adapter.substrate.lastWarp, { x: -1488, y: 50 }, 'refresh picks up a hotplug topology');

  const [window] = adapter.enumerateWindows();
  assert.deepEqual(window.bounds, rawWindow.bounds);
  assert.deepEqual(window.normalizedBounds, { x: 400, y: 100, width: 1600, height: 1200 });
  assert.deepEqual(adapter.enumerateWindowsNormalized()[0].bounds, window.normalizedBounds);

  adapter.setWindowBoundsNormalized('ax:1:0', window.normalizedBounds);
  assert.deepEqual(adapter.substrate.lastBounds, { id: 'ax:1:0', bounds: rawWindow.bounds });
});

test('coordinate transforms reject malformed native geometry', () => {
  assert.throws(() => coordinateSpace([], 'windows'), /display/);
  assert.throws(() => coordinateSpace([{ bounds: { x: 0, y: 0, width: 0, height: 1 } }], 'windows'), /bounds/);
  const space = { x: 0, y: 0, scale: 1 };
  assert.throws(() => toNormalizedBounds({ x: NaN, y: 0, width: 1, height: 1 }, space), /finite/);
  assert.throws(() => toPlatformBounds({ x: 0, y: 0, width: -1, height: 1 }, space), /positive/);
  assert.throws(() => toPlatformBounds({ x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0, scale: 0 }), /space/);
  const fallback = new FallbackNativeAdapter();
  assert.deepEqual(fallback.toPlatformBounds({ x: -5, y: 2, width: 10, height: 20 }),
    { x: -5, y: 2, width: 10, height: 20 });
});
