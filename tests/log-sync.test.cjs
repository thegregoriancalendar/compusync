'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { Session } = require('../src/core/session.cjs');
const { newSecret } = require('../src/core/wire.cjs');
const {
  LogSync, LOG_VERSION, MAX_BACKLOG_BYTES, MAX_CHUNK_BYTES, RETRY_INTERVAL_MS,
} = require('../src/main/log-sync.cjs');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Log sharing condition timed out.');
    await delay(10);
  }
}

const read = (file) => fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
const occurrences = (file, text) => read(file).toString('utf8').split(text).length - 1;
const packet = (type, details) => ({ type, version: LOG_VERSION, ...details });

class FakeSession extends EventEmitter {
  constructor() {
    super();
    this.self = { id: 'local', name: 'Local' };
    this.members = [this.self, { id: 'peer', name: 'Other laptop' }];
    this.phase = 'connected';
    this.dataPhase = 'connected';
    this.sent = [];
    this.sendResult = true;
  }

  sendData(message) {
    if (!this.sendResult) return false;
    this.sent.push(message);
    return true;
  }
}

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compusync-log-test-'));
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup) await close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('compusync-log-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, cleanup };
}

function fixture(t, content = 'local startup\n') {
  const { root, cleanup } = workspace(t);
  const logPath = path.join(root, 'compusync.log');
  fs.writeFileSync(logPath, content);
  const session = new FakeSession();
  const errors = [];
  const sync = new LogSync({ session, logPath, platform: 'win32', intervalMs: 100000, onError: (error) => errors.push(error) });
  sync.start();
  cleanup.push(async () => {
    sync.stop();
    await until(() => !sync.polling && !sync.receiving);
  });
  const receive = async (message, memberId = 'peer') => {
    session.emit('data', message, memberId);
    await until(() => !sync.receiving);
  };
  return { root, logPath, session, sync, errors, receive };
}

async function pair(t, hostText = 'Windows startup\n', peerText = 'Mac startup\n') {
  const { root, cleanup } = workspace(t);
  const secret = newSecret();
  const host = new Session({ platform: 'win32', id: 'windows', name: 'Windows laptop', role: 'host', port: 0, secret, discovery: false, bindHost: '127.0.0.1' });
  let peer;
  const services = [];
  const errors = [];
  cleanup.push(async () => {
    services.forEach((service) => service.stop());
    await until(() => services.every((service) => !service.polling && !service.receiving));
    await peer?.stop();
    await host.stop();
  });
  await host.start();
  peer = new Session({ platform: 'darwin', id: 'mac', name: 'Mac laptop', role: 'join', host: '127.0.0.1', port: host.port, secret, discovery: false });
  const [windows, mac] = [[host, 'win32', hostText], [peer, 'darwin', peerText]].map(([session, platform, text]) => {
    const directory = path.join(root, platform);
    fs.mkdirSync(directory);
    const logPath = path.join(directory, 'compusync.log');
    fs.writeFileSync(logPath, text);
    const service = new LogSync({ session, logPath, platform, intervalMs: 10, onError: (error) => errors.push(error) });
    services.push(service);
    service.start();
    return service;
  });
  await peer.start();
  await until(() => host.dataPhase === 'connected' && peer.dataPhase === 'connected');
  return { host, peer, windows, mac, errors };
}

test('paired encrypted sessions share startup and live logs in both directions without echoing', async (t) => {
  // Split an emoji across two byte chunks to verify lossless UTF-8 transport.
  const macText = `${'m'.repeat(MAX_CHUNK_BYTES - 1)}🌐 Mac startup\n`;
  const { windows, mac, errors } = await pair(t, 'Windows startup\n', macText);
  await until(() => read(windows.peerLogPath).includes(Buffer.from(macText)) && read(mac.peerLogPath).includes(Buffer.from('Windows startup\n')));
  assert.match(read(windows.peerLogPath).toString(), /"platform":"darwin"/);
  assert.match(read(mac.peerLogPath).toString(), /"platform":"win32"/);
  assert.match(read(windows.peerLogPath).toString(), /"peer":"mac"/);

  fs.appendFileSync(windows.logPath, 'Windows live error\n');
  fs.appendFileSync(mac.logPath, 'Mac live native error\n');
  await until(() => read(windows.peerLogPath).includes(Buffer.from('Mac live native error\n')) && read(mac.peerLogPath).includes(Buffer.from('Windows live error\n')));
  assert.equal(read(windows.peerLogPath).includes(Buffer.from('Windows live error')), false);
  assert.equal(read(mac.peerLogPath).includes(Buffer.from('Mac live native error')), false);
  assert.equal(occurrences(windows.peerLogPath, 'Mac live native error'), 1);
  assert.equal(occurrences(mac.peerLogPath, 'Windows live error'), 1);
  assert.deepEqual(errors, []);
});

test('a lost acknowledgement retries bytes without duplicating the peer log', async (t) => {
  const { host, windows, mac } = await pair(t);
  const send = host.sendData.bind(host);
  let dropped = false;
  host.sendData = (message) => {
    if (!dropped && message.type === 'logs.request' && message.offset > 0) {
      dropped = true;
      return true;
    }
    return send(message);
  };
  await until(() => dropped && mac.requestedOffset === fs.statSync(mac.logPath).size, RETRY_INTERVAL_MS + 5000);
  assert.equal(occurrences(windows.peerLogPath, 'Mac startup'), 1);
});

