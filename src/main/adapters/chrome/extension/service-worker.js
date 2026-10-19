'use strict';

importScripts('page-state.js');
const { pageState, sanitizePageState } = globalThis.CompuSyncPageState;

const NATIVE_HOST = 'app.compusync.chrome';
const PROTOCOL_VERSION = 1;
const DEBUGGER_VERSION = '1.3';
const MAX_TABS = 200;
const MAX_URL_LENGTH = 8192;
const MAX_HISTORY_ENTRIES = 200;
const MAX_COORDINATE = 65536;
const HISTORY_CONCURRENCY = 4;
const PING_INTERVAL_MS = 20_000;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 10_000;
const MAX_CHUNKS = 10;
const MAX_CHUNK_TEXT = 750_000;

class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

const plainObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value);

function validId(value) {
  return (typeof value === 'string' && value.length > 0 && value.length <= 100)
    || (Number.isSafeInteger(value) && value >= 0);
}

function windowIdFrom(params) {
  const value = params?.windowId;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BridgeError('INVALID_REQUEST', 'A valid Chrome window id is required.');
  }
  return value;
}

function validUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizedBounds(value) {
  if (!plainObject(value)) throw new BridgeError('INVALID_BOUNDS', 'Valid window bounds are required.');
  const bounds = {
    left: Number(value.left ?? value.x),
    top: Number(value.top ?? value.y),
    width: Number(value.width ?? value.w),
    height: Number(value.height ?? value.h),
  };
  if (!Object.values(bounds).every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0
    || Object.values(bounds).some((part) => Math.abs(part) > MAX_COORDINATE)) {
    throw new BridgeError('INVALID_BOUNDS', 'Valid finite window bounds are required.');
  }
  return Object.fromEntries(Object.entries(bounds).map(([key, part]) => [key, Math.round(part)]));
}

function normalizedHistory(value) {
  if (value === undefined) return undefined;
  if (!plainObject(value) || !Array.isArray(value.entries)
    || value.entries.length === 0 || value.entries.length > MAX_HISTORY_ENTRIES
    || !Number.isSafeInteger(value.currentIndex) || value.currentIndex < 0
    || value.currentIndex >= value.entries.length || !value.entries.every(validUrl)) {
    throw new BridgeError('INVALID_HISTORY', 'Tab navigation history is invalid.');
  }
  return { currentIndex: value.currentIndex, entries: [...value.entries] };
}

function normalizedPrepare(params) {
  if (!plainObject(params) || !Array.isArray(params.tabs)
    || params.tabs.length === 0 || params.tabs.length > MAX_TABS
    || !Number.isSafeInteger(params.activeIdx) || params.activeIdx < 0
    || params.activeIdx >= params.tabs.length) {
    throw new BridgeError('INVALID_REQUEST', 'A valid Chrome window payload is required.');
  }
  const seenIndices = new Set();
  const tabs = params.tabs.map((tab) => {
    if (!plainObject(tab) || !validUrl(tab.url) || typeof tab.pinned !== 'boolean'
      || !Number.isSafeInteger(tab.index) || tab.index < 0 || tab.index >= params.tabs.length
      || seenIndices.has(tab.index)) {
      throw new BridgeError('INVALID_TAB', 'A Chrome tab payload is invalid.');
    }
    seenIndices.add(tab.index);
    const history = normalizedHistory(tab.history);
    const state = tab.pageState === undefined ? null : sanitizePageState(tab.pageState, tab.url);
    if (tab.pageState !== undefined && !state) throw new BridgeError('INVALID_PAGE_STATE', 'The page state is invalid.');
    return { url: tab.url, pinned: tab.pinned, index: tab.index, ...(history ? { history } : {}), ...(state ? { pageState: state } : {}) };
  });
  if (seenIndices.size !== tabs.length) throw new BridgeError('INVALID_TAB', 'Chrome tab indices must be unique.');
  const state = params.state === undefined ? 'normal' : params.state;
  if (state !== 'normal' && state !== 'maximized') {
    throw new BridgeError('INVALID_STATE', 'Chrome window state is invalid.');
  }
  return { bounds: normalizedBounds(params.bounds), state, tabs, activeIdx: params.activeIdx };
}

function publicTab(tab) {
  return {
    tabId: tab.id,
    index: tab.index,
    url: typeof tab.url === 'string' ? tab.url : '',
    title: String(tab.title || '').slice(0, 1024),
    pinned: tab.pinned === true,
    active: tab.active === true,
  };
}

