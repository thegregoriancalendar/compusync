'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Session } = require('../src/core/session.cjs');
const { newSecret } = require('../src/core/wire.cjs');
const {
  FileTransfer, validateRelativePath, sanitizeSegment, collisionName,
} = require('../src/core/file-transfer.cjs');

const GiB = 1024 ** 3;

async function until(predicate, timeout = 10000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Condition timed out.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function tempDir(t, label) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), `compusync-${label}-`));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function pairSessions(t) {
  const secret = newSecret();
  const host = new Session({ id: 'host-mac', name: 'Host', role: 'host', port: 0, bindHost: '127.0.0.1', secret, discovery: false, platform: 'darwin' });
  await host.start();
  const join = new Session({ id: 'join-mac', name: 'Join', role: 'join', host: '127.0.0.1', port: host.port, secret, discovery: false, platform: 'darwin' });
  t.after(async () => { await join.stop(); await host.stop(); });
  await join.start();
  await until(() => join.phase === 'connected' && host.dataPhase === 'connected' && join.dataPhase === 'connected');
  const sender = new FileTransfer({ session: join });
  const receiver = new FileTransfer({ session: host });
  sender.start();
  receiver.start();
  t.after(async () => { await sender.stop(); await receiver.stop(); });
  return { host, join, sender, receiver };
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk);
  return hash.digest('hex');
}

async function listTree(root) {
  const out = [];
  const visit = async (directory, prefix) => {
    for (const entry of (await fsp.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push(entry.isDirectory() ? `${relative}/` : relative);
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);
    }
  };
  await visit(root, '');
  return out;
}

// Offer on one side and accept on the other the way the drag glue does.
function transfer(sender, receiver, paths, target) {
  const offered = new Promise((resolve) => receiver.once('offer', resolve));
  const id = sender.offer(paths);
  return offered.then(async (offer) => {
    assert.equal(offer.id, id);
    await receiver.accept(offer.id, target);
    return id;
  });
}

const outcome = (engine) => new Promise((resolve) => {
  const done = (value) => { engine.off('complete', complete); engine.off('failed', failed); resolve(value); };
  const complete = (value) => done({ ok: true, ...value });
  const failed = (value) => done({ ok: false, ...value });
  engine.on('complete', complete);
  engine.on('failed', failed);
});

test('relative paths cannot name anything outside the destination', () => {
  for (const bad of ['', '/etc/passwd', '\\\\server\\share', 'C:\\Windows', 'c:', 'D:/data', '../x', 'a/../../b', 'a//b', './a', 'a/./b', 'a\0b', `${'a/'.repeat(200)}b`]) {
    assert.throws(() => validateRelativePath(bad), { code: 'INVALID_PATH' }, bad);
  }
  assert.deepEqual(validateRelativePath('Photos/2026 trip/IMG 1.HEIC'), ['Photos', '2026 trip', 'IMG 1.HEIC']);
});

test('segments are made legal for the receiving file system', () => {
  assert.equal(sanitizeSegment('a:b*?"<>|.txt', 'win32'), 'a_b______.txt');
  assert.equal(sanitizeSegment('back\\slash', 'win32'), 'back_slash');
  assert.equal(sanitizeSegment('CON', 'win32'), '_CON');
  assert.equal(sanitizeSegment('nul.txt', 'win32'), '_nul.txt');
  assert.equal(sanitizeSegment('trailing. . ', 'win32'), 'trailing');
  assert.equal(sanitizeSegment('...', 'win32'), '_');
  assert.equal(sanitizeSegment('tab\there', 'darwin'), 'tab_here');
  assert.equal(sanitizeSegment('a:b', 'darwin'), 'a:b');
  const long = sanitizeSegment(`${'é'.repeat(200)}.txt`, 'darwin');
  assert.ok(Buffer.byteLength(long) <= 255);
  assert.ok(long.endsWith('.txt'));
});

test('collision names append a counter before the extension', () => {
  assert.equal(collisionName('report.pdf', 0), 'report.pdf');
  assert.equal(collisionName('report.pdf', 1), 'report (1).pdf');
  assert.equal(collisionName('report.pdf', 2), 'report (2).pdf');
  assert.equal(collisionName('.env', 1), '.env (1)');
  assert.equal(collisionName('v1.2', 1, true), 'v1.2 (1)');
  const long = collisionName(`${'x'.repeat(251)}.txt`, 12);
  assert.ok(Buffer.byteLength(long) <= 255);
  assert.ok(long.endsWith(' (12).txt'));
});

