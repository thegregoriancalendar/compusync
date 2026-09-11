'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Session } = require('../src/core/session.cjs');
const { newSecret } = require('../src/core/wire.cjs');
const { newCode, normalizeCode, claimCode, pairWithCode } = require('../src/core/pairing.cjs');
const { advertise, discover } = require('../src/core/discovery.cjs');

async function hostFor(t) {
  const host = new Session({ id: 'host', name: 'Host', role: 'host', port: 0, bindHost: '127.0.0.1', secret: newSecret(), discovery: false });
  await host.start();
  t.after(() => host.stop());
  return { host, endpoint: { host: '127.0.0.1', port: host.port } };
}

test('codes have eight unambiguous characters; case, separators, and lookalikes normalize', () => {
  for (let i = 0; i < 50; i++) assert.match(newCode(), /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(normalizeCode(' ab7k3m9q '), 'AB7K-3M9Q');
  assert.equal(normalizeCode('OIla bcde'), '011A-BCDE');
  for (const invalid of ['', 'ABC', 'ABCD-EFGHU', 'ABCD-EFG!', null]) assert.throws(() => normalizeCode(invalid), /8-character/);
});

test('a short code exchanges the existing long-term key once; a wrong code does not consume it', async (t) => {
  const { host, endpoint } = await hostFor(t);
  const code = host.invitation().code;
  const wrong = code === 'AAAA-AAAA' ? 'BBBB-BBBB' : 'AAAA-AAAA';
  await assert.rejects(claimCode(endpoint, wrong));
  assert.equal(host.invitation().code, code);
  const paired = await claimCode(endpoint, code.toLowerCase().replace('-', ''));
  assert.equal(paired.secret, host.config.secret);
  assert.equal(host.invitation().code, '');
  await assert.rejects(claimCode(endpoint, code));
  assert.equal(host.state.open, true);
  // A saved long-term key continues to connect after the short code is used.
  const peer = new Session({ ...paired, role: 'join', id: 'peer', name: 'Peer' });
  t.after(() => peer.stop());
  await peer.start();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Pairing did not reconnect.')), 3000);
    peer.on('status', (status) => { if (status.phase === 'connected') { clearTimeout(timer); resolve(); } });
  });
  assert.deepEqual(peer.state, host.state);
});

test('expired and replaced codes fail while a fresh code works', async (t) => {
  const { host, endpoint } = await hostFor(t);
  const expired = host.invitation().code;
  host.pairingExpiresAt = Date.now() - 1;
  assert.equal(host.invitation().code, '');
  await assert.rejects(claimCode(endpoint, expired));
  host.refreshCode();
  await assert.rejects(claimCode(endpoint, expired));
  assert.equal((await claimCode(endpoint, host.invitation().code)).secret, host.config.secret);
});

test('pairing attempts are bounded without affecting an existing session key', async (t) => {
  const { host, endpoint } = await hostFor(t);
  host.pairingAttempts = Array(6).fill(Date.now());
  await assert.rejects(claimCode(endpoint, host.invitation().code));
  assert.equal(host.members.length, 1);
  assert.equal(host.config.secret.length, 43);
  host.pairingAttempts = [];
  assert.equal((await claimCode(endpoint, host.invitation().code)).secret, host.config.secret);
});

test('local discovery resolves a code without transmitting it or requiring an address', async (t) => {
  const { host, endpoint } = await hostFor(t);
  const beacon = await advertise(() => host.canPair() ? { id: 'host', port: endpoint.port } : null, { port: 0 });
  t.after(() => beacon.stop());
  const discoveryOptions = { port: beacon.port, destinations: ['127.0.0.1'], timeout: 80 };
  const candidates = await discover(discoveryOptions);
  assert.deepEqual(candidates, [endpoint]);
  assert.deepEqual(await discover({ ...discoveryOptions, excludeId: 'host' }), []);
  assert.equal((await pairWithCode(host.invitation().code, { excludeId: 'peer', discoveryOptions })).secret, host.config.secret);
  assert.deepEqual(await discover(discoveryOptions), []);
});

test('discovery failure gives actionable feedback and direct-address fallback works', async (t) => {
  const { host, endpoint } = await hostFor(t);
  await assert.rejects(pairWithCode(host.invitation().code, { discoveryOptions: { destinations: [], timeout: 20 } }), /No laptop found/);
  await assert.rejects(pairWithCode(host.invitation().code, { address: 'https://example.com' }), /hostname or IPv4/);
  assert.equal((await pairWithCode(host.invitation().code, { address: endpoint.host, port: endpoint.port })).secret, host.config.secret);
});
