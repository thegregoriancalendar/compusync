'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Workspace, validatePublicPath } = require('../src/core/workspace.cjs');

async function fixture(t, limits = {}) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'compusync-workspace-'));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const workspace = new Workspace(path.join(base, 'workspace'), limits);
  await workspace.init();
  return { base, workspace };
}

test('workspace persists directories, collision-safe imports, renames, saves, and deletes', async (t) => {
  const { base, workspace } = await fixture(t);
  await workspace.mkdir('Documents');
  await workspace.mkdir('Documents/Notes');
  const source = path.join(base, 'hello.txt');
  await fsp.writeFile(source, 'first version');
  const first = await workspace.importFile(source, 'Documents/Notes');
  const second = await workspace.importLocal(source, 'Documents/Notes');
  assert.equal(first.path, 'Documents/Notes/hello.txt');
  assert.equal(second.path, 'Documents/Notes/hello (1).txt');
  assert.equal(await workspace.readText(first.path), 'first version');

  await workspace.writeText(first.path, 'saved from the editor');
  await workspace.rename(second.path, 'Documents/copy.txt');
  assert.deepEqual((await workspace.list('Documents')).map((entry) => [entry.path, entry.type]), [
    ['Documents/copy.txt', 'file'],
    ['Documents/Notes', 'directory'],
  ]);
  assert.equal((await workspace.tree()).length, 4);

  const reopened = new Workspace(path.join(base, 'workspace'));
  await reopened.init();
  assert.equal(await reopened.readText(first.path), 'saved from the editor');
  await reopened.delete('Documents/Notes');
  assert.deepEqual((await reopened.list('Documents')).map((entry) => entry.name), ['copy.txt']);
  assert.deepEqual(await reopened.stats(), { entries: 2, bytes: Buffer.byteLength('first version') });
  assert.equal(fs.existsSync(path.join(base, 'workspace', '.compusync')), true);
  assert.equal((await reopened.tree()).some((entry) => entry.path.includes('.compusync')), false);
});

test('public paths reject traversal, host paths, reserved storage, and non-portable names', async (t) => {
  const { workspace } = await fixture(t);
  const invalid = [
    '/absolute', '\\server\\share', 'C:/Windows', '../escape', 'a/../escape', './file',
    'a//file', 'a\\file', '.compusync', 'safe/.COMPUSYNC/file', 'CON', 'aux.txt',
    'LPT9.log', 'trailing.', 'trailing ', 'bad:name', 'nul\0name',
  ];
  for (const value of invalid) {
    assert.throws(() => validatePublicPath(value, { allowRoot: false }), undefined, value);
    await assert.rejects(workspace.mkdir(value), undefined, value);
  }
  assert.equal(validatePublicPath('portable/folder/file.txt'), 'portable/folder/file.txt');
  assert.equal(validatePublicPath(''), '');
  assert.throws(() => validatePublicPath('', { allowRoot: false }));
});

test('workspace rejects symbolic links at every public path segment', async (t) => {
  const { base, workspace } = await fixture(t);
  const outside = path.join(base, 'outside');
  await fsp.mkdir(outside);
  await fsp.writeFile(path.join(outside, 'secret.txt'), 'outside');
  try {
    await fsp.symlink(outside, path.join(workspace.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) { t.skip('Creating symlinks is unavailable in this environment.'); return; }
    throw error;
  }
  await assert.rejects(workspace.list(''), (error) => error.code === 'UNSAFE_SYMLINK');
  await assert.rejects(workspace.readText('linked/secret.txt'), (error) => error.code === 'UNSAFE_SYMLINK');
  assert.equal(await fsp.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'outside');
});

test('entry, file, workspace, depth, and text quotas fail without damaging existing data', async (t) => {
  const { base, workspace } = await fixture(t, {
    maxDepth: 3,
    maxEntries: 3,
    maxFileBytes: 8,
    maxWorkspaceBytes: 12,
    maxTextBytes: 8,
  });
  const eight = path.join(base, 'eight.bin');
  const five = path.join(base, 'five.bin');
  const nine = path.join(base, 'nine.bin');
  await fsp.writeFile(eight, Buffer.alloc(8, 1));
  await fsp.writeFile(five, Buffer.alloc(5, 2));
  await fsp.writeFile(nine, Buffer.alloc(9, 3));
  await workspace.mkdir('folder');
  await workspace.importFile(eight, 'folder', 'data.bin');
  await assert.rejects(workspace.importFile(five, '', 'more.bin'), (error) => error.code === 'WORKSPACE_QUOTA');
  await assert.rejects(workspace.importFile(nine, '', 'large.bin'), (error) => error.code === 'FILE_QUOTA');
  await workspace.mkdir('last');
  await assert.rejects(workspace.mkdir('too-many'), (error) => error.code === 'ENTRY_QUOTA');
  await assert.rejects(workspace.mkdir('a/b/c/d'), (error) => error.code === 'PATH_DEPTH');

  await workspace.writeText('folder/data.bin', '12345678');
  await assert.rejects(workspace.writeText('folder/data.bin', '123456789'), (error) => error.code === 'TEXT_QUOTA');
  assert.equal(await workspace.readText('folder/data.bin'), '12345678');
  assert.deepEqual(await fsp.readdir(workspace.tempRoot), []);
});

test('readText rejects non-UTF-8 data and local import rejects source symlinks', async (t) => {
  const { base, workspace } = await fixture(t, { maxFileBytes: 32, maxWorkspaceBytes: 64, maxTextBytes: 32 });
  const binary = path.join(base, 'binary.bin');
  await fsp.writeFile(binary, Buffer.from([0xc3, 0x28]));
  const entry = await workspace.importFile(binary);
  await assert.rejects(workspace.readText(entry.path), (error) => error.code === 'INVALID_UTF8');

  const link = path.join(base, 'binary-link');
  try { await fsp.symlink(binary, link, 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return;
    throw error;
  }
  await assert.rejects(workspace.importFile(link), (error) => error.code === 'INVALID_SOURCE');
});
