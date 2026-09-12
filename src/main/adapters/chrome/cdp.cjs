'use strict';

const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const {
  DEBUG_PORT_MIN,
  DEBUG_PORT_MAX,
  LOCAL_HOST,
  validBrowserWebSocket,
} = require('./detect.cjs');

const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_TARGETS = 500;

function cdpError(message, code = 'CDP_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function validatePort(port) {
  if (!Number.isInteger(port) || port < DEBUG_PORT_MIN || port > DEBUG_PORT_MAX) {
    throw new RangeError(`Chrome debug port must be ${DEBUG_PORT_MIN}-${DEBUG_PORT_MAX}.`);
  }
  return port;
}

function validateLocalPageSocket(value, port) {
  if (typeof value !== 'string' || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'ws:'
      && url.hostname === LOCAL_HOST
      && Number(url.port) === port
      && url.pathname.startsWith('/devtools/page/');
  } catch { return false; }
}

function timeoutValue(value) {
  const timeout = Number(value) || DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 10_000) throw new RangeError('CDP timeout must be 1-10000ms.');
  return timeout;
}

function normalizeBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') throw new TypeError('Window bounds are required.');
  const source = {
    left: bounds.left ?? bounds.x,
    top: bounds.top ?? bounds.y,
    width: bounds.width ?? bounds.w,
    height: bounds.height ?? bounds.h,
  };
  for (const [name, value] of Object.entries(source)) {
    if (!Number.isFinite(value)) throw new TypeError(`Window bound ${name} must be finite.`);
    source[name] = Math.round(value);
  }
  if (source.width < 1 || source.height < 1 || source.width > 32_768 || source.height > 32_768) {
    throw new RangeError('Window dimensions are outside the safe range.');
  }
  if (Math.abs(source.left) > 100_000 || Math.abs(source.top) > 100_000) {
    throw new RangeError('Window position is outside the safe range.');
  }
  return source;
}

function socketState(socket, name, fallback) {
  return socket?.[name] ?? socket?.constructor?.[name] ?? fallback;
}

class CdpSocket extends EventEmitter {
  constructor(url, options = {}) {
    super();
    this.url = url;
    this.WebSocket = options.WebSocket || WebSocket;
    this.timeoutMs = timeoutValue(options.timeoutMs);
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.connecting = null;
    this.didClose = false;
  }

  connect() {
    if (this.connecting) return this.connecting;
    if (this.socket && this.socket.readyState === socketState(this.socket, 'OPEN', 1)) return Promise.resolve(this);
    this.didClose = false;
    this.connecting = new Promise((resolve, reject) => {
      let settled = false;
      const socket = new this.WebSocket(this.url, { handshakeTimeout: this.timeoutMs, maxPayload: MAX_MESSAGE_BYTES });
      this.socket = socket;
      const timer = setTimeout(() => finish(cdpError('CDP WebSocket connection timed out.', 'CDP_TIMEOUT')), this.timeoutMs);
      timer.unref?.();
      const cleanupOpening = () => {
        clearTimeout(timer);
        socket.off?.('open', onOpen);
        socket.off?.('error', onOpeningError);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanupOpening();
        this.connecting = null;
        if (error) {
          try { socket.terminate?.(); } catch {}
          reject(error);
        } else resolve(this);
      };
      const onOpen = () => finish();
      const onOpeningError = () => finish(cdpError('CDP WebSocket connection failed.', 'CDP_CONNECT_FAILED'));
      socket.on('open', onOpen);
      socket.on('error', onOpeningError);
      socket.on('message', (data) => this._message(data));
      socket.on('close', () => this._closed());
      socket.on('error', (error) => {
        if (settled) this.emit('socketError', cdpError(error?.message ? 'CDP WebSocket error.' : 'CDP WebSocket error.'));
      });
    });
    return this.connecting;
  }

