'use strict';

const { EventEmitter } = require('node:events');
const { ChromeDetector } = require('./detect.cjs');
const { createChromeHandoffAdapter, isNativeChromeWindow } = require('./index.cjs');
const { WindowsChromeRelaunch } = require('./windows.cjs');

const STARTUP_TIMEOUT_MS = 10_000;
const POLL_MS = 250;

function typedError(code, message) {
  return Object.assign(new Error(message), { code });
}

class ChromeAdapterRuntime extends EventEmitter {
  constructor(options = {}) {
    super();
    this.platform = options.platform || process.platform;
    this.native = options.native || {};
    this.machineId = options.machineId;
    this.getPlacement = options.getPlacement;
    this.onNotice = typeof options.onNotice === 'function' ? options.onNotice : () => {};
    this.requestRelaunch = typeof options.requestRelaunch === 'function' ? options.requestRelaunch : async () => false;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now || Date.now;
    this.startupTimeoutMs = options.startupTimeoutMs || STARTUP_TIMEOUT_MS;
    this.createAdapter = options.createAdapter || createChromeHandoffAdapter;
    this.detector = options.detector || new ChromeDetector({ native: this.native, fetch: options.fetch, timeoutMs: options.detectionTimeoutMs });
    this.relaunch = options.relaunch || new WindowsChromeRelaunch({
      store: options.store, localAppData: options.localAppData, normalUserDataDir: options.normalUserDataDir,
    });
    this.adapter = this.platform === 'darwin' ? this.createAdapter({
      ...options, platform: 'darwin', native: this.native, machineId: this.machineId, getPlacement: this.getPlacement,
    }) : null;
    this.connecting = null;
    this.linked = false;
    this._detected = (result) => { void this.#acceptDetection(result).catch((error) => this.emit('error', error)); };
    this.detector.on?.('detected', this._detected);
    this.facade = Object.freeze({
      adapterId: 'chrome',
      capture: async (...args) => (await this.#ensureAdapter(true)).capture(...args),
      prepare: async (...args) => (await this.#ensureAdapter(true)).prepare(...args),
      position: async (...args) => (await this.#ensureAdapter(false)).position(...args),
      focus: async (...args) => (await this.#ensureAdapter(false)).focus(...args),
      close: async (...args) => (await this.#ensureAdapter(false)).close(...args),
    });
  }

  start() { this.setLinked(true); }

  setLinked(linked) {
    this.linked = Boolean(linked);
    this.detector.setLinked?.(this.linked);
  }

  adapterForWindow(window) {
    if (!isNativeChromeWindow(window)) return null;
    if (this.platform === 'darwin') return this.adapter;
    if (this.relaunch.decision?.() === 'declined' && !this.adapter) return null;
    return this.facade;
  }

  adapterForId(adapterId) { return adapterId === 'chrome' ? (this.platform === 'darwin' ? this.adapter : this.facade) : null; }

  async scan() {
    const detection = await this.detector.scan();
    await this.#acceptDetection(detection);
    return detection;
  }

  async #acceptDetection(detection) {
    if (this.platform === 'darwin' || !detection?.endpoint) return this.adapter;
    if (this.adapter?.cdp?.port === detection.endpoint.port) return this.adapter;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const adapter = this.createAdapter({
        platform: this.platform, native: this.native, machineId: this.machineId,
        getPlacement: this.getPlacement, detection,
      });
      await adapter.cdp.connect();
      adapter.cdp.once?.('disconnect', () => { if (this.adapter === adapter) this.adapter = null; });
      this.adapter = adapter;
      this.emit('ready', adapter);
      return adapter;
    })();
    try { return await this.connecting; }
    finally { this.connecting = null; }
  }

  async #ensureAdapter(allowRelaunch) {
    if (this.adapter) return this.adapter;
    let detection = await this.scan();
    if (this.adapter) return this.adapter;
    if (this.platform !== 'win32') throw typedError('CHROME_UNAVAILABLE', 'Google Chrome is not available for handoff.');
    if (!allowRelaunch || !detection?.detected) throw typedError('CHROME_NOT_RUNNING', 'Open Google Chrome on this laptop before handing off a window.');
    if (this.relaunch.decision() === 'declined') throw typedError('CHROME_RELAUNCH_DECLINED', 'Chrome window handoff was disabled on this laptop.');
    let accepted = this.relaunch.decision() === 'accepted';
    if (!accepted) {
      const offer = this.relaunch.offer({ crossingAttempt: true, chromeRunning: true, cdpAvailable: false });
      accepted = Boolean(await this.requestRelaunch(offer));
      await this.relaunch.rememberDecision(accepted);
    }
    if (!accepted) throw typedError('CHROME_RELAUNCH_DECLINED', 'Chrome window handoff was declined.');
    await this.relaunch.launchAccepted({ crossingAttempt: true, accepted: true });
    const notice = this.relaunch.isolatedProfileNotice?.();
    if (notice) {
      this.onNotice({ ...notice, kind: 'info', dismissible: true });
      await this.relaunch.markIsolatedProfileNoticeShown?.();
    }
    const deadline = this.now() + this.startupTimeoutMs;
    do {
      detection = await this.detector.scan();
      await this.#acceptDetection(detection);
      if (this.adapter) return this.adapter;
      await this.sleep(POLL_MS);
    } while (this.now() < deadline);
    throw typedError('CHROME_DEBUG_START_TIMEOUT', 'Chrome restarted but its local handoff connection did not become ready.');
  }

  stop() {
    this.setLinked(false);
    this.detector.off?.('detected', this._detected);
    this.adapter?.cdp?.close?.();
    this.adapter = null;
  }
}

module.exports = { ChromeAdapterRuntime, STARTUP_TIMEOUT_MS, POLL_MS, typedError };