function publicWindow(window) {
  return {
    windowId: window.id,
    left: window.left,
    top: window.top,
    width: window.width,
    height: window.height,
    state: window.state === 'maximized' || window.state === 'fullscreen' ? 'maximized' : 'normal',
    focused: window.focused === true,
    tabs: Array.isArray(window.tabs)
      ? [...window.tabs].sort((a, b) => a.index - b.index).map(publicTab) : [],
  };
}

async function mapConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

async function withDebugger(tabId, operation) {
  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, DEBUGGER_VERSION);
    attached = true;
    return await operation((method, params = {}) => chrome.debugger.sendCommand(target, method, params));
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target); } catch { /* Chrome may have closed the tab. */ }
    }
  }
}

async function captureHistory(tab) {
  if (!validUrl(tab.url)) return undefined;
  try {
    return await withDebugger(tab.id, async (command) => {
      const result = await command('Page.getNavigationHistory');
      if (!Array.isArray(result?.entries) || result.entries.length === 0
        || result.entries.length > MAX_HISTORY_ENTRIES
        || !Number.isSafeInteger(result.currentIndex) || result.currentIndex < 0
        || result.currentIndex >= result.entries.length) return undefined;
      const entries = result.entries.map((entry) => entry?.url);
      return entries.every(validUrl) ? { currentIndex: result.currentIndex, entries } : undefined;
    });
  } catch {
    // DevTools or another debugger may own this tab. The handoff can safely
    // continue without history and still preserve the current URL.
    return undefined;
  }
}

async function restoreHistory(tabId, history) {
  if (!history) return;
  await withDebugger(tabId, async (command) => {
    for (const url of history.entries) await command('Page.navigate', { url });
    const local = await command('Page.getNavigationHistory');
    if (!Array.isArray(local?.entries) || local.entries.length === 0) return;
    const offset = Math.max(0, local.entries.length - history.entries.length);
    const entry = local.entries[offset + history.currentIndex];
    if (Number.isInteger(entry?.id)) {
      await command('Page.navigateToHistoryEntry', { entryId: entry.id });
    }
  });
}

async function listWindows() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  return { windows: windows.map(publicWindow) };
}

async function captureWindow(params) {
  const windowId = windowIdFrom(params);
  const window = await chrome.windows.get(windowId, { populate: true });
  if (window.type && window.type !== 'normal') {
    throw new BridgeError('WINDOW_NOT_ADDRESSABLE', 'The selected Chrome window is not a normal browser window.');
  }
  const tabs = [...(window.tabs || [])].sort((a, b) => a.index - b.index);
  if (tabs.length === 0 || tabs.length > MAX_TABS || tabs.some((tab) => !validUrl(tab.url))) {
    throw new BridgeError('UNSUPPORTED_TABS', 'This Chrome window contains a tab that cannot be safely handed off.');
  }
  // v3 preserves back/forward history for the active tab. Keeping background
  // tabs to their current URLs also bounds the native-messaging response.
  const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.active));
  const activeHistory = await captureHistory(tabs[activeIndex]);
  const activePageState = await captureTabPageState(tabs[activeIndex]);
  const result = publicWindow(window);
  result.tabs = result.tabs.map((tab, index) => ({
    ...tab,
    ...(index === activeIndex && activeHistory ? { history: activeHistory } : {}),
    ...(index === activeIndex && activePageState ? { pageState: activePageState } : {}),
  }));
  return result;
}

async function captureTabPageState(tab) {
  try {
    return await withDebugger(tab.id, async (command) => {
      const response = await command('Runtime.evaluate', {
        expression: `(${pageState.toString()})('capture')`, returnByValue: true,
      });
      return response?.exceptionDetails ? null : sanitizePageState(response?.result?.value, tab.url);
    });
  } catch { return null; }
}

async function restoreTabPageState(tabId, state) {
  if (!state) return;
  try {
    await withDebugger(tabId, async (command) => {
      // A newly created tab may still be loading. Retry for late layout and
      // scroll restoration; never block live window-position requests.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const response = await command('Runtime.evaluate', {
          expression: `(${pageState.toString()})('restore',${JSON.stringify(state)})`, returnByValue: true,
        });
        const restored = response?.result?.value;
        if (restored?.applied && Math.abs((restored.scroll?.y ?? 0) - state.scroll.y) < 2
          && Math.abs((restored.scroll?.x ?? 0) - state.scroll.x) < 2) return;
        if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 100));
      }
    });
  } catch { /* DevTools may own this page; URL handoff must still work. */ }
}

