'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  normalizePlacement,
  toLocal,
  toVirtual,
  containsPoint,
  clampToPlacement,
  ownerAt,
  overlap,
  ensureNonOverlapping,
  layoutPair,
  boundingRect,
  placementFromDisplays,
  crossingTarget,
} = require('../src/main/virtualspace.cjs');
const {
  sanitizePeerMessage,
  sanitizeWindowDescriptor,
  policyForMessage,
} = require('../src/main/messages.cjs');
const { CursorController, accelerateDelta } = require('../src/main/cursor.cjs');
const { KeyboardRouter } = require('../src/main/keyboard.cjs');
const { RecoveryWatchdog } = require('../src/main/watchdog.cjs');
const { routePeerInput, bindPeerInput } = require('../src/main/input-runtime.cjs');
const {
  DEFAULT_LINK_HOTKEY,
  DEFAULT_OWNERSHIP_HOTKEY,
  registerCursorHotkeys,
} = require('../src/main/hotkeys.cjs');

const placement = (machineId, x, y, w, h, scale = 1) => ({ machineId, origin: { x, y }, size: { w, h }, scale });

function mockNative() {
  const calls = [];
  return {
    calls,
    showCursor: () => calls.push(['show']),
    hideCursor: () => calls.push(['hide']),
    parkCursor: () => calls.push(['park']),
    releaseCursor: () => calls.push(['release']),
    warpCursor: (point) => calls.push(['warp', point]),
    assumeInputState: (buttons, modifiers) => calls.push(['assume', buttons, modifiers]),
    synthesizeButton: (button, down) => calls.push(['button', button, down]),
    synthesizeKey: (code, down, modifiers) => calls.push(['key', code, down, modifiers]),
    releaseInputState: () => calls.push(['release-input']),
  };
}

test('virtual-space conversion preserves VU across differing DPI scales', () => {
  const mac = placement('mac', -1440, 100, 1440, 900, 2);
  const point = { x: -720.25, y: 450.5 };
  assert.deepEqual(toLocal(point, mac), { x: 1439.5, y: 701 });
  assert.deepEqual(toVirtual(toLocal(point, mac), mac), point);
  assert.equal(containsPoint(mac, { x: -1e-7, y: 100 }), true);
  assert.equal(containsPoint(mac, { x: 0, y: 100 }), false);
  assert.equal(ownerAt(point, [mac]), 'mac');
  assert.deepEqual(clampToPlacement({ x: 5, y: -5 }, mac), { x: -1e-6, y: 100 });
  assert.equal(normalizePlacement({ ...mac, scale: 0 }), null);
  assert.equal(normalizePlacement(placement('far-away', 1e300, 0, 10, 10)), null);
});

test('pair layout centers screens, applies offset, and never permits overlap', () => {
  const first = placement('windows', 0, 0, 1920, 1080, 1.25);
  const second = placement('mac', 0, 0, 1440, 900, 2);
  const [windows, mac] = layoutPair(first, second, { screenSide: 'right', verticalOffsetVU: 40 });
  assert.deepEqual(windows.origin, { x: 0, y: 0 });
  assert.deepEqual(mac.origin, { x: 1920, y: 130 });
  assert.equal(overlap(windows, mac), null);
  const warnings = [];
  const fixed = ensureNonOverlapping([
    placement('a', 0, 0, 100, 100),
    placement('b', 10, 20, 20, 20),
  ], { warn: (message) => warnings.push(message) });
  assert.equal(fixed[1].origin.x, 100);
  assert.equal(overlap(fixed[0], fixed[1]), null);
  assert.equal(warnings.length, 1);
  assert.throws(() => layoutPair(first, second, { screenSide: 'top' }), /shared edge/);
});

test('a multi-monitor desktop becomes one logical placement', () => {
  const displays = [
    { bounds: { x: -1280, y: 0, width: 1280, height: 1024 }, scaleFactor: 1 },
    { bounds: { x: 0, y: -100, width: 1920, height: 1080 }, scaleFactor: 1.5, primary: true },
  ];
  assert.deepEqual(boundingRect(displays), { x: -1280, y: -100, width: 3200, height: 1124 });
  assert.deepEqual(placementFromDisplays('pc', displays, { origin: { x: 20, y: 30 } }),
    placement('pc', 20, 30, 3200, 1124, 1.5));
});

