'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AudioRouter } = require('../src/main/audio-router.cjs');
const { RustAudioEngine } = require('../src/main/audio-engine.cjs');
const { AUDIO_VERSION, sanitizeAudioMessage } = require('../src/core/audio-contract.cjs');
const { Session } = require('../src/core/session.cjs');
const { newSecret } = require('../src/core/wire.cjs');

const settle = () => new Promise((resolve) => setImmediate(resolve));
class Engine extends EventEmitter {
  constructor(level) {
    super(); this.available = true; this.canSend = true;
    this.value = { level, muted: false, label: 'Speakers' };
    this.sets = []; this.reads = [];
  }
  volume(id) { this.reads.push(id); return this.value; }
  setVolume(id, level) {
    if (this.error) throw new Error(this.error);
    this.sets.push({ id, level });
    return this.value = { ...this.value, level, muted: level === 0 };
  }
  stop() {}
}
class Peer extends EventEmitter {
  constructor(id) {
    super(); this.self = { id }; this.phase = 'connected';
    this.members = [{ id: 'mac' }, { id: 'windows' }]; this.sent = [];
  }
  sendPeer(message) {
    this.sent.push(message);
    if (this.drop?.(message)) return true;
    queueMicrotask(() => this.other.emit('peer-message', message, this.self.id));
    return true;
  }
}
async function pair(t) {
  const macSession = new Peer('mac'); const windowsSession = new Peer('windows');
  macSession.other = windowsSession; windowsSession.other = macSession;
  const macEngine = new Engine(25); const windowsEngine = new Engine(70);
  const mac = new AudioRouter({ session: macSession, engine: macEngine, platform: 'darwin' });
  const windows = new AudioRouter({ session: windowsSession, engine: windowsEngine, platform: 'win32', outputId: 'wired' });
  mac.start(); windows.start();
  t.after(() => { mac.stop(); windows.stop(); });
  await settle();
  return { mac, windows, macEngine, windowsEngine, macSession, windowsSession };
}

test('volume messages reject invalid levels and snapshots and strip unrelated fields', () => {
  for (const level of [-1, 101, NaN, Infinity, 0.5, '50', null]) {
    assert.equal(sanitizeAudioMessage({ type: 'audio.volume-set', id: 'request', level }), null);
  }
  for (const volume of [{ level: 50 }, { level: 50, muted: false, label: 'x'.repeat(257) }, { error: 'x'.repeat(501) }]) {
    assert.equal(sanitizeAudioMessage({ type: 'audio.volume-state', volume }), null);
  }
  assert.deepEqual(sanitizeAudioMessage({ type: 'audio.volume-set', id: 'request', level: 0, platform: 'darwin' }),
    { type: 'audio.volume-set', id: 'request', level: 0 });
  assert.deepEqual(sanitizeAudioMessage({ type: 'audio.volume-state', volume: { level: 100, muted: false, label: 'Speakers', secret: 'ignored' } }),
    { type: 'audio.volume-state', volume: { level: 100, muted: false, label: 'Speakers' } });
});

test('both laptops expose current volumes and adjust local and remote outputs without sharing audio', async (t) => {
  const { mac, windows, macEngine, windowsEngine } = await pair(t);
  assert.deepEqual(mac.state().volumes, windows.state().volumes);
  assert.equal(mac.state().volumes.mac.level, 25);
  assert.equal(mac.state().volumes.windows.level, 70);
  await mac.setVolume('windows', 45);
  assert.deepEqual(windowsEngine.sets, [{ id: 'wired', level: 45 }]);
  assert.equal(mac.state().volumes.windows.level, 45);
  await windows.setVolume('mac', 0);
  assert.equal(macEngine.sets[0].id, '');
  assert.equal(windows.state().volumes.mac.muted, true);
  await mac.setVolume('mac', 100);
  await settle();
  assert.equal(windows.state().volumes.mac.level, 100);
  assert.equal(windows.state().volumes.mac.muted, false);
  assert.equal(mac.state().active, false);
  assert.equal(windows.state().active, false);
});

test('polling reports system-volume changes and output selection refreshes the target device', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { mac, windows, windowsEngine } = await pair(t);
  windowsEngine.value = { level: 33, muted: true, label: 'Headphones' };
  t.mock.timers.tick(1000); await settle();
  assert.deepEqual(mac.state().volumes.windows, windowsEngine.value);
  windows.outputs = [{ id: 'headphones', label: 'Headphones' }];
  await windows.setOutput('headphones');
  await windows.setVolume('windows', 22);
  assert.equal(windowsEngine.reads.at(-1), 'headphones');
  assert.deepEqual(windowsEngine.sets.at(-1), { id: 'headphones', level: 22 });
  windows.stop();
  const reads = windowsEngine.reads.length;
  t.mock.timers.tick(2000);
  assert.equal(windowsEngine.reads.length, reads);
});

