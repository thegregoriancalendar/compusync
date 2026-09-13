'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { SharedInputRuntime, derivePairPlacements } = require('../src/main/runtime.cjs');

function layout(width, height, scaleFactor, platform) {
  return { platform, displays: [{ bounds: { x: 0, y: 0, width, height }, scaleFactor, primary: true }] };
}

class FakeSession extends EventEmitter {
  constructor() { super(); this.phase = 'connected'; this.sent = []; }
  sendPeer(message, options) { this.sent.push({ message, options }); return true; }
}

class FakeNative extends EventEmitter {
  constructor() { super(); this.available = true; this.calls = []; }
  call(name, ...args) { this.calls.push([name, ...args]); }
  configureAcceleration(value) { this.call('configureAcceleration', value); }
  startCursorCapture(value) { this.handlers = value; this.call('startCursorCapture'); }
  stopCursorCapture() { this.call('stopCursorCapture'); }
  setLinked(value) { this.call('setLinked', value); }
  heartbeat() {}
  releaseInputState() {}
  showCursor() {}
  hideCursor() {}
  parkCursor() {}
  releaseCursor() {}
  warpCursor() {}
  emergencyRecover() {}
  removeAllHooks() {}
  installRecoveryGuard() {}
}

const settings = {
  macPosition: 'left', displayOffset: 0,
  acceleration: { base: 1, threshold: 0.5, slope: 0.015 },
  edgeResistanceVU: 0, linked: true,
};

test('host layout configuration produces one adjacent, mixed-DPI VU pair', () => {
  const placements = derivePairPlacements({ win: layout(1920, 1080, 1.25, 'win32'), mac: layout(1440, 900, 2, 'darwin') }, 'win', 'mac', settings);
  assert.deepEqual(placements[0].size, { w: 1920, h: 1080 });
  assert.equal(placements[0].scale, 1.25);
  assert.equal(placements[1].origin.x, -1440);
  assert.equal(placements[1].origin.y, 90);
});

test('v3 desktop metrics override the active-display DIP size for multi-monitor cursor placement', () => {
  const win = { ...layout(2048, 1152, 1.25, 'win32'), desktop: { widthVU: 3584, heightVU: 1440, scale: 1.25 } };
  const mac = { ...layout(1512, 982, 2, 'darwin'), desktop: { widthVU: 2792, heightVU: 1080, scale: 2 } };
  const placements = derivePairPlacements({ win, mac }, 'win', 'mac', settings);
  assert.deepEqual(placements[0].size, { w: 3584, h: 1440 });
  assert.equal(placements[0].scale, 1.25);
  assert.deepEqual(placements[1].size, { w: 2792, h: 1080 });
});

test('top layout places Mac above Windows without using the Mac menu-bar edge', () => {
  const placements = derivePairPlacements(
    { win: layout(1920, 1080, 1.25, 'win32'), mac: layout(1440, 900, 2, 'darwin') },
    'win', 'mac', { ...settings, macPosition: 'top', displayOffset: .5 },
  );
  assert.equal(placements[1].origin.y, -900);
  assert.ok(placements[1].origin.x > 240);
});

test('join runtime builds distinct host and local screen placements while its transport peer is the host', () => {
  const session = new FakeSession();
  const native = new FakeNative();
  const runtime = new SharedInputRuntime({
    session, native, machineId: 'mac', hostId: 'win', peerId: 'win', settings,
    layouts: { win: layout(1920, 1080, 1, 'win32'), mac: layout(1440, 900, 2, 'darwin') },
  });
  runtime.start();
  assert.deepEqual(runtime.cursor.placements.map(({ machineId }) => machineId), ['win', 'mac']);
  assert.equal(runtime.cursor.linked, false);
  assert.equal(runtime.receive({ type: 'cursor.mode', linked: true }, 'win'), true);
  assert.equal(runtime.cursor.linked, true);
  assert.equal(runtime.receive({ type: 'heartbeat', t: 1 }, 'win'), true);
  assert.equal(runtime.receive({ type: 'heartbeat', t: 1 }, 'mac'), false);
  runtime.stop('session-stop');
});