test('crossing finds left, right and bottom peers but never the top edge', () => {
  const a = placement('a', 0, 0, 100, 100);
  const right = placement('right', 100, 20, 100, 60);
  const left = placement('left', -100, 10, 100, 80);
  const bottom = placement('bottom', 10, 100, 80, 80);
  assert.equal(crossingTarget(a, { x: 101, y: 2 }, [a, right]).placement.machineId, 'right');
  assert.equal(crossingTarget(a, { x: -1, y: 2 }, [a, left]).edge, 'left');
  assert.equal(crossingTarget(a, { x: 2, y: 101 }, [a, bottom]).edge, 'bottom');
  assert.equal(crossingTarget(a, { x: 2, y: -1 }, [a, right]), null);
});

test('message validation classifies realtime traffic and bounds input', () => {
  assert.deepEqual(policyForMessage('cursor.delta'), { reliable: false, ordered: false, priority: 'realtime' });
  assert.deepEqual(policyForMessage('cursor.handoff'), { reliable: true, ordered: true, priority: 'control' });
  assert.deepEqual(sanitizePeerMessage({ type: 'cursor.mode', linked: true, junk: true }),
    { type: 'cursor.mode', linked: true });
  assert.equal(sanitizePeerMessage({ type: 'cursor.mode', linked: 'yes' }), null);
  assert.deepEqual(sanitizePeerMessage({ type: 'cursor.delta', dx: 2, dy: -1, t: 8, junk: true }),
    { type: 'cursor.delta', dx: 2, dy: -1, t: 8 });
  assert.equal(sanitizePeerMessage({ type: 'cursor.delta', dx: Infinity, dy: 0, t: 1 }), null);
  assert.equal(sanitizePeerMessage({ type: 'key.event', code: -1, down: true, modifiers: 0 }), null);
  assert.equal(sanitizePeerMessage({ type: 'not-real' }), null);
  const corrected = sanitizePeerMessage({ type: 'layout.update', placements: [
    placement('a', 0, 0, 100, 100), placement('b', 20, 20, 100, 100),
  ] });
  assert.equal(corrected.placements[1].origin.x, 100);
});

function validDescriptor() {
  return {
    schemaVersion: 1,
    id: 'stable-id_1',
    adapterId: 'chrome',
    origin: 'windows-1',
    capturedAt: 123,
    geometryVU: { x: 20, y: -10, w: 900, h: 600 },
    state: 'normal',
    payload: {
      activeIdx: 1,
      tabs: [
        { url: 'https://example.com/a', title: 'A', pinned: true, index: 0 },
        { url: 'http://localhost/b', title: 'B', pinned: false, index: 1, history: { currentIndex: 1, entries: ['https://example.com/1', 'https://example.com/2'] } },
      ],
    },
  };
}

test('window descriptors reject unsafe schemes, excessive tabs and malformed history', () => {
  assert.deepEqual(sanitizeWindowDescriptor(validDescriptor()), validDescriptor());
  const unsafe = validDescriptor();
  unsafe.payload.tabs[0].url = 'file:///etc/passwd';
  assert.equal(sanitizeWindowDescriptor(unsafe), null);
  const excessive = validDescriptor();
  excessive.payload.tabs = Array.from({ length: 201 }, (_, index) => ({ url: `https://example.com/${index}`, title: '', pinned: false, index }));
  excessive.payload.activeIdx = 0;
  assert.equal(sanitizeWindowDescriptor(excessive), null);
  const history = validDescriptor();
  history.payload.tabs[1].history.currentIndex = 9;
  assert.equal(sanitizeWindowDescriptor(history), null);
  const allTabHistory = validDescriptor();
  allTabHistory.payload.tabs[0].history = { currentIndex: 0, entries: ['https://example.com/before'] };
  assert.deepEqual(sanitizeWindowDescriptor(allTabHistory), allTabHistory);
  const oversizedGeometry = validDescriptor();
  oversizedGeometry.geometryVU = { x: -1e9, y: 1e9, w: 1e9, h: .5 };
  assert.deepEqual(sanitizeWindowDescriptor(oversizedGeometry).geometryVU,
    { x: -65536, y: 65536, w: 65536, h: 1 });
  const multibyteUrl = validDescriptor();
  multibyteUrl.payload.tabs[0].url = `https://example.com/${'é'.repeat(4100)}`;
  assert.equal(sanitizeWindowDescriptor(multibyteUrl), null);
});

