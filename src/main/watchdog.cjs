'use strict';

const { EventEmitter } = require('node:events');

const HEARTBEAT_INTERVAL_MS = 500;
const HEARTBEAT_TIMEOUT_MS = 2000;
const CHECK_INTERVAL_MS = 250;

function attempt(action, errors) {
  try { action(); } catch (error) { errors.push(error); }
}

class RecoveryWatchdog extends EventEmitter {
  constructor(options = {}) {
    super();
    this.native = options.native || {};
    this.cursor = options.cursor || null;
    this.keyboard = options.keyboard || null;
    this.drag = options.drag || null;
    this.send = typeof options.send === 'function' ? options.send : () => false;
    this.onUnlinked = typeof options.onUnlinked === 'function' ? options.onUnlinked : () => {};
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs || HEARTBEAT_TIMEOUT_MS;
    this.checkIntervalMs = options.checkIntervalMs || CHECK_INTERVAL_MS;
    this.peerConnected = false;
    this.lastHeartbeat = 0;
    this.recovered = false;
    this.started = false;
    this.heartbeatTimer = null;
    this.checkTimer = null;
    this.processBindings = [];
    this.powerBindings = [];
    this.panicHandler = (error) => this.trigger('addon-panic', error);
  }

  start() {
    if (this.started) return;
    this.started = true;
    // The addon owns the final crash guard. Its implementation must not call
    // back into JS in order to recover cursor visibility and parking.
    this.native.installRecoveryGuard?.();
    if (this.cursor?.linked !== false) {
      this.native.setLinked?.(true);
      this.native.heartbeat?.();
    }
    this.native.on?.('panic', this.panicHandler);
    this.heartbeatTimer = setInterval(() => {
      if (this.cursor?.linked !== false) {
        this.native.heartbeat?.();
        if (this.peerConnected) this.send({ type: 'heartbeat', t: this.now() });
      }
    }, this.heartbeatIntervalMs);
    this.checkTimer = setInterval(() => this.check(), this.checkIntervalMs);
    this.heartbeatTimer.unref?.();
    this.checkTimer.unref?.();
  }

  arm() {
    this.recovered = false;
    this.lastHeartbeat = this.now();
    this.native.installRecoveryGuard?.();
    this.native.setLinked?.(this.cursor?.linked !== false);
    if (this.cursor?.linked !== false) this.native.heartbeat?.();
  }

  setPeerConnected(connected) {
    this.peerConnected = Boolean(connected);
    this.lastHeartbeat = this.peerConnected ? this.now() : 0;
    if (!this.peerConnected && this.cursor?.linked) this.trigger('transport-error');
  }

  receiveHeartbeat(message) {
    if (message?.type !== 'heartbeat' || typeof message.t !== 'number' || !Number.isFinite(message.t)) return false;
    this.lastHeartbeat = this.now();
    return true;
  }

  check() {
    if (!this.recovered && this.peerConnected && this.cursor?.linked !== false
      && this.now() - this.lastHeartbeat > this.heartbeatTimeoutMs) {
      this.trigger('heartbeat-timeout');
      return false;
    }
    return true;
  }

  transportError(error) {
    return this.trigger('transport-error', error);
  }

  addonPanic(error) {
    return this.trigger('addon-panic', error);
  }

  trigger(reason = 'failure', cause = null) {
    if (this.recovered) return false;
    this.recovered = true;
    const errors = [];
    // Each step is isolated. A broken native operation must never prevent the
    // remaining recovery operations from running.
    attempt(() => this.native.emergencyRecover?.(), errors);
    attempt(() => this.native.setLinked?.(false), errors);
    attempt(() => this.native.showCursor?.(), errors);
    attempt(() => this.native.releaseCursor?.(), errors);
    attempt(() => this.native.removeAllHooks?.(), errors);
    attempt(() => this.keyboard?.releaseAll?.(), errors);
    attempt(() => this.native.releaseInputState?.(), errors);
    attempt(() => this.drag?.restoreOnScreen?.(reason), errors);
    attempt(() => this.cursor?.setLinked?.(false, reason), errors);
    attempt(() => this.onUnlinked(reason), errors);
    this.emit('recovered', { reason, cause, errors });
    return true;
  }

  bindProcess(processLike = process) {
    const bind = (event, handler) => {
      processLike.on(event, handler);
      this.processBindings.push([processLike, event, handler]);
    };
    bind('exit', () => this.trigger('process-exit'));
    bind('beforeExit', () => this.trigger('process-exit'));
    const exitCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
    for (const signal of Object.keys(exitCodes)) {
      const handler = () => {
        this.trigger(`signal:${signal}`);
        processLike.exit?.(exitCodes[signal]);
      };
      try { bind(signal, handler); } catch { /* Signal is not supported on this platform. */ }
    }
    return () => this.#unbind(this.processBindings);
  }

  bindPowerMonitor(powerMonitor) {
    if (!powerMonitor?.on) return () => {};
    const suspend = () => this.trigger('system-suspend');
    powerMonitor.on('suspend', suspend);
    this.powerBindings.push([powerMonitor, 'suspend', suspend]);
    return () => this.#unbind(this.powerBindings);
  }

  stop(options = {}) {
    if (options.recover !== false) this.trigger(options.reason || 'stop');
    this.started = false;
    clearInterval(this.heartbeatTimer);
    clearInterval(this.checkTimer);
    this.heartbeatTimer = null;
    this.checkTimer = null;
    this.native.off?.('panic', this.panicHandler);
    this.#unbind(this.processBindings);
    this.#unbind(this.powerBindings);
    if (options.recover === false) this.native.removeRecoveryGuard?.();
  }

  #unbind(bindings) {
    for (const [target, event, handler] of bindings.splice(0)) target.off?.(event, handler);
  }
}

module.exports = {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  CHECK_INTERVAL_MS,
  RecoveryWatchdog,
};
