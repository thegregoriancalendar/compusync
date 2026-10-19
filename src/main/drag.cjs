'use strict';

const { EventEmitter } = require('node:events');
const { nativeWindowId } = require('./adapters/chrome/capture.cjs');
const { destinationGeometry, seamAnchors } = require('./window-geometry.cjs');

const ARM_DISTANCE_VU = 200;
const MIN_WINDOW = Object.freeze({ w: 200, h: 150 });
const PREPARE_WAIT_MS = 2000;
const REVERSE_KEEPALIVE_MS = 3000;
const LATE_ID_LIMIT = 100;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const point = (value) => value && finite(value.x) && finite(value.y);

function intersectionArea(rect, placement) {
  const left = Math.max(rect.x, placement.origin.x);
  const top = Math.max(rect.y, placement.origin.y);
  const right = Math.min(rect.x + rect.w, placement.origin.x + placement.size.w);
  const bottom = Math.min(rect.y + rect.h, placement.origin.y + placement.size.h);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function crossedFraction(rect, targetPlacement) {
  const area = rect.w * rect.h;
  return area > 0 ? intersectionArea(rect, targetPlacement) / area : 0;
}

function renderedGeometry(rect, source, target, referenceRect = rect) {
  const physical = destinationGeometry(rect, source, target, referenceRect);
  const anchors = seamAnchors(source, target, referenceRect);
  const screen = anchors.targetDisplay || { w: target.size.w, h: target.size.h };
  // Preserve measured physical size whenever it fits. A window larger than
  // the receiving monitor has to shrink; leave a margin instead of filling it.
  const fit = Math.min(1, screen.w * 0.9 / physical.w, screen.h * 0.9 / physical.h);
  return { x: anchors.target.x + (physical.x - anchors.target.x) * fit,
    y: anchors.target.y + (physical.y - anchors.target.y) * fit,
    w: physical.w * fit, h: physical.h * fit };
}

function cursorDeltaInSource(previous, current, target, scale) {
  const delta = { x: current.x - previous.x, y: current.y - previous.y };
  let enter = 0, leave = 1;
  for (const axis of ['x', 'y']) {
    const minimum = target.origin[axis], maximum = minimum + target.size[axis === 'x' ? 'w' : 'h'];
    if (delta[axis] === 0) {
      if (previous[axis] < minimum || previous[axis] > maximum) { leave = 0; break; }
    } else {
      const first = (minimum - previous[axis]) / delta[axis], second = (maximum - previous[axis]) / delta[axis];
      enter = Math.max(enter, Math.min(first, second));
      leave = Math.min(leave, Math.max(first, second));
    }
  }
  const inTarget = Math.max(0, leave - enter);
  const gain = 1 + inTarget * (1 / scale - 1);
  return { x: delta.x * gain, y: delta.y * gain };
}

function dropWinner(rect, source, target) {
  const sourceArea = intersectionArea(rect, source);
  const targetArea = intersectionArea(renderedGeometry(rect, source, target), target);
  if (sourceArea > 0 && targetArea > 0) return null;
  return targetArea > 0 ? 'destination' : 'source';
}

function fitToPlacement(rect, placement) {
  const scale = Math.min(1, placement.size.w / rect.w, placement.size.h / rect.h);
  return { ...rect, w: rect.w * scale, h: rect.h * scale };
}

function clampOriginToPlacement(rect, placement) {
  return {
    x: Math.max(placement.origin.x, Math.min(placement.origin.x + Math.max(0, placement.size.w - rect.w), rect.x)),
    y: Math.max(placement.origin.y, Math.min(placement.origin.y + Math.max(0, placement.size.h - rect.h), rect.y)),
  };
}

// Wait just outside the destination on the seam side. The first authoritative
// position then moves the prepared native window in from the correct direction.
function offscreenOrigin(rect, source, target) {
  if (target.origin.x >= source.origin.x + source.size.w) return { x: target.origin.x - rect.w - 1, y: rect.y };
  if (target.origin.x + target.size.w <= source.origin.x) return { x: target.origin.x + target.size.w + 1, y: rect.y };
  if (target.origin.y + target.size.h <= source.origin.y) return { x: rect.x, y: target.origin.y + target.size.h + 1 };
  return { x: rect.x, y: target.origin.y - rect.h - 1 };
}

function targetForSource(source, placements) {
  if (!source) return null;
  const peers = placements.filter((placement) => placement.machineId !== source.machineId);
  if (!peers.length) return null;
  const edgeDistance = (target) => Math.min(
    Math.abs(target.origin.x - source.origin.x - source.size.w),
    Math.abs(source.origin.x - target.origin.x - target.size.w),
    Math.abs(target.origin.y - source.origin.y - source.size.h),
    Math.abs(source.origin.y - target.origin.y - target.size.h),
  );
  return peers.sort((a, b) => edgeDistance(a) - edgeDistance(b))[0];
}

function motionTowardEdge(previous, current, source, target) {
  if (!previous) return false;
  if (target.origin.x >= source.origin.x + source.size.w) return current.x > previous.x;
  if (target.origin.x + target.size.w <= source.origin.x) return current.x < previous.x;
  if (target.origin.y >= source.origin.y + source.size.h) return current.y > previous.y;
  return current.y < previous.y;
}

function originDistanceToEdge(rect, source, target) {
  if (target.origin.x >= source.origin.x + source.size.w) {
    return Math.max(0, source.origin.x + source.size.w - (rect.x + rect.w));
  }
  if (target.origin.x + target.size.w <= source.origin.x) {
    return Math.max(0, rect.x - source.origin.x);
  }
  if (target.origin.y >= source.origin.y + source.size.h) {
    return Math.max(0, source.origin.y + source.size.h - (rect.y + rect.h));
  }
  return Math.max(0, rect.y - source.origin.y);
}

function excludedState(value) {
  const state = String(value?.state || value?.windowState || '').toLowerCase();
  return state === 'maximized' || state === 'fullscreen' || value?.maximized === true || value?.fullscreen === true;
}

class DragController extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.machineId) throw new TypeError('machineId is required.');
    this.machineId = options.machineId;
    this.send = typeof options.send === 'function' ? options.send : () => false;
    this.adapterForWindow = typeof options.adapterForWindow === 'function' ? options.adapterForWindow : () => null;
    this.adapterForId = typeof options.adapterForId === 'function' ? options.adapterForId : () => null;
    this.getPlacements = typeof options.getPlacements === 'function' ? options.getPlacements : () => [];
    this.setDragging = typeof options.setDragging === 'function' ? options.setDragging : () => {};
    this.setBusy = typeof options.setBusy === 'function' ? options.setBusy : () => {};
    this.refreshSource = typeof options.refreshSource === 'function' ? options.refreshSource : null;
    this.beginManagedMove = typeof options.beginManagedMove === 'function' ? options.beginManagedMove : null;
    this.logger = options.logger || null;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
    this.clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
    this.waitMs = Number.isFinite(options.waitMs) ? options.waitMs : PREPARE_WAIT_MS;
    this.reverseKeepaliveMs = Number.isFinite(options.reverseKeepaliveMs) ? options.reverseKeepaliveMs : REVERSE_KEEPALIVE_MS;
    this.active = null;
    this.parked = new Map();
    this.nonCrossingHintShown = false;
    this.lateReadyIds = new Set();
  }

  begin({ window, geometryVU, cursorVU }) {
    if (this.active || !window || !this.#validGeometry(geometryVU) || !point(cursorVU)) return false;
    const placements = this.getPlacements();
    const source = placements.find((placement) => placement.machineId === this.machineId);
    const target = targetForSource(source, placements);
    if (!source || !target) return false;
    const parked = this.parkedForWindow(window);
    if (parked) this.parked.delete(parked.descriptor.id);
    this.active = {
      role: 'source', phase: 'tracking', window, adapter: this.adapterForWindow(window), source, target,
      startedAt: this.now(), startGeometry: { ...geometryVU }, geometry: { ...geometryVU }, previous: { ...geometryVU },
      cursorVU: { ...cursorVU }, grabOffsetVU: { x: cursorVU.x - geometryVU.x, y: cursorVU.y - geometryVU.y },
      descriptor: null, ready: false, aborted: false, winner: null, committed: false,
      straddleStarted: false, instant: excludedState(window), positionSequence: 0,
      resumeDescriptor: parked?.descriptor || null, dropped: false,
    };
    this.setDragging(true, { role: 'source' });
    this.#lifecycle(this.active, 'started');
    this.emit('start', this.snapshot());
    return true;
  }

  async frame({ geometryVU, cursorVU } = {}) {
    const state = this.active;
    if (!state || state.role !== 'source' || !point(cursorVU) || state.dropped) return false;
    const previous = state.geometry;
    const previousCursor = state.cursorVU;
    state.previous = { ...previous };
    state.cursorVU = { ...cursorVU };
    state.geometry = {
      x: cursorVU.x - state.grabOffsetVU.x, y: cursorVU.y - state.grabOffsetVU.y,
      w: this.#validGeometry(geometryVU) ? geometryVU.w : state.geometry.w,
      h: this.#validGeometry(geometryVU) ? geometryVU.h : state.geometry.h,
    };
    if (state.descriptor && !state.instant) {
      // Cursor ownership uses each desktop's native logical coordinates.
      // Convert deltas on the peer back to the original window's units so
      // the smaller physical rendering stays attached to the local pointer.
      const rendered = renderedGeometry(state.descriptor.geometryVU, state.source, state.target, state.descriptor.geometryVU);
      const delta = cursorDeltaInSource(previousCursor, cursorVU, state.target, rendered.w / state.descriptor.geometryVU.w);
      state.geometry.x = previous.x + delta.x;
      state.geometry.y = previous.y + delta.y;
    }

    if (state.phase === 'tracking') {
      if (!state.adapter || state.geometry.w < MIN_WINDOW.w || state.geometry.h < MIN_WINDOW.h) {
        if (!this.nonCrossingHintShown && originDistanceToEdge(state.geometry, state.source, state.target) <= ARM_DISTANCE_VU) {
          this.nonCrossingHintShown = true;
          this.emit('hint', { type: 'non-crossing-window' });
        }
        return true;
      }
      if (!state.resumeDescriptor && (originDistanceToEdge(state.geometry, state.source, state.target) > ARM_DISTANCE_VU
        || !motionTowardEdge(previous, state.geometry, state.source, state.target))) return true;
      await this.#arm(state);
    }

    if (this.active !== state || state.instant || !state.descriptor || ['committing', 'dropping'].includes(state.phase)) return true;
    return this.#positionSource(state);
  }

  async end() {
    const state = this.active;
    if (!state || state.role !== 'source' || state.dropped || state.winner) return false;
    if (!state.descriptor) { this.#clear(); return true; }
    state.dropped = true;
    const targetRect = renderedGeometry(state.geometry, state.source, state.target, state.descriptor.geometryVU);
    const sourceVisible = intersectionArea(state.geometry, state.source) > 0;
    const targetVisible = intersectionArea(targetRect, state.target) > 0;
    state.winner = state.instant ? 'destination' : sourceVisible && targetVisible ? null : targetVisible ? 'destination' : 'source';
    this.#setPhase(state, 'dropping', 'mouse-up', { winner: state.winner });
    if (state.winner !== 'source' && typeof state.adapter.captureState === 'function') await this.#refreshPageState(state);
    if (this.active !== state || state.aborted) return false;
    if (!state.winner) {
      if (!this.send({ type: 'window.pause', id: state.descriptor.id,
        originVU: { x: state.geometry.x, y: state.geometry.y } })) return this.abort('pause-send-failed');
      this.#park(state);
      return true;
    }
    if (state.winner === 'source') {
      try {
        await state.adapter.position(state.window, clampOriginToPlacement(state.geometry, state.source));
        await state.adapter.focus?.(state.window);
      } catch (error) { return this.abort(this.#reason(error, 'source-settle-failed')); }
    } else if (!state.ready) {
      this.setBusy(true);
      this.#lifecycle(state, 'prepare-wait-started', { waitMs: this.waitMs });
      const result = await this.#waitForReady(state);
      this.setBusy(false);
      if (this.active !== state || state.aborted) return false;
      this.#timing(state, 'prepare-wait', state.waitStartedAt, { status: result });
      if (!state.ready) return this.abort('prepare-timeout');
      if (state.phase === 'committing') return true;
    }
    return this.#sendCommit(state);
  }

  // Once the source native window is gone, aborting would destroy the only
  // surviving copy. A reliable destination-winning commit is ordered after
  // the offer and may be queued by the peer while preparation is still in
  // flight, so it is also safe when Chrome exits before window.ready.
  async sourceDisappeared(reason = 'source-quit') {
    const state = this.active;
    if (!state || state.role !== 'source') return false;
    if (!state.descriptor) return this.abort(reason);
    if (state.phase === 'committing' && state.winner === 'destination') return true;
    state.sourceMissing = true;
    state.winner = 'destination';
    this.setBusy(false);
    this.#setPhase(state, 'dropping', 'source-disappeared', { reason, winner: state.winner });
    return this.#sendCommit(state);
  }

  async receive(message) {
    if (!message || typeof message.type !== 'string') return false;
    if (message.type === 'window.offer') return this.#receiveOffer(message.descriptor);
    if (message.type === 'window.ready' && this.parked.has(message.id)) return true;
    if (message.type === 'window.abort' && this.parked.has(message.id)) {
      await this.#restoreParked(this.parked.get(message.id));
      this.parked.delete(message.id);
      return true;
    }
    const state = this.active;
    if ((!state || state.descriptor?.id !== message.id) && message.type === 'window.ready' && this.lateReadyIds.delete(message.id)) {
      this.send({ type: 'window.abort', id: message.id, reason: 'late-ready' });
      this.emit('lifecycle', { type: 'drag.lifecycle', event: 'late-ready-discarded', id: message.id,
        role: 'source', phase: 'aborted', at: this.now(), elapsedMs: 0 });
      return true;
    }
    if (!state || state.descriptor?.id !== message.id) return false;

    if (message.type === 'window.state' && state.role === 'destination') {
      state.pendingPayload = message.payload;
      if (state.ready) await this.#applyPageState(state);
      return true;
    }

    if (message.type === 'window.ready' && state.role === 'source') {
      if (state.aborted) { this.send({ type: 'window.abort', id: message.id, reason: 'late-ready' }); return false; }
      state.ready = true;
      state.resolveReady?.('ready');
      state.resolveReady = null;
      this.#timing(state, 'prepare', state.offerSentAt, { status: 'ready' });
      this.#lifecycle(state, 'ready');
      this.emit('ready', this.snapshot());
      if (state.instant) return this.#sendCommit(state);
      if (state.winner === 'source' || state.phase === 'committing') return true;
      this.#setPhase(state, 'straddling', 'straddle-ready');
      this.send({ type: 'window.position', id: message.id, sequence: ++state.positionSequence,
        originVU: { x: state.geometry.x, y: state.geometry.y } });
      return true;
    }
    if (message.type === 'window.position' && state.role === 'destination') {
      return this.#receivePosition(message.originVU, message.sequence);
    }
    if (message.type === 'window.pause' && state.role === 'destination' && point(message.originVU)) {
      if (!state.ready) {
        this.setDragging(false);
        state.pendingPause = { ...message.originVU };
        state.originVU = { ...message.originVU };
        state.positionReceived = true;
        if (state.reverseTimer) { this.clearTimer(state.reverseTimer); state.reverseTimer = null; }
        if (state.handle) await this.#queueDestinationPosition(state);
        return true;
      }
      return this.#receivePause(message.originVU);
    }
    if (message.type === 'window.commit' && state.role === 'destination') {
      if (!['source', 'destination'].includes(message.winner)) return false;
      if (point(message.originVU)) state.originVU = { ...message.originVU };
      if (!state.ready) {
        state.pendingWinner = message.winner;
        this.#lifecycle(state, 'commit-queued', { winner: message.winner });
        return true;
      }
      return this.#receiveCommit(message.winner);
    }
    if (message.type === 'window.committed' && state.role === 'source') {
      if (state.winner === 'destination' && !state.sourceMissing) {
        try { await state.adapter.close(state.window); }
        catch (error) { this.#lifecycle(state, 'loser-close-failed', { reason: this.#reason(error, 'close-failed') }); }
      }
      state.committed = true;
      this.#setPhase(state, 'committed', 'settled', { winner: state.winner });
      this.emit('committed', this.snapshot());
      this.#clear();
      return true;
    }
    if (message.type === 'window.abort') return this.abort(message.reason || 'peer-abort', false);
    return false;
  }

  async abort(reason = 'abort', notify = true) {
    const state = this.active;
    if (!state) return false;
    state.aborted = true;
    this.setBusy(false);
    state.resolveReady?.('aborted');
    state.resolveReady = null;
    if (state.reverseTimer) this.clearTimer(state.reverseTimer);
    if (state.role === 'source' && state.descriptor && !state.ready) this.#rememberLateReady(state.descriptor.id);
    const offered = state.descriptor || state.resumeDescriptor;
    if (notify && offered) this.send({ type: 'window.abort', id: offered.id, reason });
    try {
      if (state.role === 'source') {
        try {
          await state.adapter?.position?.(state.window, state.resumeDescriptor
            ? clampOriginToPlacement(state.startGeometry, state.source)
            : { x: state.startGeometry.x, y: state.startGeometry.y });
          await state.adapter?.focus?.(state.window);
        } catch {}
      } else if (state.handle) {
        try { await state.adapter?.close?.(state.handle); } catch {}
      }
    } finally {
      this.#setPhase(state, 'aborted', 'aborted', { reason, status: 'failed' });
      this.emit('abort', { reason, state: this.snapshot() });
      this.#clear();
    }
    return true;
  }

  async restoreOnScreen(reason = 'recovery') {
    await this.abort(reason);
    for (const parked of this.parked.values()) await this.#restoreParked(parked);
    this.parked.clear();
  }

  parkedForWindow(window) {
    const id = nativeWindowId(window);
    return id == null ? null : [...this.parked.values()].find((parked) => String(nativeWindowId(parked.handle)) === String(id));
  }

  snapshot() {
    if (!this.active) return null;
    const { adapter, window, handle, resolveReady, readyTimer, reverseTimer, positionDrain, pendingPosition, stateDrain, pendingPayload, ...safe } = this.active;
    const geometry = safe.geometry || (safe.descriptor?.geometryVU && safe.originVU
      ? { ...safe.descriptor.geometryVU, ...safe.originVU } : null);
    return { ...safe, grabOffsetVU: safe.grabOffsetVU && { ...safe.grabOffsetVU },
      cursorVU: safe.cursorVU && { ...safe.cursorVU }, geometry: geometry && { ...geometry } };
  }

  async #arm(state) {
    if (state.phase !== 'tracking') return;
    this.#setPhase(state, 'capturing', 'armed');
    const captureStartedAt = this.now();
    try {
      if (this.refreshSource) {
        const refreshed = await this.refreshSource(state.window);
        if (this.active !== state || state.aborted) return;
        if (refreshed?.window) {
          state.window = refreshed.window;
          state.instant = excludedState(state.window);
        }
        if (this.#validGeometry(refreshed?.geometryVU) && point(refreshed.cursorVU)) {
          state.geometry = { ...refreshed.geometryVU };
          state.cursorVU = { ...refreshed.cursorVU };
          state.grabOffsetVU = {
            x: state.cursorVU.x - state.geometry.x,
            y: state.cursorVU.y - state.geometry.y,
          };
        }
      }
      const descriptor = await state.adapter.capture(state.window, state.geometry);
      if (state.resumeDescriptor) descriptor.id = state.resumeDescriptor.id;
      this.#timing(state, 'capture', captureStartedAt, { status: 'ok' });
      if (this.active !== state || state.aborted) return;
      state.descriptor = descriptor;
      state.instant = state.instant || excludedState(descriptor);
      // Stop the OS drag before moving either native copy. Otherwise its
      // modal loop and our shared cursor apply different positions/gains.
      if (!state.instant && this.beginManagedMove) {
        await this.beginManagedMove(state.window);
        if (this.active !== state || state.aborted) return;
      }
      this.lateReadyIds.delete(descriptor.id);
      this.#setPhase(state, state.instant ? 'instant-preparing' : 'preparing', 'offer-created', { instant: state.instant });
      if (!this.send({ type: 'window.offer', descriptor })) throw new Error('offer-send-failed');
      state.offerSentAt = this.now();
      this.#lifecycle(state, 'offer-sent', { instant: state.instant });
      this.emit('offer', this.snapshot());
      if (!state.instant) this.#beginStraddle(state);
    } catch (error) { await this.abort(this.#reason(error, 'capture-failed')); }
  }

  async #positionSource(state) {
    try {
      this.#beginStraddle(state);
      await state.adapter.position(state.window, { x: state.geometry.x, y: state.geometry.y });
      this.emit('position', this.snapshot());
      this.send({ type: 'window.position', id: state.descriptor.id,
        sequence: ++state.positionSequence,
        originVU: { x: state.geometry.x, y: state.geometry.y } });
      return true;
    } catch (error) {
      await this.abort(this.#reason(error, 'source-position-failed'));
      return false;
    }
  }

  #beginStraddle(state) {
    if (state.straddleStarted) return;
    state.straddleStarted = true;
    state.straddleStartedAt = this.now();
    this.#lifecycle(state, 'straddle-started');
    this.emit('straddle', this.snapshot());
  }

  async #receiveOffer(descriptor) {
    if (this.active?.role === 'destination' && this.active.descriptor.id === descriptor?.id && this.active.pendingPause) {
      // Re-grabbing a split can race its original tab restoration. Finish
      // preparing the same native handle under the new drag's geometry.
      const state = this.active;
      state.descriptor = descriptor;
      state.pendingPause = null;
      state.pendingPayload = descriptor.payload;
      state.pendingWinner = null;
      state.originVU = { x: descriptor.geometryVU.x, y: descriptor.geometryVU.y };
      state.lastPositionSequence = -1;
      state.positionReceived = true;
      this.setDragging(true, { role: 'destination' });
      this.#lifecycle(state, 'split-resumed');
      if (state.handle) await this.#queueDestinationPosition(state);
      return true;
    }
    if (this.active) {
      this.send({ type: 'window.abort', id: descriptor?.id || 'busy-offer', reason: 'busy' });
      this.emit('lifecycle', { type: 'drag.lifecycle', event: 'offer-rejected', reason: 'busy',
        id: descriptor?.id || null, role: 'destination', phase: this.active.phase,
        at: this.now(), elapsedMs: 0 });
      return false;
    }
    const adapter = this.adapterForId(descriptor?.adapterId);
    const placements = this.getPlacements();
    const target = placements.find((placement) => placement.machineId === this.machineId);
    const source = placements.find((placement) => placement.machineId !== this.machineId);
    if (!adapter || !target || !source || !this.#validGeometry(descriptor?.geometryVU)) {
      this.send({ type: 'window.abort', id: descriptor?.id || 'invalid-offer', reason: 'adapter-unavailable' });
      return false;
    }
    const state = this.active = {
      role: 'destination', phase: 'preparing', adapter, descriptor, target, source,
      handle: null, aborted: false, ready: false, startedAt: this.now(),
      originVU: { x: descriptor.geometryVU.x, y: descriptor.geometryVU.y },
      instant: excludedState(descriptor), hasCrossed: false, pendingWinner: null,
      positionReceived: false, lastPositionSequence: -1, pendingPosition: null, positionDrain: null,
    };
    this.setDragging(true, { role: 'destination' });
    this.#lifecycle(state, 'offer-received', { instant: state.instant });
    const prepareStartedAt = this.now();
    try {
      const parked = this.parked.get(descriptor.id);
      this.parked.delete(descriptor.id);
      const geometryVU = renderedGeometry(descriptor.geometryVU, source, target);
      const preparedHandle = parked ? { ...parked.handle, geometryVU, placement: target }
        : await adapter.prepare({ ...descriptor, geometryVU }, {
        originVU: offscreenOrigin(geometryVU, source, target), targetPlacement: target,
        // Adapters may expose the real native window as soon as it exists,
        // while slower tab/history restoration continues. This keeps the
        // straddled copy attached to the pointer without claiming readiness
        // until the full prepare promise resolves.
        onPrepared: async (handle) => {
          if (!handle || this.active !== state || state.aborted) return false;
          state.handle = handle;
          if (!state.instant && state.positionReceived) {
            await this.#queueDestinationPosition(state);
          }
          return true;
        },
      });
      this.#timing(state, 'prepare', prepareStartedAt, { status: 'ok' });
      if (this.active !== state || state.aborted) {
        if (preparedHandle) await adapter.close(preparedHandle);
        return false;
      }
      state.handle = preparedHandle || state.handle;
      if (!state.handle) throw new Error('prepare-handle-missing');
      // A parked native copy must receive the newly grabbed half's current
      // tabs and page state before it is eligible to win a later transfer.
      if (parked || state.descriptor !== descriptor) state.pendingPayload ||= state.descriptor.payload;
      if (state.pendingPayload) await this.#applyPageState(state);
      if (this.active !== state || state.aborted) return false;
      if (!state.instant && state.positionReceived) {
        await this.#queueDestinationPosition(state);
      }
      state.ready = true;
      this.#setPhase(state, 'ready', 'ready');
      if (!this.send({ type: 'window.ready', id: descriptor.id })) throw new Error('ready-send-failed');
      const pendingWinner = state.pendingWinner;
      if (pendingWinner) return await this.#receiveCommit(pendingWinner);
      if (state.pendingPause) return await this.#receivePause(state.pendingPause);
      return true;
    } catch (error) {
      if (state.handle) { try { await adapter.close(state.handle); } catch {} }
      if (this.active === state) {
        const reason = this.#reason(error, 'prepare-failed');
        this.send({ type: 'window.abort', id: descriptor.id, reason });
        state.aborted = true;
        this.#setPhase(state, 'aborted', 'aborted', { reason, status: 'failed' });
        this.#clear();
      }
      return false;
    }
  }

  async #receivePosition(originVU, sequence = 0) {
    const state = this.active;
    if (!state || state.role !== 'destination' || !point(originVU) || state.instant
      || !Number.isSafeInteger(sequence) || sequence < 0) return false;
    if (state.pendingPause || ['pausing', 'committing', 'committed'].includes(state.phase)) return true;
    if (sequence <= state.lastPositionSequence) return true;
    state.lastPositionSequence = sequence;
    state.originVU = { ...originVU };
    state.positionReceived = true;
    const fraction = crossedFraction(renderedGeometry({ ...state.descriptor.geometryVU, ...state.originVU },
      state.source, state.target, state.descriptor.geometryVU), state.target);
    if (fraction > 0) {
      state.hasCrossed = true;
      if (state.reverseTimer) {
        this.clearTimer(state.reverseTimer);
        state.reverseTimer = null;
        this.#setPhase(state, 'straddling', 're-crossed');
      } else if (state.phase === 'ready') this.#setPhase(state, 'straddling', 'positioned');
    } else if (state.hasCrossed && !state.reverseTimer) {
      this.#setPhase(state, 'reverse-hold', 'reversed', { keepaliveMs: this.reverseKeepaliveMs });
      state.reverseTimer = this.setTimer(() => { void this.#expireReversed(state); }, this.reverseKeepaliveMs);
      state.reverseTimer?.unref?.();
    }
    if (!state.handle) return true;
    return this.#queueDestinationPosition(state);
  }

  async #queueDestinationPosition(state) {
    if (this.active !== state || !state.handle || state.instant) return false;
    state.pendingPosition = { ...state.originVU };
    if (state.positionDrain) return state.positionDrain;
    const drain = (async () => {
      while (this.active === state && state.handle && state.pendingPosition) {
        const originVU = state.pendingPosition;
        state.pendingPosition = null;
        const rect = renderedGeometry({ ...state.descriptor.geometryVU, ...originVU }, state.source, state.target, state.descriptor.geometryVU);
        state.handle = { ...state.handle, geometryVU: rect, placement: state.target };
        await state.adapter.position(state.handle, { x: rect.x, y: rect.y });
        if (this.active === state) this.emit('position', this.snapshot());
      }
      return true;
    })();
    state.positionDrain = drain;
    try {
      return await drain;
    }
    catch (error) { return this.abort(this.#reason(error, 'destination-position-failed')); }
    finally {
      if (state.positionDrain === drain) state.positionDrain = null;
    }
  }

  async #expireReversed(state) {
    if (this.active !== state || !state.reverseTimer) return;
    state.reverseTimer = null;
    try { await state.adapter.close(state.handle); } catch {}
    if (this.active !== state) return;
    this.send({ type: 'window.abort', id: state.descriptor.id, reason: 'reverse-timeout' });
    state.handle = null;
    state.aborted = true;
    this.#setPhase(state, 'aborted', 'reverse-expired', { status: 'cancelled' });
    this.#clear();
  }

  async #receiveCommit(winner) {
    const state = this.active;
    if (!state?.ready || !['source', 'destination'].includes(winner)) return false;
    if (state.reverseTimer) { this.clearTimer(state.reverseTimer); state.reverseTimer = null; }
    this.#setPhase(state, 'committing', 'commit-received', { winner });
    try {
      if (state.positionDrain) await state.positionDrain;
      if (this.active !== state || state.aborted) return false;
      state.pendingPosition = null;
      if (winner === 'destination') {
        await this.#applyPageState(state);
        if (this.active !== state || state.aborted) return false;
        const rect = fitToPlacement(renderedGeometry({ ...state.descriptor.geometryVU, ...state.originVU },
          state.source, state.target, state.descriptor.geometryVU), state.target);
        state.handle = { ...state.handle, geometryVU: rect };
        await state.adapter.position(state.handle, clampOriginToPlacement(rect, state.target));
        await state.adapter.focus(state.handle);
      } else {
        await state.adapter.close(state.handle);
        state.handle = null;
      }
      if (!this.send({ type: 'window.committed', id: state.descriptor.id })) throw new Error('committed-send-failed');
      this.#setPhase(state, 'committed', 'settled', { winner, status: 'ok' });
      this.emit('committed', { ...this.snapshot(), winner });
      this.#clear();
      return true;
    } catch (error) { return this.abort(this.#reason(error, 'destination-commit-failed')); }
  }

  async #receivePause(originVU) {
    const state = this.active;
    if (!state?.ready || state.role !== 'destination') return false;
    if (state.reverseTimer) { this.clearTimer(state.reverseTimer); state.reverseTimer = null; }
    // The reliable pause carries the exact final origin; the last realtime
    // position is allowed to be lost or to arrive after mouse release.
    this.#setPhase(state, 'pausing', 'pause-received');
    await this.#applyPageState(state);
    if (state.positionDrain) await state.positionDrain;
    if (this.active !== state || state.aborted) return false;
    state.pendingPosition = null;
    state.originVU = { ...originVU };
    const rect = renderedGeometry({ ...state.descriptor.geometryVU, ...originVU }, state.source, state.target, state.descriptor.geometryVU);
    state.handle = { ...state.handle, geometryVU: rect, placement: state.target };
    try { await state.adapter.position(state.handle, { x: rect.x, y: rect.y }); }
    catch (error) { return this.abort(this.#reason(error, 'destination-pause-failed')); }
    if (this.active !== state || state.aborted) return false;
    this.#park(state);
    return true;
  }

  #park(state) {
    if (state.reverseTimer) { this.clearTimer(state.reverseTimer); state.reverseTimer = null; }
    const geometryVU = state.role === 'source' ? state.geometry : state.handle.geometryVU;
    const handle = state.role === 'source' ? state.window : state.handle;
    this.parked.set(state.descriptor.id, { descriptor: state.descriptor, adapter: state.adapter,
      handle: { ...handle, geometryVU: { ...geometryVU } }, geometryVU: { ...geometryVU },
      placement: state.role === 'source' ? state.source : state.target });
    this.#setPhase(state, 'split', 'split-retained');
    this.emit('paused', this.snapshot());
    this.#clear();
  }

  async #refreshPageState(state) {
    if (typeof state.adapter.captureState !== 'function' || state.sourceMissing) return;
    let timer;
    try {
      const payload = await Promise.race([
        state.adapter.captureState(state.window, state.geometry),
        new Promise((_, reject) => { timer = this.setTimer(() => reject(new Error('page-state-timeout')), 1000); }),
      ]);
      if (this.active !== state || state.aborted || !payload) return;
      state.descriptor = { ...state.descriptor, payload };
      if (!this.send({ type: 'window.state', id: state.descriptor.id, payload })) {
        this.#lifecycle(state, 'page-state-unavailable', { reason: 'state-send-failed' });
      }
    } catch (error) {
      this.#lifecycle(state, 'page-state-unavailable', { reason: this.#reason(error, 'capture-state-failed') });
    } finally { if (timer) this.clearTimer(timer); }
  }

  async #applyPageState(state) {
    // Lifecycle messages can arrive while a previous snapshot is applying.
    // Serialize application so an older restore cannot overwrite the drop.
    if (state.stateDrain) await state.stateDrain.catch(() => {});
    if (this.active !== state || state.aborted) return;
    if (!state.pendingPayload || !state.handle || typeof state.adapter.syncState !== 'function') return;
    const payload = state.pendingPayload;
    state.pendingPayload = null;
    state.descriptor = { ...state.descriptor, payload };
    const drain = Promise.resolve().then(() => state.adapter.syncState(state.handle, payload));
    state.stateDrain = drain;
    try { await drain; }
    catch (error) { this.#lifecycle(state, 'page-state-unavailable', { reason: this.#reason(error, 'restore-state-failed') }); }
    finally { if (state.stateDrain === drain) state.stateDrain = null; }
  }

  async #restoreParked(parked) {
    try {
      const placement = this.getPlacements().find((candidate) => candidate.machineId === this.machineId) || parked.placement;
      const rect = fitToPlacement(parked.geometryVU, placement);
      await parked.adapter.position({ ...parked.handle, geometryVU: rect }, clampOriginToPlacement(rect, placement));
    } catch { /* The user may have already closed a parked Chrome copy. */ }
  }

  #sendCommit(state) {
    if (this.active !== state || state.aborted || state.phase === 'committing') return false;
    if (!state.winner) state.winner = 'destination';
    if (!this.send({ type: 'window.commit', id: state.descriptor.id, winner: state.winner,
      originVU: { x: state.geometry.x, y: state.geometry.y } })) {
      void this.abort('commit-send-failed');
      return false;
    }
    this.#setPhase(state, 'committing', 'commit-sent', { winner: state.winner });
    return true;
  }

  #waitForReady(state) {
    if (state.ready) return Promise.resolve('ready');
    state.waitStartedAt = this.now();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (state.readyTimer) this.clearTimer(state.readyTimer);
        state.readyTimer = null;
        state.resolveReady = null;
        resolve(result);
      };
      state.resolveReady = finish;
      state.readyTimer = this.setTimer(() => finish('timeout'), this.waitMs);
      state.readyTimer?.unref?.();
    });
  }

  #rememberLateReady(id) {
    if (!id) return;
    this.lateReadyIds.delete(id);
    this.lateReadyIds.add(id);
    while (this.lateReadyIds.size > LATE_ID_LIMIT) this.lateReadyIds.delete(this.lateReadyIds.values().next().value);
  }

  #setPhase(state, phase, event, detail) { state.phase = phase; this.#lifecycle(state, event, detail); }

  #lifecycle(state, event, detail = {}) {
    const at = this.now();
    const record = { type: 'drag.lifecycle', event, id: state.descriptor?.id || null,
      role: state.role, phase: state.phase, at, elapsedMs: Math.max(0, at - state.startedAt), ...detail };
    this.emit('lifecycle', record);
    this.#log('info', 'drag.lifecycle', record);
  }

  #timing(state, name, since, detail = {}) {
    if (!finite(since)) return;
    const at = this.now();
    const record = { type: 'drag.timing', name, id: state.descriptor?.id || null,
      role: state.role, phase: state.phase, at, durationMs: Math.max(0, at - since), ...detail };
    this.emit('timing', record);
    this.#log('info', 'drag.timing', record);
  }

  #log(level, event, details) {
    const method = typeof this.logger === 'function' ? this.logger : this.logger?.[level];
    if (typeof method === 'function') {
      try { method.call(this.logger, event, details); } catch {}
    }
  }

  #clear() {
    const state = this.active;
    if (state?.readyTimer) this.clearTimer(state.readyTimer);
    if (state?.reverseTimer) this.clearTimer(state.reverseTimer);
    this.active = null;
    this.setBusy(false);
    this.setDragging(false);
  }

  #reason(error, fallback) { return error?.code || error?.message || fallback; }
  #validGeometry(value) { return value && point(value) && finite(value.w) && finite(value.h) && value.w > 0 && value.h > 0; }
}

module.exports = {
  ARM_DISTANCE_VU, MIN_WINDOW, PREPARE_WAIT_MS, REVERSE_KEEPALIVE_MS,
  intersectionArea, crossedFraction, dropWinner, renderedGeometry, cursorDeltaInSource, fitToPlacement, clampOriginToPlacement, offscreenOrigin,
  targetForSource, motionTowardEdge, originDistanceToEdge, DragController,
};