test('shared acceleration uses the specified two-segment curve', () => {
  assert.deepEqual(accelerateDelta(3, 4, 10, { base: 2, threshold: 1, slope: .5 }), { dx: 6, dy: 8, gain: 2 });
  assert.deepEqual(accelerateDelta(6, 8, 5, { base: 1, threshold: 1, slope: .5 }), { dx: 9, dy: 12, gain: 1.5 });
});

test('the owner sums local and remote deltas and edge resistance delays handoff', () => {
  const aNative = mockNative();
  const outbound = [];
  const spaces = [placement('a', 0, 0, 100, 100), placement('b', 100, 20, 100, 60, 2)];
  const cursor = new CursorController({
    machineId: 'a', placements: spaces, initialPosition: { x: 90, y: 10 }, ownerMachineId: 'a',
    native: aNative, send: (message) => outbound.push(message), edgeResistanceVU: 5,
    acceleration: { base: 1, threshold: 1000, slope: 0 },
  });
  cursor.setModifiers(3);
  cursor.localButton('left', true);
  cursor.localDelta(12, 0, 1, 1);
  cursor.flush(2);
  assert.equal(cursor.ownerMachineId, 'a');
  assert.ok(cursor.virtualCursor.x > 99.99);
  cursor.receive({ type: 'cursor.delta', dx: 10, dy: 0, t: 3 }, 'b');
  cursor.flush(4);
  assert.equal(cursor.ownerMachineId, 'b');
  assert.ok(Math.abs(cursor.virtualCursor.x - 107) < 1e-5);
  assert.equal(cursor.virtualCursor.y, 20);
  const handoff = outbound.find((message) => message.type === 'cursor.handoff');
  assert.equal(handoff.type, 'cursor.handoff');
  assert.ok(Math.abs(handoff.x - 107) < 1e-5);
  assert.deepEqual({ y: handoff.y, buttons: handoff.buttons, modifiers: handoff.modifiers }, { y: 20, buttons: 1, modifiers: 3 });
  assert.deepEqual(aNative.calls.slice(-3), [['release-input'], ['hide'], ['park']]);
});

test('a drag disables resistance and the destination assumes held input state', () => {
  const spaces = [placement('a', 0, 0, 100, 100), placement('b', 100, 0, 100, 100, 2)];
  let handoff;
  const source = new CursorController({
    machineId: 'a', placements: spaces, initialPosition: { x: 99, y: 50 }, ownerMachineId: 'a',
    send: (message) => { if (message.type === 'cursor.handoff') handoff = message; }, edgeResistanceVU: 50,
    acceleration: { base: 1, threshold: 1000, slope: 0 },
  });
  source.setDragging(true);
  source.localButton('left', true);
  source.setModifiers(7);
  source.localDelta(2, 0, 1);
  source.flush();
  assert.equal(source.ownerMachineId, 'b');
  const native = mockNative();
  const destination = new CursorController({
    machineId: 'b', placements: spaces, initialPosition: { x: 99, y: 50 }, ownerMachineId: 'a', native,
  });
  assert.equal(destination.receive(handoff, 'a'), true);
  assert.equal(destination.isOwner(), true);
  assert.deepEqual(native.calls, [
    ['release'], ['warp', { x: 2, y: 100 }], ['show'], ['assume', 1, 7],
  ]);
});

test('the source trackpad drives a round trip after ownership moves to its peer', () => {
  const spaces = [placement('mac', 0, 0, 100, 100), placement('win', 100, 0, 100, 100)];
  let now = 0;
  let mac;
  const win = new CursorController({
    machineId: 'win', placements: spaces, initialPosition: { x: 99, y: 50 }, ownerMachineId: 'mac',
    native: mockNative(), now: () => now,
    send: (message) => mac.receive(message, 'win'),
    acceleration: { base: 1, threshold: 1000, slope: 0 },
  });
  mac = new CursorController({
    machineId: 'mac', placements: spaces, initialPosition: { x: 99, y: 50 }, ownerMachineId: 'mac',
    native: mockNative(), now: () => now,
    send: (message) => win.receive(message, 'mac'),
    acceleration: { base: 1, threshold: 1000, slope: 0 },
  });

  mac.localDelta(2, 0, 1, now);
  mac.flush(now);
  assert.equal(mac.ownerMachineId, 'win');
  assert.equal(win.ownerMachineId, 'win');

  now += 10;
  mac.localDelta(-4, 0, 1, now);
  win.flush(now);
  assert.equal(mac.ownerMachineId, 'mac');
  assert.equal(win.ownerMachineId, 'mac');
});

