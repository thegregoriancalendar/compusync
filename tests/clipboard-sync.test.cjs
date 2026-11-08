'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ClipboardSync, MAX_TEXT_BYTES, MAX_IMAGE_BYTES, digestText, cleanTextMessage, cleanImageMessage } = require('../src/main/clipboard-sync.cjs');
const { createHash } = require('node:crypto');

class FakeSession extends EventEmitter {
  constructor(role) {
    super();
    this.config = { role };
    this.phase = 'connected';
    this.sent = [];
    this.sendResult = true;
  }

  sendPeer(message) {
    this.sent.push(message);
    if (this.peer) queueMicrotask(() => this.peer.emit('peer-message', message, 'peer'));
    return this.sendResult;
  }
}

class FakeClipboard {
  constructor(text = '') {
    this.text = text;
    this.writes = [];
    this.plainText = true;
  }

  async has(type) { return type === 'text/plain' && this.plainText; }
  async readText() { return this.text; }
  async writeText(text) { this.text = text; this.writes.push(text); }
}

test('clipboard sync baselines existing text and sends only a later local copy', async () => {
  const session = new FakeSession('join');
  const clipboard = new FakeClipboard('old text');
  const sync = new ClipboardSync({ session, clipboard, intervalMs: 100000 });
  sync.start();
  await sync.poll();
  assert.equal(session.sent.length, 0);

  clipboard.text = 'new text';
  await sync.poll();
  assert.deepEqual(session.sent, [{
    type: 'clipboard.offer', digest: digestText('new text'), text: 'new text',
  }]);
  sync.stop();
});

test('host applies a peer copy once and broadcasts an ordered result without echoing it', async () => {
  const session = new FakeSession('host');
  const clipboard = new FakeClipboard('host text');
  const sync = new ClipboardSync({ session, clipboard, intervalMs: 100000 });
  sync.start();
  await sync.poll();
  session.emit('peer-message', {
    type: 'clipboard.offer', digest: digestText('peer text'), text: 'peer text',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(clipboard.writes, ['peer text']);
  assert.deepEqual(session.sent, [{
    type: 'clipboard.apply', revision: 1, digest: digestText('peer text'), text: 'peer text',
  }]);
  await sync.poll();
  assert.equal(session.sent.length, 1);
  sync.stop();
});

test('two connected services converge after copies in either direction', async () => {
  const hostSession = new FakeSession('host');
  const joinSession = new FakeSession('join');
  hostSession.peer = joinSession;
  joinSession.peer = hostSession;
  const hostClipboard = new FakeClipboard('host baseline');
  const joinClipboard = new FakeClipboard('join baseline');
  const host = new ClipboardSync({ session: hostSession, clipboard: hostClipboard, intervalMs: 100000 });
  const join = new ClipboardSync({ session: joinSession, clipboard: joinClipboard, intervalMs: 100000 });
  host.start();
  join.start();
  await Promise.all([host.poll(), join.poll()]);

  joinClipboard.text = 'copied on Windows';
  await join.poll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hostClipboard.text, 'copied on Windows');
  assert.equal(joinClipboard.text, 'copied on Windows');

  hostClipboard.text = 'copied on Mac';
  await host.poll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hostClipboard.text, 'copied on Mac');
  assert.equal(joinClipboard.text, 'copied on Mac');
  assert.deepEqual(joinClipboard.writes, ['copied on Mac']);
  host.stop();
  join.stop();
});

