'use strict';

const path = require('node:path');

const EXTENSION_ID = 'fpafmookkejpkjlegeppoecbhbgbogcp';
const MAX_TABS = 500;

function bridgeError(message, code = 'CHROME_TAB_CONTROL_FAILED') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validTargetId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

function evaluateValue(result) {
  if (result?.exceptionDetails || result?.result?.subtype === 'error') {
    throw bridgeError('Chrome tab control rejected the operation.');
  }
  return result?.result?.value;
}

const CAPTURE_EXPRESSION = 'globalThis.compusyncCapture';
const APPLY_EXPRESSION = 'globalThis.compusyncApply';

function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

class ChromeExtensionTabControl {
  constructor(options = {}) {
    if (!options.cdp || typeof options.cdp.withExtensionServiceWorker !== 'function') {
      throw new TypeError('Chrome CDP extension access is required.');
    }
    this.cdp = options.cdp;
    this.extensionId = options.extensionId || EXTENSION_ID;
    if (typeof options.extensionDirectory !== 'string' || !path.isAbsolute(options.extensionDirectory)) {
      throw new TypeError('An absolute bundled extension directory is required.');
    }
    this.extensionDirectory = path.resolve(options.extensionDirectory);
    this.timeoutMs = options.timeoutMs;
    this.installing = null;
  }

  async ensureInstalled() {
    if (this.installing) return this.installing;
    this.installing = (async () => {
      await this.cdp.connect?.();
      const current = await this.cdp.browserCommand('Extensions.getExtensions', {});
      if (!Array.isArray(current?.extensions)) throw bridgeError('Chrome extension inventory is invalid.');
      const existing = current.extensions.find((item) => item?.id === this.extensionId);
      if (existing) {
        if (existing.enabled !== true || !samePath(existing.path, this.extensionDirectory)) {
          throw bridgeError('Chrome tab-control extension conflicts with another local extension.', 'CHROME_TAB_CONTROL_CONFLICT');
        }
        return this.extensionId;
      }
      const loaded = await this.cdp.browserCommand('Extensions.loadUnpacked', {
        path: this.extensionDirectory, enableInIncognito: false,
      });
      if (loaded?.id !== this.extensionId) {
        throw bridgeError('Chrome loaded an unexpected tab-control extension.', 'CHROME_TAB_CONTROL_ID_MISMATCH');
      }
      return loaded.id;
    })();
    try { return await this.installing; }
    finally { this.installing = null; }
  }

  async evaluate(request, expression) {
    if (![CAPTURE_EXPRESSION, APPLY_EXPRESSION].includes(expression)) throw new TypeError('Invalid tab-control operation.');
    await this.ensureInstalled();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.cdp.withExtensionServiceWorker(this.extensionId, async (command) => {
          // Only validated numeric/opaque identifiers are serialized. Peer URLs
          // and titles never enter executable text.
          const result = await command('Runtime.evaluate', {
            expression: `${expression}(${JSON.stringify(request)})`, awaitPromise: true, returnByValue: true,
          });
          return evaluateValue(result);
        }, { timeoutMs: this.timeoutMs });
      } catch (error) {
        // A sleeping MV3 worker can disappear between discovery and attach.
        // Both operations are idempotent, so one bounded retry is safe.
        if (attempt || !String(error?.code || '').startsWith('CDP_')) throw error;
      }
    }
    throw bridgeError('Chrome tab control is unavailable.');
  }

  async captureWindow(input = {}) {
    if (!Number.isInteger(input.windowId) || input.windowId < 0 || !Array.isArray(input.tabs)
      || input.tabs.length < 1 || input.tabs.length > MAX_TABS) {
      throw new TypeError('A bounded Chrome window tab set is required.');
    }
    const expected = new Set(input.tabs.map((tab) => tab?.id));
    if (expected.size !== input.tabs.length || [...expected].some((id) => !validTargetId(id))) {
      throw new TypeError('Chrome target ids are invalid.');
    }
    const value = await this.evaluate({ windowId: input.windowId }, CAPTURE_EXPRESSION);
    if (!Array.isArray(value) || value.length !== input.tabs.length) {
      throw bridgeError('Chrome returned an incomplete tab state.', 'CHROME_TAB_STATE_INVALID');
    }
    const seenTargets = new Set();
    const seenIndices = new Set();
    for (const tab of value) {
      if (!tab || !expected.has(tab.targetId) || seenTargets.has(tab.targetId)
        || !Number.isSafeInteger(tab.index) || tab.index < 0 || tab.index >= value.length
        || seenIndices.has(tab.index) || typeof tab.pinned !== 'boolean' || typeof tab.active !== 'boolean') {
        throw bridgeError('Chrome returned an invalid tab state.', 'CHROME_TAB_STATE_INVALID');
      }
      seenTargets.add(tab.targetId);
      seenIndices.add(tab.index);
    }
    if (value.filter((tab) => tab.active).length !== 1) {
      throw bridgeError('Chrome returned an invalid active tab.', 'CHROME_TAB_STATE_INVALID');
    }
    return value;
  }

  async setPinned(input = {}) {
    if (!validTargetId(input.targetId) || !Number.isInteger(input.windowId) || input.windowId < 0
      || !Number.isSafeInteger(input.index) || input.index < 0 || input.index >= MAX_TABS
      || typeof input.pinned !== 'boolean') {
      throw new TypeError('Chrome tab placement is invalid.');
    }
    const value = await this.evaluate({
      targetId: input.targetId, windowId: input.windowId, index: input.index, pinned: input.pinned,
    }, APPLY_EXPRESSION);
    if (value !== true) throw bridgeError('Chrome did not apply tab placement.');
    return true;
  }
}

module.exports = {
  APPLY_EXPRESSION,
  CAPTURE_EXPRESSION,
  EXTENSION_ID,
  ChromeExtensionTabControl,
  createChromeExtensionTabControl: (options) => new ChromeExtensionTabControl(options),
};
