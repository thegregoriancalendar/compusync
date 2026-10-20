'use strict';

const { EventEmitter } = require('node:events');
const path = require('node:path');

function nativeCandidates({
  envPath = process.env.COMPUSYNC_NATIVE_PATH,
  resourcesPath = process.resourcesPath,
  platform = process.platform,
  arch = process.arch,
  nativeDirectory = __dirname,
} = {}) {
  const platformFile = `compusync-native.${platform}-${arch}.node`;
  return [
    envPath,
    resourcesPath && path.join(resourcesPath, 'native', platformFile),
    // Prefer the platform-qualified development build. An unqualified addon
    // may be left over from an older checkout and expose an obsolete API.
    path.join(nativeDirectory, platformFile),
    path.join(nativeDirectory, 'compusync-native.node'),
    path.join(nativeDirectory, 'index.node'),
    path.join(nativeDirectory, 'target', 'release', 'compusync_native.node'),
  ].filter(Boolean);
}

const CANDIDATES = nativeCandidates();

const REQUIRED_SUBSTRATE_METHODS = Object.freeze([
  'configureAcceleration', 'setEventCallback', 'startCapture', 'stopCapture',
  'showCursor', 'hideCursor', 'parkCursor', 'releaseCursor', 'warpCursor',
  'cursorPosition', 'assumeInputState', 'synthesizeButton', 'synthesizeKey', 'synthesizeScroll',
  'setGestureForwarding', 'synthesizeGesture',
  'foregroundIsElevated', 'releaseInputState', 'installRecoveryGuard',
  'setLinked', 'recover', 'heartbeat', 'displayMetrics', 'enumerateWindows',
  'setWindowBounds', 'focusWindow', 'closeWindow', 'guardWindow',
  'releaseWindowGuard', 'terminateMoveLoop',
]);

function missingSubstrateMethods(binding) {
  const prototype = binding?.NativeSubstrate?.prototype;
  if (!prototype) return [...REQUIRED_SUBSTRATE_METHODS];
  return REQUIRED_SUBSTRATE_METHODS.filter((name) => typeof prototype[name] !== 'function');
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function coordinateSpace(displays, platformName = process.platform) {
  if (!Array.isArray(displays) || !displays.length) throw new TypeError('At least one native display is required.');
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const display of displays) {
    const bounds = display?.bounds;
    if (![bounds?.x, bounds?.y, bounds?.width, bounds?.height].every(finite)
      || bounds.width <= 0 || bounds.height <= 0) throw new TypeError('Native display bounds are invalid.');
    left = Math.min(left, bounds.x);
    top = Math.min(top, bounds.y);
    right = Math.max(right, bounds.x + bounds.width);
    bottom = Math.max(bottom, bounds.y + bounds.height);
  }
  const primary = displays.find((display) => display.primary) || displays[0];
  // Win32 cursor/window coordinates are physical desktop pixels in the DPI-
  // aware addon. CoreGraphics and AX coordinates are logical points, so the
  // native boundary is where Retina pixels must be converted.
  const scale = platformName === 'darwin' ? Number(primary.scale) : 1;
  if (!finite(scale) || scale <= 0 || scale > 8) throw new TypeError('Native display scale is invalid.');
  return Object.freeze({ x: left, y: top, width: right - left, height: bottom - top, scale });
}

function validPoint(value) {
  if (!value || !finite(value.x) || !finite(value.y)) throw new TypeError('Native point must be finite.');
  return value;
}

function validBounds(value) {
  validPoint(value);
  if (!finite(value.width) || !finite(value.height) || value.width <= 0 || value.height <= 0) {
    throw new TypeError('Native bounds must have a positive finite size.');
  }
  return value;
}

function validSpace(value) {
  if (!value || !finite(value.x) || !finite(value.y) || !finite(value.scale)
    || value.scale <= 0 || value.scale > 8) throw new TypeError('Native coordinate space is invalid.');
  return value;
}

function toNormalizedPoint(point, space) {
  validPoint(point);
  validSpace(space);
  return { x: (point.x - space.x) * space.scale, y: (point.y - space.y) * space.scale };
}

function toPlatformPoint(point, space) {
  validPoint(point);
  validSpace(space);
  return { x: point.x / space.scale + space.x, y: point.y / space.scale + space.y };
}

function toNormalizedBounds(bounds, space) {
  validBounds(bounds);
  const origin = toNormalizedPoint(bounds, space);
  return { ...origin, width: bounds.width * space.scale, height: bounds.height * space.scale };
}

