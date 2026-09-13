'use strict';

const { validUrl, sanitizeWindowDescriptor } = require('../../messages.cjs');
const {
  ChromeCaptureError, DescriptorIdentityCache, geometryVU, isNativeChromeWindow,
  nativeWindowId, safeLog, selectAddressableWindow, hostOnly,
} = require('./capture.cjs');
const { ChromePrepareError, prepareBounds } = require('./prepare.cjs');

const MAX_WINDOWS = 100;
const MAX_TABS = 500;

function chromeError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function normalizeWindow(value) {
  if (!value || !Number.isInteger(value.windowId) || value.windowId < 0) return null;
  const bounds = {
    left: Number(value.left), top: Number(value.top), width: Number(value.width), height: Number(value.height),
    windowState: ['normal', 'minimized', 'maximized', 'fullscreen'].includes(value.state) ? value.state : 'normal',
  };
  if (!Object.values(bounds).slice(0, 4).every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return null;
  if (!Array.isArray(value.tabs) || !value.tabs.length || value.tabs.length > MAX_TABS) return null;
  const tabs = value.tabs.map((tab) => ({
    id: Number.isInteger(tab?.tabId) ? String(tab.tabId) : '',
    tabId: tab?.tabId,
    index: tab?.index,
    url: tab?.url,
    title: typeof tab?.title === 'string' ? tab.title.slice(0, 1024) : '',
    pinned: Boolean(tab?.pinned), active: Boolean(tab?.active), history: tab?.history,
  }));
  if (tabs.some((tab) => !tab.id || !Number.isSafeInteger(tab.index))) return null;
  return {
    windowId: value.windowId, bounds, tabs, focused: value.focused === true,
    tabsAddressable: tabs.every((tab) => validUrl(tab.url)),
  };
}

function boundsDistance(first, second) {
  if (!first || !second) return Infinity;
  const a = first.bounds || first;
  const b = second.bounds || second;
  const ax = Number(a.left ?? a.x), ay = Number(a.top ?? a.y);
  const bx = Number(b.left ?? b.x), by = Number(b.top ?? b.y);
  const values = [ax, ay, Number(a.width), Number(a.height), bx, by, Number(b.width), Number(b.height)];
  return values.every(Number.isFinite)
    ? Math.abs(ax - bx) + Math.abs(ay - by) + Math.abs(Number(a.width) - Number(b.width)) + Math.abs(Number(a.height) - Number(b.height))
    : Infinity;
}

function joinNativeWindows(groups, nativeWindows, tolerance = 48) {
  const unused = new Set((nativeWindows || []).filter(isNativeChromeWindow));
  return groups.map((group) => {
    let match = null, distance = Infinity;
    for (const candidate of unused) {
      const score = boundsDistance(group.bounds, candidate);
      if (score < distance) { match = candidate; distance = score; }
    }
    if (match && distance <= tolerance * 4) unused.delete(match);
    else match = null;
    return { ...group, nativeWindow: match, geometryDistance: match ? distance : null };
  });
}

function validHistory(value) {
  if (!value || !Number.isSafeInteger(value.currentIndex) || !Array.isArray(value.entries)
    || value.entries.length < 1 || value.entries.length > 200
    || value.currentIndex < 0 || value.currentIndex >= value.entries.length
    || value.entries.some((url) => !validUrl(url))) return undefined;
  return { currentIndex: value.currentIndex, entries: [...value.entries] };
}

class ChromeExtensionAdapter {
  constructor(options = {}) {
    if (!options.bridge || typeof options.bridge.request !== 'function') throw new TypeError('Chrome extension bridge is required.');
    this.adapterId = 'chrome';
    this.bridge = options.bridge;
    this.native = options.native || {};
    this.machineId = options.machineId || 'local';
    this.getPlacement = typeof options.getPlacement === 'function' ? options.getPlacement : () => options.placement;
    this.identities = options.identities || new DescriptorIdentityCache(options);
    this.records = options.records || new Map();
    this.logger = options.logger || null;
    this.now = options.now || Date.now;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  isAddressable(window) { return this.bridge.connected && isNativeChromeWindow(window); }

  async windows(nativeWindows) {
    const result = await this.bridge.request('windows.list', {});
    if (!Array.isArray(result?.windows) || result.windows.length > MAX_WINDOWS) {
      throw chromeError('CHROME_EXTENSION_PROTOCOL', 'The Chrome helper returned an invalid window list.');
    }
    const groups = result.windows.map(normalizeWindow).filter(Boolean);
    return joinNativeWindows(groups, nativeWindows);
  }

  async capture(window, inputGeometryVU, stableInput) {
    const geometry = geometryVU(inputGeometryVU);
    if (!geometry) throw new ChromeCaptureError('CHROME_INVALID_GEOMETRY', 'The Chrome window geometry is invalid.');
    let nativeWindows = [window];
    try {
      const enumerated = await this.native.enumerateWindows?.();
      if (Array.isArray(enumerated)) nativeWindows = enumerated;
    } catch {}
    const groups = await this.windows(nativeWindows);
    let selected;
    if (isNativeChromeWindow(window)) {
      // chrome.windows uses logical coordinates while GetWindowRect is
      // physical-DPI and may also lag during Windows' modal move loop. The
      // dragged HWND and Chrome's sole focused normal window are the same
      // user-selected window, providing an identity-safe fallback.
      const focused = groups.filter((group) => group.focused);
      if (focused.length === 1) selected = { ...focused[0], nativeWindow: window };
    }
    if (!selected) selected = selectAddressableWindow(groups, window);
    if (!selected?.nativeWindow) {
      throw new ChromeCaptureError('CHROME_WINDOW_NOT_ADDRESSABLE', 'The selected Chrome window is not available through the CompuSync Chrome helper.');
    }
    let captured;
    try { captured = await this.bridge.request('window.capture', { windowId: selected.windowId }); }
    catch (error) {
      if (error?.code === 'UNSUPPORTED_TABS') {
        throw new ChromeCaptureError('CHROME_UNSUPPORTED_TABS', error.message);
      }
      throw error;
    }
    const group = normalizeWindow(captured);
    if (!group) throw chromeError('CHROME_EXTENSION_PROTOCOL', 'The Chrome helper returned invalid window data.');
    if (!group.tabsAddressable) {
      throw new ChromeCaptureError('CHROME_UNSUPPORTED_TABS', 'This Chrome window contains a tab that cannot be safely handed off.');
    }
    const ordered = [...group.tabs].sort((a, b) => a.index - b.index);
    let activeIdx = ordered.findIndex((tab) => tab.active);
    if (activeIdx < 0) activeIdx = 0;
    const descriptor = {
      schemaVersion: 1,
      id: this.identities.idFor(window, stableInput),
      adapterId: 'chrome', origin: this.machineId, capturedAt: this.now(), geometryVU: geometry,
      state: group.bounds.windowState === 'maximized' || group.bounds.windowState === 'fullscreen' ? 'maximized' : 'normal',
      payload: {
        activeIdx,
        tabs: ordered.map((tab, index) => ({
          url: tab.url, title: tab.title, pinned: tab.pinned, index,
          ...(validHistory(tab.history) ? { history: validHistory(tab.history) } : {}),
        })),
      },
    };
    const id = nativeWindowId(selected.nativeWindow);
    if (id != null) {
      this.identities.remember(selected.nativeWindow, descriptor.id);
      this.records.set(String(id), {
        descriptor, windowId: group.windowId, tabIds: ordered.map((tab) => tab.tabId),
        activeTabId: ordered[activeIdx].tabId,
      });
    }
    safeLog(this.logger, 'info', 'chrome.capture', {
      id: descriptor.id, host: hostOnly(descriptor.payload.tabs[activeIdx].url), tabCount: ordered.length,
    });
    return descriptor;
  }

  async #nativeForWindow(windowId) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const nativeWindows = await this.native.enumerateWindows?.();
        if (Array.isArray(nativeWindows)) {
          const match = (await this.windows(nativeWindows)).find((group) => group.windowId === windowId)?.nativeWindow;
          if (match) return match;
        }
      } catch {}
      if (attempt < 7) await this.sleep(40);
    }
    return null;
  }

  async prepare(inputDescriptor, options = {}) {
    const descriptor = sanitizeWindowDescriptor(inputDescriptor);
    if (!descriptor) throw new ChromePrepareError('CHROME_INVALID_DESCRIPTOR', 'The Chrome handoff descriptor is invalid.');
    const placement = options.targetPlacement || this.getPlacement();
    const normalizedBounds = prepareBounds(descriptor, options, placement);
    const bounds = typeof this.native.toPlatformBounds === 'function'
      ? this.native.toPlatformBounds(normalizedBounds) : normalizedBounds;
    const prepared = await this.bridge.request('window.prepare', {
      bounds, state: descriptor.state, tabs: descriptor.payload.tabs, activeIdx: descriptor.payload.activeIdx,
    });
    if (!Number.isInteger(prepared?.windowId) || !Array.isArray(prepared?.tabs)) {
      throw chromeError('CHROME_EXTENSION_PROTOCOL', 'The Chrome helper returned an invalid prepared window.');
    }
    const nativeWindow = await this.#nativeForWindow(prepared.windowId);
    const handle = {
      id: descriptor.id, descriptorId: descriptor.id, windowId: prepared.windowId,
      nativeWindowId: nativeWindowId(nativeWindow),
      activeTabId: prepared.tabs.find((tab) => tab.active)?.tabId,
      tabIds: prepared.tabs.map((tab) => tab.tabId),
      geometryVU: descriptor.geometryVU, state: descriptor.state,
      instantCommit: descriptor.state === 'maximized', placement: placement || null,
    };
    if (handle.nativeWindowId != null) {
      this.identities.remember(handle, descriptor.id);
      this.records.set(String(handle.nativeWindowId), { descriptor, ...handle });
    }
    safeLog(this.logger, 'info', 'chrome.prepare', {
      id: descriptor.id, host: hostOnly(descriptor.payload.tabs[descriptor.payload.activeIdx].url),
      tabCount: descriptor.payload.tabs.length,
    });
    return handle;
  }

  boundsFor(handle, position) {
    const id = nativeWindowId(handle);
    const record = id == null ? null : this.records.get(String(id));
    const descriptor = record?.descriptor;
    return prepareBounds(descriptor || {
      geometryVU: handle?.geometryVU,
    }, { originVU: position, targetPlacement: handle?.placement || this.getPlacement() }, this.getPlacement());
  }

  async position(handle, originVU) {
    const bounds = this.boundsFor(handle, originVU);
    const id = nativeWindowId(handle);
    const record = id == null ? null : this.records.get(String(id));
    if (id != null && typeof this.native.setWindowBoundsNormalized === 'function') {
      return this.native.setWindowBoundsNormalized(id, bounds);
    }
    if (id != null && typeof this.native.setWindowBounds === 'function') return this.native.setWindowBounds(id, bounds);
    const windowId = handle?.windowId ?? record?.windowId;
    if (Number.isInteger(windowId)) return this.bridge.request('window.position', { windowId, bounds });
    throw new ChromePrepareError('CHROME_NATIVE_WINDOW_UNAVAILABLE', 'The Chrome handoff window cannot be positioned.');
  }

  async focus(handle) {
    const id = nativeWindowId(handle);
    const record = id == null ? null : this.records.get(String(id));
    const windowId = handle?.windowId ?? record?.windowId;
    if (Number.isInteger(windowId)) {
      return this.bridge.request('window.focus', { windowId, tabId: handle?.activeTabId ?? record?.activeTabId });
    }
    if (id != null && typeof this.native.focusWindow === 'function') return this.native.focusWindow(id);
    throw new ChromePrepareError('CHROME_NATIVE_WINDOW_UNAVAILABLE', 'The Chrome handoff window cannot be focused.');
  }

  async close(handle) {
    const id = nativeWindowId(handle);
    const record = id == null ? null : this.records.get(String(id));
    const windowId = handle?.windowId ?? record?.windowId;
    try {
      if (Number.isInteger(windowId)) {
        try { return await this.bridge.request('window.close', { windowId }); }
        catch (error) {
          if (id == null || typeof this.native.closeWindow !== 'function') throw error;
        }
      }
      if (id != null && typeof this.native.closeWindow === 'function') return this.native.closeWindow(id);
      throw new ChromePrepareError('CHROME_NATIVE_WINDOW_UNAVAILABLE', 'The Chrome handoff window cannot be closed.');
    } finally {
      this.identities.forget(handle);
      if (id != null) this.records.delete(String(id));
    }
  }
}

module.exports = {
  ChromeExtensionAdapter, MAX_TABS, MAX_WINDOWS, boundsDistance, joinNativeWindows, normalizeWindow, validHistory,
  createChromeExtensionAdapter: (options) => new ChromeExtensionAdapter(options),
};