test('reconnecting resumes both log streams and includes output produced while disconnected', async (t) => {
  const { host, peer, windows, mac } = await pair(t);
  await until(() => windows.requestedOffset === fs.statSync(windows.logPath).size && mac.requestedOffset === fs.statSync(mac.logPath).size);
  peer.socket.terminate();
  await until(() => host.phase !== 'connected' && peer.phase !== 'connected');
  fs.appendFileSync(windows.logPath, 'Windows offline output\n');
  fs.appendFileSync(mac.logPath, 'Mac offline output\n');
  try {
    await until(() => read(windows.peerLogPath).includes(Buffer.from('Mac offline output\n')) && read(mac.peerLogPath).includes(Buffer.from('Windows offline output\n')));
  } catch (error) {
    error.message += JSON.stringify({
      host: host.status(), peer: peer.status(), data: [host.dataPhase, peer.dataPhase],
      offsets: [windows.requestedOffset, mac.requestedOffset],
      windows: read(windows.peerLogPath).toString(), mac: read(mac.peerLogPath).toString(),
    });
    throw error;
  }
  assert.equal(occurrences(windows.peerLogPath, 'Mac startup'), 1);
  assert.equal(occurrences(mac.peerLogPath, 'Windows startup'), 1);
  assert.equal(occurrences(windows.peerLogPath, 'Mac offline output'), 1);
});

test('catch-up is bounded and source truncation starts a new stream', async (t) => {
  const old = 'omit this old log\n';
  const recent = 'r'.repeat(MAX_BACKLOG_BYTES - 20) + '\nrecent end\n';
  const text = old + 'x'.repeat(100) + recent;
  const { mac, windows } = await pair(t, 'Windows startup\n', text);
  await until(() => mac.requestedOffset === Buffer.byteLength(text));
  const received = read(windows.peerLogPath).toString();
  assert.equal(received.includes(old), false);
  assert.ok(received.endsWith(text.slice(-MAX_BACKLOG_BYTES)));
  assert.match(received, new RegExp(`"skippedBytes":${Buffer.byteLength(text) - MAX_BACKLOG_BYTES}`));
  const stream = mac.stream;
  fs.writeFileSync(mac.logPath, 'Mac log after truncation\n');
  await until(() => read(windows.peerLogPath).includes(Buffer.from('Mac log after truncation\n')));
  assert.notEqual(mac.stream, stream);
  assert.equal(occurrences(windows.peerLogPath, 'Mac log after truncation'), 1);
});

test('validation rejects unknown peers, malformed or oversized chunks, and deduplicates retries', async (t) => {
  const { sync, receive } = fixture(t);
  const stream = randomUUID();
  const hello = packet('logs.hello', { stream, platform: 'darwin', start: 0, end: 100 });
  await receive(hello, 'unpaired');
  await receive({ ...hello, version: 999 });
  await receive({ ...hello, start: -1 });
  await receive({ ...hello, platform: '../../elsewhere' });
  assert.equal(fs.existsSync(sync.peerLogPath), false);
  await receive(hello);
  const before = read(sync.peerLogPath);
  for (const data of ['!!!', Buffer.alloc(MAX_CHUNK_BYTES + 1).toString('base64'), 'YQ']) {
    await receive(packet('logs.chunk', { stream, offset: 0, data }));
  }
  await receive(packet('logs.chunk', { stream: randomUUID(), offset: 0, data: 'YQ==' }));
  await receive(packet('logs.chunk', { stream, offset: 8, data: 'YQ==' }));
  assert.deepEqual(read(sync.peerLogPath), before);
  const chunk = packet('logs.chunk', { stream, offset: 0, data: Buffer.from('one remote line\n').toString('base64') });
  await receive(chunk);
  await receive(chunk);
  assert.equal(occurrences(sync.peerLogPath, 'one remote line'), 1);
});

test('backpressure retains the byte offset and stopped or disconnected services do no work', async (t) => {
  const { sync, session, receive, errors } = fixture(t);
  await until(() => !sync.polling);
  await receive(packet('logs.request', { stream: sync.stream, offset: 0 }));
  session.sendResult = false;
  assert.equal(await sync.poll(), false);
  assert.equal(sync.requestedOffset, 0);
  session.sendResult = true;
  assert.equal(await sync.poll(), true);
  const chunk = session.sent.find((message) => message.type === 'logs.chunk');
  assert.equal(Buffer.from(chunk.data, 'base64').toString(), 'local startup\n');
  session.phase = 'reconnecting';
  session.emit('status', { phase: 'reconnecting' });
  assert.equal(await sync.poll(), false);
  assert.equal(sync.requestedOffset, null);
  sync.stop();
  assert.equal(session.listenerCount('data'), 0);
  assert.equal(session.listenerCount('status'), 0);
  assert.equal(session.listenerCount('data-status'), 0);
  assert.deepEqual(errors, []);
});

test('receiver disk failures are contained and the same chunk succeeds after recovery', async (t) => {
  const { sync, receive, errors } = fixture(t);
  const stream = randomUUID();
  const hello = packet('logs.hello', { stream, platform: 'darwin', start: 0, end: 30 });
  fs.mkdirSync(sync.peerLogPath);
  await receive(hello);
  await receive(hello);
  assert.equal(errors.length, 1);
  assert.equal(sync.remote, null);
  fs.rmdirSync(sync.peerLogPath);
  await receive(hello);
  const chunk = packet('logs.chunk', { stream, offset: 0, data: Buffer.from('retry after disk failure\n').toString('base64') });
  await receive(chunk);
  assert.equal(occurrences(sync.peerLogPath, 'retry after disk failure'), 1);
});