async function applyWindowBounds(windowId, bounds, state) {
  // Chrome rejects positional bounds while a window is maximized. Normalize it
  // first, set its exact geometry, then restore the requested state.
  await chrome.windows.update(windowId, { state: 'normal' });
  await chrome.windows.update(windowId, bounds);
  if (state === 'maximized') await chrome.windows.update(windowId, { state: 'maximized' });
}

const pendingPrepares = new Map();

async function beginPrepareWindow(params) {
  const input = normalizedPrepare(params);
  const activeSource = input.tabs[input.activeIdx];
  let createdWindow;
  try {
    createdWindow = await chrome.windows.create({
      url: activeSource.url,
      focused: false,
      state: 'normal',
      ...input.bounds,
    });
    if (!Number.isSafeInteger(createdWindow?.id) || !createdWindow.tabs?.[0]?.id) {
      throw new BridgeError('PREPARE_FAILED', 'Chrome did not create the handoff window.');
    }
    pendingPrepares.set(createdWindow.id, {
      input,
      activeTabId: createdWindow.tabs[0].id,
    });
    return publicWindow(createdWindow);
  } catch (error) {
    if (Number.isSafeInteger(createdWindow?.id)) {
      pendingPrepares.delete(createdWindow.id);
      try { await chrome.windows.remove(createdWindow.id); } catch { /* The failed window may already be gone. */ }
    }
    throw error;
  }
}

async function finishPrepareWindow(params) {
  const windowId = windowIdFrom(params);
  const pending = pendingPrepares.get(windowId);
  if (!pending) throw new BridgeError('PREPARE_NOT_FOUND', 'The handoff window is no longer being prepared.');
  const { input, activeTabId } = pending;
  const activeSource = input.tabs[input.activeIdx];
  const ordered = [...input.tabs].sort((a, b) => a.index - b.index);
  try {
    const created = new Map([[activeSource, activeTabId]]);
    for (const source of ordered) {
      if (source === activeSource) continue;
      const tab = await chrome.tabs.create({
        windowId,
        url: source.url,
        active: false,
        pinned: source.pinned,
      });
      if (!Number.isSafeInteger(tab?.id)) throw new BridgeError('PREPARE_FAILED', 'Chrome did not create a handoff tab.');
      created.set(source, tab.id);
    }

    // Pinning affects Chrome's legal tab positions, so apply pin state before
    // making a final exact-order pass.
    for (const source of ordered) {
      await chrome.tabs.update(created.get(source), { pinned: source.pinned });
    }
    for (const source of ordered) {
      await chrome.tabs.move(created.get(source), { windowId, index: source.index });
    }
    await mapConcurrent(ordered.filter((source) => source.history), HISTORY_CONCURRENCY,
      (source) => restoreHistory(created.get(source), source.history));
    await chrome.tabs.update(created.get(activeSource), { active: true });
    await restoreTabPageState(created.get(activeSource), activeSource.pageState);
    // The live handoff may already have repositioned the window while its tabs
    // were restored. Do not overwrite that newer position with the initial
    // offscreen bounds at the end of preparation.
    if (input.state === 'maximized') await chrome.windows.update(windowId, { state: 'maximized' });
    const prepared = await chrome.windows.get(windowId, { populate: true });
    return publicWindow(prepared);
  } catch (error) {
    try { await chrome.windows.remove(windowId); } catch { /* The failed window may already be gone. */ }
    throw error;
  } finally {
    pendingPrepares.delete(windowId);
  }
}

async function prepareWindow(params) {
  const begun = await beginPrepareWindow(params);
  return finishPrepareWindow({ windowId: begun.windowId });
}

async function syncWindow(params) {
  const windowId = windowIdFrom(params);
  const input = normalizedPrepare({ ...params, bounds: { left: 0, top: 0, width: 800, height: 600 }, state: 'normal' });
  const current = await chrome.windows.get(windowId, { populate: true });
  const tabs = [...(current.tabs || [])].sort((a, b) => a.index - b.index);
  const ordered = [...input.tabs].sort((a, b) => a.index - b.index);
  for (let index = 0; index < ordered.length; index += 1) {
    const source = ordered[index];
    if (!tabs[index]) tabs[index] = await chrome.tabs.create({ windowId, url: source.url, active: false });
    else if (tabs[index].url !== source.url) await chrome.tabs.update(tabs[index].id, { url: source.url });
    await chrome.tabs.update(tabs[index].id, { pinned: source.pinned });
  }
  for (const tab of tabs.slice(ordered.length)) await chrome.tabs.remove(tab.id);
  for (let index = 0; index < ordered.length; index += 1) await chrome.tabs.move(tabs[index].id, { windowId, index });
  const active = input.tabs[input.activeIdx];
  await chrome.tabs.update(tabs[active.index].id, { active: true });
  await restoreTabPageState(tabs[active.index].id, active.pageState);
  return publicWindow(await chrome.windows.get(windowId, { populate: true }));
}

