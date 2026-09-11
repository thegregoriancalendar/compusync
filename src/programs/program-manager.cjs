'use strict';

const { EventEmitter } = require('node:events');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const FRAME_RATE = 15;
const FRAME_INTERVAL_MS = 1000 / FRAME_RATE;
const PROGRAM_CATALOG = Object.freeze([
  Object.freeze({ id: 'text-editor', name: 'Text Editor', kind: 'editor' }),
]);
const IPC_BOOTSTRAP = 'compusync-program:bootstrap';
const IPC_SAVE = 'compusync-program:save';
const MOUSE_BUTTONS = new Set(['left', 'middle', 'right']);
const MODIFIERS = new Set(['shift', 'control', 'alt', 'meta']);
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const NAMED_KEYS = new Set([
  'Backspace', 'Delete', 'Tab', 'Enter', 'Escape', 'Space',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown', 'Insert',
  'Shift', 'Control', 'Alt', 'Meta',
  ...Array.from({ length: 12 }, (_value, index) => `F${index + 1}`),
]);

class ProgramError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProgramError';
    this.code = code;
  }
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function publicCatalog() {
  return PROGRAM_CATALOG.map((entry) => ({ ...entry }));
}

function validateProgramId(id) {
  return typeof id === 'string' && PROGRAM_CATALOG.some((entry) => entry.id === id);
}

function validatePublicPath(value) {
  if (typeof value !== 'string' || !value.length || value.length > 4096
    || value.startsWith('/') || value.startsWith('\\') || value.endsWith('/') || value.includes('\\')
    || /^[A-Za-z]:/.test(value) || /[\0-\x1f\x7f]/.test(value)) return false;
  const parts = value.split('/');
  return parts.length <= 32 && parts.every((part) => part && part !== '.' && part !== '..' && part.length <= 255
    && part.toLowerCase() !== '.compusync' && !/[<>:"|?*]/.test(part) && !/[. ]$/.test(part)
    && !WINDOWS_RESERVED.test(part));
}

function normalizeDocumentRef(entry) {
  const publicPath = typeof entry === 'string' ? entry : entry?.path ?? entry?.id;
  if (!validatePublicPath(publicPath)) throw new ProgramError('INVALID_DOCUMENT', 'Choose a valid workspace text file.');
  const requestedName = typeof entry === 'object' && typeof entry?.name === 'string' ? entry.name : publicPath.split('/').at(-1);
  const title = String(requestedName || 'Untitled')
    .replace(/[\0-\x1f\x7f]/g, '')
    .trim()
    .slice(0, 160) || 'Untitled';
  return { publicPath, title };
}

function normalizedModifiers(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MODIFIERS.size || value.some((item) => !MODIFIERS.has(item))) return null;
  return [...new Set(value)];
}

function validKey(value, character = false) {
  if (typeof value !== 'string' || !value.length || value.length > 32) return false;
  if (character) return !/[^\t\n\r\x20-\u{10ffff}]/u.test(value) && [...value].length <= 8;
  return NAMED_KEYS.has(value) || ([...value].length === 1 && !/[\0-\x1f\x7f]/.test(value));
}

// Returns a new Electron input event containing only explicitly supported
// fields. Coordinates are clamped to the offscreen program's current content.
function validateInputEvent(value, bounds) {
  if (!value || typeof value !== 'object' || !Number.isInteger(bounds?.width) || !Number.isInteger(bounds?.height)
    || bounds.width < 1 || bounds.height < 1) return null;
  const modifiers = normalizedModifiers(value.modifiers);
  if (!modifiers) return null;
  const withModifiers = (event) => modifiers.length ? { ...event, modifiers } : event;
  const point = () => {
    if (!finite(value.x) || !finite(value.y)) return null;
    return {
      x: Math.round(clamp(value.x, 0, bounds.width - 1)),
      y: Math.round(clamp(value.y, 0, bounds.height - 1)),
    };
  };

  if (value.type === 'mouseMove') {
    const position = point();
    if (!position) return null;
    return withModifiers({ type: 'mouseMove', ...position });
  }
  if (value.type === 'mouseDown' || value.type === 'mouseUp') {
    const position = point();
    if (!position || !MOUSE_BUTTONS.has(value.button)) return null;
    if (value.clickCount !== undefined && (!Number.isInteger(value.clickCount) || value.clickCount < 1 || value.clickCount > 3)) return null;
    return withModifiers({
      type: value.type,
      ...position,
      button: value.button,
      clickCount: value.clickCount || 1,
    });
  }
  if (value.type === 'mouseWheel') {
    const position = point();
    if (!position || !finite(value.deltaX) || !finite(value.deltaY)) return null;
    return withModifiers({
      type: 'mouseWheel',
      ...position,
      deltaX: Math.round(clamp(value.deltaX, -1000, 1000)),
      deltaY: Math.round(clamp(value.deltaY, -1000, 1000)),
      canScroll: true,
    });
  }
  if (value.type === 'keyDown' || value.type === 'keyUp') {
    const keyCode = value.keyCode ?? value.key;
    if (!validKey(keyCode)) return null;
    return withModifiers({ type: value.type, keyCode });
  }
  if (value.type === 'char') {
    const keyCode = value.keyCode ?? value.text;
    if (!validKey(keyCode, true)) return null;
    return withModifiers({ type: 'char', keyCode });
  }
  return null;
}

function safeCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,48}$/.test(error.code) ? error.code : 'SAVE_FAILED';
}

class ProgramManager extends EventEmitter {
  constructor({ BrowserWindow, ipcMain, workspace, rendererPath = __dirname, now = Date.now, jpegQuality = 72 } = {}) {
    super();
    if (typeof BrowserWindow !== 'function' || !ipcMain?.handle || !workspace?.readText || !workspace?.writeText) {
      throw new TypeError('ProgramManager requires BrowserWindow, ipcMain, and a workspace with readText/writeText.');
    }
    this.BrowserWindow = BrowserWindow;
    this.ipcMain = ipcMain;
    this.workspace = workspace;
    this.rendererPath = rendererPath;
    this.now = now;
    this.jpegQuality = Math.round(clamp(jpegQuality, 40, 90));
    this.records = new Map();
    this.senders = new Map();
    this.stopped = false;
    this.stopping = false;
    this.installIpc();
  }

  installIpc() {
    this.ipcMain.handle(IPC_BOOTSTRAP, (event) => {
      const record = this.recordForSender(event);
      return {
        programId: record.id,
        appId: record.appId,
        title: record.title,
        text: record.text,
        maxBytes: MAX_TEXT_BYTES,
      };
    });
    this.ipcMain.handle(IPC_SAVE, async (event, payload) => {
      const record = this.recordForSender(event);
      if (!payload || typeof payload !== 'object' || typeof payload.text !== 'string'
        || Buffer.byteLength(payload.text, 'utf8') > MAX_TEXT_BYTES) {
        return { ok: false, code: 'INVALID_TEXT', error: 'The document must be valid text no larger than 2 MiB.' };
      }
      const save = record.saveChain.then(async () => {
        await this.workspace.writeText(record.documentPath, payload.text);
        record.text = payload.text;
        record.modifiedAt = this.now();
        this.emit('saved', { programId: record.id, documentPath: record.documentPath, modifiedAt: record.modifiedAt });
        return { ok: true, savedAt: record.modifiedAt };
      });
      record.saveChain = save.catch(() => {});
      try {
        return await save;
      } catch (error) {
        return { ok: false, code: safeCode(error), error: 'CompuSync could not save this workspace file.' };
      }
    });
  }

  recordForSender(event) {
    const record = event?.sender && this.senders.get(event.sender);
    if (!record || record.closed || event.senderFrame !== record.webContents.mainFrame) {
      throw new ProgramError('UNKNOWN_PROGRAM', 'Unknown program window.');
    }
    return record;
  }

  catalog() {
    return publicCatalog();
  }

  programs() {
    return [...this.records.values()].filter((record) => !record.closed).map((record) => ({
      id: record.id,
      appId: record.appId,
      title: record.title,
      documentPath: record.documentPath,
      width: record.width,
      height: record.height,
      modifiedAt: record.modifiedAt,
    }));
  }

  emitPrograms() {
    this.emit('programs', this.programs());
  }

  async launch(entry, appId = 'text-editor') {
    if (this.stopped) throw new ProgramError('MANAGER_STOPPED', 'Programs are no longer available.');
    if (!validateProgramId(appId)) throw new ProgramError('UNSUPPORTED_PROGRAM', 'That workspace program is not supported.');
    const document = normalizeDocumentRef(entry);
    let text;
    try {
      text = await this.workspace.readText(document.publicPath);
    } catch (error) {
      throw new ProgramError(safeCode(error) === 'SAVE_FAILED' ? 'DOCUMENT_OPEN_FAILED' : safeCode(error), 'CompuSync could not open this workspace file.');
    }
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
      throw new ProgramError('INVALID_TEXT', 'The document must be valid text no larger than 2 MiB.');
    }

