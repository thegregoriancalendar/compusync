'use strict';

const { EventEmitter } = require('node:events');

const DEBUG_PORT_MIN = 9222;
const DEBUG_PORT_MAX = 9250;
const DETECTION_INTERVAL_MS = 2_000;
const LOCAL_HOST = '127.0.0.1';

function isChromeWindow(window) {
  if (!window || typeof window !== 'object') return false;
  const processName = String(window.processName ?? window.process_name ?? window.ownerName ?? '').trim().toLowerCase();
  const bundleId = String(window.bundleId ?? window.bundle_id ?? window.ownerBundleId ?? '').trim().toLowerCase();
  return processName === 'chrome.exe'
    || processName === 'chrome'
    || processName === 'google chrome'
    || processName === 'google chrome helper'
    || bundleId === 'com.google.chrome';
}

function enumerateNativeChrome(native) {
  let windows;
  try { windows = native?.enumerateWindows?.(); }
  catch { return []; }
  if (!Array.isArray(windows)) return [];
  return windows.filter((window) => isChromeWindow(window) && window.visible !== false);
}

function validPort(port) {
  return Number.isInteger(port) && port >= DEBUG_PORT_MIN && port <= DEBUG_PORT_MAX;
}

function validBrowserWebSocket(value, port) {
  if (typeof value !== 'string' || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'ws:'
      && url.hostname === LOCAL_HOST
      && Number(url.port) === port
      && url.pathname.startsWith('/devtools/browser/');
  } catch { return false; }
}

function debugPorts() {
  return Array.from({ length: DEBUG_PORT_MAX - DEBUG_PORT_MIN + 1 }, (_, index) => DEBUG_PORT_MIN + index);
}

async function probePort(port, options = {}) {
  if (!validPort(port)) throw new RangeError(`Chrome debug port must be ${DEBUG_PORT_MIN}-${DEBUG_PORT_MAX}.`);
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required.');
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || DETECTION_INTERVAL_MS, 1), DETECTION_INTERVAL_MS);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener?.('abort', forwardAbort, { once: true });
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error('Chrome detection timed out.'));
      resolve(null);
    }, timeoutMs);
  });
  try {
    const request = (async () => {
      const response = await fetchImpl(`http://${LOCAL_HOST}:${port}/json/version`, {
        method: 'GET', signal: controller.signal, redirect: 'error', headers: { accept: 'application/json' },
      });
      if (!response?.ok) return null;
      const type = String(response.headers?.get?.('content-type') || '');
      if (type && !type.toLowerCase().includes('application/json')) return null;
      const version = await response.json();
      if (!version || typeof version !== 'object' || !validBrowserWebSocket(version.webSocketDebuggerUrl, port)) return null;
      return {
        port,
        browser: typeof version.Browser === 'string' ? version.Browser.slice(0, 256) : '',
        protocolVersion: typeof version['Protocol-Version'] === 'string' ? version['Protocol-Version'].slice(0, 64) : '',
        webSocketDebuggerUrl: version.webSocketDebuggerUrl,
      };
    })();
    return await Promise.race([request, timedOut]);
  } catch { return null; }
  finally {
    clearTimeout(timer);
    options.signal?.removeEventListener?.('abort', forwardAbort);
  }
}

async function probeDebugPorts(options = {}) {
  const ports = options.ports === undefined ? debugPorts() : options.ports;
  if (!Array.isArray(ports) || ports.some((port) => !validPort(port))) {
    throw new RangeError(`Chrome debug ports must be within ${DEBUG_PORT_MIN}-${DEBUG_PORT_MAX}.`);
  }
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || DETECTION_INTERVAL_MS, 1), DETECTION_INTERVAL_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Chrome detection timed out.')), timeoutMs);
  try {
    const results = await Promise.all(ports.map((port) => probePort(port, {
      fetch: options.fetch,
      timeoutMs,
      signal: controller.signal,
    })));
    return results.filter(Boolean).sort((a, b) => a.port - b.port);
  } finally { clearTimeout(timer); }
}

async function detectChrome(options = {}) {
  const nativeWindows = enumerateNativeChrome(options.native);
  const endpoints = await probeDebugPorts(options);
  return {
    detected: nativeWindows.length > 0,
    controllable: endpoints.length > 0,
    nativeWindows,
    endpoints,
    endpoint: endpoints[0] || null,
  };
}

class ChromeDetector extends EventEmitter {
  constructor(options = {}) {
    super();
    this.native = options.native;
    this.fetch = options.fetch;
    this.intervalMs = DETECTION_INTERVAL_MS;
    this.timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || DETECTION_INTERVAL_MS, 1), DETECTION_INTERVAL_MS);
    this.linked = false;
    this.running = false;
    this.timer = null;
    this.lastResult = null;
  }

  async scan() {
    if (this.running) return this.lastResult;
    this.running = true;
    try {
      const result = await detectChrome({ native: this.native, fetch: this.fetch, timeoutMs: this.timeoutMs });
      this.lastResult = result;
      this.emit('detected', result);
      return result;
    } finally { this.running = false; }
  }

  setLinked(linked) {
    const next = Boolean(linked);
    if (next === this.linked) return;
    this.linked = next;
    if (!next) {
      clearInterval(this.timer);
      this.timer = null;
      return;
    }
    void this.scan().catch((error) => this.emit('scanError', error));
    this.timer = setInterval(() => { void this.scan().catch((error) => this.emit('scanError', error)); }, this.intervalMs);
    this.timer.unref?.();
  }

  start() { this.setLinked(true); }
  stop() { this.setLinked(false); }
}

module.exports = {
  DEBUG_PORT_MIN,
  DEBUG_PORT_MAX,
  DETECTION_INTERVAL_MS,
  LOCAL_HOST,
  ChromeDetector,
  createChromeDetector: (options) => new ChromeDetector(options),
  detectChrome,
  enumerateNativeChrome,
  isChromeWindow,
  probeDebugPorts,
  probePort,
  validBrowserWebSocket,
};
