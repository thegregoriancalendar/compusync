'use strict';

const crypto = require('node:crypto');
const { validUrl } = require('../../messages.cjs');

const CHROME_IDENTITY = /^(?:chrome(?:\.exe)?|google chrome(?:\.app)?|com\.google\.chrome)$/i;
const HISTORY_CONCURRENCY = 4;

class ChromeCaptureError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChromeCaptureError';
    this.code = code;
  }
}

function nativeWindowId(value) {
  // Prepared handles have a transfer UUID in `id` before a native handle is
  // known. An explicit null must not turn that UUID into a Win32 HWND.
  if (value && typeof value === 'object') {
    if ('nativeWindowId' in value) return value.nativeWindowId ?? null;
    if ('native_window_id' in value) return value.native_window_id ?? null;
  }
  return value?.nativeWindowId ?? value?.native_window_id ?? value?.nativeWindow?.id ?? value?.id ?? null;
}

function isNativeChromeWindow(value) {
  const identity = String(value?.processName ?? value?.process_name ?? value?.bundleId ?? value?.bundle_id ?? '');
  return value?.visible !== false && CHROME_IDENTITY.test(identity);
}

function descriptorIdFrom(value) {
  const id = value?.descriptorId ?? value?.descriptor?.id
    ?? (value?.schemaVersion === 1 && value?.adapterId === 'chrome' ? value.id : null);
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : null;
}

class DescriptorIdentityCache {
  constructor(options = {}) {
    this.uuid = options.uuid || crypto.randomUUID;
    this.byNativeWindow = new Map();
  }

  idFor(window, explicit) {
    const nativeId = nativeWindowId(window);
    const id = descriptorIdFrom(explicit) || descriptorIdFrom(window)
      || (nativeId == null ? null : this.byNativeWindow.get(String(nativeId)))
      || this.uuid();
    if (nativeId != null) this.byNativeWindow.set(String(nativeId), id);
    // Native bindings usually return fresh objects on every enumeration. Add
    // metadata when possible, but never depend on object identity for reuse.
    try { if (window && typeof window === 'object' && Object.isExtensible(window)) window.descriptorId = id; } catch {}
    return id;
  }

  remember(window, id) {
    const nativeId = nativeWindowId(window);
    if (nativeId != null && descriptorIdFrom({ descriptorId: id })) {
      this.byNativeWindow.set(String(nativeId), id);
      try { if (window && typeof window === 'object' && Object.isExtensible(window)) window.descriptorId = id; } catch {}
    }
    return id;
  }

  forget(window) {
    const nativeId = nativeWindowId(window);
    if (nativeId != null) this.byNativeWindow.delete(String(nativeId));
  }
}

function geometryVU(value) {
  if (!value || typeof value !== 'object') return null;
  const clean = {
    x: Number(value.x), y: Number(value.y),
    w: Number(value.w ?? value.width), h: Number(value.h ?? value.height),
  };
  return Object.values(clean).every(Number.isFinite) && clean.w > 0 && clean.h > 0 ? clean : null;
}

function boundsOf(value) {
  const bounds = value?.bounds || value;
  if (!bounds) return null;
  const clean = {
    left: Number(bounds.left ?? bounds.x), top: Number(bounds.top ?? bounds.y),
    width: Number(bounds.width ?? bounds.w), height: Number(bounds.height ?? bounds.h),
  };
  return Object.values(clean).every(Number.isFinite) ? clean : null;
}

function distanceBetween(first, second) {
  const a = boundsOf(first), b = boundsOf(second);
  if (!a || !b) return Infinity;
  return Math.abs(a.left - b.left) + Math.abs(a.top - b.top)
    + Math.abs(a.width - b.width) + Math.abs(a.height - b.height);
}

function selectAddressableWindow(groups, selected) {
  const wantedId = nativeWindowId(selected);
  if (Number.isInteger(selected?.chromeWindowId ?? selected?.windowId)) {
    const wantedWindowId = selected.chromeWindowId ?? selected.windowId;
    const exact = groups.find((group) => group.windowId === wantedWindowId);
    if (exact) return exact;
  }
  if (wantedId != null) {
    const exact = groups.find((group) => String(nativeWindowId(group.nativeWindow)) === String(wantedId));
    if (exact) return exact;
  }
  return groups.reduce((best, group) => (
    !best || distanceBetween(selected, group.nativeWindow || group.bounds)
      < distanceBetween(selected, best.nativeWindow || best.bounds) ? group : best
  ), null);
}

function hostOnly(url) {
  try { return new URL(url).host; } catch { return 'invalid'; }
}

function safeLog(logger, level, event, details) {
  const method = typeof logger === 'function' ? logger : logger?.[level];
  if (typeof method === 'function') method.call(logger, event, details);
}

async function pageVisibility(cdp, targetId) {
  try {
    return await cdp.withPage(targetId, async (command) => {
      const result = await command('Runtime.evaluate', {
        expression: 'document.visibilityState', returnByValue: true,
      });
      return result?.result?.value === 'visible';
    });
  } catch { return false; }
}

async function activeHistory(cdp, targetId) {
  try {
    return await cdp.withPage(targetId, async (command) => {
      const result = await command('Page.getNavigationHistory', {});
      if (!Array.isArray(result?.entries) || !Number.isSafeInteger(result.currentIndex)) return undefined;
      const current = result.entries[result.currentIndex];
      if (!current || !validUrl(current.url)) return undefined;
      // A history containing an internal/new-tab URL cannot be represented by
      // the wire schema. Keep capture valid by omitting history in that case.
      if (!result.entries.length || result.entries.length > 200 || result.entries.some((entry) => !validUrl(entry?.url))) return undefined;
      return { currentIndex: result.currentIndex, entries: result.entries.map((entry) => entry.url) };
    });
  } catch { return undefined; }
}

