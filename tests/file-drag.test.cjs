'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CursorController } = require('../src/main/cursor.cjs');
const { sanitizePeerMessage } = require('../src/main/messages.cjs');
const { FileDrag, ESCAPE_HID, EDGE_DWELL_MS } = require('../src/main/file-drag.cjs');

const placement = (machineId, x, y, w, h, scale = 1) => ({ machineId, origin: { x, y }, size: { w, h }, scale });
const PLACEMENTS = [placement('a', 0, 0, 100, 100), placement('b', 100, 0, 100, 100)];
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

function fakeNative(log, name) {
  const native = {
    generation: 5,
    files: ['/Users/me/Desktop/photo.jpg'],
    dragGeneration: () => native.generation,
    dragFiles: () => native.files,
    setDragCaptureRegion: (region) => log.push([name, 'strip', region]),
    synthesizeKey: (code, down) => log.push([name, 'key', code, down]),
    synthesizeButton: (button, down) => log.push([name, 'button', button, down]),
    releaseInputState: () => log.push([name, 'release-input']),
    assumeInputState: (buttons) => log.push([name, 'assume', buttons]),
    toPlatformPoint: (point) => ({ ...point }),
  };
  return native;
}

function fakeTransfer(log, name) {
  const transfer = new EventEmitter();
  transfer.busy = false;
  transfer.offer = (paths) => { log.push([name, 'offer', paths]); return 'offer-id'; };
  transfer.accept = async (id, folder) => { log.push([name, 'accept', id, folder]); return folder; };
  transfer.reject = (id, reason) => { log.push([name, 'reject', id, reason]); return true; };
  return transfer;
}

// Two linked cursors joined by the sanitized control channel, each with its
// own FileDrag. `a` owns the pointer near the a|b seam.
function harness({ platform = 'darwin', now = () => 0, folder = '/Users/me/Projects' } = {}) {
  const log = [];
  const natives = { a: fakeNative(log, 'a'), b: fakeNative(log, 'b') };
  const cursors = {};
  for (const [id, peer] of [['a', 'b'], ['b', 'a']]) {
    cursors[id] = new CursorController({
      machineId: id, placements: PLACEMENTS, ownerMachineId: 'a', initialPosition: { x: 95, y: 50 },
      native: natives[id], now,
      send(message) {
        if (message.type === 'cursor.handoff') log.push([id, 'handoff', message.managedDrag]);
        const clean = sanitizePeerMessage(JSON.parse(JSON.stringify(message)));
        cursors[peer].receive(clean, id);
        return true;
      },
    });
  }
  const transfers = { a: fakeTransfer(log, 'a'), b: fakeTransfer(log, 'b') };
  const drags = {};
  for (const id of ['a', 'b']) {
    drags[id] = new FileDrag({
      transfer: transfers[id], native: natives[id], platform, now,
      resolveDropFolder: async (point) => { log.push([id, 'resolve', point]); return folder; },
      fallbackFolder: () => '/Users/me/Downloads',
    });
    drags[id].attach(cursors[id]);
  }
  const cross = () => {
    cursors.a.localDelta(20, 0, 16, 0, { accelerated: true });
    cursors.a.flush();
  };
  return { log, natives, cursors, transfers, drags, cross };
}

const only = (log, kinds) => log.filter((entry) => kinds.includes(entry[1]));

test('a file drag crossing the seam is cancelled locally before the handoff releases it, then offered', async () => {
  const { log, natives, cursors, cross } = harness();
  cursors.a.localButton('left', true);
  natives.a.generation = 6; // Finder began a drag after the press.
  cross();
  await flushMicrotasks();
  assert.equal(cursors.a.isOwner(), false);
  assert.deepEqual(only(log, ['key', 'handoff', 'release-input', 'offer']).filter((entry) => entry[0] === 'a'), [
    ['a', 'key', ESCAPE_HID, true],
    ['a', 'key', ESCAPE_HID, false],
    ['a', 'handoff', true],
    ['a', 'release-input'],
    ['a', 'offer', ['/Users/me/Desktop/photo.jpg']],
  ]);
  // The receiver must not inject the carried left button.
  assert.deepEqual(only(log, ['assume']).filter((entry) => entry[0] === 'b'), [['b', 'assume', 0]]);
});

test('a press without a new drag (stale drag pasteboard) crosses as ordinary input', async () => {
  const { log, cursors, cross } = harness();
  cursors.a.localButton('left', true);
  cross();
  await flushMicrotasks();
  assert.equal(cursors.a.isOwner(), false);
  assert.deepEqual(only(log, ['key', 'offer']), []);
  assert.deepEqual(only(log, ['handoff']), [['a', 'handoff', false]]);
});

