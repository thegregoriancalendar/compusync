'use strict';

const SEAM_THICKNESS = 12;
const HINT_WIDTH = 430;
const HINT_HEIGHT = 54;
const HINT_DURATION_MS = 3600;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function desktopBounds(displays) {
  if (!Array.isArray(displays) || !displays.length) return null;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const display of displays) {
    const bounds = display?.bounds;
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(finite)
      || bounds.width <= 0 || bounds.height <= 0) return null;
    left = Math.min(left, bounds.x);
    top = Math.min(top, bounds.y);
    right = Math.max(right, bounds.x + bounds.width);
    bottom = Math.max(bottom, bounds.y + bounds.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function sharedEdge(local, peer) {
  if (!local || !peer) return null;
  const epsilon = 1e-4;
  if (Math.abs(local.origin.x + local.size.w - peer.origin.x) <= epsilon) return 'right';
  if (Math.abs(peer.origin.x + peer.size.w - local.origin.x) <= epsilon) return 'left';
  if (Math.abs(local.origin.y + local.size.h - peer.origin.y) <= epsilon) return 'bottom';
  return null;
}

function intersects(rect, placement) {
  if (!rect || !placement) return false;
  return Math.min(rect.x + rect.w, placement.origin.x + placement.size.w) > Math.max(rect.x, placement.origin.x)
    && Math.min(rect.y + rect.h, placement.origin.y + placement.size.h) > Math.max(rect.y, placement.origin.y);
}

function seamBounds(local, peer, bounds, thickness = SEAM_THICKNESS) {
  const edge = sharedEdge(local, peer);
  if (!edge || !bounds) return null;
  const half = Math.ceil(thickness / 2);
  if (edge === 'left' || edge === 'right') {
    const startVU = Math.max(local.origin.y, peer.origin.y);
    const endVU = Math.min(local.origin.y + local.size.h, peer.origin.y + peer.size.h);
    if (endVU <= startVU) return null;
    const scale = bounds.height / local.size.h;
    return {
      edge,
      x: edge === 'right' ? bounds.x + bounds.width - half : bounds.x - half,
      y: bounds.y + Math.round((startVU - local.origin.y) * scale),
      width: thickness,
      height: Math.max(1, Math.round((endVU - startVU) * scale)),
    };
  }
  const startVU = Math.max(local.origin.x, peer.origin.x);
  const endVU = Math.min(local.origin.x + local.size.w, peer.origin.x + peer.size.w);
  if (endVU <= startVU) return null;
  const scale = bounds.width / local.size.w;
  return {
    edge,
    x: bounds.x + Math.round((startVU - local.origin.x) * scale),
    y: bounds.y + bounds.height - half,
    width: Math.max(1, Math.round((endVU - startVU) * scale)),
    height: thickness,
  };
}

function seamForSnapshot(snapshot, machineId, bounds) {
  if (!snapshot || !machineId) return null;
  const local = snapshot.source?.machineId === machineId ? snapshot.source
    : snapshot.target?.machineId === machineId ? snapshot.target : null;
  const peer = local === snapshot.source ? snapshot.target : snapshot.source;
  const geometry = snapshot.geometry || snapshot.descriptor?.geometryVU;
  if (!local || !peer || !intersects(geometry, local) || !intersects(geometry, peer)) return null;
  return seamBounds(local, peer, bounds);
}

class SeamOverlay {
  constructor(options = {}) {
    if (typeof options.BrowserWindow !== 'function' || !options.screen
      || typeof options.preloadPath !== 'string' || typeof options.rendererPath !== 'string') {
      throw new TypeError('BrowserWindow, screen, preloadPath and rendererPath are required.');
    }
    this.BrowserWindow = options.BrowserWindow;
    this.screen = options.screen;
    this.preloadPath = options.preloadPath;
    this.rendererPath = options.rendererPath;
    this.secureWindow = options.secureWindow;
    this.hintDurationMs = finite(options.hintDurationMs) ? options.hintDurationMs : HINT_DURATION_MS;
    this.window = null;
    this.ready = false;
    this.pending = null;
    this.hintTimer = null;
    this.hintShown = false;
  }

  create() {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const window = this.window = new this.BrowserWindow({
      width: SEAM_THICKNESS, height: SEAM_THICKNESS, x: 0, y: 0,
      title: 'CompuSync handoff', show: false, frame: false, transparent: true,
      backgroundColor: '#00000000', resizable: false, movable: false,
      minimizable: false, maximizable: false, closable: false, fullscreenable: false,
      focusable: false, skipTaskbar: true, hasShadow: false, roundedCorners: false,
      webPreferences: {
        preload: this.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    window.setMenuBarVisibility?.(false);
    window.setAlwaysOnTop?.(true, 'floating');
    window.setIgnoreMouseEvents?.(true);
    window.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
    this.secureWindow?.(window);
    window.webContents.once('did-finish-load', () => {
      if (this.window !== window) return;
      this.ready = true;
      this.#applyPending();
    });
    window.on('closed', () => {
      if (this.window === window) { this.window = null; this.ready = false; }
    });
    window.loadFile(this.rendererPath);
    return window;
  }

  update(snapshot, machineId) {
    clearTimeout(this.hintTimer);
    this.hintTimer = null;
    const bounds = desktopBounds(this.screen.getAllDisplays());
    const seam = seamForSnapshot(snapshot, machineId, bounds);
    this.pending = seam ? { bounds: seam, state: { mode: 'seam', edge: seam.edge } } : null;
    this.#applyPending();
    return Boolean(seam);
  }

  showHint(message = 'This window stays here. Only supported Chrome windows can cross between laptops.') {
    if (this.hintShown) return false;
    this.hintShown = true;
    clearTimeout(this.hintTimer);
    const display = this.screen.getDisplayNearestPoint?.(this.screen.getCursorScreenPoint?.() || { x: 0, y: 0 })
      || this.screen.getPrimaryDisplay();
    const area = display.workArea || display.bounds;
    const width = Math.min(HINT_WIDTH, area.width);
    this.pending = {
      bounds: {
        x: Math.round(area.x + (area.width - width) / 2),
        y: Math.round(area.y + area.height - HINT_HEIGHT - 24),
        width, height: HINT_HEIGHT,
      },
      state: { mode: 'hint', message: String(message).slice(0, 240) },
    };
    this.#applyPending();
    this.hintTimer = setTimeout(() => this.clear(), this.hintDurationMs);
    this.hintTimer.unref?.();
    return true;
  }

  clear() {
    clearTimeout(this.hintTimer);
    this.hintTimer = null;
    this.pending = null;
    if (!this.window || this.window.isDestroyed()) return;
    if (this.ready) this.window.webContents.send('sync:handoff-overlay', { mode: 'hidden' });
    this.window.hide();
  }

  destroy() {
    this.clear();
    const window = this.window;
    this.window = null;
    this.ready = false;
    if (window && !window.isDestroyed()) window.destroy();
  }

  #applyPending() {
    if (!this.pending) { this.clear(); return; }
    const window = this.create();
    if (!this.ready || window.isDestroyed()) return;
    const { edge: _edge, ...bounds } = this.pending.bounds;
    window.setBounds(bounds, false);
    window.webContents.send('sync:handoff-overlay', this.pending.state);
    window.showInactive();
  }
}

module.exports = {
  SEAM_THICKNESS,
  HINT_DURATION_MS,
  desktopBounds,
  sharedEdge,
  intersects,
  seamBounds,
  seamForSnapshot,
  SeamOverlay,
};
