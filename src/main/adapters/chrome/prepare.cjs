'use strict';

const { sanitizeWindowDescriptor } = require('../../messages.cjs');
const { normalizePlacement, toLocal } = require('../../virtualspace.cjs');
const { hostOnly, nativeWindowId, safeLog } = require('./capture.cjs');

const LOAD_CAP_MS = 3_000;
const TAB_STAGGER_MIN_MS = 80;
const TAB_STAGGER_MAX_MS = 120;
const HISTORY_CONCURRENCY = 4;

class ChromePrepareError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChromePrepareError';
    this.code = code;
  }
}

function boundsFromVU(originVU, geometryVU, placementValue) {
  const placement = normalizePlacement(placementValue);
  if (!placement || !originVU || !geometryVU
    || !Number.isFinite(originVU.x) || !Number.isFinite(originVU.y)
    || !Number.isFinite(geometryVU.w) || !Number.isFinite(geometryVU.h)) {
    throw new ChromePrepareError('CHROME_INVALID_GEOMETRY', 'The Chrome handoff position is invalid.');
  }
  const origin = toLocal(originVU, placement);
  return {
    x: Math.round(origin.x),
    y: Math.round(origin.y),
    width: Math.max(1, Math.round(geometryVU.w * placement.scale)),
    height: Math.max(1, Math.round(geometryVU.h * placement.scale)),
  };
}

function normalizePixelBounds(value) {
  if (!value) return null;
  const clean = {
    x: Number(value.x ?? value.left), y: Number(value.y ?? value.top),
    width: Number(value.width ?? value.w), height: Number(value.height ?? value.h),
  };
  return Object.values(clean).every(Number.isFinite) && clean.width > 0 && clean.height > 0
    ? { x: Math.round(clean.x), y: Math.round(clean.y), width: Math.round(clean.width), height: Math.round(clean.height) }
    : null;
}

function prepareBounds(descriptor, options, fallbackPlacement) {
  const direct = normalizePixelBounds(options);
  if (direct) return direct;
  const originVU = options?.originVU || options;
  const placement = options?.targetPlacement || fallbackPlacement;
  return boundsFromVU(originVU, descriptor.geometryVU, placement);
}

function orderedTabs(descriptor) {
  const active = descriptor.payload.tabs[descriptor.payload.activeIdx];
  const tabs = [...descriptor.payload.tabs].sort((a, b) => a.index - b.index);
  return { tabs, active, activeIndex: tabs.indexOf(active) };
}

function delay(ms, sleep) {
  return sleep(ms);
}

function loadWaiter(page, timeoutMs, timers) {
  let timer;
  let settled = false;
  let resolvePromise;
  const done = (reason) => {
    if (settled) return;
    settled = true;
    if (timer) timers.clearTimeout(timer);
    page?.off?.('event', onEvent);
    resolvePromise(reason);
  };
  const onEvent = (method) => { if (method === 'Page.loadEventFired') done('load'); };
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  page?.on?.('event', onEvent);
  timer = timers.setTimeout(() => done('timeout'), timeoutMs);
  timer?.unref?.();
  return { promise, done };
}

async function restoreHistory(command, history) {
  if (!history?.entries?.length) return;
  // IDs returned by Page.getNavigationHistory are local to this new target.
  // Recreate the URL sequence, then select the corresponding local entry.
  for (const url of history.entries) await command('Page.navigate', { url });
  const local = await command('Page.getNavigationHistory', {});
  if (!Array.isArray(local?.entries) || !local.entries.length) return;
  const offset = Math.max(0, local.entries.length - history.entries.length);
  const entry = local.entries[offset + history.currentIndex];
  if (Number.isInteger(entry?.id)) await command('Page.navigateToHistoryEntry', { entryId: entry.id });
}