test('the receiver drops the offer into the folder under the pointer when the button is released there', async () => {
  const { log, cursors, natives, transfers, cross } = harness();
  cursors.a.localButton('left', true);
  natives.a.generation = 6;
  cross();
  transfers.b.emit('offer', { id: 'offer-id', count: 1, names: ['photo.jpg'] });
  assert.equal(cursors.b.dragging, true);
  cursors.a.localButton('left', false); // The mouse is on a; its release reaches b.
  await flushMicrotasks();
  assert.deepEqual(only(log, ['button']), [], 'no stray button injected on either OS');
  const [resolve] = only(log, ['resolve']);
  assert.equal(resolve[0], 'b');
  assert.ok(resolve[2].x >= 0 && resolve[2].x < 100, 'drop point is local to b');
  assert.deepEqual(only(log, ['accept']), [['b', 'accept', 'offer-id', '/Users/me/Projects']]);
  assert.equal(cursors.b.dragging, false);
});

test('without a certain folder the drop lands in Downloads, even if the release beat the offer', async () => {
  const { log, cursors, natives, transfers, cross } = harness({ folder: null });
  cursors.a.localButton('left', true);
  natives.a.generation = 6;
  cross();
  cursors.b.localButton('left', false); // The mouse is on b; its release is local.
  transfers.b.emit('offer', { id: 'offer-id', count: 1, names: ['photo.jpg'] });
  await flushMicrotasks();
  assert.deepEqual(only(log, ['accept']), [['b', 'accept', 'offer-id', '/Users/me/Downloads']]);
});

test('an offer that no cross-seam drag is waiting for is refused', () => {
  const { log, transfers } = harness();
  transfers.b.emit('offer', { id: 'stray', count: 1, names: ['x'] });
  assert.deepEqual(only(log, ['reject', 'accept']), [['b', 'reject', 'stray', 'unexpected']]);
});

test('carrying the drag back before releasing refuses the offer', async () => {
  const { log, cursors, natives, transfers, cross } = harness();
  cursors.a.localButton('left', true);
  natives.a.generation = 6;
  cross();
  transfers.b.emit('offer', { id: 'offer-id', count: 1, names: ['photo.jpg'] });
  // Move a little into b (clearing the anti-bounce latch), then back to a.
  cursors.b.localDelta(10, 0, 16, 0, { accelerated: true });
  cursors.b.flush();
  cursors.b.localDelta(-80, 0, 16, 0, { accelerated: true });
  cursors.b.flush();
  assert.equal(cursors.a.isOwner(), true);
  cursors.a.localButton('left', false);
  await flushMicrotasks();
  assert.deepEqual(only(log, ['reject', 'accept']), [['b', 'reject', 'offer-id', 'returned']]);
});

test('turning file drag off leaves seam crossings untouched', async () => {
  const { log, cursors, natives, drags, cross } = harness();
  drags.a.setEnabled(false);
  cursors.a.localButton('left', true);
  natives.a.generation = 6;
  cross();
  await flushMicrotasks();
  assert.deepEqual(only(log, ['key', 'offer']), []);
});

test('on Windows the pointer waits at the seam until the drop strip has seen the drag', async () => {
  let clock = 1000;
  const { log, cursors, natives, cross } = harness({ platform: 'win32', now: () => clock });
  cursors.a.localButton('left', true);
  assert.deepEqual(only(log, ['strip']), [['a', 'strip', { x: 97, y: 0, width: 3, height: 100 }]]);
  cross();
  assert.equal(cursors.a.isOwner(), true, 'held at the seam');
  clock += EDGE_DWELL_MS / 2;
  natives.a.generation = 6; // The strip received DragEnter.
  cross();
  await flushMicrotasks();
  assert.equal(cursors.a.isOwner(), false);
  assert.deepEqual(only(log, ['offer']), [['a', 'offer', ['/Users/me/Desktop/photo.jpg']]]);
  cursors.a.localButton('left', false);
  assert.deepEqual(only(log, ['strip']).at(-1), ['a', 'strip', null]);
});

test('on Windows an ordinary held-button crossing is delayed only briefly', () => {
  let clock = 1000;
  const { cursors, cross } = harness({ platform: 'win32', now: () => clock });
  cursors.a.localButton('left', true);
  cross();
  assert.equal(cursors.a.isOwner(), true);
  clock += EDGE_DWELL_MS;
  cross();
  assert.equal(cursors.a.isOwner(), false);
});

test('a file drag preempts a background clipboard copy', async () => {
  const { log, cursors, natives, transfers, cross } = harness();
  transfers.a.busy = true;
  transfers.a.activePurpose = 'clipboard';
  transfers.a.cancel = async (reason) => { log.push(['a', 'cancel', reason]); transfers.a.busy = false; transfers.a.activePurpose = null; return true; };
  cursors.a.localButton('left', true);
  natives.a.generation = 6;
  cross();
  await flushMicrotasks();
  assert.deepEqual(only(log, ['cancel', 'offer']), [['a', 'cancel', 'superseded'], ['a', 'offer', ['/Users/me/Desktop/photo.jpg']]]);
});
