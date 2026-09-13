'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ClipboardSync, MAX_TEXT_BYTES, digestText, cleanTextMessage } = require('../src/main/clipboard-sync.cjs');

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
