'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Session } = require('../src/core/session.cjs');
const { newSecret } = require('../src/core/wire.cjs');
const { FileTransfer } = require('../src/core/file-transfer.cjs');
const { ClipboardFiles } = require('../src/main/clipboard-files.cjs');
const { ClipboardSync } = require('../src/main/clipboard-sync.cjs');

async function until(predicate, timeout = 10000) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeout) throw new Error('Condition timed out.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function tempDir(t, label) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), `compusync-${label}-`));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

// One computer's clipboard: text plus the native file list.
function fakeClipboard() {
  const board = { generation: 1, files: [], text: '' };
  board.native = {
    clipboardFilesAvailable: () => true,
    clipboardGeneration: () => board.generation,
    clipboardFiles: () => board.files.slice(),
    setClipboardFiles: (paths) => { board.files = paths.slice(); board.text = ''; board.generation++; },
  };
  board.text_ = {
    readText: async () => board.text,
    writeText: async (text) => { board.text = text; board.files = []; board.generation++; },
  };
  board.copyFiles = (paths) => { board.files = paths.slice(); board.text = path.basename(paths[0]); board.generation++; };
  board.copyText = (text) => { board.files = []; board.text = text; board.generation++; };
  return board;
}

async function pairedClipboards(t, options = {}) {
  const secret = newSecret();
  const host = new Session({ id: 'host-mac', name: 'Host', role: 'host', port: 0, bindHost: '127.0.0.1', secret, discovery: false, platform: 'darwin' });
  await host.start();
  const join = new Session({ id: 'join-pc', name: 'Join', role: 'join', host: '127.0.0.1', port: host.port, secret, discovery: false, platform: 'darwin' });
  t.after(async () => { await join.stop(); await host.stop(); });
  await join.start();
  await until(() => join.phase === 'connected' && host.dataPhase === 'connected' && join.dataPhase === 'connected');
  const cache = await tempDir(t, 'clip-cache');
  const side = (session, role) => {
    const board = fakeClipboard();
    const transfer = new FileTransfer({ session });
    const files = new ClipboardFiles({ transfer, native: board.native, cacheRoot: path.join(cache, role), ...options });
    const sync = new ClipboardSync({ session, clipboard: board.text_, files, role, intervalMs: 1000 });
    transfer.start();
    files.start();
    sync.start();
    clearInterval(sync.timer); // Poll deterministically.
    t.after(async () => { sync.stop(); files.stop(); await transfer.stop(); });
    return { board, transfer, files, sync, cache: path.join(cache, role) };
  };
  return { a: side(host, 'host'), b: side(join, 'join') };
}

const sha = async (file) => createHash('sha256').update(await fsp.readFile(file)).digest('hex');

test('copied files and folders become pasteable files on the other computer, without echo', async (t) => {
  const source = await tempDir(t, 'src');
  await fsp.writeFile(path.join(source, 'report.pdf'), Buffer.alloc(3 * 1024 * 1024, 7));
  await fsp.mkdir(path.join(source, 'Album', 'raw'), { recursive: true });
  await fsp.writeFile(path.join(source, 'Album', 'raw', 'a.jpg'), 'jpeg');
  const { a, b } = await pairedClipboards(t);
  await a.sync.poll();
  await b.sync.poll();

  a.board.copyFiles([path.join(source, 'report.pdf'), path.join(source, 'Album')]);
  assert.equal(await a.sync.poll(), true);
  await until(() => b.board.files.length === 2);

  const [report, album] = b.board.files;
  assert.ok(report.startsWith(b.cache) && album.startsWith(b.cache), 'pasted from the private cache');
  assert.equal(await sha(report), await sha(path.join(source, 'report.pdf')));
  assert.equal(await fsp.readFile(path.join(album, 'raw', 'a.jpg'), 'utf8'), 'jpeg');
  // Neither side treats the applied files as a new local copy.
  assert.equal(await b.sync.poll(), false);
  assert.equal(await a.sync.poll(), false);
  assert.equal(b.transfer.busy, false);
});

test('a newer copy supersedes copied files still in flight, and their partial cache is removed', async (t) => {
  const source = await tempDir(t, 'src');
  const big = path.join(source, 'big.bin');
  const handle = await fsp.open(big, 'w');
  await handle.truncate(512 * 1024 * 1024);
  await handle.close();
  const { a, b } = await pairedClipboards(t);
  await a.sync.poll();
  a.board.copyFiles([big]);
  await a.sync.poll();
  await until(() => (b.transfer.state()?.bytes || 0) > 16 * 1024 * 1024);
  const failed = new Promise((resolve) => b.transfer.once('failed', resolve));

  a.board.copyText('newer text');
  await a.sync.poll();

  assert.equal((await failed).reason, 'superseded');
  await until(async () => (await fsp.readdir(b.cache).catch(() => [])).length === 0);
  assert.deepEqual(b.board.files, [], 'the receiver clipboard never got the superseded files');
  await until(() => b.board.text === 'newer text');
});

test('copies over the size limit are not offered and the user is told', async (t) => {
  const source = await tempDir(t, 'src');
  await fsp.writeFile(path.join(source, 'large.bin'), Buffer.alloc(2048));
  const notices = [];
  const { a, b } = await pairedClipboards(t, { maxBytes: 1024, onNotice: (message) => notices.push(message) });
  const offered = [];
  b.transfer.on('offer', (offer) => offered.push(offer));
  await a.sync.poll();
  a.board.copyFiles([path.join(source, 'large.bin')]);
  await a.sync.poll();
  await until(() => notices.length === 1);
  assert.match(notices[0], /larger than/);
  assert.deepEqual(offered, []);
  assert.equal(a.transfer.busy, false);
});

test('a clipboard receiver writes nothing beyond the totals the offer announced', async (t) => {
  const target = await tempDir(t, 'dst');
  const session = new EventEmitter();
  session.sent = [];
  session.sendPeer = (message) => { session.sent.push(message); return true; };
  session.sendDataFrame = () => true;
  session.sendData = () => true;
  const receiver = new FileTransfer({ session });
  receiver.start();
  t.after(() => receiver.stop());
  const offered = new Promise((resolve) => receiver.once('offer', resolve));
  session.emit('peer-message', {
    type: 'file.offer', v: 1, id: 'abcdefghijklmnopqrstuv', count: 1, names: ['x.bin'],
    purpose: 'clipboard', bytes: 4, files: 1,
  }, 'peer');
  const offer = await offered;
  assert.deepEqual([offer.purpose, offer.bytes, offer.files], ['clipboard', 4, 1]);
  await receiver.accept(offer.id, target);
  const failed = new Promise((resolve) => receiver.once('failed', resolve));
  session.emit('data-frame', {
    type: 'file.frame', id: offer.id, entry: 0, item: 0, path: 'x.bin', kind: 'file', size: 1024 ** 3, offset: 0,
  }, Buffer.alloc(8), 'peer');
  assert.equal((await failed).reason, 'too-large');
  assert.deepEqual(await fsp.readdir(target), []);
});