async function mapConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

function normalizeTabState(tabs, state) {
  const byId = new Map();
  if (Array.isArray(state)) {
    for (const item of state) if (item?.targetId || item?.id) byId.set(String(item.targetId || item.id), item);
  } else if (state && typeof state === 'object') {
    for (const [id, item] of Object.entries(state)) byId.set(id, item);
  }
  return tabs.map((target, fallbackIndex) => {
    const extra = byId.get(String(target.id)) || {};
    return {
      target,
      index: Number.isSafeInteger(extra.index) ? extra.index
        : (Number.isSafeInteger(target.index) ? target.index : fallbackIndex),
      pinned: typeof extra.pinned === 'boolean' ? extra.pinned : Boolean(target.pinned),
      active: typeof extra.active === 'boolean' ? extra.active : Boolean(target.active),
    };
  }).sort((a, b) => a.index - b.index);
}

class ChromeCapture {
  constructor(options = {}) {
    if (!options.cdp) throw new TypeError('Chrome CDP client is required.');
    this.cdp = options.cdp;
    this.native = options.native || {};
    this.machineId = options.machineId || 'local';
    this.now = options.now || Date.now;
    this.identities = options.identities || new DescriptorIdentityCache(options);
    this.tabControl = options.tabControl || {};
    this.logger = options.logger || null;
    this.records = options.records || new Map();
  }

  async capture(window, inputGeometryVU, stableInput) {
    const geometry = geometryVU(inputGeometryVU);
    if (!geometry) throw new ChromeCaptureError('CHROME_INVALID_GEOMETRY', 'The Chrome window geometry is invalid.');
    await this.cdp.connect?.();
    let nativeWindows = [window];
    if (typeof this.native.enumerateWindows === 'function') {
      try {
        const enumerated = await this.native.enumerateWindows();
        if (Array.isArray(enumerated)) nativeWindows = enumerated.filter(isNativeChromeWindow);
      } catch {}
    }
    const groups = await this.cdp.windows(nativeWindows);
    const group = selectAddressableWindow(groups, window);
    if (!group?.nativeWindow || !Array.isArray(group.tabs) || !group.tabs.length) {
      throw new ChromeCaptureError('CHROME_WINDOW_NOT_ADDRESSABLE', 'The selected Chrome window is not available through local debugging.');
    }

    let suppliedState;
    if (typeof this.tabControl.captureWindow === 'function') {
      suppliedState = await this.tabControl.captureWindow({
        windowId: group.windowId, nativeWindow: group.nativeWindow, tabs: group.tabs,
      });
    }
    const ordered = normalizeTabState(group.tabs, suppliedState);
    if (ordered.some(({ target }) => !validUrl(target.url))) {
      throw new ChromeCaptureError('CHROME_UNSUPPORTED_TABS', 'This Chrome window contains a tab that cannot be safely handed off.');
    }
    if (!ordered.some(({ active }) => active)) {
      const visible = await Promise.all(ordered.map(({ target }) => pageVisibility(this.cdp, target.id)));
      const index = visible.indexOf(true);
      if (index >= 0) ordered[index].active = true;
    }
    let activeIdx = ordered.findIndex(({ active }) => active);
    if (activeIdx < 0) activeIdx = 0;
    const histories = await mapConcurrent(ordered, HISTORY_CONCURRENCY,
      ({ target }) => activeHistory(this.cdp, target.id));
    const tabs = ordered.map(({ target, pinned }, index) => ({
      url: target.url,
      title: String(target.title || '').slice(0, 1024),
      pinned,
      index,
      ...(histories[index] ? { history: histories[index] } : {}),
    }));
    const id = this.identities.idFor(window, stableInput);
    const descriptor = {
      schemaVersion: 1,
      id,
      adapterId: 'chrome',
      origin: this.machineId,
      capturedAt: this.now(),
      geometryVU: geometry,
      state: window?.maximized === true || window?.fullscreen === true
        || group.nativeWindow?.fullscreen === true || group.bounds?.windowState === 'maximized'
        || group.bounds?.windowState === 'fullscreen' ? 'maximized' : 'normal',
      payload: { activeIdx, tabs },
    };
    const nativeId = nativeWindowId(group.nativeWindow);
    if (nativeId != null) {
      this.identities.remember(group.nativeWindow, id);
      this.records.set(String(nativeId), {
        descriptor, windowId: group.windowId, targetIds: ordered.map(({ target }) => target.id),
        activeTargetId: ordered[activeIdx].target.id,
      });
    }
    safeLog(this.logger, 'info', 'chrome.capture', {
      id, host: hostOnly(tabs[activeIdx].url), tabCount: tabs.length,
    });
    return descriptor;
  }
}

module.exports = {
  CHROME_IDENTITY,
  HISTORY_CONCURRENCY,
  ChromeCapture,
  ChromeCaptureError,
  DescriptorIdentityCache,
  createChromeCapture: (options) => new ChromeCapture(options),
  captureChromeWindow: (options, window, geometry, stableInput) => new ChromeCapture(options).capture(window, geometry, stableInput),
  descriptorIdFrom,
  geometryVU,
  hostOnly,
  isNativeChromeWindow,
  mapConcurrent,
  nativeWindowId,
  safeLog,
  selectAddressableWindow,
};
