'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Workspace } = require('../src/core/workspace.cjs');
const { TransferReceiver } = require('../src/core/transfer.cjs');

const digest = (contents) => createHash('sha256').update(contents).digest('hex');

async function fixture(t, options = {}) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'compusync-transfer-'));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const workspace = new Workspace(path.join(base, 'workspace'), {
    maxFileBytes: options.maxFileBytes || 1024,
    maxWorkspaceBytes: options.maxWorkspaceBytes || 4096,
    maxTextBytes: options.maxTextBytes || 1024,
  });
  await workspace.init();
  const receiver = new TransferReceiver(workspace, {
    maxTransfers: options.maxTransfers || 4,
    maxChunkBytes: options.maxChunkBytes || 8,
    maxFileBytes: options.maxFileBytes || 1024,
  });
  await receiver.init();
  return { base, workspace, receiver };
}

async function send(receiver, id, contents, options = {}) {
  const owner = options.owner || 'peer';
  await receiver.start({
    transferId: id,
    name: options.name || 'upload.txt',
    target: options.target || '',
    size: contents.length,
    sha256: options.sha256 || digest(contents),
  }, owner);
  const chunkBytes = options.chunkBytes || 5;
  for (let offset = 0; offset < contents.length; offset += chunkBytes) {
    const chunk = contents.subarray(offset, Math.min(contents.length, offset + chunkBytes));
    await receiver.chunk({ transferId: id, offset, data: chunk.toString('base64') }, owner);
  }
  return receiver.finish({ transferId: id }, owner);
}

test('receiver assembles ordered chunks, verifies SHA-256, and promotes without overwrite', async (t) => {
  const { workspace, receiver } = await fixture(t);
  await workspace.writeText('upload.txt', 'local');
  const contents = Buffer.from('remote saved text');
  const result = await send(receiver, 'transfer-1', contents, { chunkBytes: 4 });
  assert.equal(result.transferId, 'transfer-1');
  assert.equal(result.entry.path, 'upload (1).txt');
  assert.equal(await workspace.readText('upload.txt'), 'local');
  assert.equal(await workspace.readText(result.entry.path), contents.toString());
  assert.deepEqual(receiver.active(), []);
  assert.deepEqual(await fsp.readdir(workspace.internalTransferDirectory()), []);
});

test('bad offsets, malformed chunks, incomplete input, and hash mismatch remove partials', async (t) => {
  const { workspace, receiver } = await fixture(t);
  const contents = Buffer.from('abcdef');
  const start = (id, sha256 = digest(contents)) => receiver.start({ transferId: id, name: `${id}.txt`, size: contents.length, sha256 });

  await start('offset');
  await assert.rejects(receiver.chunk({ transferId: 'offset', offset: 1, data: Buffer.from('a').toString('base64') }), (error) => error.code === 'CHUNK_OFFSET');
  assert.equal(receiver.active().length, 0);

  await start('encoding');
  await assert.rejects(receiver.chunk({ transferId: 'encoding', offset: 0, data: 'not base64' }), (error) => error.code === 'INVALID_CHUNK');
  assert.equal(receiver.active().length, 0);

  await start('incomplete');
  await receiver.chunk({ transferId: 'incomplete', offset: 0, data: Buffer.from('abc').toString('base64') });
  await assert.rejects(receiver.finish({ transferId: 'incomplete' }), (error) => error.code === 'INCOMPLETE_TRANSFER');
  assert.equal(receiver.active().length, 0);

  await start('hash', '0'.repeat(64));
  await receiver.chunk({ transferId: 'hash', offset: 0, data: contents.toString('base64') });
  await assert.rejects(receiver.finish({ transferId: 'hash' }), (error) => error.code === 'HASH_MISMATCH');
  assert.equal(receiver.active().length, 0);
  assert.deepEqual(await fsp.readdir(workspace.internalTransferDirectory()), []);
  assert.deepEqual(await workspace.list(), []);
});

test('receiver enforces file, chunk, concurrency, and connection ownership bounds', async (t) => {
  const { receiver } = await fixture(t, { maxFileBytes: 10, maxWorkspaceBytes: 30, maxTextBytes: 10, maxChunkBytes: 4, maxTransfers: 2 });
  const zeroHash = digest(Buffer.alloc(0));
  const request = (transferId, size = 0) => ({ transferId, name: `${transferId}.txt`, size, sha256: zeroHash });
  await receiver.start(request('alice'), 'alice');
  await receiver.start(request('bob'), 'bob');
  await assert.rejects(receiver.start(request('third'), 'alice'), (error) => error.code === 'TRANSFER_LIMIT');
  await assert.rejects(receiver.abort({ transferId: 'alice' }, 'bob'), (error) => error.code === 'TRANSFER_OWNER');
  assert.equal(receiver.active().length, 2);
  assert.equal(await receiver.abortOwner('alice'), 1);
  assert.deepEqual(receiver.active().map((item) => item.owner), ['bob']);
  await receiver.start(request('third'), 'alice');
  assert.equal(await receiver.abortAll(), 2);
  assert.deepEqual(receiver.active(), []);
  await assert.rejects(receiver.start({ ...request('large', 11), sha256: digest(Buffer.alloc(11)) }), (error) => error.code === 'FILE_QUOTA');

  const five = Buffer.from('12345');
  await receiver.start({ transferId: 'chunky', name: 'chunky.txt', size: 5, sha256: digest(five) });
  await assert.rejects(receiver.chunk({ transferId: 'chunky', offset: 0, data: five.toString('base64') }), (error) => error.code === 'CHUNK_QUOTA');
  assert.deepEqual(receiver.active(), []);
});

test('zero-byte files complete and receiver initialization cleans abandoned partials', async (t) => {
  const { workspace, receiver } = await fixture(t);
  const empty = await send(receiver, 'empty', Buffer.alloc(0), { name: 'empty.txt' });
  assert.equal(empty.entry.size, 0);
  await fsp.writeFile(path.join(workspace.internalTransferDirectory(), 'abandoned.part'), 'partial');
  const replacement = new TransferReceiver(workspace);
  await replacement.init();
  assert.deepEqual(await fsp.readdir(workspace.internalTransferDirectory()), []);
  assert.equal(await replacement.abortAll(), 0);
});
