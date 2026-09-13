'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const { sanitizeWindowDescriptor, validUrl } = require('../../messages.cjs');

const APP_NAME = 'Google Chrome';
const AUTOMATION_HELP = 'Allow Compusync to control Google Chrome in System Settings > Privacy & Security > Automation, then try the handoff again.';
const CAPTURE_MARKER = '/* compusync:chrome:capture */';
const CREATE_MARKER = '/* compusync:chrome:prepare:create */';
const POPULATE_MARKER = '/* compusync:chrome:prepare:populate */';
const CLOSE_MARKER = '/* compusync:chrome:close */';
const MAX_PREPARED_DESCRIPTORS = 200;

class AppleChromeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AppleChromeError';
    this.code = code;
  }
}

// JSON is valid JavaScript. Escaping the two JavaScript-only line separators
// makes this safe even on older macOS JavaScriptCore releases. Dynamic values
// are never passed through a shell.
function scriptLiteral(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function captureScript() {
  return `${CAPTURE_MARKER}
function safe(read, fallback) { try { var value = read(); return value === undefined ? fallback : value; } catch (_) { return fallback; } }
var chrome = Application(${scriptLiteral(APP_NAME)});
if (!chrome.running()) throw new Error('COMPUSYNC_CHROME_NOT_RUNNING');
var output = chrome.windows().map(function (win, windowIndex) {
  var bounds = safe(function () { return win.bounds(); }, null);
  var tabs = win.tabs().map(function (tab, tabIndex) {
    return {
      index: tabIndex,
      url: String(safe(function () { return tab.url(); }, '')),
      title: String(safe(function () { return tab.title(); }, '')),
      pinned: Boolean(safe(function () {
        return typeof tab.pinned === 'function' ? tab.pinned() : false;
      }, false))
    };
  });
  return {
    chromeWindowId: String(safe(function () { return win.id(); }, '')),
    chromeWindowIndex: windowIndex + 1,
    title: String(safe(function () { return win.title(); }, '')),
    bounds: bounds,
    activeIdx: Number(safe(function () { return win.activeTabIndex(); }, 1)) - 1,
    tabs: tabs
  };
});
JSON.stringify(output);`;
}

function createdWindowResultScript() {
  return `var allWindows = chrome.windows();
var resultIndex = 0;
for (var w = 0; w < allWindows.length; w += 1) {
  try { if (String(allWindows[w].id()) === String(win.id())) { resultIndex = w + 1; break; } } catch (_) {}
}
JSON.stringify({
  chromeWindowId: String((function () { try { return win.id(); } catch (_) { return ''; } })()),
  chromeWindowIndex: resultIndex || 1,
  title: String((function () { try { return win.title(); } catch (_) { return ''; } })()),
  bounds: (function () { try { return win.bounds(); } catch (_) { return null; } })()
});`;
}

function createWindowScript(descriptor) {
  const activeUrl = descriptor.payload.tabs[descriptor.payload.activeIdx].url;
  return `${CREATE_MARKER}
var activeUrl = ${scriptLiteral(activeUrl)};
var chrome = Application(${scriptLiteral(APP_NAME)});
if (!chrome.running()) throw new Error('COMPUSYNC_CHROME_NOT_RUNNING');
var win = chrome.Window().make();
win.activeTab().url = activeUrl;
${createdWindowResultScript()}`;
}

function populateWindowScript(descriptor, handle) {
  const activeTabIndex = descriptor.payload.tabs[descriptor.payload.activeIdx].index;
  const tabs = [...descriptor.payload.tabs]
    .sort((left, right) => left.index - right.index)
    .map((tab) => ({ url: tab.url, pinned: tab.pinned, index: tab.index }));
  const input = {
    tabs,
    activeIdx: tabs.findIndex((tab) => tab.index === activeTabIndex),
    chromeWindowId: String(handle?.chromeWindowId || ''),
    chromeWindowIndex: Number.isSafeInteger(handle?.chromeWindowIndex) ? handle.chromeWindowIndex : 0,
  };
  return `${POPULATE_MARKER}
var input = ${scriptLiteral(input)};
var chrome = Application(${scriptLiteral(APP_NAME)});
if (!chrome.running()) throw new Error('COMPUSYNC_CHROME_NOT_RUNNING');
var windows = chrome.windows();
var win = null;
if (input.chromeWindowId) {
  for (var candidate = 0; candidate < windows.length; candidate += 1) {
    try { if (String(windows[candidate].id()) === input.chromeWindowId) { win = windows[candidate]; break; } } catch (_) {}
  }
}
if (!win && input.chromeWindowIndex > 0 && input.chromeWindowIndex <= windows.length) win = windows[input.chromeWindowIndex - 1];
if (!win) throw new Error('COMPUSYNC_CHROME_WINDOW_GONE');
var active = input.tabs[input.activeIdx];
var creationOrder = input.tabs.filter(function (_, index) { return index !== input.activeIdx; });
for (var i = 0; i < creationOrder.length; i += 1) {
  win.tabs.push(chrome.Tab({ url: creationOrder[i].url }));
  delay(0.1);
}
// AppleScript creates every new tab at the end. Canonicalize the URL at each
// position after opening the active URL first so the final order is exact.
var madeTabs = win.tabs();
for (var position = 0; position < input.tabs.length; position += 1) {
  if (String(madeTabs[position].url()) !== input.tabs[position].url) {
    madeTabs[position].url = input.tabs[position].url;
  }
  try { madeTabs[position].pinned = Boolean(input.tabs[position].pinned); } catch (_) {}
}
win.activeTabIndex = input.activeIdx + 1;
var until = Date.now() + 3000;
while (Date.now() < until) {
  var loading = false;
  try { loading = Boolean(win.activeTab().loading()); } catch (_) {}
  if (!loading) break;
  delay(0.05);
}
${createdWindowResultScript()}`;
}

function closeScript(handle) {
  const input = {
    chromeWindowId: String(handle?.chromeWindowId || ''),
    chromeWindowIndex: Number.isSafeInteger(handle?.chromeWindowIndex) ? handle.chromeWindowIndex : 0,
  };
  return `${CLOSE_MARKER}
var input = ${scriptLiteral(input)};
var chrome = Application(${scriptLiteral(APP_NAME)});
if (!chrome.running()) 'already-closed';
else {
  var windows = chrome.windows();
  var target = null;
  if (input.chromeWindowId) {
    for (var i = 0; i < windows.length; i += 1) {
      try { if (String(windows[i].id()) === input.chromeWindowId) { target = windows[i]; break; } } catch (_) {}
    }
  }
  if (!target && input.chromeWindowIndex > 0 && input.chromeWindowIndex <= windows.length) target = windows[input.chromeWindowIndex - 1];
  if (target) target.close();
  'closed';
}`;
}

function chromeNativeWindow(candidate) {
  const processName = String(candidate?.processName ?? candidate?.process_name ?? candidate?.bundleId ?? candidate?.bundle_id ?? '');
  return candidate?.visible !== false
    && /^(?:Google Chrome(?:\.app)?|com\.google\.Chrome)$/i.test(processName);
}

function boundsOf(value) {
  const bounds = value?.bounds || value;
  if (!bounds) return null;
  const width = Number(bounds.width ?? bounds.w);
  const height = Number(bounds.height ?? bounds.h);
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
    ? { x, y, width, height }
    : null;
}

function geometryOf(value) {
  if (!value) return null;
  const geometry = { x: Number(value.x), y: Number(value.y), w: Number(value.w ?? value.width), h: Number(value.h ?? value.height) };
  return Object.values(geometry).every(Number.isFinite) && geometry.w > 0 && geometry.h > 0 ? geometry : null;
}

function titleScore(nativeTitle, chromeTitle) {
  const left = String(nativeTitle || '').replace(/\s+-\s+Google Chrome\s*$/i, '').trim();
  const right = String(chromeTitle || '').trim();
  if (!left || !right) return 0;
  return left === right ? -10000 : (left.includes(right) || right.includes(left) ? -1000 : 0);
}

function windowScore(nativeWindow, chromeWindow) {
  const nativeBounds = boundsOf(nativeWindow);
  const appleBounds = Array.isArray(chromeWindow?.bounds) && chromeWindow.bounds.length === 4
    ? {
        x: Number(chromeWindow.bounds[0]),
        y: Number(chromeWindow.bounds[1]),
        width: Number(chromeWindow.bounds[2]) - Number(chromeWindow.bounds[0]),
        height: Number(chromeWindow.bounds[3]) - Number(chromeWindow.bounds[1]),
      }
    : boundsOf(chromeWindow?.bounds);
  let score = titleScore(nativeWindow?.title, chromeWindow?.title);
  if (nativeBounds && appleBounds && Object.values(appleBounds).every(Number.isFinite)) {
    score += Math.abs(nativeBounds.x - appleBounds.x) + Math.abs(nativeBounds.y - appleBounds.y)
      + Math.abs(nativeBounds.width - appleBounds.width) + Math.abs(nativeBounds.height - appleBounds.height);
  } else {
    score += 100000;
  }
  return score;
}

function nativeId(value) {
  return value?.nativeWindowId ?? value?.native_window_id ?? value?.nativeWindow?.id ?? value?.id ?? null;
}

function stableDescriptorId(value, explicit) {
  const candidate = explicit?.id || (typeof explicit === 'string' ? explicit : null)
    || value?.descriptorId || value?.descriptor?.id || (value?.schemaVersion === 1 ? value.id : null);
  return typeof candidate === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(candidate) ? candidate : null;
}

// Chrome's public Apple Events dictionary exposes only the current URL for a
// tab. It offers go-back/go-forward commands, but no navigation-entry list or
// current history index. Preserve history metadata received while preparing a
// window only while the same indexed tab remains on that exact current URL.
// This makes a Windows -> Mac -> Windows round trip lossless without enabling
// Chrome's disabled-by-default "JavaScript from Apple Events" preference, and
// deliberately drops stale metadata after the user navigates or rearranges.
function retainPreparedHistories(tabs, descriptor) {
  if (!Array.isArray(tabs) || !Array.isArray(descriptor?.payload?.tabs)) return tabs;
  const priorByIndex = new Map(descriptor.payload.tabs.map((tab) => [tab.index, tab]));
  return tabs.map((tab) => {
    const prior = priorByIndex.get(tab.index);
    if (!prior?.history || prior.url !== tab.url) return tab;
    return {
      ...tab,
      history: {
        currentIndex: prior.history.currentIndex,
        entries: [...prior.history.entries],
      },
    };
  });
}

function rememberPreparedDescriptor(records, id, descriptor, limit = MAX_PREPARED_DESCRIPTORS) {
  if (!(records instanceof Map) || typeof id !== 'string' || !descriptor) return;
  records.delete(id);
  records.set(id, descriptor);
  while (records.size > limit) records.delete(records.keys().next().value);
}

function normalizeExecResult(stdout, stderr) {
  if (stdout && typeof stdout === 'object' && !Buffer.isBuffer(stdout)) {
    return { stdout: String(stdout.stdout ?? ''), stderr: String(stdout.stderr ?? '') };
  }
  return { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
}

function invokeExecFile(execFile, args, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(normalizeExecResult(stdout, stderr));
    };
    let returned;
    try { returned = execFile('/usr/bin/osascript', args, options, finish); }
    catch (error) { finish(error); return; }
    if (returned && typeof returned.then === 'function') {
      returned.then((result) => {
        const normalized = normalizeExecResult(result);
        finish(null, normalized.stdout, normalized.stderr);
      }, finish);
    }
  });
}