test('runtime sanitizes traffic, agrees layout, links only with peer and native support, then recovers', () => {
  const session = new FakeSession();
  const native = new FakeNative();
  const modes = [];
  const runtime = new SharedInputRuntime({
    session, native, machineId: 'win', hostId: 'win', peerId: 'mac', settings,
    layouts: { win: layout(1920, 1080, 1, 'win32'), mac: layout(1440, 900, 2, 'darwin') },
    onModeChange: (linked, reason) => modes.push([linked, reason]),
  });
  runtime.start();
  assert.equal(runtime.cursor.linked, false);
  assert.equal(session.sent.some(({ message }) => message.type === 'cursor.mode' && message.linked), true);
  assert.equal(runtime.receive({ type: 'cursor.mode', linked: true }, 'mac'), true);
  assert.equal(runtime.cursor.linked, true);
  assert.equal(session.sent.some(({ message }) => message.type === 'layout.update'), true);
  assert.equal(runtime.receive({ type: 'cursor.delta', dx: Infinity, dy: 0, t: 1 }, 'mac'), false);
  assert.equal(runtime.receive({ type: 'heartbeat', t: 1 }, 'stranger'), false);
  runtime.watchdog.trigger('test-failure');
  assert.equal(runtime.cursor.linked, false);
  assert.deepEqual(modes.at(-1), [false, 'test-failure']);
  runtime.stop();
});

test('one peer-wide link request activates both runtimes and unlink propagates', () => {
  const unlinkedSettings = { ...settings, linked: false };
  const winSession = new FakeSession(), macSession = new FakeSession();
  const layouts = { win: layout(1920, 1080, 1, 'win32'), mac: layout(1440, 900, 2, 'darwin') };
  const win = new SharedInputRuntime({
    session: winSession, native: new FakeNative(), machineId: 'win', hostId: 'win', peerId: 'mac',
    settings: unlinkedSettings, layouts,
  });
  const mac = new SharedInputRuntime({
    session: macSession, native: new FakeNative(), machineId: 'mac', hostId: 'win', peerId: 'win',
    settings: unlinkedSettings, layouts,
  });
  win.start();
  mac.start();

  assert.equal(win.setLinked(true, 'user'), true);
  assert.equal(win.cursor.linked, false);
  const request = winSession.sent.at(-1).message;
  assert.deepEqual(request, { type: 'cursor.mode', linked: true });
  assert.equal(mac.receive(request, 'win'), true);
  assert.equal(mac.cursor.linked, true);
  assert.equal(win.receive(macSession.sent.at(-1).message, 'mac'), true);
  assert.equal(win.cursor.linked, true);

  assert.equal(mac.setLinked(false, 'user'), true);
  assert.equal(win.receive(macSession.sent.at(-1).message, 'mac'), true);
  assert.equal(win.cursor.linked, false);
  assert.equal(mac.receive(winSession.sent.at(-1).message, 'win'), true);
  assert.equal(mac.cursor.linked, false);
  win.stop();
  mac.stop();
});

test('dragged canonical screen layout applies identically when changed from the join laptop', () => {
  const unlinked = { ...settings, linked: false };
  const layouts = { win: layout(1920, 1080, 1, 'win32'), mac: layout(1440, 900, 2, 'darwin') };
  const hostSession = new FakeSession(), joinSession = new FakeSession();
  const saved = [];
  const host = new SharedInputRuntime({
    session: hostSession, native: new FakeNative(), machineId: 'win', hostId: 'win', peerId: 'mac',
    settings: unlinked, layouts, onSettingsChange: (value) => saved.push(value),
  });
  const join = new SharedInputRuntime({
    session: joinSession, native: new FakeNative(), machineId: 'mac', hostId: 'win', peerId: 'win',
    settings: unlinked, layouts,
  });
  host.start();
  join.start();

  join.updateSettings({ ...unlinked, macPosition: 'right', displayOffset: .4 });
  const proposal = joinSession.sent.findLast(({ message }) => message.type === 'cursor.layout').message;
  assert.equal(host.receive(proposal, 'mac'), true);
  assert.deepEqual(saved.at(-1), { macPosition: 'right', displayOffset: .4 });
  assert.equal(host.cursor.placementFor('mac').origin.x, 1920);
  const acknowledgement = hostSession.sent.findLast(({ message }) => message.type === 'cursor.layout').message;
  assert.equal(join.receive(acknowledgement, 'win'), true);
  assert.equal(join.settings.macPosition, 'right');
  host.stop();
  join.stop();
});