test('a >1 GiB file and a nested folder stream across a real session without overwriting', { timeout: 180000 }, async (t) => {
  const source = await tempDir(t, 'src');
  const target = await tempDir(t, 'dst');
  const big = path.join(source, 'big.bin');
  // Sparse: 1.1 GiB of mostly zeros plus a marked tail so order matters.
  const handle = await fsp.open(big, 'w');
  await handle.truncate(Math.floor(1.1 * GiB));
  await handle.write(Buffer.from('compusync-head'), 0, 14, 4096);
  await handle.write(Buffer.from('compusync-tail'), 0, 14, Math.floor(1.1 * GiB) - 14);
  await handle.close();
  const folder = path.join(source, 'Project');
  await fsp.mkdir(path.join(folder, 'src', 'deep'), { recursive: true });
  await fsp.mkdir(path.join(folder, 'empty-dir'));
  await fsp.writeFile(path.join(folder, 'README.md'), '# hello\n');
  await fsp.writeFile(path.join(folder, 'src', 'main.js'), 'console.log(1);\n');
  await fsp.writeFile(path.join(folder, 'src', 'deep', 'empty.txt'), '');
  await fsp.writeFile(path.join(folder, 'run.sh'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
  // Pre-existing items with the same names must survive untouched.
  await fsp.writeFile(path.join(target, 'big.bin'), 'keep me');
  await fsp.mkdir(path.join(target, 'Project'));
  await fsp.writeFile(path.join(target, 'Project', 'mine.txt'), 'mine');

  const { sender, receiver } = await pairSessions(t);
  const progress = [];
  receiver.on('progress', (state) => progress.push(state));
  const received = outcome(receiver);
  const sent = outcome(sender);
  await transfer(sender, receiver, [big, folder], target);
  const [done, senderDone] = await Promise.all([received, sent]);

  assert.equal(done.ok, true, done.reason);
  assert.equal(senderDone.ok, true, senderDone.reason);
  assert.deepEqual(done.paths, [path.join(target, 'big (1).bin'), path.join(target, 'Project (1)')]);
  assert.equal(done.files, 5);
  assert.equal(await fsp.readFile(path.join(target, 'big.bin'), 'utf8'), 'keep me');
  assert.deepEqual(await listTree(path.join(target, 'Project')), ['mine.txt']);
  assert.deepEqual(await listTree(path.join(target, 'Project (1)')), [
    'empty-dir/', 'README.md', 'run.sh', 'src/', 'src/deep/', 'src/deep/empty.txt', 'src/main.js',
  ]);
  assert.equal(await fsp.readFile(path.join(target, 'Project (1)', 'src', 'main.js'), 'utf8'), 'console.log(1);\n');
  assert.equal((await fsp.stat(path.join(target, 'Project (1)', 'run.sh'))).mode & 0o111, 0o111);
  const copy = path.join(target, 'big (1).bin');
  assert.equal((await fsp.stat(copy)).size, Math.floor(1.1 * GiB));
  assert.equal(await sha256(copy), await sha256(big));
  assert.ok(progress.some((state) => state.totalBytes > GiB && state.bytes > 0 && state.bytes < state.totalBytes));
  assert.deepEqual((await listTree(target)).filter((name) => name.includes('.part')), []);
});

test('cancelling mid-transfer removes partials and the unfinished folder', { timeout: 60000 }, async (t) => {
  const source = await tempDir(t, 'src');
  const target = await tempDir(t, 'dst');
  await fsp.writeFile(path.join(source, 'done-first.txt'), 'finished before cancel');
  const folder = path.join(source, 'Large');
  await fsp.mkdir(folder);
  await fsp.writeFile(path.join(folder, 'a.txt'), 'a');
  const handle = await fsp.open(path.join(folder, 'huge.bin'), 'w');
  await handle.truncate(4 * GiB);
  await handle.close();

  const { sender, receiver } = await pairSessions(t);
  const received = outcome(receiver);
  const sent = outcome(sender);
  await transfer(sender, receiver, [path.join(source, 'done-first.txt'), folder], target);
  await until(() => (receiver.state()?.bytes || 0) > 64 * 1024 * 1024, 30000);
  assert.ok(await sender.cancel());
  const [receiverResult, senderResult] = await Promise.all([received, sent]);

  assert.equal(receiverResult.ok, false);
  assert.equal(receiverResult.reason, 'cancelled');
  assert.equal(senderResult.reason, 'cancelled');
  // The completed first item stays; nothing of the interrupted folder does.
  assert.deepEqual(await listTree(target), ['done-first.txt']);
  assert.deepEqual(receiverResult.kept, [path.join(target, 'done-first.txt')]);
  assert.equal(receiver.busy, false);
  assert.equal(sender.busy, false);
});

// A receiver driven directly with hostile or corrupt frames.
function fakeReceiver(t, platform = process.platform) {
  const session = new EventEmitter();
  session.sent = [];
  session.sendPeer = (message) => { session.sent.push(message); return true; };
  session.sendDataFrame = () => true;
  session.sendData = () => true;
  const receiver = new FileTransfer({ session, platform });
  receiver.start();
  t.after(() => receiver.stop());
  return { session, receiver };
}

async function offerTo(session, receiver, target, names = ['item']) {
  const offered = new Promise((resolve) => receiver.once('offer', resolve));
  session.emit('peer-message', { type: 'file.offer', v: 1, id: 'abcdefghijklmnopqrstuv', count: names.length, names }, 'peer');
  const offer = await offered;
  await receiver.accept(offer.id, target);
  session.emit('data', { type: 'file.manifest', id: offer.id, files: 1, bytes: 5, entries: 1 }, 'peer');
  return offer.id;
}

test('a file whose bytes do not match the sender checksum is never kept', async (t) => {
  const target = await tempDir(t, 'dst');
  const { session, receiver } = fakeReceiver(t);
  const failed = outcome(receiver);
  const id = await offerTo(session, receiver, target, ['note.txt']);
  session.emit('data-frame', {
    type: 'file.frame', id, entry: 0, item: 0, path: 'note.txt', kind: 'file', size: 5, offset: 0,
    sha256: createHash('sha256').update('HELLO').digest('hex'),
  }, Buffer.from('hello'), 'peer');
  const result = await failed;
  assert.equal(result.reason, 'hash-mismatch');
  assert.deepEqual(await fsp.readdir(target), []);
  assert.deepEqual(session.sent.at(-1), { type: 'file.cancel', id, reason: 'hash-mismatch' });
});

test('traversal paths are refused before anything is written', async (t) => {
  const parent = await tempDir(t, 'dst');
  const target = path.join(parent, 'inbox');
  await fsp.mkdir(target);
  for (const hostile of ['../escape.txt', '/tmp/escape.txt', 'C:\\escape.txt', 'item/../../escape.txt']) {
    const { session, receiver } = fakeReceiver(t);
    const failed = outcome(receiver);
    const id = await offerTo(session, receiver, target);
    session.emit('data-frame', {
      type: 'file.frame', id, entry: 0, item: 0, path: hostile, kind: 'file', size: 1, offset: 0,
      sha256: createHash('sha256').update('x').digest('hex'),
    }, Buffer.from('x'), 'peer');
    assert.equal((await failed).reason, 'invalid', hostile);
  }
  assert.deepEqual(await listTree(parent), ['inbox/']);
});

test('a Windows receiver stores names it can represent and never escapes via them', async (t) => {
  const target = await tempDir(t, 'dst');
  const { session, receiver } = fakeReceiver(t, 'win32');
  const done = outcome(receiver);
  const id = await offerTo(session, receiver, target, ['a:b?.txt']);
  session.emit('data-frame', {
    type: 'file.frame', id, entry: 0, item: 0, path: 'a:b?.txt', kind: 'file', size: 2, offset: 0,
    sha256: createHash('sha256').update('ok').digest('hex'),
  }, Buffer.from('ok'), 'peer');
  session.emit('data', { type: 'file.end', id }, 'peer');
  const result = await done;
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.paths, [path.join(target, 'a_b_.txt')]);
});

test('a second offer while one is active is refused as busy', async (t) => {
  const target = await tempDir(t, 'dst');
  const { session, receiver } = fakeReceiver(t);
  await offerTo(session, receiver, target);
  session.emit('peer-message', { type: 'file.offer', v: 1, id: 'zyxwvutsrqponmlkjihgfe', count: 1, names: ['x'] }, 'peer');
  assert.deepEqual(session.sent.at(-1), { type: 'file.reject', id: 'zyxwvutsrqponmlkjihgfe', reason: 'busy' });
});
