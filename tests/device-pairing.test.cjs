'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Session } = require('../src/core/session.cjs');
const { claimCode, pairWithCode } = require('../src/core/pairing.cjs');
const { advertise, discover } = require('../src/core/discovery.cjs');
const { newSecret } = require('../src/core/wire.cjs');
const { AudioRouter } = require('../src/main/audio-router.cjs');
const { derivePairPlacements } = require('../src/main/runtime.cjs');
const { stereoAssignment, snapDragged, arrangeDiagram } = require('../src/renderer/screen-layout.js');
const { normalizeMember, deviceSlots, deviceLabel } = require('../src/shared/devices.js');
const { sanitizeAudioMessage, AUDIO_VERSION } = require('../src/core/audio-contract.cjs');

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Pair condition timed out.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function layout(platform, width = 1440) {
  return { revision: 1, platform, edge: 'right', activeDisplayId: 'main',
    displays: [{ id: 'main', primary: true, scaleFactor: 2,
      bounds: { x: 0, y: 0, width, height: 900 }, workArea: { x: 0, y: 25, width, height: 875 } }] };
}
async function hostFor(t, platform) {
  const host = new Session({ id: 'laptop-one', name: 'My laptop', platform, role: 'host', port: 0,
    bindHost: '127.0.0.1', secret: newSecret(), layout: layout(platform), discovery: false });
  await host.start(); t.after(() => host.stop());
  return host;
}
async function connectPair(t, hostPlatform, peerPlatform) {
  const host = await hostFor(t, hostPlatform);
  const paired = await claimCode({ host: '127.0.0.1', port: host.port }, host.invitation().code, { platform: peerPlatform });
  assert.deepEqual(paired.peer, host.self);
  const peer = new Session({ ...paired, id: 'laptop-two', name: 'My laptop', platform: peerPlatform,
    role: 'join', discovery: false, layout: layout(peerPlatform, 1920) });
  t.after(() => peer.stop());
  peer.on('status', () => { if (peer.phase === 'connected') peer.action({ type: 'layout', layout: peer.config.layout }); });
  await peer.start();
  await until(() => peer.phase === 'connected' && Object.keys(host.state.layouts).length === 2 && Object.keys(peer.state.layouts).length === 2);
  return { host, peer };
}

test('pairing and saved reconnect advertise both device types in every supported host direction', async (t) => {
  for (const [first, second] of [['darwin', 'darwin'], ['darwin', 'win32'], ['win32', 'darwin']]) {
    await t.test(`${first} hosts ${second}`, async (t) => {
      const { host, peer } = await connectPair(t, first, second);
      assert.deepEqual(host.members, peer.members);
      assert.deepEqual(host.members.map((member) => member.platform), [first, second]);
      assert.equal(host.status().peers[0].platform, second);
      host.connections.get(peer.self.id).socket.terminate();
      await until(() => peer.phase === 'reconnecting');
      await until(() => peer.phase === 'connected');
      assert.deepEqual(host.members, peer.members);
      assert.deepEqual(peer.members.map((member) => member.platform), [first, second]);
    });
  }
});

test('Windows-to-Windows rejects code claims and saved sessions without consuming the code', async (t) => {
  const host = await hostFor(t, 'win32');
  const code = host.invitation().code;
  await assert.rejects(pairWithCode(code, { platform: 'win32', address: '127.0.0.1', port: host.port }), /Windows-to-Windows is not supported yet/);
  assert.equal(host.invitation().code, code);
  const peer = new Session({ id: 'second-windows', name: 'Windows', platform: 'win32', role: 'join',
    host: '127.0.0.1', port: host.port, secret: host.config.secret });
  t.after(() => peer.stop()); await peer.start();
  await until(() => peer.phase === 'error');
  assert.match(peer.message, /Windows-to-Windows/);
  assert.equal(peer.retryTimer, undefined);
  assert.equal(host.members.length, 1);
  assert.equal(host.invitation().code, code);
});