  _message(data) {
    let message;
    try {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) throw new Error('oversized');
      message = JSON.parse(text);
    } catch {
      this.emit('protocolError', cdpError('CDP returned an invalid message.', 'CDP_PROTOCOL_ERROR'));
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (Number.isInteger(message.id)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = cdpError(`CDP command failed (${Number(message.error.code) || 'unknown'}).`, 'CDP_COMMAND_FAILED');
        error.cdpCode = Number(message.error.code) || 0;
        pending.reject(error);
      } else pending.resolve(message.result || {});
      return;
    }
    if (typeof message.method === 'string') this.emit('event', message.method, message.params || {});
  }

  command(method, params = {}, options = {}) {
    if (typeof method !== 'string' || !/^[A-Za-z]+\.[A-Za-z]+$/.test(method)) {
      return Promise.reject(new TypeError('Invalid CDP method.'));
    }
    if (!params || typeof params !== 'object' || Array.isArray(params)) return Promise.reject(new TypeError('CDP params must be an object.'));
    const socket = this.socket;
    if (!socket || socket.readyState !== socketState(socket, 'OPEN', 1)) {
      return Promise.reject(cdpError('CDP WebSocket is not connected.', 'CDP_NOT_CONNECTED'));
    }
    const id = this.nextId++;
    if (this.nextId > 0x7fffffff) this.nextId = 1;
    const timeoutMs = timeoutValue(options.timeoutMs || this.timeoutMs);
    let payload;
    try { payload = JSON.stringify({ id, method, params }); }
    catch { return Promise.reject(new TypeError('CDP params must be JSON serializable.')); }
    if (Buffer.byteLength(payload) > MAX_MESSAGE_BYTES) return Promise.reject(cdpError('CDP command is too large.', 'CDP_MESSAGE_TOO_LARGE'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(cdpError(`CDP command ${method} timed out.`, 'CDP_TIMEOUT'));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(payload, (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(timer);
          reject(cdpError('CDP command could not be sent.', 'CDP_SEND_FAILED'));
        });
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(cdpError('CDP command could not be sent.', 'CDP_SEND_FAILED'));
      }
    });
  }

  _closed() {
    if (this.didClose) return;
    this.didClose = true;
    this.socket = null;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(cdpError('CDP WebSocket closed.', 'CDP_CLOSED'));
    }
    this.pending.clear();
    this.emit('closed');
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try { socket.close(1000, 'done'); } catch { socket.terminate?.(); }
    }
    this._closed();
  }
}

function isPageTarget(target) {
  if (!target || target.type !== 'page' || !validId(target.id)) return false;
  if (typeof target.url !== 'string' || target.url.length > 8_192) return false;
  try {
    const protocol = new URL(target.url).protocol;
    return protocol !== 'devtools:' && protocol !== 'chrome-extension:';
  } catch { return target.url === 'about:blank'; }
}

function boundsDistance(a, b) {
  return Math.abs(a.left - b.left) + Math.abs(a.top - b.top)
    + Math.abs(a.width - b.width) + Math.abs(a.height - b.height);
}

function nativeBounds(window) {
  const bounds = window?.bounds;
  if (!bounds) return null;
  const result = {
    left: Number(bounds.left ?? bounds.x), top: Number(bounds.top ?? bounds.y),
    width: Number(bounds.width ?? bounds.w), height: Number(bounds.height ?? bounds.h),
  };
  return Object.values(result).every(Number.isFinite) ? result : null;
}

