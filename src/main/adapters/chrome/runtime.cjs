'use strict';

const { EventEmitter } = require('node:events');
const { createChromeHandoffAdapter, isNativeChromeWindow } = require('./index.cjs');
const { createChromeExtensionAdapter } = require('./extension-adapter.cjs');
const { ChromeNativeMessagingServer } = require('./native-messaging-server.cjs');

const STARTUP_TIMEOUT_MS = 30_000;
const COLD_LAUNCH_TIMEOUT_MS = 5_000;
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
    this.logger = options.logger || null;
    this.requestExtensionSetup = typeof options.requestExtensionSetup === 'function'
      ? options.requestExtensionSetup : async () => false;
    this.promptOnStart = options.promptOnStart === true;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.startupTimeoutMs = options.startupTimeoutMs || STARTUP_TIMEOUT_MS;
    this.coldLaunchTimeoutMs = options.coldLaunchTimeoutMs || COLD_LAUNCH_TIMEOUT_MS;
    this.setup = options.setup || null;
    this.launching = null;
    this.bridge = this.platform === 'win32'
      ? (options.bridge || new ChromeNativeMessagingServer(options)) : null;
    this.createAdapter = options.createAdapter || (this.platform === 'win32'
      ? createChromeExtensionAdapter : createChromeHandoffAdapter);
    this.adapter = this.platform === 'darwin' ? this.createAdapter({
      ...options, platform: 'darwin', native: this.native, machineId: this.machineId,
      getPlacement: this.getPlacement,
    }) : null;
    this.started = false;
    this.starting = null;
    this.setupRequest = null;
    this._bridgeReady = () => this.#acceptBridge();
    this._bridgeDisconnect = () => { if (this.platform === 'win32') this.adapter = null; };
    this._bridgeError = (error) => this.emit('error', error);
    this.bridge?.on?.('ready', this._bridgeReady);
    this.bridge?.on?.('disconnect', this._bridgeDisconnect);
    this.bridge?.on?.('error', this._bridgeError);
    this.facade = Object.freeze({
      adapterId: 'chrome',
      capture: async (...args) => (await this.#ensureAdapter()).capture(...args),
      prepare: async (...args) => (await this.#ensureDestinationAdapter()).prepare(...args),
      position: async (...args) => (await this.#ensureAdapter()).position(...args),
      focus: async (...args) => (await this.#ensureAdapter()).focus(...args),
      close: async (...args) => (await this.#ensureAdapter()).close(...args),
    });
  }

  start() {
    if (this.started) return;
    this.started = true;
    if (this.platform !== 'win32') return;
    this.starting = (async () => {
      await this.setup?.prepare?.();
      await this.bridge.start();
      if (this.bridge.connected) this.#acceptBridge();
      if (this.promptOnStart && !this.bridge.connected) {
        await this.sleep(1_000);
        if (!this.bridge.connected) {
          try { await this.#openSetup(); }
          catch (error) {
            if (error?.code !== 'CHROME_EXTENSION_SETUP_REQUIRED') throw error;
          }
        }
      }
    })();
    this.starting.catch((error) => this.emit('error', error));
  }

  setLinked() { this.start(); }

  adapterForWindow(window) {
    if (!isNativeChromeWindow(window)) return null;
    return this.platform === 'darwin' ? this.adapter : (this.adapter ? this.facade : null);
  }

  adapterForId(adapterId) {
    if (adapterId !== 'chrome') return null;
    return this.platform === 'darwin' ? this.adapter : this.facade;
  }

  async scan() {
    if (this.starting) await this.starting;
    return { detected: Boolean(this.bridge?.connected), endpoint: null };
  }

  #acceptBridge() {
    if (this.platform !== 'win32' || !this.bridge?.connected) return this.adapter;
    if (!this.adapter) {
      this.adapter = this.createAdapter({
        platform: 'win32', bridge: this.bridge, native: this.native,
        machineId: this.machineId, getPlacement: this.getPlacement, logger: this.logger,
      });
      this.emit('ready', this.adapter);
    }
    return this.adapter;
  }

  async #openSetup() {
    if (!this.setupRequest) {
      this.setupRequest = (async () => {
        const offer = await this.setup?.offer?.() || {
          id: 'chrome-extension-setup', title: 'Set up Chrome window handoff',
          message: 'Add the CompuSync helper to Chrome to move Chrome windows between laptops.',
          detail: 'Chrome requires one confirmation for unpublished extensions. CompuSync will open the exact helper folder and Chrome Extensions page.',
          confirmLabel: 'Open setup', cancelLabel: 'Not now',
        };
        if (!await this.requestExtensionSetup(offer)) {
          throw typedError('CHROME_EXTENSION_SETUP_REQUIRED', 'Install the CompuSync Chrome helper before handing off Chrome windows.');
        }
        await this.setup?.open?.();
      })();
    }
    try { await this.setupRequest; }
    finally { this.setupRequest = null; }
  }

  async #waitForBridge(timeoutMs) {
    const intervalMs = Math.min(POLL_MS, Math.max(1, timeoutMs));
    const polls = Math.max(0, Math.ceil(timeoutMs / intervalMs));
    for (let poll = 0; poll <= polls; poll += 1) {
      if (this.bridge.connected) return this.#acceptBridge();
      if (poll < polls) await this.sleep(intervalMs);
    }
    return null;
  }

  async #launchDestinationChrome() {
    if (this.bridge.connected) return this.#acceptBridge();
    if (typeof this.setup?.launch !== 'function') return null;
    if (!this.launching) {
      this.launching = (async () => {
        await this.setup.launch();
        return this.#waitForBridge(this.coldLaunchTimeoutMs);
      })();
    }
    try { return await this.launching; }
    finally { this.launching = null; }
  }

  async #ensureStarted() {
    if (!this.started) this.start();
    if (this.starting) await this.starting;
    return this.bridge.connected ? this.#acceptBridge() : null;
  }

  async #ensureAdapter() {
    if (this.adapter) return this.adapter;
    if (this.platform !== 'win32') throw typedError('CHROME_UNAVAILABLE', 'Google Chrome is not available for handoff.');
    const started = await this.#ensureStarted();
    if (started) return started;
    await this.#openSetup();
    const connected = await this.#waitForBridge(this.startupTimeoutMs);
    if (connected) return connected;
    this.onNotice({
      id: 'chrome-extension-not-connected', kind: 'warning', title: 'Chrome helper needs attention',
      message: 'In Chrome Extensions, enable Developer mode and use Load unpacked to select the CompuSync helper folder.',
      dismissible: true,
    });
    throw typedError('CHROME_EXTENSION_NOT_CONNECTED', 'The CompuSync Chrome helper did not connect. Finish Load unpacked, then try again.');
  }

  async #ensureDestinationAdapter() {
    if (this.adapter) return this.adapter;
    if (this.platform !== 'win32') return this.#ensureAdapter();
    const started = await this.#ensureStarted();
    if (started) return started;
    const launched = await this.#launchDestinationChrome();
    return launched || this.#ensureAdapter();
  }

  stop() {
    this.started = false;
    if (this.platform === 'win32') this.adapter = null;
    this.bridge?.off?.('ready', this._bridgeReady);
    this.bridge?.off?.('disconnect', this._bridgeDisconnect);
    this.bridge?.off?.('error', this._bridgeError);
    void this.bridge?.stop?.();
  }
}

module.exports = { ChromeAdapterRuntime, STARTUP_TIMEOUT_MS, COLD_LAUNCH_TIMEOUT_MS, POLL_MS, typedError };
