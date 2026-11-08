'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { resolveDropFolder } = require('../src/main/drop-folder.cjs');

const SCREEN = { x: 0, y: 0, width: 1728, height: 1117 };
// Shapes taken from a real macOS CoreGraphics list, front to back.
const DOCK_SHIELD = { id: '7', pid: 648, ownerName: 'Dock', layer: 20, bounds: SCREEN };
const WALLPAPER = { id: '15827', pid: 648, ownerName: 'Dock', layer: -2147483622, bounds: SCREEN };
const DESKTOP_ICONS = { id: '90', pid: 652, ownerName: 'Finder', layer: -2147483603, bounds: SCREEN };
const finderWindow = (id, bounds) => ({ id, pid: 652, ownerName: 'Finder', layer: 0, bounds });
const FOLDER = os.tmpdir();

function resolve(windows, finderOutput = '', options = {}) {
  const calls = [];
  const execFile = (file, args, settings, callback) => { calls.push(file); callback(null, finderOutput); };
  return resolveDropFolder({
    platform: 'darwin', point: { x: 500, y: 300 }, ownPid: 4242, execFile, desktop: FOLDER,
    native: { windowsAtPoint: () => windows }, ...options,
  }).then((folder) => ({ folder, calls }));
}

test('a Finder window under the pointer resolves to its folder, matched by window id', async () => {
  const bounds = { x: 404, y: 178, width: 920, height: 436 };
  const { folder } = await resolve(
    [DOCK_SHIELD, finderWindow('17037', bounds), WALLPAPER],
    `99\t0,0,10,10\t/nope\n17037\t404,178,1324,614\t${FOLDER}\n`,
  );
  assert.equal(folder, FOLDER);
});

test('Finder windows sharing the same bounds without an id match are never guessed', async () => {
  const bounds = { x: 404, y: 178, width: 920, height: 436 };
  const { folder } = await resolve(
    [finderWindow('17037', bounds), WALLPAPER],
    `1\t404,178,1324,614\t${FOLDER}\n2\t404,178,1324,614\t/Users\n`,
  );
  assert.equal(folder, null);
});

test('another app, the menu bar, or our own window under the pointer means no folder', async () => {
  const menuBar = { id: '15842', pid: 300, ownerName: 'Window Server', layer: 24, bounds: { x: 0, y: 0, width: 1728, height: 33 } };
  for (const windows of [
    [{ id: '5', pid: 37815, ownerName: 'Aside', layer: 0, bounds: SCREEN }, WALLPAPER],
    [menuBar, finderWindow('1', SCREEN), WALLPAPER],
    [{ id: '8', pid: 4242, ownerName: 'CompuSync', layer: 0, bounds: SCREEN }],
  ]) {
    const { folder, calls } = await resolve(windows, `1\t0,0,1728,1117\t${FOLDER}\n`);
    assert.equal(folder, null);
    assert.deepEqual(calls, [], 'Finder is only asked about its own windows');
  }
});

test('the desktop resolves to the Desktop folder only when Finder draws desktop icons there', async () => {
  assert.equal((await resolve([DOCK_SHIELD, DESKTOP_ICONS, WALLPAPER])).folder, FOLDER);
  assert.equal((await resolve([DOCK_SHIELD, WALLPAPER])).folder, null);
});

test('a reported folder that does not exist is ignored', async () => {
  const { folder } = await resolve([finderWindow('1', SCREEN)], '1\t0,0,1728,1117\t/definitely/not/here\n');
  assert.equal(folder, null);
});