function toPlatformBounds(bounds, space) {
  validBounds(bounds);
  const origin = toPlatformPoint(bounds, space);
  return { ...origin, width: bounds.width / space.scale, height: bounds.height / space.scale };
}

function loadBinding(options = {}) {
  const failures = [];
  const candidates = options.candidates || CANDIDATES;
  const requireBinding = options.requireBinding || require;
  for (const candidate of candidates) {
    try {
      const binding = requireBinding(candidate);
      const missingMethods = missingSubstrateMethods(binding);
      if (missingMethods.length) {
        failures.push({
          path: candidate,
          code: 'COMPUSYNC_NATIVE_INCOMPATIBLE',
          message: `Native addon is missing required methods: ${missingMethods.join(', ')}`,
        });
        continue;
      }
      return { binding, path: candidate, failures };
    }
    catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND' && error?.code !== 'ERR_DLOPEN_FAILED') throw error;
      failures.push({ path: candidate, code: error.code, message: error.message });
    }
  }
  return { binding: null, path: null, failures };
}

class FallbackNativeAdapter extends EventEmitter {
  constructor(loadFailures = []) {
    super();
    this.available = false;
    this.platformName = 'fallback';
    this.loadFailures = loadFailures;
    this._position = { x: 0, y: 0 };
  }
  configureAcceleration() {}
  startCursorCapture() {}
  stopCursorCapture() {}
  showCursor() {}
  hideCursor() {}
  parkCursor() {}
  releaseCursor() {}
  warpCursor(point) { if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) this._position = { ...point }; }
  cursorPosition() { return { ...this._position }; }
  assumeInputState() {}
  synthesizeButton() {}
  synthesizeKey() {}
  synthesizeScroll() {}
  setGestureForwarding() {}
  synthesizeGesture() {}
  isForegroundElevated() { return false; }
  releaseInputState() {}
  installRecoveryGuard() {}
  removeRecoveryGuard() {}
  emergencyRecover() {}
  removeAllHooks() {}
  heartbeat() {}
  setLinked() {}
  displayMetrics() { return []; }
  enumerateWindows() { return []; }
  windowExists() { return false; }
  enumerateWindowsNormalized() { return []; }
  setWindowBounds() {}
  setWindowBoundsNormalized(id, bounds) { return this.setWindowBounds(id, bounds); }
  focusWindow() {}
  closeWindow() {}
  guardWindow() {}
  releaseWindowGuard() {}
  terminateMoveLoop() {}
  inputMonitoringAccess() { return false; }
  chromeAutomationAccess() { return 'unavailable'; }
  permissionPreflightAvailable() { return false; }
  refreshCoordinateSpace() { return null; }
  toNormalizedPoint(point) { return { ...validPoint(point) }; }
  toPlatformPoint(point) { return { ...validPoint(point) }; }
  toNormalizedBounds(bounds) { return { ...validBounds(bounds) }; }
  toPlatformBounds(bounds) { return { ...validBounds(bounds) }; }
  toDesktopDIPBounds(bounds) { return this.toPlatformBounds(bounds); }
}

class NativeAdapter extends EventEmitter {
  constructor(binding, bindingPath, options = {}) {
    super();
    this.available = true;
    this.bindingPath = bindingPath;
    this.substrate = new binding.NativeSubstrate();
    this.platformName = this.substrate.platformName;
    this.handlers = {};
    this.callbackInstalled = false;
    this._coordinateSpace = null;
    this.screen = options.screen;
    this.guardPath = path.join(path.dirname(bindingPath), `compusync-recovery-guard${process.platform === 'win32' ? '.exe' : ''}`);
  }