test('volume errors propagate to the initiating laptop and never stop an audio route', async (t) => {
  const { mac, windows, windowsEngine } = await pair(t);
  windows.route = { id: 'active', role: 'receiver' };
  windowsEngine.error = 'The speakers were disconnected.';
  await assert.rejects(mac.setVolume('windows', 50), /speakers were disconnected/);
  assert.equal(windows.route.id, 'active');
  assert.equal(mac.volumeRequests.size, 0);
  for (const [platform, level] of [['darwin', -1], ['darwin', 101], ['linux', 50], ['darwin', '50']]) {
    await assert.rejects(mac.setVolume(platform, level), /between 0 and 100/);
  }
});

test('volume reads and writes use the physical output pinned by an active sender', async (t) => {
  const { windows, windowsEngine } = await pair(t);
  windows.route = { id: 'active', role: 'sender', outputId: 'pinned-speakers' };
  windows.refreshVolume();
  await windows.setVolume('windows', 40);
  assert.equal(windowsEngine.reads.at(-1), 'pinned-speakers');
  assert.deepEqual(windowsEngine.sets.at(-1), { id: 'pinned-speakers', level: 40 });
  windows.stopRoute();
  windows.refreshVolume();
  assert.equal(windowsEngine.reads.at(-1), 'wired');
});

test('disconnection rejects unconfirmed changes and clears remote volume while local control remains available', async (t) => {
  const { mac, windowsSession, macSession } = await pair(t);
  windowsSession.drop = (message) => message.type === 'audio.volume-result';
  const pending = mac.setVolume('windows', 12);
  const rejected = assert.rejects(pending, /disconnected before confirming/);
  await settle();
  macSession.phase = 'reconnecting'; macSession.emit('status');
  await rejected;
  assert.equal(mac.state().volumes.windows, null);
  assert.equal(mac.volumeRequests.size, 0);
  await assert.rejects(mac.setVolume('windows', 20), /Connect to the other laptop/);
  await mac.setVolume('mac', 20);
  assert.equal(mac.state().volumes.mac.level, 20);
});

test('unconfirmed remote changes time out and foreign members cannot adjust the device', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { mac, windowsSession, windowsEngine } = await pair(t);
  windowsSession.emit('peer-message', { type: 'audio.volume-set', id: 'foreign', level: 0 }, 'stranger');
  assert.equal(windowsEngine.sets.length, 0);
  windowsSession.drop = (message) => message.type === 'audio.volume-result';
  const pending = mac.setVolume('windows', 30);
  const rejected = assert.rejects(pending, /did not confirm/);
  await settle();
  t.mock.timers.tick(5000);
  await rejected;
  assert.equal(mac.volumeRequests.size, 0);
});

test('volume controls handle native addons that predate volume support', () => {
  class NativeAudio { protocolVersion() { return AUDIO_VERSION; } }
  const engine = new RustAudioEngine({ binding: { NativeAudio }, platform: 'win32' });
  assert.throws(() => engine.volume(''), /Update the native addon/);
  assert.throws(() => engine.setVolume('', 50), /Update the native addon/);
});

test('volume commands and acknowledgements cross real encrypted sessions', async (t) => {
  const secret = newSecret();
  const host = new Session({ platform: 'darwin', id: 'mac', name: 'Mac', role: 'host', secret, port: 0, bindHost: '127.0.0.1', discovery: false });
  await host.start();
  const join = new Session({ platform: 'win32', id: 'windows', name: 'Windows', role: 'join', secret, host: '127.0.0.1', port: host.port, discovery: false });
  const mac = new AudioRouter({ session: host, engine: new Engine(25), platform: 'darwin' });
  const windows = new AudioRouter({ session: join, engine: new Engine(70), platform: 'win32' });
  t.after(async () => { mac.stop(); windows.stop(); await join.stop(); await host.stop(); });
  mac.start(); windows.start(); await join.start();
  const deadline = Date.now() + 5000;
  while (!mac.peerVolume || !windows.peerVolume) {
    if (Date.now() > deadline) throw new Error('Volume announcements did not arrive.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await mac.setVolume('windows', 15);
  await windows.setVolume('mac', 65);
  assert.equal(mac.state().volumes.windows.level, 15);
  assert.equal(windows.state().volumes.mac.level, 65);
});