test('top movement clamps, non-owner follows authority, and ownership hotkey preserves relative position', () => {
  const spaces = [placement('a', 0, 0, 100, 100), placement('b', 100, 0, 200, 50)];
  const outbound = [];
  const cursor = new CursorController({
    machineId: 'a', placements: spaces, initialPosition: { x: 25, y: 25 }, ownerMachineId: 'a',
    send: (message) => outbound.push(message), acceleration: { base: 1, threshold: 1000, slope: 0 },
  });
  cursor.localDelta(0, -50, 1);
  cursor.flush();
  assert.equal(cursor.virtualCursor.y, 0);
  cursor.virtualCursor = { x: 25, y: 25 };
  assert.equal(cursor.toggleOwnership(), true);
  assert.deepEqual(cursor.virtualCursor, { x: 150, y: 12.5 });
  const follower = new CursorController({
    machineId: 'a', placements: spaces, initialPosition: { x: 150, y: 12.5 },
    ownerMachineId: 'b', send: () => true,
  });
  assert.equal(follower.receive({ type: 'cursor.position', x: 250, y: 40, t: 1 }, 'b'), true);
  assert.deepEqual(follower.virtualCursor, { x: 250, y: 40 });
  assert.equal(follower.receive({ type: 'cursor.position', x: 1, y: 1, t: 2 }, 'stranger'), false);
  assert.equal(follower.toggleOwnership(), true);
  assert.equal(follower.ownerMachineId, 'a');
});

test('ownership hotkey on the non-owner updates both peers without split brain', () => {
  const spaces = [placement('a', 0, 0, 100, 100), placement('b', 100, 0, 100, 100)];
  let claim;
  const oldOwnerNative = mockNative();
  const oldOwner = new CursorController({
    machineId: 'a', placements: spaces, initialPosition: { x: 25, y: 40 },
    ownerMachineId: 'a', native: oldOwnerNative,
  });
  const claimant = new CursorController({
    machineId: 'b', placements: spaces, initialPosition: { x: 25, y: 40 },
    ownerMachineId: 'a', send: (message) => { claim = message; },
  });
  assert.equal(claimant.toggleOwnership(), true);
  assert.equal(claimant.ownerMachineId, 'b');
  assert.equal(oldOwner.receive(claim, 'b'), true);
  assert.equal(oldOwner.ownerMachineId, 'b');
  assert.equal(oldOwner.isOwner(), false);
  assert.deepEqual(oldOwnerNative.calls.slice(-3), [['release-input'], ['hide'], ['park']]);
});

test('failed reliable handoff keeps ownership and invokes fail-closed recovery', () => {
  const native = mockNative();
  const failures = [];
  const cursor = new CursorController({
    machineId: 'a', placements: [placement('a', 0, 0, 100, 100), placement('b', 100, 0, 100, 100)],
    initialPosition: { x: 99, y: 50 }, ownerMachineId: 'a', native,
    acceleration: { base: 1, threshold: 1000, slope: 0 }, send: () => false,
    onFailure: (reason, error) => failures.push([reason, error.message]),
  });
  cursor.localDelta(2, 0, 1);
  cursor.flush();
  assert.equal(cursor.ownerMachineId, 'a');
  assert.deepEqual(cursor.virtualCursor, { x: 99, y: 50 });
  assert.equal(cursor.linked, false);
  assert.equal(native.calls.some(([name]) => name === 'hide' || name === 'park'), false);
  assert.match(failures[0][0], /handoff-send-failed/);
});