class ChromeCdp extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = validatePort(Number(options.port));
    if (!validBrowserWebSocket(options.webSocketDebuggerUrl, this.port)) {
      throw new TypeError('A localhost Chrome browser WebSocket URL is required.');
    }
    this.browserUrl = options.webSocketDebuggerUrl;
    this.fetch = options.fetch || globalThis.fetch;
    this.WebSocket = options.WebSocket || WebSocket;
    this.timeoutMs = timeoutValue(options.timeoutMs);
    this.browser = null;
    this.windowForTarget = new Map();
    this.targets = new Map();
  }

  async connect() {
    if (this.browser) return this;
    const browser = new CdpSocket(this.browserUrl, { WebSocket: this.WebSocket, timeoutMs: this.timeoutMs });
    this.browser = browser;
    browser.on('event', (method, params) => this._browserEvent(method, params));
    browser.on('closed', () => {
      if (this.browser === browser) this.browser = null;
      this.invalidateTargets();
      this.emit('disconnect');
    });
    browser.on('socketError', (error) => this.emit('connectionError', error));
    try {
      await browser.connect();
      await browser.command('Target.setDiscoverTargets', { discover: true });
      return this;
    } catch (error) {
      if (this.browser === browser) this.browser = null;
      browser.close();
      throw error;
    }
  }

  _browserEvent(method, params) {
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      const info = params?.targetInfo;
      if (info && validId(info.targetId)) {
        this.targets.delete(info.targetId);
        this.windowForTarget.delete(info.targetId);
      }
      this.emit('targetsChanged', { method, targetId: info?.targetId });
    } else if (method === 'Target.targetDestroyed') {
      if (validId(params?.targetId)) {
        this.targets.delete(params.targetId);
        this.windowForTarget.delete(params.targetId);
      }
      this.emit('targetsChanged', { method, targetId: params?.targetId });
    }
    this.emit('event', method, params);
  }

  invalidateTargets() {
    this.targets.clear();
    this.windowForTarget.clear();
  }

  _command(method, params, options) {
    if (!this.browser) return Promise.reject(cdpError('Browser CDP is not connected.', 'CDP_NOT_CONNECTED'));
    return this.browser.command(method, params, options);
  }

  async _fetchJson(path) {
    if (typeof this.fetch !== 'function') throw new TypeError('fetch is required.');
    const controller = new AbortController();
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(cdpError('Chrome target discovery timed out.', 'CDP_TIMEOUT'));
      }, this.timeoutMs);
    });
    try {
      const request = (async () => {
        const response = await this.fetch(`http://${LOCAL_HOST}:${this.port}${path}`, {
          method: 'GET', signal: controller.signal, redirect: 'error', headers: { accept: 'application/json' },
        });
        if (!response?.ok) throw cdpError('Chrome target discovery failed.', 'CDP_HTTP_ERROR');
        return await response.json();
      })();
      return await Promise.race([request, timedOut]);
    } catch (error) {
      if (error?.code) throw error;
      throw cdpError('Chrome target discovery failed.', 'CDP_HTTP_ERROR');
    } finally { clearTimeout(timer); }
  }

  async listTargets(options = {}) {
    const raw = await this._fetchJson('/json/list');
    if (!Array.isArray(raw) || raw.length > MAX_TARGETS) throw cdpError('Chrome returned an invalid target list.', 'CDP_PROTOCOL_ERROR');
    const pages = raw.filter(isPageTarget).map((target) => ({
      id: target.id,
      type: 'page',
      title: typeof target.title === 'string' ? target.title.slice(0, 4_096) : '',
      url: target.url,
      webSocketDebuggerUrl: validateLocalPageSocket(target.webSocketDebuggerUrl, this.port) ? target.webSocketDebuggerUrl : null,
    }));
    const present = new Set(pages.map(({ id }) => id));
    for (const targetId of this.windowForTarget.keys()) {
      if (!present.has(targetId)) this.windowForTarget.delete(targetId);
    }
    this.targets.clear();
    for (const target of pages) this.targets.set(target.id, target);
    if (options.includeWithoutPageSocket !== true) return pages.filter((target) => target.webSocketDebuggerUrl);
    return pages;
  }

  async getWindowForTarget(targetId) {
    if (!validId(targetId)) throw new TypeError('Invalid target id.');
    if (this.windowForTarget.has(targetId)) return this.windowForTarget.get(targetId);
    const result = await this._command('Browser.getWindowForTarget', { targetId });
    if (!Number.isInteger(result.windowId) || result.windowId < 0) throw cdpError('Chrome returned an invalid window id.', 'CDP_PROTOCOL_ERROR');
    this.windowForTarget.set(targetId, result.windowId);
    return result.windowId;
  }

  async groupTabsByWindow(targets) {
    const pages = targets || await this.listTargets({ includeWithoutPageSocket: true });
    if (!Array.isArray(pages) || pages.length > MAX_TARGETS) throw new TypeError('Invalid target list.');
    const pairs = await Promise.all(pages.filter(isPageTarget).map(async (target) => ({
      target, windowId: await this.getWindowForTarget(target.id),
    })));
    const groups = new Map();
    for (const pair of pairs) {
      if (!groups.has(pair.windowId)) groups.set(pair.windowId, { windowId: pair.windowId, tabs: [] });
      groups.get(pair.windowId).tabs.push(pair.target);
    }
    return [...groups.values()];
  }

  async getWindowBounds(windowId) {
    if (!Number.isInteger(windowId) || windowId < 0) throw new TypeError('Invalid window id.');
    const result = await this._command('Browser.getWindowBounds', { windowId });
    const bounds = result?.bounds;
    if (!bounds || !['normal', 'minimized', 'maximized', 'fullscreen'].includes(bounds.windowState)) {
      throw cdpError('Chrome returned invalid window bounds.', 'CDP_PROTOCOL_ERROR');
    }
    const rectangle = normalizeBounds(bounds);
    return { ...rectangle, windowState: bounds.windowState };
  }

  async joinNativeWindows(nativeWindows, groups, options = {}) {
    if (!Array.isArray(nativeWindows) || !Array.isArray(groups)) throw new TypeError('Native windows and groups must be arrays.');
    const tolerance = Number.isFinite(options.tolerance) ? Math.max(0, options.tolerance) : 48;
    const unused = new Set(nativeWindows);
    const joined = [];
    for (const group of groups) {
      const bounds = await this.getWindowBounds(group.windowId);
      let match = null;
      let distance = Infinity;
      for (const candidate of unused) {
        const candidateBounds = nativeBounds(candidate);
        if (!candidateBounds) continue;
        const score = boundsDistance(bounds, candidateBounds);
        if (score < distance) { match = candidate; distance = score; }
      }
      if (match && distance <= tolerance * 4) unused.delete(match);
      else match = null;
      joined.push({ ...group, bounds, nativeWindow: match, geometryDistance: match ? distance : null });
    }
    return joined;
  }

  async windows(nativeWindows, options) {
    const groups = await this.groupTabsByWindow();
    return this.joinNativeWindows(nativeWindows, groups, options);
  }

  async withPage(targetId, callback, options = {}) {
    if (!validId(targetId) || typeof callback !== 'function') throw new TypeError('Target id and callback are required.');
    let target = this.targets.get(targetId);
    if (!target?.webSocketDebuggerUrl) {
      await this.listTargets();
      target = this.targets.get(targetId);
    }
    if (!target?.webSocketDebuggerUrl) throw cdpError('Target has no page debugging socket.', 'CDP_NO_PAGE_SOCKET');
    const page = new CdpSocket(target.webSocketDebuggerUrl, { WebSocket: this.WebSocket, timeoutMs: options.timeoutMs || this.timeoutMs });
    await page.connect();
    try { return await callback((method, params, commandOptions) => page.command(method, params, commandOptions), page); }
    finally { page.close(); }
  }

  async createTarget(url, options = {}) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new TypeError('Target URL must be a valid HTTP(S) URL.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || url.length > 8_192) throw new TypeError('Target URL must be a valid HTTP(S) URL.');
    const params = { url };
    if (options.newWindow !== undefined) params.newWindow = Boolean(options.newWindow);
    if (options.background !== undefined) params.background = Boolean(options.background);
    const result = await this._command('Target.createTarget', params);
    if (!validId(result.targetId)) throw cdpError('Chrome returned an invalid target id.', 'CDP_PROTOCOL_ERROR');
    return result.targetId;
  }

  async createWindow(url, bounds, options = {}) {
    const targetId = await this.createTarget(url, { newWindow: true, background: options.background });
    const windowId = await this.getWindowForTarget(targetId);
    if (bounds) await this.setWindowBounds(windowId, bounds);
    return { targetId, windowId };
  }

  async closeTarget(targetId) {
    if (!validId(targetId)) throw new TypeError('Invalid target id.');
    const result = await this._command('Target.closeTarget', { targetId });
    this.targets.delete(targetId);
    this.windowForTarget.delete(targetId);
    return result.success !== false;
  }

  async focusTarget(targetId, nativeWindow, native) {
    if (!validId(targetId)) throw new TypeError('Invalid target id.');
    await this._command('Target.activateTarget', { targetId });
    if (nativeWindow?.id != null) await native?.focusWindow?.(nativeWindow.id);
  }

  async setWindowBounds(windowId, bounds) {
    if (!Number.isInteger(windowId) || windowId < 0) throw new TypeError('Invalid window id.');
    const clean = normalizeBounds(bounds);
    await this._command('Browser.setWindowBounds', { windowId, bounds: clean });
    return clean;
  }

  close() {
    const browser = this.browser;
    this.browser = null;
    browser?.close();
    this.invalidateTargets();
  }
}

module.exports = {
  ChromeCdp,
  ChromeCdpClient: ChromeCdp,
  createChromeCdp: (options) => new ChromeCdp(options),
  CdpSocket,
  DEFAULT_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
  boundsDistance,
  isPageTarget,
  normalizeBounds,
  validateLocalPageSocket,
};
