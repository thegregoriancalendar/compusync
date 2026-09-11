'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const {
  ProgramManager,
  ProgramError,
  MAX_TEXT_BYTES,
  IPC_BOOTSTRAP,
  IPC_SAVE,
  publicCatalog,
  validateProgramId,
  validatePublicPath,
  normalizeDocumentRef,
  validateInputEvent,
} = require('../src/programs/program-manager.cjs');

class FakeIpcMain {
  constructor() { this.handlers = new Map(); }
  handle(channel, handler) {
    if (this.handlers.has(channel)) throw new Error(`Duplicate handler: ${channel}`);
    this.handlers.set(channel, handler);
  }
  removeHandler(channel) { this.handlers.delete(channel); }
  invoke(channel, event, payload) { return this.handlers.get(channel)(event, payload); }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.mainFrame = {};
    this.events = [];
    this.destroyed = false;
    this.focused = false;
  }
  setWindowOpenHandler(handler) { this.openHandler = handler; }
  setFrameRate(rate) { this.frameRate = rate; }
  sendInputEvent(event) { this.events.push(event); }
  focus() { this.focused = true; }
  isDestroyed() { return this.destroyed; }
}

class FakeBrowserWindow extends EventEmitter {
  static instances = [];
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    FakeBrowserWindow.instances.push(this);
  }
  async loadFile(file) { this.loadedFile = file; }
  isDestroyed() { return this.destroyed; }
  close() { this.destroy(); }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.webContents.destroyed = true;
    this.emit('closed');
  }
}

function senderEvent(window, frame = window.webContents.mainFrame) {
  return { sender: window.webContents, senderFrame: frame };
}

test('catalog, public document references, and remote input are narrowly validated', () => {
  assert.deepEqual(publicCatalog(), [{ id: 'text-editor', name: 'Text Editor', kind: 'editor' }]);
  const changed = publicCatalog();
  changed[0].name = 'Changed';
  assert.equal(publicCatalog()[0].name, 'Text Editor');
  assert.equal(validateProgramId('text-editor'), true);
  assert.equal(validateProgramId('shell'), false);
  for (const valid of ['notes.txt', 'folder/notes with spaces.md', '資料/メモ.txt']) assert.equal(validatePublicPath(valid), true);
  for (const invalid of ['', '/notes.txt', '../notes.txt', 'folder//notes.txt', 'folder\\notes.txt', 'notes.txt/', `bad\0name`, 'C:/Users/name/notes.txt', 'CON.txt', '.compusync/secret']) assert.equal(validatePublicPath(invalid), false);
  assert.deepEqual(normalizeDocumentRef({ path: 'notes/one.txt', name: 'One\nDocument' }), { publicPath: 'notes/one.txt', title: 'OneDocument' });
  assert.throws(() => normalizeDocumentRef('../../host.txt'), ProgramError);

  const bounds = { width: 800, height: 500 };
  assert.deepEqual(validateInputEvent({ type: 'mouseMove', x: 900.4, y: -20, ignored: 'value' }, bounds), { type: 'mouseMove', x: 799, y: 0 });
  assert.deepEqual(validateInputEvent({ type: 'mouseDown', x: 12, y: 18, button: 'left', clickCount: 2, modifiers: ['shift', 'shift'] }, bounds), {
    type: 'mouseDown', x: 12, y: 18, button: 'left', clickCount: 2, modifiers: ['shift'],
  });
  assert.deepEqual(validateInputEvent({ type: 'mouseWheel', x: 4, y: 5, deltaX: -9000, deltaY: 2000 }, bounds), {
    type: 'mouseWheel', x: 4, y: 5, deltaX: -1000, deltaY: 1000, canScroll: true,
  });
  assert.deepEqual(validateInputEvent({ type: 'keyDown', key: 'ArrowLeft', modifiers: ['control'] }, bounds), { type: 'keyDown', keyCode: 'ArrowLeft', modifiers: ['control'] });
  assert.deepEqual(validateInputEvent({ type: 'char', text: 'é' }, bounds), { type: 'char', keyCode: 'é' });
  for (const invalid of [
    { type: 'mouseDown', x: 1, y: 2, button: 'back' },
    { type: 'mouseMove', x: NaN, y: 2 },
    { type: 'keyDown', key: 'launch-calculator' },
    { type: 'char', text: '\0' },
    { type: 'keyUp', key: 'A', modifiers: ['command'] },
    { type: 'unknown' },
  ]) assert.equal(validateInputEvent(invalid, bounds), null);
});

