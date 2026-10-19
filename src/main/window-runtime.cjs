'use strict';

const { EventEmitter } = require('node:events');
const { DragController } = require('./drag.cjs');
const { BUTTON_BITS } = require('./cursor.cjs');

const WINDOW_FRAME_MS = 1000 / 60;
const CURSOR_EDGE_CAPTURE_VU = 12;
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

function processIdOf(window) {
  const value = Number(window?.pid ?? window?.processId ?? window?.process_id ?? window?.ownerPid ?? window?.owner_pid);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

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

function cursorAtSharedEdge(cursor, source, target, margin = CURSOR_EDGE_CAPTURE_VU) {
  if (!cursor || !source || !target) return false;
  const sourceRight = source.origin.x + source.size.w;
  const sourceBottom = source.origin.y + source.size.h;
  const targetRight = target.origin.x + target.size.w;
  const targetBottom = target.origin.y + target.size.h;
  if (target.origin.x >= source.origin.x + source.size.w) {
    const sharedTop = Math.max(source.origin.y, target.origin.y);
    const sharedBottom = Math.min(sourceBottom, targetBottom);
    return cursor.y >= sharedTop && cursor.y < sharedBottom && cursor.x >= sourceRight - margin;
  }
  if (targetRight <= source.origin.x) {
    const sharedTop = Math.max(source.origin.y, target.origin.y);
    const sharedBottom = Math.min(sourceBottom, targetBottom);
    return cursor.y >= sharedTop && cursor.y < sharedBottom && cursor.x <= source.origin.x + margin;
  }
  if (target.origin.y >= source.origin.y + source.size.h) {
    const sharedLeft = Math.max(source.origin.x, target.origin.x);
    const sharedRight = Math.min(sourceRight, targetRight);
    return cursor.x >= sharedLeft && cursor.x < sharedRight && cursor.y >= sourceBottom - margin;
  }
  const sharedLeft = Math.max(source.origin.x, target.origin.x);
  const sharedRight = Math.min(sourceRight, targetRight);
  return cursor.x >= sharedLeft && cursor.x < sharedRight && cursor.y <= source.origin.y + margin;
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
    this.livenessMs = Number.isFinite(options.livenessMs) ? Math.max(0, options.livenessMs) : 250;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.started = false;
    this.polling = false;
    this.pollPromise = null;
    this.endingPromise = null;
    this.pollTimer = null;
    this.sourceWindowId = null;
    this.sourceStartBounds = null;
    this.sourceGeometryVU = null;
    this.lastLivenessAt = -Infinity;
    this.nativeLoopTerminated = false;
    this.guardedWindowId = null;
    // Never let native window discovery feed one of CompuSync's own Electron
    // windows into a handoff adapter. Chrome identity checks already reject it,
    // but the PID boundary is an independent last line of defence before any
    // adapter can capture, move, or close a source window.
    this.processId = Number.isSafeInteger(options.processId) && options.processId > 0
      ? options.processId : process.pid;
    this.drag = new DragController({
      machineId: this.input.machineId,
      send: (message) => this.input.send(message),
      adapterForWindow: (window) => this.chrome.adapterForWindow(window),
      adapterForId: (id) => this.chrome.adapterForId(id),
      getPlacements: () => this.input.cursor.placements,
      setDragging: (dragging, options) => this.input.setDragging(dragging, options),
      setBusy: this.setBusy,
      refreshSource: (window) => this.#refreshSource(window),
      beginManagedMove: () => this.#enterProgrammaticMove(),
      logger: (event, details) => writeHandoffLog(this.logger, event, details),
    });
    this._moveStart = (id) => { void this.handleMoveStart(id); };
    this._moveEnd = (id) => { void this.handleMoveEnd(id); };
    this._nativeEvent = (event) => {
      if (this.nativeLoopTerminated && event?.kind === 'cursorButton'
        && event.button === 'left' && event.down === false) void this.handleMoveEnd(this.sourceWindowId, { physical: true });
    };
    this._cursorPosition = ({ buttons } = {}) => {
      // Transported releases update logical button state without injecting
      // native events during a managed drag. Cursor frames cover that path
      // even after ownership has crossed to the other laptop.
      if (this.nativeLoopTerminated && Number.isInteger(buttons) && !(buttons & BUTTON_BITS.left)) {
        void this.handleMoveEnd(this.sourceWindowId, { physical: true });
      }
    };
    this._mode = ({ linked, reason }) => {
      this.chrome.setLinked(linked);
      if (!linked) {
        this.setSeam(null);
        if (this.drag.active || this.drag.parked.size) void this.#restoreSafely(reason || 'unlinked');
      }
    };
    this._displayChanged = () => {
      if (this.drag.active || this.drag.parked.size) void this.#restoreSafely('display-changed');
    };
    this._serviceError = (error) => this.#noticeError(error);
    this.drag.on('hint', () => this.showHint('This window stays here. Only supported Chrome windows can cross between laptops.'));
    this.drag.on('position', (state) => this.setSeam(state));
    this.drag.on('paused', (state) => {
      this.setSeam(state);
      this.#settleSource();
    });
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
    this.input.cursor.on?.('position', this._cursorPosition);
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
    if (processIdOf(window) === this.processId) return false;
    const geometryVU = geometryToVU(window, this.localPlacement());
    if (!window || !geometryVU) return false;
    const began = this.drag.begin({ window, geometryVU, cursorVU: this.input.cursor.virtualCursor });
    if (!began) return false;
    this.sourceWindowId = String(id);
    this.sourceStartBounds = boundsOf(window);
    this.sourceGeometryVU = { ...geometryVU };
    this.lastLivenessAt = -Infinity;
    this.nativeLoopTerminated = false;
    this.pollTimer = setInterval(() => { void this.poll(); }, this.frameMs);
    this.pollTimer.unref?.();
    return true;
  }

  async poll() {
    if (!this.drag.active || this.drag.active.role !== 'source') return false;
    if (this.pollPromise) return this.pollPromise;
    const sourceState = this.drag.active;
    const sourceWindowId = this.sourceWindowId;
    this.polling = true;
    const operation = (async () => {
      // Window enumeration is an expensive synchronous AX walk on macOS and
      // must not gate 60 Hz drag frames. Position is authoritative from the
      // shared cursor; only the initially captured width/height are needed.
      const geometryVU = this.sourceGeometryVU || this.drag.active?.geometry;
      const cursorVU = this.input.cursor.virtualCursor;
      const frame = this.drag.frame({ geometryVU, cursorVU });
      await frame;
      if (this.drag.active !== sourceState || this.sourceWindowId !== sourceWindowId) return false;
      const at = this.now();
      if (typeof this.native.windowExists === 'function'
        && at - this.lastLivenessAt >= this.livenessMs) {
        this.lastLivenessAt = at;
        let exists;
        try { exists = await this.native.windowExists(sourceWindowId); }
        catch (error) {
          this.input.watchdog.trigger('window-liveness-failed', error);
          return true;
        }
        if (this.drag.active !== sourceState || this.sourceWindowId !== sourceWindowId) return false;
        if (!exists) {
          await this.drag.sourceDisappeared('source-quit');
          this.setSeam(null);
          this.#settleSource();
          return false;
        }
      }
      return true;
    })();
    this.pollPromise = operation;
    try { return await operation; }
    finally {
      if (this.pollPromise === operation) this.pollPromise = null;
      this.polling = false;
    }
  }

  async handleMoveEnd(id, options = {}) {
    if (!this.drag.active || this.drag.active.role !== 'source'
      || (id != null && String(id) !== this.sourceWindowId)) return false;
    // Ending the OS modal drag can emit a drag-end on either platform while
    // the user's logical button is still held. Await a real release instead.
    if (this.nativeLoopTerminated && !options.physical) return false;
    if (this.endingPromise) return this.endingPromise;
    const operation = this.#finishMove(this.drag.active, this.sourceWindowId);
    this.endingPromise = operation;
    try { return await operation; }
    finally { if (this.endingPromise === operation) this.endingPromise = null; }
  }

  async #finishMove(sourceState, sourceWindowId) {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.pollPromise) {
      try { await this.pollPromise; } catch { /* Drag abort reports the actionable failure. */ }
    }
    if (this.drag.active !== sourceState || this.sourceWindowId !== sourceWindowId) return false;
    await this.poll();
    if (this.drag.active !== sourceState || this.sourceWindowId !== sourceWindowId) return false;
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
    this.input.cursor.off?.('position', this._cursorPosition);
    this.chrome.off?.('error', this._serviceError);
    this.input.setWindowController(null);
    await this.drag.restoreOnScreen(reason);
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
      // The synthetic native mouse-up can synchronously emit MOVESIZEEND.
      // Mark it as the modal-loop terminator before asking the OS to release
      // the drag, otherwise that event is mistaken for the user's real drop.
      this.nativeLoopTerminated = true;
      await this.native.terminateMoveLoop?.(id);
      return true;
    } catch (error) {
      this.nativeLoopTerminated = false;
      try { await this.drag.abort(error?.code || 'native-move-loop-failed'); } catch { /* abort still clears its state */ }
      return false;
    }
  }

  async #refreshSource(window) {
    // Windows can restore a maximized window after MOVESIZESTART. Capture
    // the restored size and actual grab point once, before freezing geometry
    // for the managed drag; keep expensive AX enumeration out of later frames.
    const current = (await this.windows()).find((candidate) => String(candidate.id) === String(window.id));
    const geometryVU = geometryToVU(current, this.localPlacement());
    if (!current || !geometryVU) throw Object.assign(new Error('The source Chrome window disappeared.'), { code: 'source-quit' });
    const resized = !this.sourceGeometryVU || Math.abs(geometryVU.w - this.sourceGeometryVU.w) > 0.5
      || Math.abs(geometryVU.h - this.sourceGeometryVU.h) > 0.5;
    this.sourceGeometryVU = { ...geometryVU };
    return { window: current, geometryVU: resized ? geometryVU : null,
      cursorVU: { ...this.input.cursor.virtualCursor } };
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
    this.sourceGeometryVU = null;
    this.lastLivenessAt = -Infinity;
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
  CURSOR_EDGE_CAPTURE_VU,
  WINDOW_FRAME_MS,
  sanitizeHandoffLog,
  writeHandoffLog,
  boundsOf,
  processIdOf,
  normalizedBoundsOf,
  geometryToVU,
  cursorAtSharedEdge,
  WindowHandoffRuntime,
};
