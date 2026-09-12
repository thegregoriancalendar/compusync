'use strict';

const { EventEmitter } = require('node:events');
const path = require('node:path');

const CANDIDATES = [
  process.env.COMPUSYNC_NATIVE_PATH,
  process.resourcesPath && path.join(process.resourcesPath, 'native', `compusync-native.${process.platform}-${process.arch}.node`),
  path.join(__dirname, 'compusync-native.node'),
  path.join(__dirname, `compusync-native.${process.platform}-${process.arch}.node`),
  path.join(__dirname, 'index.node'),
  path.join(__dirname, 'target', 'release', 'compusync_native.node'),
].filter(Boolean);

function loadBinding() {
  const failures = [];
  for (const candidate of CANDIDATES) {
    try { return { binding: require(candidate), path: candidate, failures }; }
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
  setWindowBounds() {}
  focusWindow() {}
  closeWindow() {}
  guardWindow() {}
  releaseWindowGuard() {}
  terminateMoveLoop() {}
}

class NativeAdapter extends EventEmitter {
  constructor(binding, bindingPath) {
    super();
    this.available = true;
    this.bindingPath = bindingPath;
    this.substrate = new binding.NativeSubstrate();
    this.platformName = this.substrate.platformName;
    this.handlers = {};
    this.callbackInstalled = false;
  }

  _installCallback() {
    if (this.callbackInstalled) return;
    this.substrate.setEventCallback((json) => {
      let event;
      try { event = JSON.parse(json); } catch (error) { this.emit('panic', error); return; }
      this.emit('nativeEvent', event);
      if (event.kind === 'cursorDelta') this.handlers.onDelta?.(event.dx, event.dy, event.dt, event.timestamp);
      else if (event.kind === 'cursorButton') this.handlers.onButton?.(event.button, event.down);
      else if (event.kind === 'keyEvent') {
        this.handlers.onModifiers?.(event.modifiers || 0);
        this.emit('key', event);
      } else if (event.kind === 'recovered') this.emit('recovered', event);
      else if (event.kind === 'unlinkHotkey') this.emit('unlinkHotkey');
      else if (event.kind === 'toggleOwnershipHotkey') this.emit('toggleOwnershipHotkey');
      else if (event.kind === 'displayChanged') this.emit('displayChanged');
      else if (event.kind === 'moveSizeStart' || event.kind === 'moveSizeEnd') this.emit(event.kind, event.windowId);
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
  warpCursor(point) { return this.substrate.warpCursor(point); }
  cursorPosition() { return this.substrate.cursorPosition(); }
  assumeInputState(buttons, modifiers) { return this.substrate.assumeInputState(buttons >>> 0, modifiers >>> 0); }
  synthesizeButton(button, down) { return this.substrate.synthesizeButton(button, Boolean(down)); }
  synthesizeKey(code, down, modifiers = 0) { return this.substrate.synthesizeKey(code >>> 0, Boolean(down), modifiers >>> 0); }
  isForegroundElevated() { return this.substrate.foregroundIsElevated(); }
  releaseInputState() { return this.substrate.releaseInputState(); }
  installRecoveryGuard() { /* Installed by the Rust constructor. setLinked(true) arms its 2s heartbeat. */ }
  removeRecoveryGuard() { return this.substrate.setLinked(false); }
  emergencyRecover(reason = 'requested by JavaScript watchdog') { return this.substrate.recover(reason); }
  removeAllHooks() { return this.substrate.stopCapture(); }
  heartbeat() { return this.substrate.heartbeat(); }
  setLinked(linked) { return this.substrate.setLinked(Boolean(linked)); }
  displayMetrics() { return this.substrate.displayMetrics(); }
  enumerateWindows() { return this.substrate.enumerateWindows(); }
  setWindowBounds(id, bounds) { return this.substrate.setWindowBounds(id, bounds); }
  focusWindow(id) { return this.substrate.focusWindow(id); }
  closeWindow(id) { return this.substrate.closeWindow(id); }
  guardWindow(id, bounds) { return this.substrate.guardWindow(id, bounds); }
  releaseWindowGuard(id) { return this.substrate.releaseWindowGuard(id); }
  terminateMoveLoop(id) { return this.substrate.terminateMoveLoop(id); }
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
  return new NativeAdapter(loaded.binding, loaded.path);
}

module.exports = { createNativeAdapter, loadBinding, NativeAdapter, FallbackNativeAdapter };