test('orderly session restart recovers native input without reporting a failure or forgetting desired linking', () => {
  const session = new FakeSession();
  const native = new FakeNative();
  const modes = [];
  const runtime = new SharedInputRuntime({
    session, native, machineId: 'win', hostId: 'win', peerId: 'mac', settings,
    layouts: { win: layout(1920, 1080, 1, 'win32'), mac: layout(1440, 900, 2, 'darwin') },
    onModeChange: (linked, reason) => modes.push([linked, reason]),
  });
  runtime.start();
  runtime.receive({ type: 'cursor.mode', linked: true }, 'mac');
  assert.equal(runtime.cursor.linked, true);
  const modesBeforeStop = modes.length;
  runtime.stop('session-restart');
  assert.equal(modes.length, modesBeforeStop);
  assert.equal(modes.some(([linked, reason]) => !linked && reason === 'session-restart'), false);
  assert.equal(runtime.desiredLinked, true);
  assert.equal(native.calls.some(([name]) => name === 'stopCursorCapture'), true);
  assert.equal(native.calls.some(([name, value]) => name === 'setLinked' && value === false), true);
});

test('production native owns fail-safe hotkeys without Electron registration conflicts', () => {
  const session = new FakeSession(), native = new FakeNative(), registered = [];
  const runtime = new SharedInputRuntime({
    session, native, machineId: 'win', hostId: 'win', peerId: 'mac', settings,
    layouts: { win: layout(1920, 1080, 1, 'win32'), mac: layout(1440, 900, 2, 'darwin') },
    globalShortcut: { register: (key) => { registered.push(key); return true; }, unregister() {} },
  });
  runtime.start();
  assert.deepEqual(registered, []);
  runtime.stop();
});

test('overlapping peer placements are repaired with a runtime warning', () => {
  const session = new FakeSession(), native = new FakeNative(), warnings = [];
  const runtime = new SharedInputRuntime({
    session, native, machineId: 'win', hostId: 'win', peerId: 'mac', settings,
    layouts: { win: layout(100, 100, 1, 'win32'), mac: layout(100, 100, 1, 'darwin') },
    logger: { warn: (message) => warnings.push(message) },
  });
  runtime.start();
  assert.equal(runtime.receive({ type: 'layout.update', placements: [
    { machineId: 'win', origin: { x: 0, y: 0 }, size: { w: 100, h: 100 }, scale: 1 },
    { machineId: 'mac', origin: { x: 50, y: 0 }, size: { w: 100, h: 100 }, scale: 1 },
  ] }, 'mac'), true);
  assert.match(warnings[0], /overlapped/);
  assert.equal(runtime.cursor.placementFor('mac').origin.x, 100);
  runtime.stop();
});

test('a denied macOS event tap reports persistent Input Monitoring remediation', () => {
  const session = new FakeSession(), native = new FakeNative(), notices = [];
  native.platformName = 'darwin';
  native.startCursorCapture = () => { throw new Error('CGEventTapCreate failed; grant Accessibility and Input Monitoring permissions'); };
  const runtime = new SharedInputRuntime({
    session, native, machineId: 'win', hostId: 'win', peerId: 'mac', settings,
    layouts: { win: layout(100, 100, 1, 'win32'), mac: layout(100, 100, 1, 'darwin') },
    onNotice: (notice) => notices.push(notice),
  });
  runtime.start();
  runtime.receive({ type: 'cursor.mode', linked: true }, 'mac');
  assert.equal(runtime.cursor.linked, false);
  assert.equal(notices[0].action, 'open-input-monitoring');
  assert.equal(notices[0].dismissible, false);
  runtime.stop();
});
