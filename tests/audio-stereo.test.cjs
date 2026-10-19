'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AudioRouter } = require('../src/main/audio-router.cjs');
const { RustAudioEngine } = require('../src/main/audio-engine.cjs');
const { AUDIO_VERSION, sanitizeAudioMessage } = require('../src/core/audio-contract.cjs');
const { stereoAssignment } = require('../src/renderer/screen-layout.js');

const settle = () => new Promise((resolve) => setImmediate(resolve));
const display = (id, x = 0, primary = true, width = 1920) => ({
  id, primary, bounds: { x, y: 0, width, height: 1080 },
});
const layouts = () => ({
  mac: { platform: 'darwin', displays: [display('mac')] },
  windows: { platform: 'win32', displays: [display('windows')] },
});

async function pair(t) {
  class Peer extends EventEmitter {
    constructor(id) {
      super(); this.self = { id }; this.phase = 'connected'; this.state = { layouts: layouts() };
      this.members = [{ id: 'mac' }, { id: 'windows' }]; this.sent = [];
    }
    peerAddress() { return '127.0.0.1'; }
    sendPeer(message) {
      this.sent.push(message);
      queueMicrotask(() => this.other.emit('peer-message', message, this.self.id));
      return true;
    }
  }
  class Engine extends EventEmitter {
    constructor() { super(); this.available = true; this.canSend = true; this.supportsStereoSplit = true; this.calls = []; this.channels = []; }
    routingStatus() { return { ready: true, buses: [], outputId: 'speakers' }; }
    async listOutputs() {}
    async receive(options) { this.calls.push(options); return this.pending || 45123; }
    async send(options) { this.calls.push(options); }
    setPlaybackChannel(channel) { this.channels.push(channel); }
    stop() {}
  }
  const macSession = new Peer('mac'), windowsSession = new Peer('windows');
  macSession.other = windowsSession; windowsSession.other = macSession;
  const macEngine = new Engine(), windowsEngine = new Engine();
  const mac = new AudioRouter({ session: macSession, engine: macEngine, platform: 'darwin' });
  const windows = new AudioRouter({ session: windowsSession, engine: windowsEngine, platform: 'win32' });
  mac.start(); windows.start();
  t.after(() => { mac.stop(); windows.stop(); });
  await settle();
  return { mac, windows, macEngine, windowsEngine, macSession, windowsSession };
}

test('stereo assignment follows main displays, horizontal offsets, and secondary monitor geometry', () => {
  const value = layouts();
  assert.deepEqual(stereoAssignment(value, { macPosition: 'left' }).channels, { mac: 'left', windows: 'right' });
  assert.deepEqual(stereoAssignment(value, { macPosition: 'right' }).channels, { mac: 'right', windows: 'left' });
  assert.equal(stereoAssignment(value, { macPosition: 'top' }).ready, false);
  assert.equal(stereoAssignment(value, { macPosition: 'top', displayOffset: -0.5 }).channels.mac, 'left');
  assert.equal(stereoAssignment(value, { macPosition: 'top', displayOffset: 0.5 }).channels.mac, 'right');
  // Computer groups are centered, but the Mac's main display is on the right
  // of its own group. Assignment must use the main display, not group center.
  value.mac.displays.unshift(display('secondary', -1920, false));
  assert.equal(stereoAssignment(value, { macPosition: 'top' }).channels.mac, 'right');
  value.mac.displays[0].primary = true;
  value.mac.displays[1].primary = false;
  assert.equal(stereoAssignment(value, { macPosition: 'top' }).channels.mac, 'left');
  assert.equal(stereoAssignment({}).ready, false);
  value.mac.displays = [];
  assert.equal(stereoAssignment(value).ready, false);
});

