'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { Session } = require('../src/core/session.cjs');
const { newSecret } = require('../src/core/wire.cjs');

async function until(predicate, timeout = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Condition timed out.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function pair(t) {
  const secret = newSecret();
  const host = new Session({ id: 'windows', name: 'Windows', role: 'host', port: 0, bindHost: '127.0.0.1', secret });
  await host.start();
  const peer = new Session({ id: 'mac', name: 'Mac', role: 'join', host: '127.0.0.1', port: host.port, secret });
  t.after(async () => { await peer.stop(); await host.stop(); });
  await peer.start();
  await until(() => peer.phase === 'connected');
  return { host, peer, secret };
}

test('real sockets synchronize dual input, click, resize, close, reopen, and handoff', async (t) => {
  const { host, peer } = await pair(t);
  host.action({ type: 'enter', x: .3, y: .3 });
  peer.action({ type: 'enter', x: .8, y: .8 });
  host.action({ type: 'move', dx: .1, dy: 0 });
  peer.action({ type: 'move', dx: .2, dy: .1 });
  await until(() => host.state.cursor.active.length === 2 && host.state.cursor.x > .59);
  await until(() => peer.state.revision === host.state.revision);
  assert.deepEqual(peer.state, host.state);
  assert.ok(Math.abs(peer.state.cursor.x - .6) < 1e-10);
  peer.action({ type: 'button', buttons: 1 });
  peer.action({ type: 'resize', width: 800, height: 500 });
  await until(() => host.state.size.width === 800);
  assert.equal(host.state.cursor.buttons.mac, 1);
  peer.action({ type: 'close' });
  await until(() => !host.state.open && !peer.state.open);
  host.action({ type: 'open' });
  await until(() => peer.state.open);
  host.action({ type: 'handoff', edge: 'right', ratio: .5 });
  await until(() => peer.state.handoff?.to === 'mac');
  assert.deepEqual(peer.state.views, ['mac']);
  peer.action({ type: 'handoff', edge: 'left', ratio: .5 });
  await until(() => host.state.handoff.to === 'windows');
});

test('unexpected disconnect clears input and reconnects to a fresh authoritative snapshot', async (t) => {
  const { host, peer } = await pair(t);
  peer.action({ type: 'enter', x: .4, y: .4 });
  peer.action({ type: 'button', buttons: 1 });
  await until(() => host.state.cursor.buttons.mac === 1);
  peer.socket.terminate();
  await until(() => host.phase === 'hosting');
  assert.deepEqual(host.state.cursor.active, []);
  assert.deepEqual(host.state.cursor.buttons, {});
  host.action({ type: 'close' });
  await until(() => peer.phase === 'connected');
  assert.equal(peer.state.open, false);
  assert.deepEqual(peer.state, host.state);
});

test('a restarted host accepts the saved pairing and client reconnects automatically', async (t) => {
  const { host, peer, secret } = await pair(t);
  const port = host.port;
  await host.stop();
  await until(() => peer.phase === 'reconnecting');
  const replacement = new Session({ id: 'windows', name: 'Windows', role: 'host', port, bindHost: '127.0.0.1', secret });
  t.after(() => replacement.stop());
  await replacement.start();
  await until(() => peer.phase === 'connected');
  assert.deepEqual(peer.state, replacement.state);
});

test('rejects a third laptop without disturbing the connected pair', async (t) => {
  const { host, peer, secret } = await pair(t);
  const extra = new Session({ id: 'extra', name: 'Extra', role: 'join', host: '127.0.0.1', port: host.port, secret });
  t.after(() => extra.stop());
  await extra.start();
  await until(() => extra.phase === 'reconnecting');
  assert.match(extra.message, /already connected/);
  assert.equal(host.members.length, 2);
  assert.equal(peer.phase, 'connected');
});

test('wrong invitations and browser origins cannot join or mutate the session', async (t) => {
  const { host } = await pair(t);
  const wrong = new Session({ id: 'wrong', name: 'Wrong', role: 'join', host: '127.0.0.1', port: host.port, secret: newSecret() });
  t.after(() => wrong.stop());
  await wrong.start();
  await until(() => wrong.phase === 'reconnecting');
  assert.equal(wrong.action({ type: 'close' }), false);
  assert.equal(host.state.open, true);
  const browser = new WebSocket(`ws://127.0.0.1:${host.port}`, { origin: 'https://example.com' });
  const error = await new Promise((resolve) => browser.once('error', resolve));
  assert.match(error.message, /403/);
});
