'use strict';

const { EventEmitter } = require('node:events');

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
    this.logger = options.logger || null;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
    this.clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
    this.waitMs = Number.isFinite(options.waitMs) ? options.waitMs : PREPARE_WAIT_MS;
    this.reverseKeepaliveMs = Number.isFinite(options.reverseKeepaliveMs) ? options.reverseKeepaliveMs : REVERSE_KEEPALIVE_MS;
    this.active = null;
    this.nonCrossingHintShown = false;
    this.lateReadyIds = new Set();
  }

  begin({ window, geometryVU, cursorVU }) {
    if (this.active || !window || !this.#validGeometry(geometryVU) || !point(cursorVU)) return false;
    const placements = this.getPlacements();
    const source = placements.find((placement) => placement.machineId === this.machineId);
    const target = targetForSource(source, placements);
    if (!source || !target) return false;
    this.active = {
      role: 'source', phase: 'tracking', window, adapter: this.adapterForWindow(window), source, target,
      startedAt: this.now(), startGeometry: { ...geometryVU }, geometry: { ...geometryVU }, previous: { ...geometryVU },
      cursorVU: { ...cursorVU }, grabOffsetVU: { x: cursorVU.x - geometryVU.x, y: cursorVU.y - geometryVU.y },
      descriptor: null, ready: false, aborted: false, winner: null, committed: false,
      straddleStarted: false, instant: excludedState(window), positionSequence: 0,
    };
    this.setDragging(true);
    this.#lifecycle(this.active, 'started');
    this.emit('start', this.snapshot());
    return true;
  }

  async frame({ geometryVU, cursorVU } = {}) {
    const state = this.active;
    if (!state || state.role !== 'source' || !point(cursorVU)) return false;
    const previous = state.geometry;
    state.previous = { ...previous };
    state.cursorVU = { ...cursorVU };
    state.geometry = {
      x: cursorVU.x - state.grabOffsetVU.x, y: cursorVU.y - state.grabOffsetVU.y,
      w: this.#validGeometry(geometryVU) ? geometryVU.w : state.geometry.w,
      h: this.#validGeometry(geometryVU) ? geometryVU.h : state.geometry.h,
    };

    if (state.phase === 'tracking') {
      if (!state.adapter || state.geometry.w < MIN_WINDOW.w || state.geometry.h < MIN_WINDOW.h) {
        if (!this.nonCrossingHintShown && originDistanceToEdge(state.geometry, state.source, state.target) <= ARM_DISTANCE_VU) {
          this.nonCrossingHintShown = true;
          this.emit('hint', { type: 'non-crossing-window' });
        }
        return true;
      }
      if (originDistanceToEdge(state.geometry, state.source, state.target) > ARM_DISTANCE_VU
        || !motionTowardEdge(previous, state.geometry, state.source, state.target)) return true;
      await this.#arm(state);
    }

    if (this.active !== state || state.instant || !state.descriptor || ['committing', 'dropping'].includes(state.phase)) return true;
    return this.#positionSource(state);
  }

  async end() {
    const state = this.active;
    if (!state || state.role !== 'source') return false;
    if (!state.descriptor) { this.#clear(); return true; }
    state.winner = state.instant || crossedFraction(state.geometry, state.target) >= 0.5 ? 'destination' : 'source';
    this.#setPhase(state, 'dropping', 'mouse-up', { winner: state.winner });
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
    const state = this.active;
    if ((!state || state.descriptor?.id !== message.id) && message.type === 'window.ready' && this.lateReadyIds.delete(message.id)) {
      this.send({ type: 'window.abort', id: message.id, reason: 'late-ready' });
      this.emit('lifecycle', { type: 'drag.lifecycle', event: 'late-ready-discarded', id: message.id,
        role: 'source', phase: 'aborted', at: this.now(), elapsedMs: 0 });
      return true;
    }
    if (!state || state.descriptor?.id !== message.id) return false;

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
    if (message.type === 'window.commit' && state.role === 'destination') {
      if (!['source', 'destination'].includes(message.winner)) return false;
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
    if (notify && state.descriptor) this.send({ type: 'window.abort', id: state.descriptor.id, reason });
    try {
      if (state.role === 'source') {
        try {
          await state.adapter?.position?.(state.window, { x: state.startGeometry.x, y: state.startGeometry.y });
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

  restoreOnScreen(reason = 'recovery') { return this.abort(reason); }

  snapshot() {
    if (!this.active) return null;
    const { adapter, window, handle, resolveReady, readyTimer, reverseTimer, positionDrain, pendingPosition, ...safe } = this.active;
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
      const descriptor = await state.adapter.capture(state.window, state.geometry);
      this.#timing(state, 'capture', captureStartedAt, { status: 'ok' });
      if (this.active !== state || state.aborted) return;
      state.descriptor = descriptor;
      state.instant = state.instant || excludedState(descriptor);
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
    this.setDragging(true);
    this.#lifecycle(state, 'offer-received', { instant: state.instant });
    const prepareStartedAt = this.now();
    try {
      const preparedHandle = await adapter.prepare(descriptor, {
        originVU: offscreenOrigin(descriptor.geometryVU, source, target), targetPlacement: target,
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
      if (!state.instant && state.positionReceived) {
        await this.#queueDestinationPosition(state);
      }
      state.ready = true;
      this.#setPhase(state, 'ready', 'ready');
      if (!this.send({ type: 'window.ready', id: descriptor.id })) throw new Error('ready-send-failed');
      const pendingWinner = state.pendingWinner;
      if (pendingWinner) return this.#receiveCommit(pendingWinner);
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
    if (['committing', 'committed'].includes(state.phase)) return true;
    if (sequence <= state.lastPositionSequence) return true;
    state.lastPositionSequence = sequence;
    state.originVU = { ...originVU };
    state.positionReceived = true;
    const fraction = crossedFraction({ ...state.descriptor.geometryVU, ...state.originVU }, state.target);
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
        await state.adapter.position(state.handle, originVU);
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
        const rect = { ...state.descriptor.geometryVU, ...state.originVU };
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

  #sendCommit(state) {
    if (this.active !== state || state.aborted || state.phase === 'committing') return false;
    if (!state.winner) state.winner = 'destination';
    if (!this.send({ type: 'window.commit', id: state.descriptor.id, winner: state.winner })) {
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
  intersectionArea, crossedFraction, clampOriginToPlacement, offscreenOrigin,
  targetForSource, motionTowardEdge, originDistanceToEdge, DragController,
};
