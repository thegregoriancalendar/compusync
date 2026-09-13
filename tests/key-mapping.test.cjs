'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CursorController } = require('../src/main/cursor.cjs');
const { KeyboardRouter } = require('../src/main/keyboard.cjs');
const { mapModifiers, mapKeyEvent } = require('../src/main/key-mapping.cjs');
const { SharedInputRuntime } = require('../src/main/runtime.cjs');

test('Windows Control becomes Mac Command and Windows key becomes Mac Control', () => {
  assert.equal(mapModifiers(2, 'win32', 'darwin'), 8);
  assert.equal(mapModifiers(8, 'windows', 'macos'), 2);
  assert.equal(mapModifiers(1 | 2 | 4, 'win32', 'darwin'), 1 | 8 | 4);
  assert.deepEqual(mapKeyEvent({ type: 'key.event', code: 0xE0, down: true, modifiers: 2 }, 'win32', 'darwin'), {
    type: 'key.event', code: 0xE3, down: true, modifiers: 8,
  });
  assert.deepEqual(mapKeyEvent({ type: 'key.event', code: 0xE7, down: false, modifiers: 0 }, 'win32', 'darwin'), {
    type: 'key.event', code: 0xE4, down: false, modifiers: 0,
  });
});

test('mapping is not applied locally or from Mac to Windows', () => {
  const event = { type: 'key.event', code: 0xE3, down: true, modifiers: 8 };
  assert.equal(mapKeyEvent(event, 'darwin', 'win32'), event);
  assert.equal(mapKeyEvent(event, 'win32', 'win32'), event);
  assert.equal(mapModifiers(8, 'darwin', 'win32'), 8);
});

test('keyboard injection maps keys but retains raw source state for a return handoff', () => {
  const calls = [];
  const cursor = {
    linked: true,
    modifiers: 0,
    isOwner: () => true,
    setModifiers(value) { this.modifiers = value; },
  };
  const keyboard = new KeyboardRouter({
    cursor,
    native: { synthesizeKey: (...args) => calls.push(args), releaseInputState() {} },
    mapRemoteEvent: (message) => mapKeyEvent(message, 'win32', 'darwin'),
  });
  assert.equal(keyboard.receive({ type: 'key.event', code: 0xE0, down: true, modifiers: 2 }), true);
  assert.deepEqual(calls, [[0xE3, true, 8]]);
  assert.equal(cursor.modifiers, 2);
  keyboard.releaseAll();
  assert.deepEqual(calls.at(-1), [0xE3, false, 0]);
  assert.equal(cursor.modifiers, 0);
});

test('cursor handoff maps held modifiers only for native injection', () => {
  const calls = [];
  const native = Object.fromEntries(['releaseCursor', 'warpCursor', 'showCursor', 'parkCursor']
    .map((name) => [name, (...args) => calls.push([name, ...args])]));
  native.assumeInputState = (...args) => calls.push(['assumeInputState', ...args]);
  const cursor = new CursorController({
    machineId: 'mac', ownerMachineId: 'win', native, linked: true,
    placements: [
      { machineId: 'mac', origin: { x: 0, y: 0 }, size: { w: 100, h: 100 }, scale: 1 },
      { machineId: 'win', origin: { x: 100, y: 0 }, size: { w: 100, h: 100 }, scale: 1 },
    ],
    mapRemoteModifiers: (modifiers) => mapModifiers(modifiers, 'win32', 'darwin'),
  });
  assert.equal(cursor.receive({
    type: 'cursor.handoff', x: 50, y: 50, buttons: 0, modifiers: 2,
  }, 'win'), true);
  assert.equal(cursor.state().modifiers, 2);
  assert.deepEqual(calls.at(-1), ['assumeInputState', 0, 8]);
});

test('Mac runtime derives the mapping from the two reported laptop platforms', () => {
  const session = new EventEmitter();
  session.phase = 'connected';
  session.sendPeer = () => true;
  const calls = [];
  const runtime = new SharedInputRuntime({
    session,
    native: { available: true, platformName: 'macos', synthesizeKey: (...args) => calls.push(args) },
    machineId: 'mac', hostId: 'win', peerId: 'win',
    settings: {
      macPosition: 'left', displayOffset: 0, linked: false, edgeResistanceVU: 0,
      acceleration: { base: 1, threshold: .5, slope: .015 },
    },
    layouts: {
      win: { platform: 'win32', displays: [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, primary: true }] },
      mac: { platform: 'darwin', displays: [{ bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2, primary: true }] },
    },
  });
  runtime.cursor.linked = true;
  runtime.cursor.ownerMachineId = 'mac';
  assert.equal(runtime.receive({
    type: 'key.event', code: 0x06, down: true, modifiers: 2,
  }, 'win'), true);
  assert.deepEqual(calls, [[0x06, true, 8]]);
});