async function positionWindow(params) {
  const windowId = windowIdFrom(params);
  const bounds = normalizedBounds(params?.bounds);
  const state = params?.state === undefined ? 'normal' : params.state;
  if (state !== 'normal' && state !== 'maximized') throw new BridgeError('INVALID_STATE', 'Chrome window state is invalid.');
  if (state === 'normal') await chrome.windows.update(windowId, bounds);
  else await applyWindowBounds(windowId, bounds, state);
  return { windowId };
}

async function focusWindow(params) {
  const windowId = windowIdFrom(params);
  if (params?.tabId !== undefined) {
    if (!Number.isSafeInteger(params.tabId) || params.tabId < 0) {
      throw new BridgeError('INVALID_REQUEST', 'A valid Chrome tab id is required.');
    }
    const tab = await chrome.tabs.get(params.tabId);
    if (tab.windowId !== windowId) throw new BridgeError('INVALID_REQUEST', 'The Chrome tab belongs to another window.');
    await chrome.tabs.update(params.tabId, { active: true });
  }
  await chrome.windows.update(windowId, { focused: true });
  return { windowId };
}

async function closeWindow(params) {
  const windowId = windowIdFrom(params);
  pendingPrepares.delete(windowId);
  await chrome.windows.remove(windowId);
  return { windowId };
}

const RPC_METHODS = Object.freeze({
  'windows.list': listWindows,
  'window.capture': captureWindow,
  'window.prepare': prepareWindow,
  'window.prepare.begin': beginPrepareWindow,
  'window.prepare.finish': finishPrepareWindow,
  'window.position': positionWindow,
  'window.focus': focusWindow,
  'window.close': closeWindow,
  'window.sync': syncWindow,
});

function rpcError(error) {
  return {
    code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
      ? error.code : 'CHROME_EXTENSION_FAILED',
    message: error instanceof BridgeError ? error.message : 'Chrome could not complete the requested operation.',
  };
}

let nativePort = null;
let reconnectTimer = null;
let pingTimer = null;
let reconnectDelay = RECONNECT_MIN_MS;
let operationQueue = Promise.resolve();
let liveWindowQueue = Promise.resolve();
const incomingChunks = new Map();

function clearBridgeTimers() {
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  if (pingTimer !== null) clearTimeout(pingTimer);
  reconnectTimer = null;
  pingTimer = null;
}

function postNative(message) {
  if (!nativePort) return false;
  try {
    nativePort.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function schedulePing() {
  if (pingTimer !== null) clearTimeout(pingTimer);
  pingTimer = setTimeout(() => {
    pingTimer = null;
    if (nativePort) {
      postNative({ v: PROTOCOL_VERSION, type: 'ping', at: Date.now() });
      schedulePing();
    }
  }, PING_INTERVAL_MS);
}

function scheduleReconnect() {
  if (reconnectTimer !== null || nativePort) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(RECONNECT_MAX_MS, reconnectDelay * 2);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNativeBridge();
  }, delay);
}

async function dispatchRequest(message) {
  if (!plainObject(message) || message.v !== PROTOCOL_VERSION || !validId(message.id)
    || typeof message.method !== 'string' || !Object.hasOwn(RPC_METHODS, message.method)
    || (message.params !== undefined && !plainObject(message.params))) {
    if (plainObject(message) && validId(message.id)) {
      postNative({ v: PROTOCOL_VERSION, id: message.id, ok: false,
        error: { code: 'INVALID_REQUEST', message: 'The native bridge request is invalid.' } });
    }
    return;
  }
  try {
    const result = await RPC_METHODS[message.method](message.params || {});
    postNative({ v: PROTOCOL_VERSION, id: message.id, ok: true, result });
  } catch (error) {
    postNative({ v: PROTOCOL_VERSION, id: message.id, ok: false, error: rpcError(error) });
  }
}

function enqueueRequest(message) {
  // Position and close must stay responsive while the ordered queue is doing
  // slower tab/history restoration for window.prepare.finish. Keep them on a
  // separate ordered queue so rapid pointer frames cannot complete out of order.
  if (plainObject(message) && (message.method === 'window.position' || message.method === 'window.close')) {
    liveWindowQueue = liveWindowQueue.then(() => dispatchRequest(message), () => dispatchRequest(message));
    return;
  }
  operationQueue = operationQueue.then(() => dispatchRequest(message), () => dispatchRequest(message));
}

