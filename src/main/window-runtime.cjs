'use strict';

const { EventEmitter } = require('node:events');
const { DragController } = require('./drag.cjs');

const WINDOW_FRAME_MS = 1000 / 60;
const HANDOFF_LOG_FIELDS = new Set([
  'type', 'event', 'name', 'id', 'role', 'phase', 'at', 'elapsedMs', 'durationMs',
  'status', 'winner', 'reason', 'instant', 'waitMs', 'keepaliveMs',
]);

function sanitizeHandoffLog(details) {
  const clean = {};
  for (const [key, value] of Object.entries(details || {})) {
    if (!HANDOFF_LOG_FIELDS.has(key)) continue;
    if (typeof value === 'string') clean[key] = value.slice(0, 160).replace(/https?:\/\/[^\s]+/gi, '[redacted-url]');
    else if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
    else if (typeof value === 'boolean' || value === null) clean[key] = value;
  }
  return clean;
}

function writeHandoffLog(logger, event, details) {
  if (!['drag.lifecycle', 'drag.timing'].includes(event)) return;
  const method = typeof logger === 'function' ? logger : logger?.info;
  if (typeof method !== 'function') return;
  try { method.call(logger, event, sanitizeHandoffLog(details)); } catch { /* Logging cannot interrupt handoff. */ }
}

function normalizeBounds(bounds) {
  if (!bounds) return null;
  const x = Number(bounds.x), y = Number(bounds.y);
  const width = Number(bounds.width ?? bounds.w), height = Number(bounds.height ?? bounds.h);
  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
    ? { x, y, width, height } : null;
}

function boundsOf(window) { return normalizeBounds(window?.bounds); }

function normalizedBoundsOf(window) {
  return normalizeBounds(window?.normalizedBounds) || boundsOf(window);
}

function geometryToVU(window, placement) {
  const bounds = normalizedBoundsOf(window);
  if (!bounds || !placement || !Number.isFinite(placement.scale) || placement.scale <= 0) return null;
  return {
    x: bounds.x / placement.scale + placement.origin.x,
    y: bounds.y / placement.scale + placement.origin.y,
    w: bounds.width / placement.scale,
    h: bounds.height / placement.scale,
  };
}

function cursorAtSharedEdge(cursor, source, target) {
  if (!cursor || !source || !target) return false;
  if (target.origin.x >= source.origin.x + source.size.w) {
    return cursor.x >= source.origin.x + source.size.w;
  }
  if (target.origin.x + target.size.w <= source.origin.x) return cursor.x <= source.origin.x;
  if (target.origin.y >= source.origin.y + source.size.h) {
    return cursor.y >= source.origin.y + source.size.h;
  }
  return cursor.y <= source.origin.y;
}