    const id = `program-${randomUUID()}`;
    let window;
    try {
      window = new this.BrowserWindow({
        width: 800,
        height: 500,
        show: false,
        frame: false,
        backgroundColor: '#f7f8fa',
        webPreferences: {
          preload: path.join(this.rendererPath, 'editor-preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          backgroundThrottling: false,
          offscreen: true,
        },
      });
    } catch {
      throw new ProgramError('PROGRAM_LOAD_FAILED', 'The text editor could not start.');
    }
    const webContents = window.webContents;
    const record = {
      id,
      appId,
      title: document.title,
      documentPath: document.publicPath,
      text,
      window,
      webContents,
      width: 800,
      height: 500,
      serial: 0,
      lastFrameAt: -Infinity,
      modifiedAt: null,
      saveChain: Promise.resolve(),
      closed: false,
    };
    this.records.set(id, record);
    this.senders.set(webContents, record);

    webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    webContents.on?.('will-navigate', (event) => event.preventDefault());
    webContents.on?.('will-redirect', (event) => event.preventDefault());
    webContents.on?.('will-attach-webview', (event) => event.preventDefault());
    webContents.setFrameRate?.(FRAME_RATE);
    record.paint = (_event, _dirty, image) => this.capture(record, image);
    webContents.on?.('paint', record.paint);
    window.once?.('closed', () => this.cleanup(record));

    try {
      await window.loadFile(path.join(this.rendererPath, 'editor.html'));
    } catch (error) {
      this.cleanup(record);
      if (!window.isDestroyed?.()) window.destroy?.();
      throw new ProgramError('PROGRAM_LOAD_FAILED', 'The text editor could not start.');
    }
    this.emitPrograms();
    return this.metadata(record);
  }

  metadata(record) {
    return {
      id: record.id,
      appId: record.appId,
      title: record.title,
      documentPath: record.documentPath,
      width: record.width,
      height: record.height,
      modifiedAt: record.modifiedAt,
    };
  }

  capture(record, image) {
    if (record.closed || !this.records.has(record.id) || !image || image.isEmpty?.()) return;
    const capturedAt = this.now();
    if (capturedAt - record.lastFrameAt < FRAME_INTERVAL_MS) return;
    const size = image.getSize?.();
    if (!size || !Number.isInteger(size.width) || !Number.isInteger(size.height)
      || size.width < 1 || size.height < 1 || size.width > 4096 || size.height > 4096) return;
    const jpeg = image.toJPEG?.(this.jpegQuality);
    if (!Buffer.isBuffer(jpeg) || !jpeg.length) return;
    record.lastFrameAt = capturedAt;
    record.width = size.width;
    record.height = size.height;
    this.emit('frame', {
      programId: record.id,
      serial: ++record.serial,
      width: size.width,
      height: size.height,
      format: 'jpeg',
      data: jpeg.toString('base64'),
    });
  }

  input(programId, value) {
    const record = this.records.get(programId);
    if (!record || record.closed || record.webContents.isDestroyed?.()) return false;
    const event = validateInputEvent(value, { width: record.width, height: record.height });
    if (!event) return false;
    try {
      record.webContents.focus?.();
      const modifiers = event.modifiers || [];
      const selectAll = event.type === 'keyDown'
        && event.keyCode.toLowerCase() === 'a'
        && modifiers.length === 1
        && (modifiers[0] === 'control' || modifiers[0] === 'meta');
      if (selectAll && typeof record.webContents.selectAll === 'function') {
        record.webContents.selectAll();
        return true;
      }
      record.webContents.sendInputEvent(event);
      return true;
    } catch {
      return false;
    }
  }

  close(programId) {
    const record = this.records.get(programId);
    if (!record || record.closed) return false;
    if (record.window.isDestroyed?.()) this.cleanup(record);
    else if (record.window.close) record.window.close();
    else this.cleanup(record);
    return true;
  }

  cleanup(record) {
    if (!record || record.closed) return;
    record.closed = true;
    record.webContents.removeListener?.('paint', record.paint);
    this.senders.delete(record.webContents);
    this.records.delete(record.id);
    if (!this.stopping) this.emitPrograms();
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.stopping = true;
    this.ipcMain.removeHandler?.(IPC_BOOTSTRAP);
    this.ipcMain.removeHandler?.(IPC_SAVE);
    const records = [...this.records.values()];
    await Promise.allSettled(records.map((record) => record.saveChain));
    for (const record of records) {
      if (!record.window.isDestroyed?.()) record.window.destroy?.();
      this.cleanup(record);
    }
    this.stopping = false;
    this.emitPrograms();
    this.removeAllListeners();
  }
}

module.exports = {
  ProgramManager,
  ProgramError,
  PROGRAM_CATALOG,
  MAX_TEXT_BYTES,
  FRAME_RATE,
  IPC_BOOTSTRAP,
  IPC_SAVE,
  publicCatalog,
  validateProgramId,
  validatePublicPath,
  normalizeDocumentRef,
  validateInputEvent,
};
