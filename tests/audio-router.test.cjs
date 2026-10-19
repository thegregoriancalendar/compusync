'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AudioRouter } = require('../src/main/audio-router.cjs');
const { RustAudioEngine, supportsMacCapture } = require('../src/main/audio-engine.cjs');
const { AUDIO_VERSION, sanitizeAudioMessage } = require('../src/core/audio-contract.cjs');
const { Session } = require('../src/core/session.cjs');
const { newSecret } = require('../src/core/wire.cjs');

const settle = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Audio condition timed out.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class Engine extends EventEmitter {
  constructor(canSend = false) {
    super(); this.available = true; this.canSend = canSend; this.calls = []; this.stops = 0;
  }
  async receive(options) { this.calls.push(['receive', options]); return this.pending || 45123; }
  async send(options) { this.calls.push(['send', options]); }
  async listOutputs() { this.emit('event', { type: 'outputs', outputs: [{ id: 'speakers', label: 'Speakers' }] }); }
  stop() { this.stops++; }
}

class Peer extends EventEmitter {
  constructor(id) {
    super(); this.self = { id }; this.phase = 'connected'; this.members = [{ id: 'mac' }, { id: 'windows' }]; this.sent = []; this.sendResult = true;
  }
  peerAddress() { return '127.0.0.1'; }
  sendPeer(message) {
    this.sent.push(message);
    if (this.sendResult) queueMicrotask(() => this.other.emit('peer-message', message, this.self.id));
    return this.sendResult;
  }
}

async function pair(t) {
  const macSession = new Peer('mac');
  const windowsSession = new Peer('windows');
  macSession.other = windowsSession; windowsSession.other = macSession;
  const macEngine = new Engine(true);
  const windowsEngine = new Engine();
  const mac = new AudioRouter({ session: macSession, engine: macEngine, platform: 'darwin' });
  const windows = new AudioRouter({ session: windowsSession, engine: windowsEngine, platform: 'win32' });
  mac.start(); windows.start();
  t.after(() => { mac.stop(); windows.stop(); });
  await settle();
  return { mac, windows, macSession, windowsSession, macEngine, windowsEngine };
}

test('audio messages bound inputs, strip extra fields and reject malformed keys or unsupported capabilities', () => {
  assert.equal(sanitizeAudioMessage({ type: 'audio.ready', id: 'route', key: 'x'.repeat(64), port: 43187 }), null);
  assert.equal(sanitizeAudioMessage({ type: 'audio.ready', id: 'route', key: '42'.repeat(32), port: 65536 }), null);
  assert.equal(sanitizeAudioMessage({ type: 'audio.offer', id: '../bad' }), null);
  assert.equal(sanitizeAudioMessage({ type: 'audio.hello', version: 1, platform: 'darwin', canSend: true, canReceive: false }), null);
  assert.deepEqual(sanitizeAudioMessage({ type: 'audio.offer', id: 'route', injected: 'ignore' }), { type: 'audio.offer', id: 'route' });
  assert.deepEqual(sanitizeAudioMessage({ type: 'audio.hello', version: AUDIO_VERSION, platform: 'win32', canSend: true, canReceive: true }),
    { type: 'audio.hello', version: AUDIO_VERSION, platform: 'win32', canSend: false, canReceive: true });
});

test('negotiates Mac-to-Windows with a fresh key and reports streaming only after receiver acknowledgement', async (t) => {
  const { mac, windows, macEngine, windowsEngine } = await pair(t);
  assert.equal(mac.state().canStart, true);
  assert.equal(windows.state().canStart, false);
  assert.throws(() => windows.startRoute(), /Start audio sharing from/);
  mac.startRoute();
  await settle();
  const receiver = windowsEngine.calls[0][1];
  const sender = macEngine.calls[0][1];
  assert.match(receiver.key, /^[a-f0-9]{64}$/);
  assert.equal(receiver.key, sender.key);
  assert.equal(sender.peerIp, '127.0.0.1');
  assert.equal(sender.port, 45123);
  assert.equal(mac.phase, 'connecting');
  windowsEngine.emit('event', { type: 'connected', id: windows.route.id });
  await settle();
  assert.equal(mac.phase, 'streaming');
  assert.equal(windows.phase, 'receiving');
  windows.stopRoute();
  await settle();
  assert.equal(mac.route, null);
  assert.equal(windows.route, null);
  mac.startRoute();
  await settle();
  assert.notEqual(windowsEngine.calls[1][1].key, receiver.key);
});