test('manager launches one sandboxed editor, owns IPC and input, throttles frames, saves, and cleans up', async () => {
  FakeBrowserWindow.instances = [];
  const reads = [];
  const writes = [];
  const workspace = {
    async readText(publicPath) {
      reads.push(publicPath);
      if (publicPath === 'documents/missing.txt') {
        const error = new Error('ENOENT at C:\\Users\\host\\private-workspace\\missing.txt');
        error.code = 'ENOENT';
        throw error;
      }
      return 'hello workspace';
    },
    async writeText(publicPath, text) { writes.push({ publicPath, text }); return { path: publicPath, type: 'file', size: Buffer.byteLength(text) }; },
  };
  const ipcMain = new FakeIpcMain();
  let now = 1000;
  const manager = new ProgramManager({
    BrowserWindow: FakeBrowserWindow,
    ipcMain,
    workspace,
    rendererPath: path.join('safe', 'programs'),
    now: () => now,
  });
  const programUpdates = [];
  const frames = [];
  const saves = [];
  manager.on('programs', (programs) => programUpdates.push(programs));
  manager.on('frame', (frame) => frames.push(frame));
  manager.on('saved', (saved) => saves.push(saved));

  const launched = await manager.launch({ path: 'documents/notes.txt', name: 'Notes' });
  assert.deepEqual(reads, ['documents/notes.txt']);
  assert.equal(launched.appId, 'text-editor');
  assert.equal(launched.documentPath, 'documents/notes.txt');
  assert.equal(programUpdates.length, 1);
  assert.deepEqual(manager.catalog(), [{ id: 'text-editor', name: 'Text Editor', kind: 'editor' }]);
  assert.equal(manager.programs().length, 1);
  const window = FakeBrowserWindow.instances[0];
  assert.equal(window.options.show, false);
  assert.equal(window.options.width, 800);
  assert.equal(window.options.height, 500);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.options.webPreferences.offscreen, true);
  assert.match(window.options.webPreferences.preload, /editor-preload\.cjs$/);
  assert.match(window.loadedFile, /editor\.html$/);
  assert.deepEqual(window.webContents.openHandler(), { action: 'deny' });
  assert.equal(window.webContents.frameRate, 15);

  const bootstrap = await ipcMain.invoke(IPC_BOOTSTRAP, senderEvent(window));
  assert.deepEqual(bootstrap, {
    programId: launched.id,
    appId: 'text-editor',
    title: 'Notes',
    text: 'hello workspace',
    maxBytes: MAX_TEXT_BYTES,
  });
  assert.throws(() => ipcMain.invoke(IPC_BOOTSTRAP, senderEvent(window, {})), /Unknown program window/);
  const invalidSave = await ipcMain.invoke(IPC_SAVE, senderEvent(window), { text: 42 });
  assert.equal(invalidSave.ok, false);
  const saved = await ipcMain.invoke(IPC_SAVE, senderEvent(window), { text: 'saved text' });
  assert.deepEqual(saved, { ok: true, savedAt: 1000 });
  assert.deepEqual(writes, [{ publicPath: 'documents/notes.txt', text: 'saved text' }]);
  assert.equal(saves[0].documentPath, 'documents/notes.txt');

  const image = {
    isEmpty: () => false,
    getSize: () => ({ width: 640, height: 400 }),
    toJPEG: (quality) => Buffer.from(`jpeg-${quality}`),
  };
  window.webContents.emit('paint', {}, {}, image);
  now += 20;
  window.webContents.emit('paint', {}, {}, image);
  now += 60;
  window.webContents.emit('paint', {}, {}, image);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames.map((frame) => frame.serial), [1, 2]);
  assert.equal(frames[0].format, 'jpeg');
  assert.equal(frames[0].data, Buffer.from('jpeg-72').toString('base64'));
  assert.equal(frames[0].width, 640);
  assert.equal('window' in frames[0], false);

  assert.equal(manager.input(launched.id, { type: 'mouseMove', x: 900, y: -1 }), true);
  assert.deepEqual(window.webContents.events[0], { type: 'mouseMove', x: 639, y: 0 });
  assert.equal(window.webContents.focused, true);
  assert.equal(manager.input(launched.id, { type: 'keyDown', key: 'run-shell-command' }), false);
  assert.equal(manager.input('unknown', { type: 'keyDown', key: 'A' }), false);

  assert.equal(manager.close(launched.id), true);
  assert.equal(window.destroyed, true);
  assert.deepEqual(manager.programs(), []);
  assert.throws(() => ipcMain.invoke(IPC_BOOTSTRAP, senderEvent(window)), /Unknown program window/);
  assert.equal(manager.close(launched.id), false);

  await assert.rejects(
    () => manager.launch('documents/missing.txt'),
    (error) => error.code === 'ENOENT' && error.message === 'CompuSync could not open this workspace file.' && !error.message.includes('private-workspace'),
  );

  const second = await manager.launch('documents/second.txt');
  assert.equal(manager.programs()[0].id, second.id);
  await manager.stop();
  assert.equal(FakeBrowserWindow.instances[1].destroyed, true);
  assert.equal(ipcMain.handlers.has(IPC_BOOTSTRAP), false);
  assert.equal(ipcMain.handlers.has(IPC_SAVE), false);
  await assert.rejects(() => manager.launch('documents/third.txt'), /no longer available/);
});
