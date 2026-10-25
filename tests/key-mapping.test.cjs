'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mapModifiers, mapKeyEvent } = require('../src/main/key-mapping.cjs');
const { KeyboardRouter } = require('../src/main/keyboard.cjs');
const event = (code, modifiers, down = true) => ({ type: 'key.event', code, modifiers, down });
const win = (code, modifiers) => mapKeyEvent(event(code, modifiers), 'win32', 'darwin');
const mac = (code, modifiers) => mapKeyEvent(event(code, modifiers), 'darwin', 'win32');

test('shortcut-specific equivalents work in both directions', () => {
  for (const [wc, wm, mc, mm] of [
    [0x06, 2, 0x06, 8], [0x16, 3, 0x16, 9],
    [0x4A, 0, 0x50, 8], [0x4D, 1, 0x4F, 9],
    [0x4A, 2, 0x52, 8], [0x4D, 3, 0x51, 9],
    [0x50, 2, 0x50, 4], [0x4F, 3, 0x4F, 5],
    [0x2A, 2, 0x2A, 4], [0x4C, 2, 0x4C, 4],
    [0x46, 0, 0x20, 9], [0x47, 0, 0x69, 2],
  ]) {
    assert.deepEqual(win(wc, wm), event(mc, mm));
    assert.deepEqual(mac(mc, mm), event(wc, wm));
  }
  assert.deepEqual(mac(0x2C, 8), event(0xE3, 8));
});

test('unrecognized chords, bare modifiers, AltGr and terminal Control remain physical', () => {
  for (const [code, modifiers] of [[0xE0, 2], [0xE7, 8], [0x2B, 2], [0x06, 6], [0x06, 10], [0x2A, 0], [0x4C, 0]]) {
    assert.deepEqual(win(code, modifiers), event(code, modifiers));
  }
  assert.deepEqual(mac(0x06, 2), event(0x06, 2));
  assert.deepEqual(mac(0x2B, 2), event(0x2B, 2));
  assert.equal(mapModifiers(2, 'win32', 'darwin'), 2);
  for (const platforms of [['darwin', 'macos'], ['win32', 'windows'], ['linux', 'darwin'], [undefined, 'win32']]) {
    const original = event(0x06, 2);
    assert.equal(mapKeyEvent(original, ...platforms), original);
  }
});

function setup(source = 'win32', destination = 'darwin') {
  const calls = [];
  const cursor = { linked: true, modifiers: 0, isOwner: () => true, setModifiers(value) { this.modifiers = value; } };
  const keyboard = new KeyboardRouter({ cursor, synchronizeModifiers: true,
    native: { synthesizeKey: (...args) => calls.push(args), releaseInputState() {} },
    mapRemoteEvent: (message) => mapKeyEvent(message, source, destination),
  });
  return { keyboard, calls, cursor };
}

test('injection changes modifiers for each shortcut and restores Control for the next chord', () => {
  const { keyboard, calls, cursor } = setup();
  for (const e of [event(0xE0, 2), event(0x06, 2), event(0x06, 2, false), event(0x2B, 2)]) keyboard.receive(e);
  assert.deepEqual(calls, [
    [0xE0, true, 2], [0xE0, false, 0], [0xE3, true, 8], [0x06, true, 8],
    [0x06, false, 8], [0xE3, false, 0], [0xE0, true, 2], [0x2B, true, 2],
  ]);
  assert.equal(cursor.modifiers, 2);
  keyboard.releaseAll();
  assert.equal(keyboard.remotePressed.size, 0);
});

test('Home release retains translated key even when Control is released first', () => {
  const { keyboard, calls } = setup();
  for (const e of [event(0x4A, 2), event(0xE0, 0, false), event(0x4A, 0, false)]) keyboard.receive(e);
  assert.ok(calls.some(([code, down]) => code === 0x52 && !down));
  assert.equal(keyboard.remotePressed.size, 0);
});

test('Windows injection gets real modifier events for translated Mac shortcuts', () => {
  const { keyboard, calls } = setup('darwin', 'win32');
  keyboard.receive(event(0x50, 8));
  assert.deepEqual(calls, [[0x4A, true, 0]]);
  keyboard.receive(event(0x50, 8, false));
  assert.deepEqual(calls.at(-1), [0xE3, true, 8]);
  keyboard.releaseAll();
  assert.equal(keyboard.remotePressed.size, 0);
});

test('Start tap opens Spotlight, but a Windows-key chord does not', () => {
  const { keyboard, calls } = setup();
  keyboard.receive(event(0xE3, 8));
  keyboard.receive(event(0xE3, 0, false));
  assert.ok(calls.some(([code, down, modifiers]) => code === 0x2C && down && modifiers === 8));
  calls.length = 0;
  keyboard.receive(event(0xE3, 8));
  keyboard.receive(event(0x07, 8));
  keyboard.receive(event(0x07, 8, false));
  keyboard.receive(event(0xE3, 0, false));
  assert.ok(!calls.some(([code]) => code === 0x2C));
});

test('region capture and keypad lock equivalents', () => {
  assert.deepEqual(win(0x16, 9), event(0x21, 9));
  assert.deepEqual(mac(0x21, 9), event(0x16, 9));
  assert.deepEqual(mac(0x53, 1), event(0x53, 0));
});

test('Spotlight translated into a Start tap releases the Windows key', () => {
  const { keyboard, calls } = setup('darwin', 'win32');
  keyboard.receive(event(0x2C, 8));
  keyboard.receive(event(0xE3, 0, false));
  keyboard.receive(event(0x2C, 0, false));
  assert.equal(keyboard.remotePressed.size, 0);
  assert.equal(keyboard.injectedModifiers, 0);
  assert.ok(calls.some(([code, down]) => code === 0xE3 && !down));
});