test('LAN discovery announces OS without secrets; malformed member platforms are rejected', async (t) => {
  const host = await hostFor(t, 'darwin');
  const beacon = await advertise(() => ({ id: host.self.id, port: host.port, platform: host.self.platform }), { port: 0 });
  t.after(() => beacon.stop());
  assert.deepEqual(await discover({ port: beacon.port, destinations: ['127.0.0.1'], timeout: 80 }),
    [{ host: '127.0.0.1', port: host.port, platform: 'darwin' }]);
  assert.equal(normalizeMember({ id: 'x', name: 'Mac', platform: 'linux' }), null);
  assert.deepEqual(normalizeMember({ id: 'x', name: 'Mac', platform: 'darwin', secret: 'hidden' }),
    { id: 'x', name: 'Mac', platform: 'darwin' });
});

test('two Macs keep distinct, consistently ordered layouts and channels even with identical names', () => {
  const members = [{ id: 'host-mac', name: 'MacBook', platform: 'darwin' }, { id: 'join-mac', name: 'MacBook', platform: 'darwin' }];
  const layouts = { 'join-mac': layout('darwin', 1920), 'host-mac': layout('darwin') };
  const slots = deviceSlots(members, layouts);
  assert.equal(deviceLabel(slots.mac, slots), 'Mac 1');
  assert.equal(deviceLabel(slots.windows, slots), 'Mac 2');
  for (const position of ['left', 'right', 'top']) {
    const settings = { macPosition: position, displayOffset: 0 };
    const placements = derivePairPlacements(layouts, 'host-mac', 'join-mac', settings);
    assert.deepEqual(placements.map((placement) => placement.platform), ['darwin', 'darwin']);
    assert.equal(placements[0].origin.x, position === 'right' ? 1920 : -1440);
    assert.equal(placements[1].origin.x, 0);
    const channels = stereoAssignment(layouts, settings, members).channels;
    assert.equal(channels['host-mac'], position === 'right' ? 'right' : 'left');
    assert.notEqual(channels['host-mac'], channels['join-mac']);
  }
  const rects = arrangeDiagram(500, 300, 'left', 0);
  assert.notEqual(snapDragged('mac', { x: rects.windows.x, y: -500 }, rects, false).macPosition, 'top');
  assert.deepEqual(derivePairPlacements({ a: layout('win32'), b: layout('win32') }, 'a', 'b', {}), []);
});

class Engine extends EventEmitter {
  constructor(level) {
    super(); this.available = this.canSend = this.supportsStereoSplit = true;
    this.level = level; this.calls = []; this.channels = [];
  }
  volume() { return { level: this.level, muted: this.level === 0, label: 'Speakers' }; }
  setVolume(_id, level) { this.level = level; return this.volume(); }
  routingStatus() { return { ready: true, buses: [] }; }
  async listOutputs() {}
  async receive(options) { this.calls.push(options); return 45123; }
  async send(options) { this.calls.push(options); }
  setPlaybackChannel(channel) { this.channels.push(channel); }
  stop() {}
}