  _installCallback() {
    if (this.callbackInstalled) return;
    this.substrate.setEventCallback((...callbackArgs) => {
      try {
        // Current addons use Node's error-first callback convention. Continue
        // accepting the one-argument convention used by v3 development builds
        // so replacing an addon can never turn the first input event into a
        // process-fatal callback exception.
        const error = callbackArgs.length > 1 || callbackArgs[0] == null
          ? callbackArgs[0] : (typeof callbackArgs[0] === 'string' ? null : callbackArgs[0]);
        if (error) throw error;
        const json = callbackArgs.length > 1 ? callbackArgs[1] : callbackArgs[0];
        if (typeof json !== 'string') throw new TypeError('Native input event must be JSON text.');
        const event = JSON.parse(json);
        this.emit('nativeEvent', event);
        if (event.kind === 'cursorDelta') this.handlers.onDelta?.(event.dx, event.dy, event.dt, event.timestamp);
        else if (event.kind === 'cursorButton') this.handlers.onButton?.(event.button, event.down, event.clickCount ?? undefined);
        else if (event.kind === 'keyEvent') {
          this.handlers.onModifiers?.(event.modifiers || 0);
          this.emit('key', event);
        } else if (event.kind === 'recovered') this.emit('recovered', event);
        else if (event.kind === 'scrollDelta') this.emit('scroll', event);
        else if (event.kind === 'trackpadGesture') this.emit('gesture', event);
        else if (event.kind === 'unlinkHotkey') this.emit('unlinkHotkey');
        else if (event.kind === 'toggleOwnershipHotkey') this.emit('toggleOwnershipHotkey');
        else if (event.kind === 'displayChanged') {
          this._coordinateSpace = null;
          this.emit('displayChanged');
        }
      else if (event.kind === 'moveSizeStart' || event.kind === 'moveSizeEnd') {
        this.emit(event.kind, event.windowId ?? event.window_id);
      }
      } catch (error) {
        // A ThreadsafeFunction callback is a fatal N-API boundary: anything
        // thrown from here terminates Electron (SIGTRAP on macOS). Recovery is
        // best effort and must therefore be unable to escape this callback too.
        try {
          if (this.listenerCount('panic') > 0) this.emit('panic', error);
          else console.error('[Compusync] Native input callback failed:', error);
        } catch (recoveryError) {
          try { console.error('[Compusync] Native input recovery failed:', recoveryError); } catch { /* Never cross N-API. */ }
        }
      }
    });
    this.callbackInstalled = true;
  }