test('native exceptions invoke recovery without escaping the input loop', () => {
  const calls = [], failures = [];
  const native = {
    warpCursor: () => { throw new Error('warp failed'); },
    setLinked: (value) => calls.push(['linked', value]),
    showCursor: () => calls.push(['show']), releaseCursor: () => calls.push(['release']),
    stopCursorCapture: () => calls.push(['stop']), releaseInputState: () => calls.push(['release-input']),
  };
  const cursor = new CursorController({
    machineId: 'a', placements: [placement('a', 0, 0, 100, 100)],
    initialPosition: { x: 10, y: 10 }, native, send: () => true,
    acceleration: { base: 1, threshold: 1000, slope: 0 },
    onFailure: (reason) => failures.push(reason),
  });
  cursor.localDelta(1, 0, 1);
  assert.doesNotThrow(() => cursor.flush());
  assert.equal(cursor.linked, false);
  assert.deepEqual(failures, ['native-warpCursor-failed']);
  assert.deepEqual(calls, [['linked', false], ['show'], ['release'], ['stop'], ['release-input']]);
});

test('button reconciliation synthesizes only aggregate transitions and releases on handoff', () => {
  const native = mockNative();
  const sent = [];
  const cursor = new CursorController({
    machineId: 'a', placements: [placement('a', 0, 0, 100, 100), placement('b', 100, 0, 100, 100)],
    initialPosition: { x: 99, y: 50 }, ownerMachineId: 'a', native,
    acceleration: { base: 1, threshold: 1000, slope: 0 }, send: (message) => { sent.push(message); return true; },
  });
  cursor.localButton('left', true);
  cursor.receive({ type: 'cursor.button', button: 'left', down: true }, 'b');
  assert.equal(native.calls.some((call) => call[0] === 'button'), false);
  cursor.localButton('left', false);
  assert.deepEqual(native.calls.at(-1), ['button', 'left', true]);
  cursor.receive({ type: 'cursor.button', button: 'left', down: false }, 'b');
  assert.deepEqual(native.calls.at(-1), ['button', 'left', false]);
  cursor.receive({ type: 'cursor.button', button: 'right', down: true }, 'b');
  cursor.localDelta(2, 0, 1);
  cursor.flush();
  assert.equal(cursor.ownerMachineId, 'b');
  assert.deepEqual(native.calls.slice(-3), [['release-input'], ['hide'], ['park']]);
});

test('handoff into a locally held button synthesizes only the remote remainder', () => {
  const native = mockNative();
  const cursor = new CursorController({
    machineId: 'b', placements: [placement('a', 0, 0, 100, 100), placement('b', 100, 0, 100, 100)],
    initialPosition: { x: 50, y: 50 }, ownerMachineId: 'a', native, send: () => true,
  });
  cursor.localButton('left', true);
  cursor.receive({ type: 'cursor.button', button: 'right', down: true }, 'a');
  assert.equal(cursor.receive({ type: 'cursor.handoff', x: 110, y: 50, buttons: 3, modifiers: 0 }, 'a'), true);
  assert.deepEqual(native.calls.at(-1), ['assume', 2, 0]);
});

test('cursor deltas are coalesced below 250 messages per second', () => {
  let now = 0;
  const deltas = [];
  const cursor = new CursorController({
    machineId: 'a', placements: [placement('a', 0, 0, 1000, 1000)],
    initialPosition: { x: 100, y: 100 }, ownerMachineId: 'a', now: () => now,
    acceleration: { base: 1, threshold: 1000, slope: 0 },
    send: (message) => { if (message.type === 'cursor.delta') deltas.push(message); return true; },
  });
  for (let index = 0; index < 100; index += 1) cursor.localDelta(1, 0, 1, index);
  assert.equal(deltas.length, 1);
  now = 4.9;
  cursor.flush(now);
  assert.equal(deltas.length, 1);
  now = 5;
  cursor.flush(now);
  assert.equal(deltas.length, 2);
  assert.equal(deltas[1].dx, 99);
});

test('native capture deltas are not accelerated twice', () => {
  let capture, message;
  const native = mockNative();
  native.configureAcceleration = (curve) => native.calls.push(['curve', curve]);
  native.startCursorCapture = (handlers) => { capture = handlers; };
  native.stopCursorCapture = () => {};
  const cursor = new CursorController({
    machineId: 'a', placements: [placement('a', 0, 0, 100, 100)],
    initialPosition: { x: 10, y: 10 }, native,
    acceleration: { base: 10, threshold: 0, slope: 10 },
    send: (value) => { if (value.type === 'cursor.delta') message = value; },
  });
  cursor.start();
  capture.onDelta(3, 4, 1, 99);
  cursor.stop();
  assert.deepEqual(message, { type: 'cursor.delta', dx: 3, dy: 4, t: 99 });
  assert.equal(native.calls.some((call) => call[0] === 'curve'), true);
});

