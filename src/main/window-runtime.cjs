'use strict';

const { EventEmitter } = require('node:events');
const { DragController } = require('./drag.cjs');

const WINDOW_FRAME_MS = 1000 / 60;

function boundsOf(window) {
  const bounds = window?.bounds;
  if (!bounds) return null;
  const x = Number(bounds.x), y = Number(bounds.y);
  const width = Number(bounds.width ?? bounds.w), height = Number(bounds.height ?? bounds.h);
  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
    ? { x, y, width, height } : null;
}

function geometryToVU(window, placement) {
  const bounds = boundsOf(window);
  if (!bounds || !placement || !Number.isFinite(placement.scale) || placement.scale <= 0) return null;
  return {
    x: bounds.x / placement.scale + placement.origin.x,
    y: bounds.y / placement.scale + placement.origin.y,
    w: bounds.width / placement.scale,
    h: bounds.height / placement.scale,
  };
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
    this.frameMs = options.frameMs || WINDOW_FRAME_MS;
    this.started = false;
    this.polling = false;
    this.pollTimer = null;
    this.sourceWindowId = null;
    this.drag = new DragController({
      machineId: this.input.machineId,
      send: (message) => this.input.send(message),
      adapterForWindow: (window) => this.chrome.adapterForWindow(window),
      adapterForId: (id) => this.chrome.adapterForId(id),
      getPlacements: () => this.input.cursor.placements,
      setDragging: (dragging) => this.input.setDragging(dragging),
      setBusy: this.setBusy,
    });
    this._moveStart = (id) => { void this.handleMoveStart(id); };
    this._moveEnd = (id) => { void this.handleMoveEnd(id); };
    this._mode = ({ linked }) => this.chrome.setLinked(linked);
    this._serviceError = (error) => this.#noticeError(error);
    this.drag.on('hint', () => this.onNotice({
      id: 'non-crossing-window', kind: 'info', title: 'This window stays here',
      message: 'Only Chrome windows with available handoff access can cross between laptops.', dismissible: true,
    }));
    this.drag.on('abort', ({ reason }) => {
      if (!['peer-abort', 'late-ready'].includes(reason)) this.#noticeError(Object.assign(new Error('The source Chrome window was kept in place.'), { code: reason }));
    });
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.input.setWindowController(this.drag);
    this.native.on?.('moveSizeStart', this._moveStart);
    this.native.on?.('moveSizeEnd', this._moveEnd);
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
      if (!window) { await this.drag.abort('chrome-quit'); return false; }
      const geometryVU = geometryToVU(window, this.localPlacement());
      if (!geometryVU) return false;
      await this.drag.frame({ geometryVU, cursorVU: this.input.cursor.virtualCursor });
      return true;
    } finally { this.polling = false; }
  }

  async handleMoveEnd(id) {
    if (!this.drag.active || this.drag.active.role !== 'source'
      || (id != null && String(id) !== this.sourceWindowId)) return false;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    await this.poll();
    const geometryVU = this.drag.active?.geometry;
    this.sourceWindowId = null;
    return this.drag.end({ geometryVU });
  }

  async stop(reason = 'window-runtime-stop') {
    if (!this.started) return;
    this.started = false;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.native.off?.('moveSizeStart', this._moveStart);
    this.native.off?.('moveSizeEnd', this._moveEnd);
    this.input.off?.('mode', this._mode);
    this.chrome.off?.('error', this._serviceError);
    this.input.setWindowController(null);
    await this.drag.abort(reason);
    this.chrome.stop();
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

module.exports = { WINDOW_FRAME_MS, boundsOf, geometryToVU, WindowHandoffRuntime };