  configureAcceleration(value) { return this.substrate.configureAcceleration(value); }
  startCursorCapture(handlers = {}) { this.handlers = handlers; this._installCallback(); return this.substrate.startCapture(); }
  stopCursorCapture() { this.handlers = {}; return this.substrate.stopCapture(); }
  showCursor() { return this.substrate.showCursor(); }
  hideCursor() { return this.substrate.hideCursor(); }
  parkCursor() { return this.substrate.parkCursor(); }
  releaseCursor() { return this.substrate.releaseCursor(); }
  warpCursor(point) { return this.substrate.warpCursor(this.toPlatformPoint(point)); }
  cursorPosition() { return this.toNormalizedPoint(this.substrate.cursorPosition()); }
  assumeInputState(buttons, modifiers) { return this.substrate.assumeInputState(buttons >>> 0, modifiers >>> 0); }
  synthesizeButton(button, down, clickCount = 1) { return this.substrate.synthesizeButton(button, Boolean(down), clickCount); }
  synthesizeKey(code, down, modifiers = 0) { return this.substrate.synthesizeKey(code >>> 0, Boolean(down), modifiers >>> 0); }
  synthesizeScroll(dy) { return this.substrate.synthesizeScroll(Number(dy)); }
  setGestureForwarding(enabled) { return this.substrate.setGestureForwarding(Boolean(enabled)); }
  synthesizeGesture(data) { return this.substrate.synthesizeGesture(data); }
  isForegroundElevated() { return this.substrate.foregroundIsElevated(); }
  releaseInputState() { return this.substrate.releaseInputState(); }
  installRecoveryGuard() { return this.substrate.installRecoveryGuard(this.guardPath); }
  removeRecoveryGuard() { return this.substrate.setLinked(false); }
  emergencyRecover(reason = 'requested by JavaScript watchdog') { return this.substrate.recover(reason); }
  removeAllHooks() { return this.substrate.stopCapture(); }
  heartbeat() { return this.substrate.heartbeat(); }
  setLinked(linked) { return this.substrate.setLinked(Boolean(linked)); }
  displayMetrics() { return this.substrate.displayMetrics(); }
  coordinateSpace(displays) {
    if (displays) return coordinateSpace(displays, this.platformName);
    if (!this._coordinateSpace) this._coordinateSpace = coordinateSpace(this.displayMetrics(), this.platformName);
    return this._coordinateSpace;
  }
  refreshCoordinateSpace() {
    this._coordinateSpace = coordinateSpace(this.displayMetrics(), this.platformName);
    return this._coordinateSpace;
  }
  toNormalizedPoint(point, displays) { return toNormalizedPoint(point, this.coordinateSpace(displays)); }
  toPlatformPoint(point, displays) { return toPlatformPoint(point, this.coordinateSpace(displays)); }
  toNormalizedBounds(bounds, displays) { return toNormalizedBounds(bounds, this.coordinateSpace(displays)); }
  toPlatformBounds(bounds, displays) { return toPlatformBounds(bounds, this.coordinateSpace(displays)); }
  toDesktopDIPBounds(bounds) {
    const platformBounds = this.toPlatformBounds(bounds);
    if (!['windows', 'win32'].includes(this.platformName)) return platformBounds;
    // Chrome's window APIs use desktop DIPs; Win32 uses physical pixels.
    // Let Chromium map monitor origins as well as dimensions. Dividing the
    // whole desktop by the primary scale breaks mixed-DPI monitor layouts.
    const screen = this.screen || require('electron').screen;
    if (typeof screen?.screenToDipRect !== 'function') throw new TypeError('Desktop DIP conversion requires Electron screen.');
    const rounded = Object.fromEntries(Object.entries(platformBounds).map(([key, value]) => [key, Math.round(value)]));
    return validBounds(screen.screenToDipRect(null, rounded));
  }
  enumerateWindows() {
    const windows = this.substrate.enumerateWindows();
    if (!Array.isArray(windows)) throw new TypeError('Native window enumeration must return an array.');
    const space = this.coordinateSpace();
    const usable = [];
    for (const window of windows) {
      // OS window lists routinely include transient, minimized, cloaked, or
      // closing windows with empty geometry. They cannot participate in a
      // handoff, but must not invalidate every other window in the snapshot.
      try { validBounds(window?.bounds); } catch { continue; }
      usable.push({
        ...window,
        // Keep `bounds` in raw OS-global coordinates: Chrome CDP window matching
        // relies on it. New VU-aware callers must opt into normalizedBounds.
        normalizedBounds: toNormalizedBounds(window.bounds, space),
      });
    }
    return usable;
  }
  enumerateWindowsNormalized() {
    return this.enumerateWindows().map((window) => ({ ...window, bounds: window.normalizedBounds }));
  }
  setWindowBounds(id, bounds) { return this.substrate.setWindowBounds(id, bounds); }
  setWindowBoundsNormalized(id, bounds) { return this.substrate.setWindowBounds(id, this.toPlatformBounds(bounds)); }
  focusWindow(id) { return this.substrate.focusWindow(id); }
  closeWindow(id) { return this.substrate.closeWindow(id); }
  guardWindow(id, bounds) { return this.substrate.guardWindow(id, bounds); }
  releaseWindowGuard(id) { return this.substrate.releaseWindowGuard(id); }
  terminateMoveLoop(id) { return this.substrate.terminateMoveLoop(id); }
  inputMonitoringAccess(request = false) {
    return typeof this.substrate.inputMonitoringAccess === 'function'
      && this.substrate.inputMonitoringAccess(Boolean(request));
  }
  windowExists(id) {
    return typeof this.substrate.windowExists === 'function'
      ? this.substrate.windowExists(String(id)) : true;
  }
  chromeAutomationAccess(request = false) {
    return typeof this.substrate.chromeAutomationAccess === 'function'
      ? this.substrate.chromeAutomationAccess(Boolean(request)) : 'unavailable';
  }
  permissionPreflightAvailable() {
    return typeof this.substrate.inputMonitoringAccess === 'function'
      && typeof this.substrate.chromeAutomationAccess === 'function';
  }
}

function createNativeAdapter(options = {}) {
  const loaded = loadBinding();
  if (!loaded.binding) {
    if (options.required) {
      const error = new Error(`Compusync native addon is unavailable for ${process.platform}-${process.arch}`);
      error.code = 'COMPUSYNC_NATIVE_UNAVAILABLE';
      error.failures = loaded.failures;
      throw error;
    }
    return new FallbackNativeAdapter(loaded.failures);
  }
  return new NativeAdapter(loaded.binding, loaded.path, options);
}

module.exports = {
  createNativeAdapter,
  loadBinding,
  NativeAdapter,
  FallbackNativeAdapter,
  coordinateSpace,
  toNormalizedPoint,
  toPlatformPoint,
  toNormalizedBounds,
  toPlatformBounds,
  nativeCandidates,
  missingSubstrateMethods,
  REQUIRED_SUBSTRATE_METHODS,
};