function receiveNativeMessage(message) {
  if (plainObject(message) && message.v === PROTOCOL_VERSION && message.type === 'chunk') {
    const transferId = message.transferId;
    if (!validId(transferId) || !Number.isSafeInteger(message.index) || !Number.isSafeInteger(message.total)
      || message.index < 0 || message.total < 2 || message.total > MAX_CHUNKS || message.index >= message.total
      || typeof message.data !== 'string' || message.data.length > MAX_CHUNK_TEXT) return;
    if (!incomingChunks.has(transferId)) {
      if (incomingChunks.size >= 2) return;
      incomingChunks.set(transferId, { total: message.total, received: 0, parts: new Array(message.total) });
    }
    const transfer = incomingChunks.get(transferId);
    if (transfer.total !== message.total || transfer.parts[message.index] !== undefined) {
      incomingChunks.delete(transferId);
      return;
    }
    transfer.parts[message.index] = message.data;
    transfer.received += 1;
    if (transfer.received === transfer.total) {
      incomingChunks.delete(transferId);
      try {
        const byteParts = transfer.parts.map((part) => Uint8Array.from(atob(part), (character) => character.charCodeAt(0)));
        const size = byteParts.reduce((total, part) => total + part.length, 0);
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of byteParts) { bytes.set(part, offset); offset += part.length; }
        const decoded = JSON.parse(new TextDecoder().decode(bytes));
        enqueueRequest(decoded);
      } catch { /* Invalid chunks are discarded without reaching Chrome APIs. */ }
    }
    return;
  }
  if (plainObject(message) && message.v === PROTOCOL_VERSION && message.type === 'ping') {
    postNative({ v: PROTOCOL_VERSION, type: 'pong', at: Date.now() });
    return;
  }
  enqueueRequest(message);
}

function connectNativeBridge() {
  if (nativePort || typeof chrome.runtime?.connectNative !== 'function') return;
  clearBridgeTimers();
  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch {
    scheduleReconnect();
    return;
  }
  nativePort = port;
  port.onMessage.addListener(receiveNativeMessage);
  port.onDisconnect.addListener(() => {
    // Reading lastError prevents Chrome from reporting an unchecked runtime
    // error when the desktop app or registered host is not running.
    void chrome.runtime.lastError;
    if (nativePort === port) nativePort = null;
    if (pingTimer !== null) clearTimeout(pingTimer);
    pingTimer = null;
    scheduleReconnect();
  });
  reconnectDelay = RECONNECT_MIN_MS;
  postNative({
    v: PROTOCOL_VERSION,
    type: 'hello',
    extensionId: chrome.runtime.id,
    extensionVersion: chrome.runtime.getManifest().version,
  });
  schedulePing();
}

chrome.runtime.onStartup.addListener(connectNativeBridge);
chrome.action.onClicked.addListener(connectNativeBridge);
if (chrome.runtime.onInstalled?.addListener) chrome.runtime.onInstalled.addListener(connectNativeBridge);
connectNativeBridge();

// Retained during the v3 transition for older desktop builds that already
// loaded this extension through their private debugging connection.
globalThis.compusyncCapture = async (input) => {
  const tabs = await chrome.tabs.query({ windowId: input.windowId });
  const targets = await chrome.debugger.getTargets();
  const byTab = new Map(targets.filter((item) => Number.isInteger(item.tabId))
    .map((item) => [item.tabId, item.id]));
  return tabs.map((tab) => ({ targetId: byTab.get(tab.id), index: tab.index,
    pinned: tab.pinned === true, active: tab.active === true }))
    .filter((tab) => typeof tab.targetId === 'string');
};

globalThis.compusyncApply = async (input) => {
  let match;
  for (let attempt = 0; attempt < 5 && !match; attempt += 1) {
    match = (await chrome.debugger.getTargets()).find((item) => item.id === input.targetId
      && Number.isInteger(item.tabId));
    if (!match) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!match) throw new Error('target unavailable');
  const tab = await chrome.tabs.get(match.tabId);
  if (tab.windowId !== input.windowId) throw new Error('wrong window');
  await chrome.tabs.update(match.tabId, { pinned: input.pinned });
  await chrome.tabs.move(match.tabId, { windowId: input.windowId, index: input.index });
  return true;
};
