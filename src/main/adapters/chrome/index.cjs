'use strict';

const { sanitizeWindowDescriptor } = require('../../messages.cjs');
const {
  ChromeCapture,
  DescriptorIdentityCache,
  isNativeChromeWindow,
  nativeWindowId,
} = require('./capture.cjs');
const {
  ChromePrepare,
  ChromePrepareError,
  boundsFromVU,
  chromeBounds,
  normalizePixelBounds,
  prepareBounds,
} = require('./prepare.cjs');

function localRecord(records, value) {
  const id = nativeWindowId(value);
  return id == null ? null : records.get(String(id)) || null;
}

function endpointFromOptions(options) {
  return options.endpoint || options.detection?.endpoint || null;
}

function cdpFromOptions(options, platform) {
  if (options.cdp) return options.cdp;
  const endpoint = endpointFromOptions(options);
  if (platform === 'darwin' || !endpoint) return null;
  const { ChromeCdp } = require('./cdp.cjs');
  return new ChromeCdp({
    port: endpoint.port,
    webSocketDebuggerUrl: endpoint.webSocketDebuggerUrl,
    fetch: options.fetch,
    WebSocket: options.WebSocket,
    timeoutMs: options.cdpTimeoutMs || options.timeoutMs,
  });
}

function tabControlFromOptions(options, platform, cdp) {
  if (options.tabControl) return options.tabControl;
  if (platform !== 'win32' || !cdp || typeof cdp.withExtensionServiceWorker !== 'function') return null;
  const { ChromeExtensionTabControl } = require('./extension-tab-control.cjs');
  const { defaultExtensionDirectory } = require('./windows.cjs');
  return new ChromeExtensionTabControl({
    cdp, extensionDirectory: options.extensionDirectory || defaultExtensionDirectory(),
    timeoutMs: options.cdpTimeoutMs || options.timeoutMs,
  });
}

class ChromeHandoffAdapter {
  constructor(options = {}) {
    this.adapterId = 'chrome';
    this.platform = options.platform || process.platform;
    this.native = options.native || {};
    // Runtime may either retain a connected client or pass the endpoint from
    // detectChrome(). No probing or Chrome launch occurs at construction.
    this.cdp = cdpFromOptions(options, this.platform);
    this.tabControl = tabControlFromOptions(options, this.platform, this.cdp);
    this.placement = options.placement || null;
    this.getPlacement = typeof options.getPlacement === 'function' ? options.getPlacement : () => this.placement;
    this.identities = options.identities || new DescriptorIdentityCache(options);
    this.records = options.records || new Map();
    this.apple = options.appleAdapter || null;
    if (this.platform === 'darwin' && !this.apple) {
      const { createAppleChromeAdapter } = require('./apple.cjs');
      this.apple = createAppleChromeAdapter({ ...options, native: this.native });
    }
    if (this.platform !== 'darwin' && this.cdp) {
      const shared = { ...options, cdp: this.cdp, tabControl: this.tabControl, native: this.native, identities: this.identities, records: this.records };
      this.capturer = new ChromeCapture(shared);
      this.preparer = new ChromePrepare(shared);
    }
  }

  isAddressable(window) {
    if (!isNativeChromeWindow(window)) return false;
    if (this.platform === 'darwin') return Boolean(this.apple);
    return Boolean(this.cdp);
  }

  async capture(window, geometryVU) {
    if (!this.isAddressable(window)) {
      const error = new Error('The selected window is not an addressable Google Chrome window.');
      error.code = 'CHROME_WINDOW_NOT_ADDRESSABLE';
      throw error;
    }
    if (this.platform === 'darwin') {
      const id = this.identities.idFor(window);
      const descriptor = await this.apple.capture(window, geometryVU, { id });
      this.identities.remember(window, descriptor.id);
      const nativeId = nativeWindowId(window);
      if (nativeId != null) this.records.set(String(nativeId), { descriptor });
      return descriptor;
    }
    return this.capturer.capture(window, geometryVU);
  }

  async prepare(inputDescriptor, options = {}) {
    const descriptor = sanitizeWindowDescriptor(inputDescriptor);
    if (!descriptor) throw new ChromePrepareError('CHROME_INVALID_DESCRIPTOR', 'The Chrome handoff descriptor is invalid.');
    const placement = options.targetPlacement || this.getPlacement();
    if (this.platform === 'darwin') {
      const bounds = prepareBounds(descriptor, options, placement);
      const decorate = (appleHandle) => ({
        ...appleHandle,
        descriptorId: descriptor.id,
        geometryVU: descriptor.geometryVU,
        state: descriptor.state,
        instantCommit: descriptor.state === 'maximized',
        placement: placement || null,
      });
      const remember = (handle) => {
        this.identities.remember(handle, descriptor.id);
        const nativeId = nativeWindowId(handle);
        if (nativeId != null) this.records.set(String(nativeId), { descriptor, ...handle });
        return handle;
      };
      const appleHandle = await this.apple.prepare(descriptor, bounds, {
        onPrepared: typeof options.onPrepared === 'function'
          ? (earlyAppleHandle) => options.onPrepared(decorate(earlyAppleHandle))
          : undefined,
      });
      const handle = remember(decorate(appleHandle));
      return handle;
    }
    if (!this.preparer) throw new ChromePrepareError('CHROME_UNAVAILABLE', 'Chrome local debugging is unavailable.');
    return this.preparer.prepare(descriptor, { ...options, targetPlacement: placement });
  }