class WindowHandoffRuntime extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.input || !options.native || !options.chrome) throw new TypeError('input, native and chrome are required.');
    this.input = options.input;
    this.native = options.native;
    this.chrome = options.chrome;
    this.onNotice = typeof options.onNotice === 'function' ? options.onNotice : () => {};
    this.setBusy = typeof options.setBusy === 'function' ? options.setBusy : () => {};
    this.setSeam = typeof options.setSeam === 'function' ? options.setSeam : () => {};
    this.showHint = typeof options.showHint === 'function' ? options.showHint : () => {};
    this.logger = options.logger || null;
    this.frameMs = options.frameMs || WINDOW_FRAME_MS;
    this.started = false;
    this.polling = false;
    this.pollTimer = null;
    this.sourceWindowId = null;
    this.sourceStartBounds = null;
    this.nativeLoopTerminated = false;
    this.guardedWindowId = null;
    this.isWindows = (this.native.platformName || (process.platform === 'win32' ? 'windows' : process.platform)) === 'windows';
    this.drag = new DragController({
      machineId: this.input.machineId,
      send: (message) => this.input.send(message),
      adapterForWindow: (window) => this.chrome.adapterForWindow(window),
      adapterForId: (id) => this.chrome.adapterForId(id),
      getPlacements: () => this.input.cursor.placements,
      setDragging: (dragging) => this.input.setDragging(dragging),
      setBusy: this.setBusy,
      logger: (event, details) => writeHandoffLog(this.logger, event, details),
    });
    this._moveStart = (id) => { void this.handleMoveStart(id); };
    this._moveEnd = (id) => { void this.handleMoveEnd(id); };
    this._nativeEvent = (event) => {
      if (this.isWindows && this.nativeLoopTerminated && event?.kind === 'cursorButton'
        && event.button === 'left' && event.down === false) void this.handleMoveEnd(this.sourceWindowId, { physical: true });
    };
    this._mode = ({ linked, reason }) => {
      this.chrome.setLinked(linked);
      if (!linked) {
        this.setSeam(null);
        if (this.drag.active) void this.#restoreSafely(reason || 'unlinked');
      }
    };
    this._displayChanged = () => {
      if (this.drag.active) void this.#restoreSafely('display-changed');
    };
    this._serviceError = (error) => this.#noticeError(error);
    this.drag.on('hint', () => this.showHint('This window stays here. Only supported Chrome windows can cross between laptops.'));
    this.drag.on('position', (state) => this.setSeam(state));
    this.drag.on('abort', ({ reason }) => {
      this.setSeam(null);
      this.#settleSource();
      if (!['peer-abort', 'late-ready'].includes(reason)) this.#noticeError(Object.assign(new Error('The source Chrome window was kept in place.'), { code: reason }));
    });
    this.drag.on('committed', () => {
      this.setSeam(null);
      this.#settleSource();
    });
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.input.setWindowController(this.drag);
    this.native.on?.('moveSizeStart', this._moveStart);
    this.native.on?.('moveSizeEnd', this._moveEnd);
    this.native.on?.('nativeEvent', this._nativeEvent);
    this.native.on?.('displayChanged', this._displayChanged);
    this.input.on?.('mode', this._mode);
    this.chrome.on?.('error', this._serviceError);
    this.chrome.setLinked(this.input.cursor.linked);
  }

  localPlacement() { return this.input.cursor.placementFor(this.input.machineId); }

  async windows() {
    try {
      const windows = await this.native.enumerateWindows();
      return Array.isArray(windows) ? windows : [];
    } catch (error) {
      this.input.watchdog.trigger('window-enumeration-failed', error);
      return [];
    }
  }

  async handleMoveStart(id) {
    if (!this.started || !this.input.cursor.linked || this.drag.active) return false;
    const windows = await this.windows();
    const window = windows.find((candidate) => String(candidate.id) === String(id));
    const geometryVU = geometryToVU(window, this.localPlacement());
    if (!window || !geometryVU) return false;
    const began = this.drag.begin({ window, geometryVU, cursorVU: this.input.cursor.virtualCursor });
    if (!began) return false;
    this.sourceWindowId = String(id);
    this.sourceStartBounds = boundsOf(window);
    this.nativeLoopTerminated = false;
    this.pollTimer = setInterval(() => { void this.poll(); }, this.frameMs);
    this.pollTimer.unref?.();
    return true;
  }

  async poll() {
    if (this.polling || !this.drag.active || this.drag.active.role !== 'source') return false;
    this.polling = true;
    try {
      const windows = await this.windows();
      const window = windows.find((candidate) => String(candidate.id) === this.sourceWindowId);
      if (!window) {
        try { await this.drag.abort('chrome-quit'); } catch { /* The vanished source cannot be restored locally. */ }
        return false;
      }
      const geometryVU = geometryToVU(window, this.localPlacement());
      if (!geometryVU) return false;
      const cursorVU = this.input.cursor.virtualCursor;
      if (!this.nativeLoopTerminated && this.drag.active?.adapter
        && cursorAtSharedEdge(cursorVU, this.drag.active.source, this.drag.active.target)) {
        if (!await this.#enterProgrammaticMove()) return false;
      }
      await this.drag.frame({ geometryVU, cursorVU });
      return true;
    } finally { this.polling = false; }
  }

  async handleMoveEnd(id, options = {}) {
    if (!this.drag.active || this.drag.active.role !== 'source'
      || (id != null && String(id) !== this.sourceWindowId)) return false;
    // terminateMoveLoop causes MOVESIZEEND on Windows, but the user's true
    // physical left button is still held and raw deltas must keep driving.
    if (this.isWindows && this.nativeLoopTerminated && !options.physical) return false;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    await this.poll();
    const geometryVU = this.drag.active?.geometry;
    const ended = await this.drag.end({ geometryVU });
    this.setSeam(this.drag.snapshot());
    if (!this.drag.active) this.#settleSource();
    return ended;
  }

  async stop(reason = 'window-runtime-stop') {
    if (!this.started) { this.setSeam(null); return; }
    this.started = false;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.native.off?.('moveSizeStart', this._moveStart);
    this.native.off?.('moveSizeEnd', this._moveEnd);
    this.native.off?.('nativeEvent', this._nativeEvent);
    this.native.off?.('displayChanged', this._displayChanged);
    this.input.off?.('mode', this._mode);
    this.chrome.off?.('error', this._serviceError);
    this.input.setWindowController(null);
    await this.drag.abort(reason);
    this.setSeam(null);
    this.#settleSource();
    this.chrome.stop();
  }

  async #enterProgrammaticMove() {
    const id = this.sourceWindowId;
    if (!id || this.nativeLoopTerminated) return true;
    try {
      await this.native.guardWindow?.(id, this.sourceStartBounds);
      this.guardedWindowId = id;
      await this.native.terminateMoveLoop?.(id);
      this.nativeLoopTerminated = true;
      return true;
    } catch (error) {
      try { await this.drag.abort(error?.code || 'native-move-loop-failed'); } catch { /* abort still clears its state */ }
      return false;
    }
  }

  #settleSource() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    const guarded = this.guardedWindowId;
    this.guardedWindowId = null;
    if (guarded != null) {
      try {
        const released = this.native.releaseWindowGuard?.(guarded);
        released?.catch?.((error) => this.input.watchdog.trigger('window-guard-release-failed', error));
      } catch (error) { this.input.watchdog.trigger('window-guard-release-failed', error); }
    }
    this.sourceWindowId = null;
    this.sourceStartBounds = null;
    this.nativeLoopTerminated = false;
  }

  async #restoreSafely(reason) {
    try { await this.drag.restoreOnScreen(reason); }
    catch { /* DragController still clears and emits abort if native restoration fails. */ }
  }

  #noticeError(error) {
    const code = error?.code || 'window-handoff-failed';
    const permission = code === 'CHROME_AUTOMATION_DENIED';
    this.onNotice({
      id: String(code).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 100),
      kind: permission ? 'permission' : 'warning',
      title: permission ? 'Allow Chrome Automation' : 'Chrome handoff did not complete',
      message: error?.message || 'The source Chrome window was kept in place.',
      ...(permission ? { actionLabel: 'Open Automation Settings', action: 'open-automation', dismissible: false } : { dismissible: true }),
    });
  }
}

module.exports = {
  WINDOW_FRAME_MS,
  sanitizeHandoffLog,
  writeHandoffLog,
  boundsOf,
  normalizedBoundsOf,
  geometryToVU,
  cursorAtSharedEdge,
  WindowHandoffRuntime,
};