async function mapConcurrent(values, concurrency, mapper) {
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next++;
      await mapper(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
}

class ChromePrepare {
  constructor(options = {}) {
    if (!options.cdp) throw new TypeError('Chrome CDP client is required.');
    this.cdp = options.cdp;
    this.native = options.native || {};
    this.tabControl = options.tabControl || {};
    this.logger = options.logger || null;
    this.records = options.records || new Map();
    this.identities = options.identities;
    this.placement = options.placement;
    this.sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random || Math.random;
    this.timers = {
      setTimeout: options.setTimeout || setTimeout,
      clearTimeout: options.clearTimeout || clearTimeout,
    };
    this.loadCapMs = Number.isFinite(options.loadCapMs) ? Math.min(LOAD_CAP_MS, Math.max(1, options.loadCapMs)) : LOAD_CAP_MS;
  }

  async nativeForWindow(windowId) {
    if (typeof this.native.enumerateWindows !== 'function') return null;
    try {
      const windows = await this.native.enumerateWindows();
      if (!Array.isArray(windows)) return null;
      const groups = await this.cdp.windows(windows);
      return groups.find((group) => group.windowId === windowId)?.nativeWindow || null;
    } catch { return null; }
  }

  async setPinned(target, pinned, context) {
    const setter = this.tabControl.setPinned || this.cdp.setPinned;
    if (typeof setter === 'function') {
      await setter.call(this.tabControl.setPinned ? this.tabControl : this.cdp, {
        targetId: target.targetId, pinned, index: target.index, windowId: context.windowId,
      });
      return true;
    }
    if (pinned) safeLog(this.logger, 'warn', 'chrome.pin.unsupported', {
      id: context.id, host: hostOnly(target.url), tabCount: context.tabCount,
    });
    return false;
  }

  async prepare(inputDescriptor, options = {}) {
    const descriptor = sanitizeWindowDescriptor(inputDescriptor);
    if (!descriptor) throw new ChromePrepareError('CHROME_INVALID_DESCRIPTOR', 'The Chrome handoff descriptor is invalid.');
    const bounds = prepareBounds(descriptor, options, this.placement);
    const { tabs, active, activeIndex } = orderedTabs(descriptor);
    await this.cdp.connect?.();
    let created;
    const targets = [];
    try {
      // The active URL is deliberately the only content created before bounds
      // are applied, preventing a populated window from flashing on-screen.
      created = await this.cdp.createWindow(active.url, bounds);
      targets.push({ targetId: created.targetId, index: active.index, url: active.url, pinned: active.pinned, history: active.history });
      for (const tab of tabs) {
        if (tab === active) continue;
        const stagger = TAB_STAGGER_MIN_MS + Math.floor(this.random() * (TAB_STAGGER_MAX_MS - TAB_STAGGER_MIN_MS + 1));
        await delay(stagger, this.sleep);
        const targetId = await this.cdp.createTarget(tab.url, { background: true });
        targets.push({ targetId, index: tab.index, url: tab.url, pinned: tab.pinned, history: tab.history });
      }
      targets.sort((a, b) => a.index - b.index);
      for (const target of targets) await this.setPinned(target, target.pinned, {
        id: descriptor.id, tabCount: tabs.length, windowId: created.windowId,
      });

      const activeTargetId = created.targetId;
      const nativeWindow = await this.nativeForWindow(created.windowId);
      // Background tab creation can move selection; explicitly reactivate the
      // originally active tab before history restoration and readiness.
      await this.cdp.focusTarget(activeTargetId, nativeWindow, this.native);
      await mapConcurrent(targets, HISTORY_CONCURRENCY, async (target) => {
        if (!target.history && target.targetId !== activeTargetId) return;
        await this.cdp.withPage(target.targetId, async (command, page) => {
          await command('Page.enable', {});
          await restoreHistory(command, target.history);
          if (target.targetId !== activeTargetId) return;
          const waiter = loadWaiter(page, this.loadCapMs, this.timers);
          try {
            const result = await command('Runtime.evaluate', {
              expression: 'document.readyState', returnByValue: true,
            });
            if (result?.result?.value === 'complete') waiter.done('already-loaded');
          } catch { /* The load event/cap remains authoritative. */ }
          await waiter.promise;
        });
      });

      const handle = {
        id: descriptor.id,
        descriptorId: descriptor.id,
        targetId: activeTargetId,
        activeTargetId,
        windowId: created.windowId,
        nativeWindowId: nativeWindowId(nativeWindow),
        targetIds: targets.map(({ targetId }) => targetId),
        geometryVU: descriptor.geometryVU,
        state: descriptor.state,
        instantCommit: descriptor.state === 'maximized',
        placement: options.targetPlacement || this.placement || null,
      };
      if (handle.nativeWindowId != null) {
        this.identities?.remember(handle, descriptor.id);
        this.records.set(String(handle.nativeWindowId), { descriptor, ...handle });
      }
      safeLog(this.logger, 'info', 'chrome.prepare', {
        id: descriptor.id, host: hostOnly(active.url), tabCount: tabs.length,
      });
      return handle;
    } catch (error) {
      const ids = targets.map(({ targetId }) => targetId);
      if (created?.targetId && !ids.includes(created.targetId)) ids.push(created.targetId);
      for (const targetId of ids.reverse()) {
        try { await this.cdp.closeTarget(targetId); } catch {}
      }
      if (error?.code) throw error;
      throw new ChromePrepareError('CHROME_PREPARE_FAILED', 'Chrome could not prepare the handoff window.');
    }
  }
}

module.exports = {
  LOAD_CAP_MS,
  HISTORY_CONCURRENCY,
  TAB_STAGGER_MIN_MS,
  TAB_STAGGER_MAX_MS,
  ChromePrepare,
  ChromePrepareError,
  boundsFromVU,
  createChromePrepare: (options) => new ChromePrepare(options),
  loadWaiter,
  mapConcurrent,
  normalizePixelBounds,
  orderedTabs,
  prepareBounds,
  prepareChromeWindow: (options, descriptor, bounds) => new ChromePrepare(options).prepare(descriptor, bounds),
  restoreHistory,
};
