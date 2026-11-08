'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { newSecret, createChannel, handshakeSalt, makeInvitation, parseInvitation } = require('../src/core/wire.cjs');

test('invitation round trip and input validation', () => {
  const secret = newSecret();
  assert.deepEqual(parseInvitation(makeInvitation('192.168.1.20', 43187, secret)), { host: '192.168.1.20', port: 43187, secret });
  for (const value of ['', 'CS1.broken', makeInvitation('host/path', 43187, secret), makeInvitation('host', -1, secret), makeInvitation('host', 1, 'short')]) assert.throws(() => parseInvitation(value), /complete invitation/);
});

test('encrypted messages authenticate in both directions and hide application state', () => {
  const secret = newSecret(), salt = newSecret();
  const host = createChannel(secret, salt, true), peer = createChannel(secret, salt, false);
  const packet = host.seal({ type: 'snapshot', cursor: 'private cursor state' });
  assert.equal(packet.includes('private cursor state'), false);
  assert.deepEqual(peer.open(packet), { type: 'snapshot', cursor: 'private cursor state' });
  assert.deepEqual(host.open(peer.seal({ type: 'action' })), { type: 'action' });
});

test('rejects a wrong secret, tampering, replay, reflected packets, and old connections', () => {
  const secret = newSecret(), salt = newSecret();
  const host = createChannel(secret, salt, true), peer = createChannel(secret, salt, false);
  const packet = host.seal({ type: 'snapshot' });
  assert.throws(() => createChannel(newSecret(), salt, false).open(packet));
  assert.throws(() => host.open(packet));
  assert.throws(() => createChannel(secret, newSecret(), false).open(packet));
  const changed = JSON.parse(packet);
  const data = Buffer.from(changed.data, 'base64'); data[0] ^= 1; changed.data = data.toString('base64');
  assert.throws(() => peer.open(JSON.stringify(changed)));
  assert.deepEqual(peer.open(packet), { type: 'snapshot' });
  assert.throws(() => peer.open(packet), /sequence/);
});

test('freshness from either laptop prevents replaying an entire old handshake', () => {
  const root = newSecret(), hostSalt = newSecret(), peerSalt = newSecret();
  const oldSalt = handshakeSalt(hostSalt, peerSalt);
  const oldHost = createChannel(root, oldSalt, true);
  const oldWelcome = oldHost.seal({ type: 'welcome' });
  const newPeer = createChannel(root, handshakeSalt(hostSalt, newSecret()), false);
  assert.throws(() => newPeer.open(oldWelcome));
  assert.notEqual(handshakeSalt(newSecret(), peerSalt), oldSalt);
});

test('bulk data uses distinct keys from control and enforces its configured wire limit', () => {
  const secret = newSecret(), salt = newSecret();
  const controlHost = createChannel(secret, salt, true);
  const controlPeer = createChannel(secret, salt, false);
  const dataHost = createChannel(secret, salt, true, { context: 'data', maxMessage: 1500000 });
  const dataPeer = createChannel(secret, salt, false, { context: 'data', maxMessage: 1500000 });
  const controlPacket = controlHost.seal({ type: 'action', private: 'control' });
  const dataPacket = dataHost.seal({ type: 'data-message', payload: 'x'.repeat(200000) });
  assert.deepEqual(controlPeer.open(controlPacket), { type: 'action', private: 'control' });
  assert.equal(dataPeer.open(dataPacket).payload.length, 200000);
  assert.throws(() => createChannel(secret, salt, false, { context: 'data', maxMessage: 1500000 }).open(controlPacket));
  assert.throws(() => createChannel(secret, salt, false).open(dataPacket), /too large|authenticate/i);

  const limited = createChannel(secret, salt, true, { context: 'limited', maxMessage: 128 });
  const limitedPeer = createChannel(secret, salt, false, { context: 'limited', maxMessage: 128 });
  assert.throws(() => limited.seal({ payload: 'x'.repeat(100) }), /too large/);
  assert.deepEqual(limitedPeer.open(limited.seal({ ok: true })), { ok: true });
  assert.throws(() => createChannel(secret, salt, true, { context: 'UPPERCASE' }), /options/);
});

test('binary frames carry raw bytes, share the packet sequence, and reject tampering or replay', () => {
  const secret = newSecret(), salt = newSecret();
  const options = { context: 'data', maxMessage: 8 * 1024 * 1024 };
  const host = createChannel(secret, salt, true, options), peer = createChannel(secret, salt, false, options);
  const payload = Buffer.from('private file bytes');
  const frame = host.sealFrame({ type: 'file.frame', offset: 0 }, payload);
  assert.equal(frame.includes(payload), false);
  const opened = peer.openFrame(frame);
  assert.deepEqual(opened.header, { type: 'file.frame', offset: 0 });
  assert.deepEqual(opened.payload, payload);
  // JSON packets and frames interleave on one strict counter.
  assert.deepEqual(peer.open(host.seal({ type: 'file.end' })), { type: 'file.end' });
  assert.throws(() => peer.openFrame(frame), /sequence/);
  const next = host.sealFrame({ type: 'file.frame', offset: 18 }, payload);
  const tampered = Buffer.from(next); tampered[tampered.length - 1] ^= 1;
  assert.throws(() => peer.openFrame(tampered));
  assert.deepEqual(peer.openFrame(next).header, { type: 'file.frame', offset: 18 });
  assert.throws(() => host.sealFrame({ type: 'too-big' }, Buffer.alloc(8 * 1024 * 1024)), /too large/);
});