test('disconnect stops native audio and reconnect never restarts capture automatically', async (t) => {
  const { mac, windows, macSession, windowsSession, macEngine } = await pair(t);
  mac.startRoute(); await settle();
  for (const session of [macSession, windowsSession]) { session.phase = 'reconnecting'; session.emit('status'); }
  assert.equal(mac.state().active, false);
  assert.equal(windows.state().active, false);
  assert.ok(macEngine.stops > 0);
  for (const session of [macSession, windowsSession]) { session.phase = 'connected'; session.emit('status'); }
  await settle();
  assert.equal(mac.state().canStart, true);
  assert.equal(mac.route, null);
  assert.equal(macEngine.calls.length, 1);
});

test('stopping while receiver startup is pending prevents late negotiation and capture', async (t) => {
  const { mac, windows, macEngine, windowsEngine, windowsSession } = await pair(t);
  let complete;
  windowsEngine.pending = new Promise((resolve) => { complete = resolve; });
  mac.startRoute(); await settle();
  mac.stopRoute(); await settle();
  complete(45123); await settle();
  assert.equal(windows.route, null);
  assert.equal(windowsSession.sent.some((message) => message.type === 'audio.ready'), false);
  assert.equal(macEngine.calls.length, 0);
});

test('foreign members, stale routes, reverse offers, and duplicate ready messages cannot start another native stream', async (t) => {
  const { mac, windows, macSession, windowsSession, macEngine, windowsEngine } = await pair(t);
  windowsSession.emit('peer-message', { type: 'audio.offer', id: 'foreign' }, 'stranger');
  macSession.emit('peer-message', { type: 'audio.offer', id: 'reverse' }, 'windows');
  assert.equal(windowsEngine.calls.length, 0);
  mac.startRoute(); await settle();
  const ready = windowsSession.sent.find((message) => message.type === 'audio.ready');
  macSession.emit('peer-message', ready, 'windows');
  macSession.emit('peer-message', { ...ready, id: 'stale' }, 'windows');
  windowsSession.emit('peer-message', { type: 'audio.stop', id: 'stale' }, 'mac');
  await settle();
  assert.equal(macEngine.calls.length, 1);
  assert.ok(windows.route);
});

test('native failures stop both sides and output changes require an idle route', async (t) => {
  const { mac, windows, macEngine } = await pair(t);
  await windows.refreshOutputs();
  await windows.setOutput('speakers');
  assert.equal(windows.state().outputId, 'speakers');
  await assert.rejects(windows.setOutput('unknown'), /available device/);
  mac.startRoute(); await settle();
  await assert.rejects(windows.setOutput(''), /Stop audio sharing/);
  macEngine.emit('event', { type: 'error', id: mac.route.id, message: 'Audio permission denied.' });
  await settle();
  assert.equal(mac.phase, 'error');
  assert.equal(mac.message, 'Audio permission denied.');
  assert.equal(windows.route, null);
});

test('unsupported or old peers cannot enable capture', async (t) => {
  const { mac, macSession } = await pair(t);
  macSession.emit('peer-message', { type: 'audio.hello', version: AUDIO_VERSION, platform: 'win32', canSend: false, canReceive: false }, 'windows');
  assert.equal(mac.state().canStart, false);
  assert.throws(() => mac.startRoute(), /rebuilt native addon/);
  assert.equal(supportsMacCapture('23.5.0'), false);
  assert.equal(supportsMacCapture('23.6.0'), true);
  assert.equal(supportsMacCapture('24.0.0'), true);
  const unavailable = new RustAudioEngine({ platform: 'darwin', release: '24.0.0' });
  assert.equal(unavailable.canSend, false);
  await assert.rejects(unavailable.send({}), /rebuilt native addon/);
});