  boundsFor(value, position) {
    const record = localRecord(this.records, value);
    const geometry = value?.geometryVU || record?.geometryVU || record?.descriptor?.geometryVU;
    const placement = value?.placement || record?.placement || this.getPlacement();
    if (geometry && placement && Number.isFinite(position?.x) && Number.isFinite(position?.y)) {
      return boundsFromVU(position, geometry, placement);
    }
    const direct = normalizePixelBounds(position);
    if (direct) return direct;
    if (geometry && Number.isFinite(position?.x) && Number.isFinite(position?.y)) {
      return { x: Math.round(position.x), y: Math.round(position.y), width: Math.round(geometry.w), height: Math.round(geometry.h) };
    }
    throw new ChromePrepareError('CHROME_INVALID_GEOMETRY', 'The Chrome handoff position is invalid.');
  }

  async position(handle, originVU) {
    const bounds = this.boundsFor(handle, originVU);
    if (this.platform === 'darwin') return this.apple.position(handle, bounds);
    const record = localRecord(this.records, handle);
    const windowId = handle?.windowId ?? record?.windowId;
    if (Number.isInteger(windowId)) {
      const platformBounds = chromeBounds(this.native, bounds);
      return this.cdp.setWindowBounds(windowId, platformBounds);
    }
    const id = nativeWindowId(handle);
    if (id != null && typeof this.native.setWindowBoundsNormalized === 'function') {
      return this.native.setWindowBoundsNormalized(id, bounds);
    }
    if (id != null && typeof this.native.setWindowBounds === 'function') return this.native.setWindowBounds(id, bounds);
    throw new ChromePrepareError('CHROME_NATIVE_WINDOW_UNAVAILABLE', 'The Chrome handoff window cannot be positioned.');
  }

  async focus(handle) {
    if (this.platform === 'darwin') return this.apple.focus(handle);
    const record = localRecord(this.records, handle);
    const targetId = handle?.activeTargetId ?? handle?.targetId ?? record?.activeTargetId;
    if (targetId) return this.cdp.focusTarget(targetId, { id: nativeWindowId(handle) }, this.native);
    const id = nativeWindowId(handle);
    if (id != null && typeof this.native.focusWindow === 'function') return this.native.focusWindow(id);
    throw new ChromePrepareError('CHROME_NATIVE_WINDOW_UNAVAILABLE', 'The Chrome handoff window cannot be focused.');
  }

  async close(handle) {
    const id = nativeWindowId(handle);
    try {
      if (this.platform === 'darwin') return await this.apple.close(handle);
      const record = localRecord(this.records, handle);
      const targetIds = handle?.targetIds || record?.targetIds || [];
      let cdpFailure = null;
      if (targetIds.length) {
        const active = handle?.activeTargetId ?? handle?.targetId ?? record?.activeTargetId;
        const closeOrder = targetIds.filter((targetId) => targetId !== active).reverse();
        if (active && targetIds.includes(active)) closeOrder.push(active);
        try {
          for (const targetId of closeOrder) {
            if (await this.cdp.closeTarget(targetId) === false) {
              throw new Error(`Chrome refused to close target ${targetId}.`);
            }
          }
          return;
        } catch (error) {
          cdpFailure = error;
          // If Chrome vanishes partway through, closing its surviving native
          // top-level window prevents a partial prepared copy from remaining.
        }
      }
      if (id != null && typeof this.native.closeWindow === 'function') {
        try { return await this.native.closeWindow(id); }
        catch (error) {
          const failure = new Error('Compusync could not close the Chrome handoff window.');
          failure.code = 'CHROME_CLOSE_FAILED';
          failure.cause = cdpFailure || error;
          throw failure;
        }
      }
      const failure = new Error('Compusync could not close the Chrome handoff window.');
      failure.code = 'CHROME_CLOSE_FAILED';
      failure.cause = cdpFailure;
      throw failure;
    } finally {
      this.identities.forget(handle);
      if (id != null) this.records.delete(String(id));
    }
  }
}

function createChromeHandoffAdapter(options) {
  return new ChromeHandoffAdapter(options);
}

module.exports = {
  ChromeHandoffAdapter,
  ChromeAdapter: ChromeHandoffAdapter,
  createChromeHandoffAdapter,
  createChromeAdapter: createChromeHandoffAdapter,
  cdpFromOptions,
  endpointFromOptions,
  isNativeChromeWindow,
  tabControlFromOptions,
};