function permissionFailure(error) {
  const detail = `${error?.message || ''} ${error?.stderr || ''}`;
  return /-1743|not authorized to send apple events|automation.*denied|errAEEventNotPermitted/i.test(detail);
}

function notRunningFailure(error) {
  const detail = `${error?.message || ''} ${error?.stderr || ''}`;
  return /COMPUSYNC_CHROME_NOT_RUNNING|-600|isn.?t running|application isn.?t running/i.test(detail);
}

function parseScriptJson(stdout, code) {
  const text = String(stdout || '').trim();
  try { return JSON.parse(text); }
  catch { throw new AppleChromeError(code, 'Google Chrome returned an unreadable Automation response. Try the handoff again.'); }
}

function createAppleChromeAdapter(options = {}) {
  const execFile = options.execFile || childProcess.execFile;
  const native = options.native || {};
  const machineId = options.machineId || 'local';
  const now = options.now || Date.now;
  const makeUuid = options.uuid || crypto.randomUUID;
  const requestAutomation = options.requestAutomation;
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let automationState = 'unrequested';
  let automationRequest;
  const descriptorIds = new Map();
  const preparedDescriptors = new Map();

  async function ensureAutomation() {
    if (automationState === 'denied') throw new AppleChromeError('CHROME_AUTOMATION_DENIED', AUTOMATION_HELP);
    if (automationState === 'requested') return;
    if (!automationRequest) {
      automationRequest = (async () => {
        if (typeof requestAutomation === 'function') {
          let accepted;
          try { accepted = await requestAutomation({ appName: APP_NAME, reason: 'window-handoff' }); }
          catch { accepted = false; }
          if (accepted === false) {
            automationState = 'denied';
            throw new AppleChromeError('CHROME_AUTOMATION_DENIED', AUTOMATION_HELP);
          }
        }
        automationState = 'requested';
      })();
    }
    return automationRequest;
  }

  async function runJxa(script, failureCode) {
    await ensureAutomation();
    try {
      const result = await invokeExecFile(execFile, ['-l', 'JavaScript', '-e', script], {
        encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 10000,
      });
      return result.stdout;
    } catch (error) {
      if (permissionFailure(error)) {
        automationState = 'denied';
        throw new AppleChromeError('CHROME_AUTOMATION_DENIED', AUTOMATION_HELP);
      }
      if (notRunningFailure(error)) {
        throw new AppleChromeError('CHROME_NOT_RUNNING', 'Google Chrome closed before the window handoff. Reopen Chrome and try again.');
      }
      throw new AppleChromeError(failureCode, 'macOS could not control the selected Google Chrome window. Try the handoff again.');
    }
  }

  async function nativeWindows() {
    if (typeof native.enumerateWindows !== 'function') return [];
    let windows;
    try { windows = await native.enumerateWindows(); }
    catch { return []; }
    return Array.isArray(windows) ? windows.filter(chromeNativeWindow) : [];
  }

  async function detect() {
    // Deliberately native-only: detection is safe to call at startup and cannot
    // launch Chrome or cause an Automation prompt.
    return nativeWindows();
  }

  async function capture(nativeWindow, geometryVU, stableInput) {
    const geometry = geometryOf(geometryVU);
    if (!geometry) throw new AppleChromeError('CHROME_INVALID_GEOMETRY', 'The Chrome window has invalid geometry and cannot be handed off.');

    const stdout = await runJxa(captureScript(), 'CHROME_CAPTURE_FAILED');
    const addressable = parseScriptJson(stdout, 'CHROME_CAPTURE_FAILED');
    if (!Array.isArray(addressable) || !addressable.length) {
      throw new AppleChromeError('CHROME_WINDOW_NOT_ADDRESSABLE', 'The selected Chrome window is not available to macOS Automation.');
    }

    let selected = null;
    const wantedChromeId = String(nativeWindow?.chromeWindowId || '');
    if (wantedChromeId) selected = addressable.find((candidate) => String(candidate.chromeWindowId) === wantedChromeId) || null;
    if (!selected && Number.isSafeInteger(nativeWindow?.chromeWindowIndex)) {
      selected = addressable.find((candidate) => candidate.chromeWindowIndex === nativeWindow.chromeWindowIndex) || null;
    }
    if (!selected) selected = addressable.reduce((best, candidate) => (
      !best || windowScore(nativeWindow, candidate) < windowScore(nativeWindow, best) ? candidate : best
    ), null);

    const originalTabs = Array.isArray(selected?.tabs) ? selected.tabs : [];
    const activeOriginalIndex = Number.isSafeInteger(selected?.activeIdx) ? selected.activeIdx : 0;
    const tabs = originalTabs
      .filter((tab) => !/^(?:devtools|chrome-extension):\/\//i.test(String(tab?.url || '')))
      .map((tab, index) => ({
        url: String(tab?.url || ''),
        title: String(tab?.title || '').slice(0, 1024),
        pinned: Boolean(tab?.pinned),
        index,
        originalIndex: Number.isSafeInteger(tab?.index) ? tab.index : index,
      }));
    const activeIdx = tabs.findIndex((tab) => tab.originalIndex === activeOriginalIndex);
    if (!tabs.length || activeIdx < 0 || tabs.some((tab) => !validUrl(tab.url))) {
      throw new AppleChromeError('CHROME_UNSUPPORTED_TABS', 'This Chrome window contains a tab that Compusync cannot safely hand off. Open an HTTP or HTTPS page in that tab and try again.');
    }
    for (const tab of tabs) delete tab.originalIndex;

    const id = stableDescriptorId(nativeWindow, stableInput)
      || descriptorIds.get(String(nativeId(nativeWindow)))
      || makeUuid();
    const descriptor = {
      schemaVersion: 1,
      id,
      adapterId: 'chrome',
      origin: machineId,
      capturedAt: now(),
      geometryVU: geometry,
      // The wire schema has no separate fullscreen state; both states use the
      // required non-straddling/instant-commit path.
      state: nativeWindow?.maximized || nativeWindow?.fullscreen ? 'maximized' : 'normal',
      payload: { activeIdx, tabs: retainPreparedHistories(tabs, preparedDescriptors.get(id)) },
    };
    rememberPreparedDescriptor(preparedDescriptors, id, descriptor);
    return descriptor;
  }

  async function findPreparedNativeWindow(beforeIds, appleResult) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const windows = await nativeWindows();
      const matched = windows.reduce((best, candidate) => (
        !best || windowScore(candidate, appleResult) < windowScore(best, appleResult) ? candidate : best
      ), null);
      if (matched && windowScore(matched, appleResult) < 100) return matched;
      // AX window IDs contain the app's current window-array index. Opening a
      // frontmost Chrome window can therefore renumber every old ID, so a new
      // ID alone is weaker evidence than the bounds/title join above.
      const fresh = windows.find((candidate) => !beforeIds.has(String(candidate.id)));
      if (fresh) return fresh;
      if (attempt < 7) await sleep(25);
    }
    return null;
  }

  async function setNativeBounds(id, bounds) {
    const normalized = boundsOf(bounds);
    const setter = native.setWindowBoundsNormalized || native.setWindowBounds;
    if (!id || !normalized || typeof setter !== 'function') {
      throw new AppleChromeError('CHROME_NATIVE_WINDOW_UNAVAILABLE', 'Compusync could not position the Chrome handoff window. Check Accessibility permission and try again.');
    }
    try { await setter.call(native, id, normalized); }
    catch { throw new AppleChromeError('CHROME_NATIVE_POSITION_FAILED', 'Compusync could not position the Chrome handoff window. Check Accessibility permission and try again.'); }
    return normalized;
  }

  async function prepare(inputDescriptor, offscreenBoundsPx, options = {}) {
    const descriptor = sanitizeWindowDescriptor(inputDescriptor);
    if (!descriptor) throw new AppleChromeError('CHROME_INVALID_DESCRIPTOR', 'The Chrome window handoff data is invalid.');
    const bounds = boundsOf(offscreenBoundsPx);
    if (!bounds) throw new AppleChromeError('CHROME_INVALID_GEOMETRY', 'The offscreen Chrome window geometry is invalid.');
    const beforeIds = new Set((await nativeWindows()).map((window) => String(window.id)));
    // Return after opening only the active URL so the native adapter can hide
    // the real window before background tabs are created (the spec's ordering
    // is visible here and avoids flashing a populated window on the desktop).
    const stdout = await runJxa(createWindowScript(descriptor), 'CHROME_PREPARE_FAILED');
    const appleResult = parseScriptJson(stdout, 'CHROME_PREPARE_FAILED');
    const preparedWindow = await findPreparedNativeWindow(beforeIds, appleResult);
    if (!preparedWindow) {
      // The Chrome window exists, but proceeding without a native handle could
      // expose it on-screen or later close the wrong window.
      try { await runJxa(closeScript(appleResult), 'CHROME_CLOSE_FAILED'); } catch { /* Best-effort cleanup. */ }
      throw new AppleChromeError('CHROME_NATIVE_WINDOW_UNAVAILABLE', 'Compusync created the Chrome window but could not address it through Accessibility. Check Accessibility permission and try again.');
    }
    await setNativeBounds(preparedWindow.id, bounds);
    const handle = {
      id: descriptor.id,
      descriptorId: descriptor.id,
      nativeWindowId: preparedWindow.id,
      chromeWindowId: String(appleResult?.chromeWindowId || ''),
      chromeWindowIndex: Number.isSafeInteger(appleResult?.chromeWindowIndex) ? appleResult.chromeWindowIndex : 1,
    };
    try {
      if (typeof options.onPrepared === 'function') {
        const accepted = await options.onPrepared(handle);
        if (accepted === false) {
          throw new AppleChromeError('CHROME_PREPARE_CANCELLED', 'The Chrome handoff was cancelled while preparing.');
        }
      }
      await runJxa(populateWindowScript(descriptor, handle), 'CHROME_PREPARE_FAILED');
    } catch (error) {
      try { await runJxa(closeScript(handle), 'CHROME_CLOSE_FAILED'); } catch { /* Best-effort cleanup. */ }
      throw error;
    }
    descriptorIds.set(String(preparedWindow.id), descriptor.id);
    rememberPreparedDescriptor(preparedDescriptors, descriptor.id, descriptor);
    return handle;
  }

  async function position(handle, boundsPx) {
    await setNativeBounds(nativeId(handle), boundsPx);
  }

  async function focus(handle) {
    const id = nativeId(handle);
    if (!id || typeof native.focusWindow !== 'function') {
      throw new AppleChromeError('CHROME_NATIVE_WINDOW_UNAVAILABLE', 'Compusync cannot focus the Chrome handoff window. Check Accessibility permission and try again.');
    }
    try { await native.focusWindow(id); }
    catch { throw new AppleChromeError('CHROME_NATIVE_FOCUS_FAILED', 'Compusync could not focus the Chrome handoff window. Check Accessibility permission and try again.'); }
  }

  async function close(handle) {
    // Chrome's Automation identity is more stable than the AX array index and
    // lets Chrome dispose of the whole window (including every prepared tab).
    const descriptorId = stableDescriptorId(handle);
    if (handle?.chromeWindowId || handle?.chromeWindowIndex) {
      try { await runJxa(closeScript(handle), 'CHROME_CLOSE_FAILED'); }
      finally {
        descriptorIds.delete(String(nativeId(handle)));
        if (descriptorId) preparedDescriptors.delete(descriptorId);
      }
      return;
    }
    const id = nativeId(handle);
    if (!id || typeof native.closeWindow !== 'function') {
      throw new AppleChromeError('CHROME_NATIVE_WINDOW_UNAVAILABLE', 'Compusync cannot close the Chrome handoff window.');
    }
    try {
      await native.closeWindow(id);
      descriptorIds.delete(String(id));
      if (descriptorId) preparedDescriptors.delete(descriptorId);
    }
    catch { throw new AppleChromeError('CHROME_CLOSE_FAILED', 'Compusync could not close the Chrome handoff window.'); }
  }

  return Object.freeze({
    adapterId: 'chrome',
    detect,
    capture,
    prepare,
    position,
    focus,
    close,
  });
}

module.exports = {
  APP_NAME,
  MAX_PREPARED_DESCRIPTORS,
  AppleChromeError,
  rememberPreparedDescriptor,
  retainPreparedHistories,
  createAppleChromeAdapter,
};
