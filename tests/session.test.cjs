'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { Session } = require('../src/core/session.cjs');
const { DRAG_LEASE_MS } = require('../src/core/state.cjs');
const { viewportsForActor } = require('../src/core/geometry.cjs');
const { newSecret } = require('../src/core/wire.cjs');

async function until(predicate, timeout = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Condition timed out.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hostLayout(revision = 1) {
  return {
    revision,
    edge: 'right',
    activeDisplayId: 'win-display',
    displays: [{
      id: 'win-display',
      bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
      workArea: { x: -1920, y: 40, width: 1920, height: 1040 },
      scaleFactor: 1.25,
      primary: true,
    }],
  };
}

function peerLayout(revision = 1) {
  return {
    revision,
    edge: 'left',
    activeDisplayId: 'mac-display',
    displays: [{
      id: 'mac-display',
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea: { x: 0, y: 25, width: 1440, height: 875 },
      scaleFactor: 2,
      primary: true,
    }],
  };
}

async function pair(t) {
  const secret = newSecret();
  const host = new Session({
    id: 'windows', name: 'Windows', role: 'host', port: 0,
    bindHost: '127.0.0.1', secret, layout: hostLayout(), discovery: false,
  });
  await host.start();
  const peer = new Session({
    id: 'mac', name: 'Mac', role: 'join', host: '127.0.0.1',
    port: host.port, secret, layout: peerLayout(), discovery: false,
  });
  t.after(async () => { await peer.stop(); await host.stop(); });
  await peer.start();
  await until(() => peer.phase === 'connected');
  // Layout is an authenticated actor action rather than part of identity.
  assert.equal(peer.action({ type: 'layout', layout: peerLayout() }), true);
  await until(() => host.state.topology.displays.length === 2);
  await until(() => peer.state.revision === host.state.revision);
  return { host, peer, secret };
}

async function straddle(host, peer, token = 'host-seam-1') {
  assert.equal(host.action({ type: 'drag-start', id: token, offsetX: 100, offsetY: 10 }), true);
  assert.equal(host.action({ type: 'drag-move', id: token, seq: 1, dx: 480, dy: 0 }), true);
  assert.equal(host.action({ type: 'drag-move', id: token, seq: 2, dx: 480, dy: 0 }), true);
  assert.equal(host.action({ type: 'drag-end', id: token }), true);
  await until(() => peer.state.drag === null && peer.state.window.rect.x === 1470);
}

test('real sockets share topology, dual input, and a reversible client-owned seam drag', async (t) => {
  const { host, peer } = await pair(t);
  assert.equal(host.state.version, 2);
  assert.equal(host.state.topology.displays[0].scaleFactor, 1.25);
  assert.equal(host.state.topology.displays[1].scaleFactor, 2);
  assert.equal(viewportsForActor(host.state.window.rect, host.state.topology, 'windows').length, 1);
  assert.equal(viewportsForActor(host.state.window.rect, host.state.topology, 'mac').length, 0);

  await straddle(host, peer);
  const win = viewportsForActor(host.state.window.rect, host.state.topology, 'windows')[0];
  const mac = viewportsForActor(host.state.window.rect, host.state.topology, 'mac')[0];
  assert.equal(win.viewport.width, 450);
  assert.equal(mac.viewport.width, 450);
  assert.equal(win.viewport.width + mac.viewport.width, host.state.window.rect.width);

  host.action({ type: 'enter', x: .3, y: .3 });
  peer.action({ type: 'enter', x: .8, y: .8 });
  host.action({ type: 'move', dx: .1, dy: 0 });
  peer.action({ type: 'move', dx: .2, dy: .1 });
  await until(() => host.state.cursor.active.length === 2 && host.state.cursor.x > .59);
  await until(() => peer.state.revision === host.state.revision);
  assert.deepEqual(peer.state, host.state);
  assert.ok(Math.abs(host.state.cursor.x - .6) < 1e-10);

  const positions = [];
  host.on('state', (state) => {
    if (state.drag?.owner === 'mac') positions.push(state.window.rect.x);
  });
  peer.action({ type: 'drag-start', id: 'peer-drag-1', offsetX: 700, offsetY: 10 });
  await until(() => host.state.drag?.owner === 'mac');
  peer.action({ type: 'drag-move', id: 'peer-drag-1', seq: 1, dx: 500, dy: 0 });
  peer.action({ type: 'drag-move', id: 'peer-drag-1', seq: 2, dx: -300, dy: 0 });
  peer.action({ type: 'drag-move', id: 'peer-drag-1', seq: 3, dx: 500, dy: 0 });
  peer.action({ type: 'drag-end', id: 'peer-drag-1' });
  await until(() => host.state.drag === null && host.state.window.rect.x === 2170);
  await until(() => peer.state.revision === host.state.revision);
  assert.deepEqual(positions, [1470, 1970, 1670, 2170]);
  assert.equal(viewportsForActor(host.state.window.rect, host.state.topology, 'windows').length, 0);
  assert.equal(viewportsForActor(host.state.window.rect, host.state.topology, 'mac').length, 1);
});

test('the first accepted drag owner rejects a conflicting peer grab and stale movement', async (t) => {
  const { host, peer } = await pair(t);
  await straddle(host, peer, 'conflict-base');
  assert.equal(host.action({ type: 'drag-start', id: 'host-owner-1', offsetX: 100, offsetY: 10 }), true);
  const revision = host.state.revision;
  peer.action({ type: 'drag-start', id: 'peer-loser-1', offsetX: 700, offsetY: 10 });
  peer.action({ type: 'drag-move', id: 'peer-loser-1', seq: 1, dx: 100, dy: 0 });
  await delay(60);
  assert.equal(host.state.revision, revision);
  assert.equal(host.state.drag.owner, 'windows');
  assert.equal(host.state.drag.id, 'host-owner-1');
  assert.equal(host.action({ type: 'drag-move', id: 'host-owner-1', seq: 2, dx: 10, dy: 0 }), false);
  assert.equal(host.action({ type: 'drag-cancel', id: 'host-owner-1' }), true);
});

test('peer close and open place the one logical window on the peer only', async (t) => {
  const { host, peer } = await pair(t);
  peer.action({ type: 'close' });
  await until(() => !host.state.open && !peer.state.open);
  assert.deepEqual(host.state.cursor.active, []);
  peer.action({ type: 'open' });
  await until(() => host.state.open && host.state.window.rect.x === 2190);
  await until(() => peer.state.revision === host.state.revision);
  assert.equal(viewportsForActor(host.state.window.rect, host.state.topology, 'windows').length, 0);
  assert.equal(viewportsForActor(host.state.window.rect, host.state.topology, 'mac').length, 1);
  assert.equal('views' in host.state, false);
  assert.equal('handoff' in host.state, false);
});

test('disconnect during a peer drag cancels capture and recovers the window on the host', async (t) => {
  const { host, peer } = await pair(t);
  peer.action({ type: 'place-here' });
  await until(() => host.state.window.rect.x === 2190);
  peer.action({ type: 'drag-start', id: 'drop-peer-1', offsetX: 100, offsetY: 10 });
  await until(() => host.state.drag?.owner === 'mac');
  peer.action({ type: 'drag-move', id: 'drop-peer-1', seq: 1, dx: 300, dy: 0 });
  await until(() => host.state.window.rect.x === 2490);
  await peer.stop();
  await until(() => host.phase === 'hosting');
  assert.equal(host.state.drag, null);
  assert.deepEqual(host.state.cursor.active, []);
  assert.deepEqual(host.state.cursor.buttons, {});
  assert.equal(host.state.topology.displays.length, 1);
  assert.equal(host.state.layouts.mac, undefined);
  assert.deepEqual(host.state.window.rect, { x: 510, y: 220, width: 900, height: 600 });
});

test('an abandoned drag lease restores its starting rectangle on both sessions', async (t) => {
  const { host, peer } = await pair(t);
  const start = structuredClone(host.state.window.rect);
  host.action({ type: 'drag-start', id: 'lease-test-1', offsetX: 100, offsetY: 10 });
  host.action({ type: 'drag-move', id: 'lease-test-1', seq: 1, dx: 300, dy: 0 });
  assert.equal(host.state.window.rect.x, start.x + 300);
  await until(() => host.state.drag === null, DRAG_LEASE_MS + 1500);
  await until(() => peer.state.drag === null && peer.state.revision === host.state.revision);
  assert.deepEqual(host.state.window.rect, start);
  assert.deepEqual(peer.state, host.state);
});

test('unexpected disconnect reconnects to the latest authoritative snapshot and layout can rejoin', async (t) => {
  const { host, peer } = await pair(t);
  peer.socket.terminate();
  await until(() => host.phase === 'hosting');
  host.action({ type: 'close' });
  await until(() => peer.phase === 'connected');
  await until(() => peer.state.revision === host.state.revision);
  assert.equal(peer.state.open, false);
  assert.deepEqual(peer.state, host.state);
  peer.action({ type: 'layout', layout: peerLayout(2) });
  await until(() => host.state.topology.displays.length === 2);
  await until(() => peer.state.revision === host.state.revision);
  assert.deepEqual(peer.state, host.state);
});

test('a restarted host accepts the saved pairing and sends a fresh authoritative v2 snapshot', async (t) => {
  const { host, peer, secret } = await pair(t);
  const port = host.port;
  await host.stop();
  await until(() => peer.phase === 'reconnecting');
  const replacement = new Session({
    id: 'windows', name: 'Windows', role: 'host', port,
    bindHost: '127.0.0.1', secret, layout: hostLayout(2), discovery: false,
  });
  t.after(() => replacement.stop());
  await replacement.start();
  await until(() => peer.phase === 'connected');
  assert.equal(peer.state.version, 2);
  assert.deepEqual(peer.state, replacement.state);
});

test('rejects a third laptop without disturbing the connected pair', async (t) => {
  const { host, peer, secret } = await pair(t);
  const extra = new Session({
    id: 'extra', name: 'Extra', role: 'join', host: '127.0.0.1',
    port: host.port, secret, layout: peerLayout(), discovery: false,
  });
  t.after(() => extra.stop());
  await extra.start();
  await until(() => extra.phase === 'reconnecting');
  assert.match(extra.message, /already connected/);
  assert.equal(host.members.length, 2);
  assert.equal(peer.phase, 'connected');
});

test('wrong invitations and browser origins cannot join or mutate the session', async (t) => {
  const { host } = await pair(t);
  const wrong = new Session({
    id: 'wrong', name: 'Wrong', role: 'join', host: '127.0.0.1',
    port: host.port, secret: newSecret(), layout: peerLayout(), discovery: false,
  });
  t.after(() => wrong.stop());
  await wrong.start();
  await until(() => wrong.phase === 'reconnecting');
  assert.equal(wrong.action({ type: 'close' }), false);
  assert.equal(host.state.open, true);
  const browser = new WebSocket(`ws://127.0.0.1:${host.port}`, { origin: 'https://example.com' });
  const error = await new Promise((resolve) => browser.once('error', resolve));
  assert.match(error.message, /403/);
});