test('keyboard follows cursor and elevated-window notice appears only once', async () => {
  const sent = [], notices = [];
  const native = mockNative();
  native.isForegroundElevated = () => true;
  const cursor = { linked: true, owner: false, isOwner() { return this.owner; } };
  const keyboard = new KeyboardRouter({ cursor, native, send: (message) => sent.push(message), notice: (message) => notices.push(message) });
  assert.equal(keyboard.localKey(65, true, 2), true);
  assert.deepEqual(sent, [{ type: 'key.event', code: 65, down: true, modifiers: 2 }]);
  cursor.owner = true;
  assert.equal(keyboard.localKey(65, false, 0), false);
  assert.equal(keyboard.receive({ type: 'key.event', code: 66, down: true, modifiers: 1 }), true);
  assert.equal(keyboard.receive({ type: 'key.event', code: 66, down: false, modifiers: 0 }), true);
  assert.equal(notices.length, 1);
  assert.deepEqual(native.calls.slice(-2), [['key', 66, true, 1], ['key', 66, false, 0]]);
  keyboard.releaseAll();
  assert.deepEqual(native.calls.at(-1), ['release-input']);
});

test('watchdog runs every recovery step even when one native operation fails', () => {
  let now = 1000;
  const calls = [];
  const cursor = { linked: true, setLinked: (linked, reason) => { cursor.linked = linked; calls.push(['linked', linked, reason]); } };
  const watchdog = new RecoveryWatchdog({
    now: () => now,
    native: {
      emergencyRecover: () => { calls.push(['emergency']); throw new Error('guard failed'); },
      showCursor: () => calls.push(['show']), releaseCursor: () => calls.push(['release']),
      removeAllHooks: () => calls.push(['hooks']), releaseInputState: () => calls.push(['input']),
    },
    cursor,
    keyboard: { releaseAll: () => calls.push(['keyboard']) },
    drag: { restoreOnScreen: (reason) => calls.push(['drag', reason]) },
    onUnlinked: (reason) => calls.push(['unlinked', reason]),
    heartbeatTimeoutMs: 2000,
  });
  watchdog.setPeerConnected(true);
  now = 3001;
  assert.equal(watchdog.check(), false);
  assert.deepEqual(calls, [
    ['emergency'], ['show'], ['release'], ['hooks'], ['keyboard'], ['input'],
    ['drag', 'heartbeat-timeout'], ['linked', false, 'heartbeat-timeout'], ['unlinked', 'heartbeat-timeout'],
  ]);
  assert.equal(watchdog.trigger('again'), false);
});

test('peer heartbeat continues while local cursors are unlinked', () => {
  const sent = [], nativeCalls = [];
  const cursor = { linked: false };
  const watchdog = new RecoveryWatchdog({
    now: () => 1234,
    cursor,
    native: { heartbeat: () => nativeCalls.push('heartbeat') },
    send: (message) => sent.push(message),
  });
  watchdog.setPeerConnected(true);

  watchdog.pulse();
  assert.deepEqual(sent, [{ type: 'heartbeat', t: 1234 }]);
  assert.deepEqual(nativeCalls, []);

  cursor.linked = true;
  watchdog.pulse();
  assert.deepEqual(nativeCalls, ['heartbeat']);
});

test('hotkeys toggle fail-safe link mode and jump ownership', () => {
  assert.equal(DEFAULT_LINK_HOTKEY, 'CommandOrControl+Shift+U');
  assert.equal(DEFAULT_OWNERSHIP_HOTKEY, 'CommandOrControl+Shift+Y');
  const handlers = new Map(), unregistered = [];
  const shortcut = {
    register: (key, handler) => { handlers.set(key, handler); return true; },
    unregister: (key) => unregistered.push(key),
  };
  const cursor = { linked: true, ownerMachineId: 'a', setLinked(value) { this.linked = value; }, toggleOwnership() { this.ownerMachineId = 'b'; return true; } };
  let recoveries = 0, arms = 0;
  const binding = registerCursorHotkeys(shortcut, {
    cursor,
    watchdog: { trigger: () => { recoveries += 1; cursor.linked = false; }, arm: () => { arms += 1; } },
  });
  handlers.get(DEFAULT_LINK_HOTKEY)();
  assert.equal(cursor.linked, false);
  assert.equal(recoveries, 1);
  handlers.get(DEFAULT_LINK_HOTKEY)();
  assert.equal(cursor.linked, true);
  assert.equal(arms, 1);
  handlers.get(DEFAULT_OWNERSHIP_HOTKEY)();
  assert.equal(cursor.ownerMachineId, 'b');
  binding.dispose();
  assert.deepEqual(unregistered, [DEFAULT_LINK_HOTKEY, DEFAULT_OWNERSHIP_HOTKEY]);
});