test('join applies only newer host revisions and disabling prevents clipboard access', async () => {
  const session = new FakeSession('join');
  const clipboard = new FakeClipboard('local');
  const sync = new ClipboardSync({ session, clipboard, enabled: false, intervalMs: 100000 });
  sync.start();
  session.emit('peer-message', {
    type: 'clipboard.apply', revision: 1, digest: digestText('remote'), text: 'remote',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(clipboard.writes, []);

  sync.setEnabled(true);
  await sync.poll();
  session.emit('peer-message', {
    type: 'clipboard.apply', revision: 2, digest: digestText('remote'), text: 'remote',
  });
  await new Promise((resolve) => setImmediate(resolve));
  session.emit('peer-message', {
    type: 'clipboard.apply', revision: 1, digest: digestText('stale'), text: 'stale',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(clipboard.writes, ['remote']);
  sync.stop();
});

test('clipboard messages reject tampering, oversized text, and non-text clipboard formats', async () => {
  assert.equal(cleanTextMessage({
    type: 'clipboard.offer', digest: digestText('safe'), text: 'changed',
  }, 'clipboard.offer'), null);
  const oversized = 'x'.repeat(MAX_TEXT_BYTES + 1);
  assert.equal(cleanTextMessage({
    type: 'clipboard.offer', digest: digestText(oversized), text: oversized,
  }, 'clipboard.offer'), null);

  const session = new FakeSession('join');
  const clipboard = new FakeClipboard('');
  clipboard.plainText = false;
  const sync = new ClipboardSync({ session, clipboard, intervalMs: 100000 });
  sync.start();
  await sync.poll();
  clipboard.text = '/local/file-that-must-not-sync';
  await sync.poll();
  assert.deepEqual(session.sent, []);
  sync.stop();
});

// Pixel digest differs from wire bytes, like a real OS re-encoding the image.
class FakeImages {
  constructor() { this.bytes = null; this.writes = 0; }
  async read() {
    if (!this.bytes) return null;
    const bytes = this.bytes;
    return { digest: createHash('sha256').update('pixels:').update(bytes).digest('hex'),
      encode: () => ({ mime: 'image/png', bytes }) };
  }
  async write(bytes) { this.bytes = Buffer.from(bytes); this.writes += 1; return (await this.read()).digest; }
}

test('screenshots copied on either side reach the other clipboard once, without echo', async () => {
  const hostSession = new FakeSession('host');
  const joinSession = new FakeSession('join');
  hostSession.peer = joinSession;
  joinSession.peer = hostSession;
  const hostClipboard = new FakeClipboard('');
  const joinClipboard = new FakeClipboard('');
  const hostImages = new FakeImages();
  const joinImages = new FakeImages();
  const host = new ClipboardSync({ session: hostSession, clipboard: hostClipboard, images: hostImages, intervalMs: 100000 });
  const join = new ClipboardSync({ session: joinSession, clipboard: joinClipboard, images: joinImages, intervalMs: 100000 });
  host.start();
  join.start();
  await Promise.all([host.poll(), join.poll()]);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

  joinImages.bytes = Buffer.from('windows screenshot');
  await join.poll();
  await settle();
  assert.deepEqual(hostImages.bytes, Buffer.from('windows screenshot'));
  assert.equal(joinImages.writes, 0);

  hostImages.bytes = Buffer.from('mac screenshot');
  await host.poll();
  await settle();
  assert.deepEqual(joinImages.bytes, Buffer.from('mac screenshot'));

  const sent = hostSession.sent.length + joinSession.sent.length;
  await Promise.all([host.poll(), join.poll()]);
  await settle();
  assert.equal(hostSession.sent.length + joinSession.sent.length, sent);

  hostClipboard.text = 'text after image';
  await host.poll();
  await settle();
  assert.equal(joinClipboard.text, 'text after image');
  host.stop();
  join.stop();
});

test('image messages reject tampered or oversized payloads', () => {
  const bytes = Buffer.from('png');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const valid = { type: 'clipboard.offer', kind: 'image', mime: 'image/png', digest, data: bytes.toString('base64') };
  assert.ok(cleanImageMessage(valid, 'clipboard.offer'));
  assert.equal(cleanImageMessage({ ...valid, data: Buffer.from('pnh').toString('base64') }, 'clipboard.offer'), null);
  assert.equal(cleanImageMessage({ ...valid, mime: 'image/svg+xml' }, 'clipboard.offer'), null);
  const big = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  assert.equal(cleanImageMessage({ ...valid, digest: createHash('sha256').update(big).digest('hex'), data: big.toString('base64') }, 'clipboard.offer'), null);
  assert.equal(cleanTextMessage(valid, 'clipboard.offer'), null);
});