test('two Macs negotiate both audio directions, separate volumes, live channel swaps, and disconnect recovery', async (t) => {
  const { host, peer } = await connectPair(t, 'darwin', 'darwin');
  const firstEngine = new Engine(25), secondEngine = new Engine(70);
  const first = new AudioRouter({ session: host, engine: firstEngine, platform: 'darwin' });
  const second = new AudioRouter({ session: peer, engine: secondEngine, platform: 'darwin' });
  t.after(() => { first.stop(); second.stop(); }); first.start(); second.start();
  await until(() => first.peerVolume && second.peerVolume);
  assert.deepEqual(first.state().volumes, second.state().volumes);
  await first.setVolume(peer.self.id, 43);
  assert.equal(firstEngine.level, 25); assert.equal(secondEngine.level, 43);
  await second.setVolume(host.self.id, 11);
  assert.equal(firstEngine.level, 11); assert.equal(secondEngine.level, 43);
  await assert.rejects(first.setVolume('darwin', 30), /Choose a laptop/);
  for (const source of [first, second]) {
    for (const mode of ['stereo', 'split-stereo']) {
      source.setPlaybackMode(mode); source.startRoute();
      await until(() => firstEngine.calls.length && secondEngine.calls.length && source.route?.ready);
      assert.equal(firstEngine.calls.at(-1).channel, mode === 'stereo' ? 'stereo' : 'left');
      assert.equal(secondEngine.calls.at(-1).channel, mode === 'stereo' ? 'stereo' : 'right');
      const receiver = source === first ? second : first;
      if (mode === 'split-stereo') {
        const id = source.route.id;
        const receiverEngine = source === first ? secondEngine : firstEngine;
        const changes = receiverEngine.channels.length;
        receiver.receive({ type: 'audio.channels', id, mode, channelBasis: 'device',
          channels: { [host.self.id]: 'right', stranger: 'left' } }, source.session.self.id);
        assert.equal(receiverEngine.channels.length, changes);
        source.layoutChanged({ macPosition: 'right' });
        await until(() => receiver.route.channels[host.self.id] === 'right');
        assert.equal(source.route.id, id);
        assert.equal(firstEngine.channels.at(-1), 'right');
        assert.equal(secondEngine.channels.at(-1), 'left');
        source.layoutChanged({ macPosition: 'left' });
        await until(() => receiver.route.channels[host.self.id] === 'left');
      }
      source.stopRoute(); await until(() => !receiver.route);
      firstEngine.calls = []; secondEngine.calls = [];
    }
  }
  first.startRoute(); await until(() => second.route);
  host.connections.get(peer.self.id).socket.terminate();
  await until(() => !first.connected && !second.connected);
  assert.equal(first.route, null); assert.equal(second.route, null);
  assert.equal(first.peerVolume, null); assert.equal(second.peerVolume, null);
});

test('mixed pairs retain split stereo with an older peer using platform-based channels', async (t) => {
  const { host, peer } = await connectPair(t, 'win32', 'darwin');
  const windowsEngine = new Engine(20), macEngine = new Engine(30);
  const windows = new AudioRouter({ session: host, engine: windowsEngine, platform: 'win32' });
  const mac = new AudioRouter({ session: peer, engine: macEngine, platform: 'darwin' });
  t.after(() => { windows.stop(); mac.stop(); }); windows.start(); mac.start();
  await until(() => windows.peer && mac.peer);
  for (const router of [windows, mac]) {
    router.receive({ ...router.peer, deviceRouting: false }, router.session.members.find((member) => member.id !== router.session.self.id).id);
  }
  windows.setPlaybackMode('split-stereo'); windows.startRoute();
  await until(() => windowsEngine.calls.length && macEngine.calls.length);
  assert.equal(windows.route.channelBasis, undefined);
  assert.deepEqual(windows.route.channels, { mac: 'left', windows: 'right' });
  assert.equal(windowsEngine.calls[0].channel, 'right');
  assert.equal(macEngine.calls[0].channel, 'left');
  assert.deepEqual(mac.state().stereoSplit.channels, { [peer.self.id]: 'left', [host.self.id]: 'right' });
  windows.layoutChanged({ macPosition: 'right' });
  await until(() => macEngine.channels.at(-1) === 'right');
  assert.equal(windowsEngine.channels.at(-1), 'left');
});

test('device channel messages reject ambiguous or malformed assignments', () => {
  const offer = { type: 'audio.offer', id: 'route', mode: 'split-stereo', channelBasis: 'device' };
  for (const channels of [{ a: 'left' }, { a: 'left', b: 'left' }, { a: 'left', b: 'right', c: 'left' }, { 'bad/id': 'left', b: 'right' }]) {
    assert.equal(sanitizeAudioMessage({ ...offer, channels }), null);
  }
  const valid = { ...offer, channels: { 'mac-one': 'left', 'mac-two': 'right' } };
  assert.deepEqual(sanitizeAudioMessage(valid), valid);
  assert.equal(sanitizeAudioMessage({ type: 'audio.hello', version: AUDIO_VERSION, platform: 'darwin', canSend: true, canReceive: true, deviceRouting: 'yes' }), null);
});