test('addon panic event and suspend integration enter unlinked mode', () => {
  const native = new EventEmitter();
  const cursor = { linked: true, setLinked(value) { this.linked = value; } };
  const watchdog = new RecoveryWatchdog({ native, cursor });
  watchdog.start();
  native.emit('panic', new Error('native failure'));
  assert.equal(cursor.linked, false);
  watchdog.stop({ recover: false });

  const power = new EventEmitter();
  cursor.linked = true;
  const wakeCalls = [];
  const suspendWatchdog = new RecoveryWatchdog({
    cursor,
    native: {
      setLinked: (value) => wakeCalls.push(['linked', value]),
      showCursor: () => wakeCalls.push(['show']),
      releaseCursor: () => wakeCalls.push(['release']),
      releaseInputState: () => wakeCalls.push(['input']),
    },
    onResume: () => wakeCalls.push(['layout']),
  });
  suspendWatchdog.bindPowerMonitor(power);
  power.emit('suspend');
  assert.equal(cursor.linked, false);
  wakeCalls.length = 0;
  power.emit('resume');
  assert.deepEqual(wakeCalls, [['linked', false], ['show'], ['release'], ['input'], ['layout']]);
  assert.equal(cursor.linked, false);
  suspendWatchdog.stop({ recover: false });
});

test('async drag recovery failures are contained by the watchdog', async () => {
  const watchdog = new RecoveryWatchdog({
    cursor: { linked: true, setLinked() {} },
    drag: { async restoreOnScreen() { throw new Error('Chrome quit'); } },
  });
  let recovered;
  watchdog.on('recovered', (event) => { recovered = event; });
  assert.equal(watchdog.trigger('chrome-quit'), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recovered.errors[0].message, 'Chrome quit');
});

test('input runtime routes only M0 messages and can be detached', () => {
  const received = [];
  const components = {
    cursor: { receive: (message, peer) => { received.push(['cursor', message.type, peer]); return true; }, setPlacements: (value) => received.push(['layout', value.length]) },
    keyboard: { receive: (message) => { received.push(['key', message.code]); return true; } },
    watchdog: { receiveHeartbeat: (message) => { received.push(['heartbeat', message.t]); return true; } },
  };
  assert.equal(routePeerInput(components, { type: 'cursor.delta' }, 'peer'), true);
  assert.equal(routePeerInput(components, { type: 'key.event', code: 4 }), true);
  assert.equal(routePeerInput(components, { type: 'heartbeat', t: 8 }), true);
  assert.equal(routePeerInput(components, { type: 'layout.update', placements: [placement('a', 0, 0, 1, 1)] }), true);
  assert.equal(routePeerInput(components, { type: 'window.ready' }), false);
  const emitter = new EventEmitter();
  const unbind = bindPeerInput(emitter, components);
  emitter.emit('peer-message', { type: 'cursor.button' }, 'b');
  unbind();
  emitter.emit('peer-message', { type: 'cursor.button' }, 'b');
  assert.deepEqual(received.at(-1), ['cursor', 'cursor.button', 'b']);
  assert.doesNotThrow(() => routePeerInput(components, { type: null }, 'peer'));
  assert.equal(routePeerInput(components, { type: null }, 'peer'), false);
  components.cursor.setPlacements = () => { throw new TypeError('bad layout'); };
  assert.doesNotThrow(() => routePeerInput(components, { type: 'layout.update', placements: null }, 'peer'));
  assert.equal(routePeerInput(components, { type: 'layout.update', placements: null }, 'peer'), false);
});