test('split negotiation validates complementary channels and preserves legacy stereo offers', () => {
  const offer = { type: 'audio.offer', id: 'route', mode: 'split-stereo', channels: { mac: 'left', windows: 'right', extra: true } };
  assert.deepEqual(sanitizeAudioMessage(offer), { ...offer, channels: { mac: 'left', windows: 'right' } });
  for (const channels of [undefined, {}, { mac: 'left', windows: 'left' }, { mac: 'stereo', windows: 'right' }]) {
    assert.equal(sanitizeAudioMessage({ ...offer, channels }), null);
  }
  assert.equal(sanitizeAudioMessage({ ...offer, mode: 'unknown' }), null);
  assert.equal(sanitizeAudioMessage({ type: 'audio.channels', id: 'route', mode: 'stereo' }), null);
  assert.deepEqual(sanitizeAudioMessage({ type: 'audio.offer', id: 'route' }), { type: 'audio.offer', id: 'route' });
});

test('either source negotiates opposite native channels and stereo is restored for the next route', async (t) => {
  const pairValue = await pair(t);
  const { mac, windows, macEngine, windowsEngine } = pairValue;
  for (const [source, receiver] of [[mac, windows], [windows, mac]]) {
    source.setPlaybackMode('split-stereo');
    source.startRoute(); await settle();
    assert.equal(macEngine.calls.at(-1).channel, 'left');
    assert.equal(windowsEngine.calls.at(-1).channel, 'right');
    assert.equal(receiver.state().playbackMode, 'split-stereo');
    assert.throws(() => source.setPlaybackMode('stereo'), /Stop audio/);
    receiver.stopRoute(); await settle();
    source.setPlaybackMode('stereo'); source.startRoute(); await settle();
    assert.equal(macEngine.calls.at(-1).channel, 'stereo');
    assert.equal(windowsEngine.calls.at(-1).channel, 'stereo');
    source.stopRoute(); await settle();
  }
});

test('layout changes swap active channels without capture restart; aligned primaries stop both outputs', async (t) => {
  const { mac, windows, macEngine, windowsEngine, macSession } = await pair(t);
  mac.setPlaybackMode('split-stereo'); mac.startRoute(); await settle();
  const id = mac.route.id;
  mac.layoutChanged({ macPosition: 'right' }); await settle();
  assert.equal(mac.route.id, id);
  assert.equal(macEngine.calls.length, 1); assert.equal(windowsEngine.calls.length, 1);
  assert.deepEqual(macEngine.channels, ['right']); assert.deepEqual(windowsEngine.channels, ['left']);
  assert.deepEqual(mac.state().stereoSplit.channels, windows.state().stereoSplit.channels);
  // Changes to the OS primary monitor arrive through shared layout state.
  mac.layoutChanged({ macPosition: 'top', displayOffset: 0.5 }); await settle();
  macSession.state.layouts.mac.displays.push(display('secondary', 1920, false, 10000));
  macSession.state.layouts.mac.revision = 1;
  macSession.emit('state'); await settle();
  assert.equal(mac.route.channels.mac, 'left');
  assert.equal(windowsEngine.channels.at(-1), 'right');
  macSession.state.layouts = layouts();
  mac.layoutChanged({ macPosition: 'top', displayOffset: 0 }); await settle();
  assert.equal(mac.route, null); assert.equal(windows.route, null);
  assert.match(mac.state().stereoSplit.reason, /horizontally aligned/);
  assert.equal(mac.state().canStart, false);
});

test('foreign, stale and receiver-originated channel updates cannot change the active assignment', async (t) => {
  const { mac, windows, macEngine, windowsEngine, macSession, windowsSession } = await pair(t);
  mac.setPlaybackMode('split-stereo'); mac.startRoute(); await settle();
  const message = { type: 'audio.channels', id: mac.route.id, mode: 'split-stereo', channels: { mac: 'right', windows: 'left' } };
  windowsSession.emit('peer-message', message, 'stranger');
  windowsSession.emit('peer-message', { ...message, id: 'stale' }, 'mac');
  macSession.emit('peer-message', message, 'windows');
  assert.equal(macEngine.channels.length, 0); assert.equal(windowsEngine.channels.length, 0);
});