test('Mac development launches reach native capture so macOS can request permission', async (t) => {
  const calls = [];
  class NativeAudio {
    protocolVersion() { return AUDIO_VERSION; }
    async startSender(...args) { calls.push(args); }
    stop() {}
  }
  const engine = new RustAudioEngine({ binding: { NativeAudio }, platform: 'darwin', release: '23.6.0' });
  t.after(() => engine.stop());
  const key = '42'.repeat(32);
  await engine.send({ id: 'development', key, peerIp: '192.168.1.5', port: 45123 });
  assert.deepEqual(calls, [[key, '192.168.1.5', 45123]]);
  assert.equal(engine.route.role, 'sender');
});

test('Mac native permission denial remains actionable during development', async (t) => {
  class NativeAudio {
    protocolVersion() { return AUDIO_VERSION; }
    async startSender() { throw new Error('System Audio Recording permission denied.'); }
    stop() {}
  }
  const engine = new RustAudioEngine({ binding: { NativeAudio }, platform: 'darwin', release: '24.0.0' });
  t.after(() => engine.stop());
  await assert.rejects(engine.send({ id: 'denied', key: '42'.repeat(32), peerIp: '192.168.1.5', port: 45123 }),
    /System Audio Recording permission denied/);
});

test('stale native addons cannot advertise synchronized audio support', () => {
  class NativeAudio { protocolVersion() { return 1; } }
  const engine = new RustAudioEngine({ binding: { NativeAudio }, platform: 'darwin', release: '24.0.0' });
  assert.equal(engine.available, false);
  assert.equal(engine.canSend, false);
});

test('receiving packets alone cannot report synchronized playback; the device must have played scheduled frames', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let state = { running: true, packets: 10, clockReady: true, playedFrames: 0 };
  class NativeAudio {
    protocolVersion() { return AUDIO_VERSION; }
    async startReceiver() { return 45123; }
    status() { return state; }
    stop() {}
  }
  const engine = new RustAudioEngine({ binding: { NativeAudio }, platform: 'win32' });
  t.after(() => engine.stop());
  const events = []; engine.on('event', (event) => events.push(event));
  await engine.receive({ id: 'timed', key: '42'.repeat(32), peerIp: '127.0.0.1', outputId: '' });
  t.mock.timers.tick(500);
  assert.equal(events.some((event) => event.type === 'connected'), false);
  state = { ...state, playedFrames: 240, clockReady: false }; t.mock.timers.tick(500);
  assert.equal(events.some((event) => event.type === 'connected'), false);
  state = { ...state, clockReady: true }; t.mock.timers.tick(500);
  assert.equal(events.filter((event) => event.type === 'connected').length, 1);
});

test('audio negotiation uses real encrypted sessions and their observed socket addresses in either host role', async (t) => {
  for (const macHosts of [false, true]) {
    const secret = newSecret();
    const host = new Session({ id: macHosts ? 'mac' : 'windows', name: 'Host', role: 'host', secret,
      port: 0, bindHost: '127.0.0.1', discovery: false });
    await host.start();
    const join = new Session({ id: macHosts ? 'windows' : 'mac', name: 'Join', role: 'join', secret,
      host: '127.0.0.1', port: host.port, discovery: false });
    const macSession = macHosts ? host : join;
    const windowsSession = macHosts ? join : host;
    const macEngine = new Engine(true);
    const windowsEngine = new Engine();
    const mac = new AudioRouter({ session: macSession, engine: macEngine, platform: 'darwin' });
    const windows = new AudioRouter({ session: windowsSession, engine: windowsEngine, platform: 'win32' });
    t.after(async () => { mac.stop(); windows.stop(); await join.stop(); await host.stop(); });
    mac.start(); windows.start();
    await join.start();
    await until(() => mac.state().canStart);
    assert.equal(host.peerAddress(), '127.0.0.1');
    assert.equal(join.peerAddress(), '127.0.0.1');
    mac.startRoute();
    await until(() => macEngine.calls.length > 0);
    assert.equal(macEngine.calls[0][1].key, windowsEngine.calls[0][1].key);
    windowsEngine.emit('event', { type: 'connected', id: windows.route.id });
    await until(() => mac.phase === 'streaming');
    mac.stop(); windows.stop(); await join.stop(); await host.stop();
  }
});
