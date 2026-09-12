'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const {
  SEAM_THICKNESS,
  desktopBounds,
  sharedEdge,
  seamBounds,
  seamForSnapshot,
  SeamOverlay,
} = require('../src/main/seam-overlay.cjs');

const source = { machineId: 'source', origin: { x: 0, y: 0 }, size: { w: 1000, h: 800 }, scale: 1 };
const target = { machineId: 'target', origin: { x: 1000, y: 100 }, size: { w: 1200, h: 900 }, scale: 1 };

test('seam geometry follows only the shared portion of the local crossing edge', () => {
  assert.deepEqual(desktopBounds([
    { bounds: { x: -200, y: 20, width: 800, height: 600 } },
    { bounds: { x: 600, y: 0, width: 1000, height: 900 } },
  ]), { x: -200, y: 0, width: 1800, height: 900 });
  assert.equal(sharedEdge(source, target), 'right');
  assert.deepEqual(seamBounds(source, target, { x: 10, y: 20, width: 1000, height: 800 }), {
    edge: 'right', x: 1004, y: 120, width: SEAM_THICKNESS, height: 700,
  });
});

test('the treatment is active only while one real window intersects both machines', () => {
  const base = { role: 'source', source, target };
  const bounds = { x: 0, y: 0, width: 1000, height: 800 };
  assert.equal(seamForSnapshot({ ...base, geometry: { x: 700, y: 120, w: 250, h: 300 } }, 'source', bounds), null);
  assert.equal(seamForSnapshot({ ...base, geometry: { x: 900, y: 120, w: 250, h: 300 } }, 'source', bounds).edge, 'right');
  assert.equal(seamForSnapshot({ ...base, geometry: { x: 1000, y: 120, w: 250, h: 300 } }, 'source', bounds), null);
  assert.equal(seamForSnapshot({ ...base, geometry: { x: 900, y: 120, w: 250, h: 300 } }, 'target',
    { x: 20, y: 30, width: 1200, height: 900 }).edge, 'left');
});

class FakeWebContents extends EventEmitter {
  constructor() { super(); this.messages = []; }
  send(channel, value) { this.messages.push({ channel, value }); }
}

class FakeWindow extends EventEmitter {
  static instances = [];
  constructor(options) {
    super(); this.options = options; this.webContents = new FakeWebContents(); this.visible = false;
    FakeWindow.instances.push(this);
  }
  isDestroyed() { return false; }
  setMenuBarVisibility() {}
  setAlwaysOnTop() {}
  setIgnoreMouseEvents() {}
  setVisibleOnAllWorkspaces() {}
  loadFile(file) { this.file = file; }
  setBounds(bounds) { this.bounds = bounds; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  destroy() { this.emit('closed'); }
}

test('overlay is click-through, renders seam state, and clears without taking focus', () => {
  FakeWindow.instances = [];
  const overlay = new SeamOverlay({
    BrowserWindow: FakeWindow,
    screen: { getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1000, height: 800 } }] },
    preloadPath: 'preload.cjs', rendererPath: 'handoff-overlay.html',
  });
  const window = overlay.create();
  assert.equal(window.options.focusable, false);
  assert.equal(window.options.transparent, true);
  assert.equal(window.options.skipTaskbar, true);
  window.webContents.emit('did-finish-load');
  assert.equal(overlay.update({ source, target, geometry: { x: 900, y: 120, w: 250, h: 300 } }, 'source'), true);
  assert.equal(window.visible, true);
  assert.deepEqual(window.webContents.messages.at(-1), {
    channel: 'sync:handoff-overlay', value: { mode: 'seam', edge: 'right' },
  });
  overlay.clear();
  assert.equal(window.visible, false);
  assert.equal(window.webContents.messages.at(-1).value.mode, 'hidden');
});

test('the unsupported-window hint is transient and shown once per app lifetime', () => {
  FakeWindow.instances = [];
  const overlay = new SeamOverlay({
    BrowserWindow: FakeWindow,
    screen: {
      getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1000, height: 800 } }],
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 760 } }),
    },
    preloadPath: 'preload.cjs', rendererPath: 'handoff-overlay.html', hintDurationMs: 100000,
  });
  const window = overlay.create();
  window.webContents.emit('did-finish-load');
  assert.equal(overlay.showHint('This window stays here.'), true);
  assert.equal(window.webContents.messages.at(-1).value.mode, 'hint');
  assert.equal(overlay.showHint('Do not show this second message.'), false);
  assert.equal(window.webContents.messages.at(-1).value.message, 'This window stays here.');
  overlay.destroy();
});

test('overlay renderer keeps a narrow subscription and nonmodal seam/hint elements', () => {
  const root = path.join(__dirname, '..', 'src');
  const preload = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'renderer', 'handoff-overlay.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'renderer', 'handoff-overlay.css'), 'utf8');
  assert.match(preload, /onHandoffOverlay: \(callback\) => subscribe\('sync:handoff-overlay'/);
  assert.match(html, /id="seam"/);
  assert.match(html, /id="hint" role="status" aria-live="polite"/);
  assert.match(css, /pointer-events: none/);
  assert.match(css, /linear-gradient/);
});