test('layout swaps during receiver preparation use the latest source channel and cancellation ignores late readiness', async (t) => {
  const { mac, windows, macEngine, windowsEngine, windowsSession } = await pair(t);
  let ready;
  windowsEngine.pending = new Promise((resolve) => { ready = resolve; });
  mac.setPlaybackMode('split-stereo'); mac.startRoute(); await settle();
  mac.layoutChanged({ macPosition: 'right' }); await settle();
  assert.equal(windowsEngine.channels.at(-1), 'left');
  ready(45123); await settle();
  assert.equal(macEngine.calls[0].channel, 'right');
  mac.stopRoute(); await settle();
  windowsEngine.pending = new Promise((resolve) => { ready = resolve; });
  mac.startRoute(); await settle();
  const cancelledId = mac.route.id;
  mac.stopRoute(); await settle(); ready(45123); await settle();
  assert.equal(mac.route, null); assert.equal(windows.route, null);
  assert.equal(windowsSession.sent.some((message) => message.type === 'audio.ready' && message.id === cancelledId), false);
  assert.equal(macEngine.calls.length, 1);
});

test('missing capabilities and missing layouts block split stereo without preventing full stereo', async (t) => {
  const { mac, windows, macEngine, windowsEngine, macSession } = await pair(t);
  macSession.emit('peer-message', { type: 'audio.hello', version: AUDIO_VERSION, platform: 'win32', canSend: true, canReceive: true }, 'windows');
  mac.setPlaybackMode('split-stereo');
  assert.equal(mac.state().canStart, false);
  assert.throws(() => mac.startRoute(), /rebuild/);
  mac.setPlaybackMode('stereo'); mac.startRoute(); await settle();
  assert.equal(macEngine.calls.at(-1).channel, 'stereo');
  assert.equal(windowsEngine.calls.at(-1).channel, 'stereo');
  mac.stopRoute(); await settle();
  windowsEngine.supportsStereoSplit = false;
  assert.throws(() => windows.setPlaybackMode('split-stereo'), /native addon/);
  windows.session.emit('peer-message', { type: 'audio.offer', id: 'unsupported', mode: 'split-stereo', channels: { mac: 'left', windows: 'right' } }, 'mac');
  await settle();
  assert.equal(windows.route, null);
  macSession.state.layouts = {};
  mac.peer.stereoSplit = true;
  mac.setPlaybackMode('split-stereo');
  assert.throws(() => mac.startRoute(), /main displays/);
});

test('native engine applies channel selection before start, preserves pending layout changes, and resets on stop', async (t) => {
  const calls = [];
  class NativeAudio {
    protocolVersion() { return AUDIO_VERSION; }
    setPlaybackChannel(channel) { calls.push(channel); }
    async startReceiver() { calls.push('start'); return 45123; }
    stop() { calls.push('stop'); }
  }
  const engine = new RustAudioEngine({ binding: { NativeAudio }, platform: 'win32' });
  t.after(() => engine.stop());
  let prepare;
  engine.prepareRouting = () => new Promise((resolve) => { prepare = resolve; });
  const pending = engine.receive({ id: 'route', key: '42'.repeat(32), peerIp: '127.0.0.1', outputId: '', channel: 'left' });
  engine.setPlaybackChannel('right'); prepare(); await pending;
  assert.deepEqual(calls, ['right', 'right', 'start']);
  engine.stop();
  assert.deepEqual(calls.slice(-2), ['stop', 'stereo']);
  const oldEngine = new RustAudioEngine({ binding: { NativeAudio: class { protocolVersion() { return AUDIO_VERSION; } } }, platform: 'win32' });
  assert.equal(oldEngine.supportsStereoSplit, false);
  assert.throws(() => oldEngine.setPlaybackChannel('left'), /Rebuild/);
  assert.doesNotThrow(() => oldEngine.setPlaybackChannel('stereo'));
});
