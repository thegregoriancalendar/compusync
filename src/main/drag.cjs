'use strict';

const { EventEmitter } = require('node:events');
const ARM_DISTANCE_VU = 200;
const MIN_WINDOW = Object.freeze({ w: 200, h: 150 });
const PREPARE_WAIT_MS = 2000;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

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

function offscreenOrigin(rect, source, target) {
  if (target.origin.x >= source.origin.x + source.size.w) {
    return { x: target.origin.x + target.size.w + 1, y: rect.y };
  }
  if (target.origin.x + target.size.w <= source.origin.x) {
    return { x: target.origin.x - rect.w - 1, y: rect.y };
  }
  return { x: rect.x, y: target.origin.y + target.size.h + 1 };
}

function targetForSource(source, placements) {
  if (!source) return null;
  const peers = placements.filter((placement) => placement.machineId !== source.machineId);
  if (!peers.length) return null;
  const edgeDistance = (target) => Math.min(
    Math.abs(target.origin.x - source.origin.x - source.size.w),
    Math.abs(source.origin.x - target.origin.x - target.size.w),
    Math.abs(target.origin.y - source.origin.y - source.size.h),
  );
  return peers.sort((a, b) => edgeDistance(a) - edgeDistance(b))[0];
}

function motionTowardEdge(previous, current, source, target) {
  if (!previous) return false;
  if (target.origin.x >= source.origin.x + source.size.w) return current.x > previous.x;
  if (target.origin.x + target.size.w <= source.origin.x) return current.x < previous.x;
  return current.y > previous.y;
}

function originDistanceToEdge(rect, source, target) {
  if (target.origin.x >= source.origin.x + source.size.w) return Math.abs(source.origin.x + source.size.w - rect.x);
  if (target.origin.x + target.size.w <= source.origin.x) return Math.abs(rect.x - source.origin.x);
  return Math.abs(source.origin.y + source.size.h - rect.y);
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
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.waitMs = Number.isFinite(options.waitMs) ? options.waitMs : PREPARE_WAIT_MS;
    this.active = null;
    this.nonCrossingHintShown = false;
  }

  begin({ window, geometryVU, cursorVU }) {
    if (this.active || !window || !this.#validGeometry(geometryVU) || !cursorVU) return false;
    const placements = this.getPlacements();
    const source = placements.find((placement) => placement.machineId === this.machineId);
    const target = targetForSource(source, placements);
    if (!source || !target) return false;
    const adapter = this.adapterForWindow(window);
    this.active = {
      role: 'source', phase: 'tracking', window, adapter, source, target,
      startGeometry: { ...geometryVU }, geometry: { ...geometryVU }, previous: null,
      cursorVU: { ...cursorVU }, descriptor: null, ready: false, aborted: false,
      winner: null, committed: false,
    };
    this.setDragging(true);
    this.emit('start', this.snapshot());
    return true;
  }

  async frame({ geometryVU, cursorVU }) {
    const state = this.active;
    if (!state || state.role !== 'source' || !this.#validGeometry(geometryVU)) return false;
    const previous = state.geometry;
    state.previous = previous;
    state.geometry = { ...geometryVU };
    if (cursorVU) state.cursorVU = { ...cursorVU };
    if (state.phase !== 'tracking') return true;
    if (!state.adapter || geometryVU.w < MIN_WINDOW.w || geometryVU.h < MIN_WINDOW.h) {
      if (!this.nonCrossingHintShown && originDistanceToEdge(geometryVU, state.source, state.target) <= ARM_DISTANCE_VU) {
        this.nonCrossingHintShown = true;
        this.emit('hint', { type: 'non-crossing-window' });
      }
      return true;
    }
    if (originDistanceToEdge(geometryVU, state.source, state.target) > ARM_DISTANCE_VU
      || !motionTowardEdge(previous, geometryVU, state.source, state.target)) return true;
    await this.#arm(state);
    return true;
  }

  async end({ geometryVU } = {}) {
    const state = this.active;
    if (!state || state.role !== 'source') return false;
    if (this.#validGeometry(geometryVU)) state.geometry = { ...geometryVU };
    if (!state.descriptor) { this.#clear(); return true; }
    state.winner = crossedFraction(state.geometry, state.target) >= 0.5 ? 'destination' : 'source';
    state.phase = 'dropping';
    if (state.winner === 'destination' && !state.ready) {
      this.setBusy(true);
      await Promise.race([
        new Promise((resolve) => { state.resolveReady = resolve; }),
        new Promise((resolve) => setTimeout(resolve, this.waitMs)),
      ]);
      this.setBusy(false);
      if (!this.active || state.aborted) return false;
      if (!state.ready) return this.abort('prepare-timeout');
    }
    if (!this.send({ type: 'window.commit', id: state.descriptor.id, winner: state.winner })) {
      return this.abort('commit-send-failed');
    }
    state.phase = 'committing';
    return true;
  }

  async receive(message) {
    if (!message || typeof message.type !== 'string') return false;
    if (message.type === 'window.offer') return this.#receiveOffer(message.descriptor);
    const state = this.active;
    if (!state || state.descriptor?.id !== message.id) return false;
    if (message.type === 'window.ready' && state.role === 'source') {
      if (state.aborted) { this.send({ type: 'window.abort', id: message.id, reason: 'late-ready' }); return false; }
      state.ready = true;
      state.resolveReady?.();
      state.resolveReady = null;
      this.emit('ready', this.snapshot());
      return true;
    }
    if (message.type === 'window.commit' && state.role === 'destination') return this.#receiveCommit(message.winner);
    if (message.type === 'window.committed' && state.role === 'source') {
      if (state.winner === 'destination') await state.adapter.close(state.window);
      state.committed = true;
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
    state.resolveReady?.();
    if (notify && state.descriptor) this.send({ type: 'window.abort', id: state.descriptor.id, reason });
    try {
      if (state.role === 'source') await state.adapter?.position?.(state.window, { x: state.startGeometry.x, y: state.startGeometry.y });
      else if (state.handle) await state.adapter?.close?.(state.handle);
    } finally {
      this.emit('abort', { reason, state: this.snapshot() });
      this.#clear();
    }
    return true;
  }

  restoreOnScreen(reason = 'recovery') { return this.abort(reason); }

  snapshot() {
    if (!this.active) return null;
    const { adapter, window, handle, resolveReady, ...safe } = this.active;
    return { ...safe };
  }

  async #arm(state) {
    if (state.phase !== 'tracking') return;
    state.phase = 'capturing';
    try {
      const descriptor = await state.adapter.capture(state.window, state.geometry);
      if (!this.active || state.aborted) return;
      state.descriptor = descriptor;
      state.phase = 'preparing';
      if (!this.send({ type: 'window.offer', descriptor })) throw new Error('offer-send-failed');
      this.emit('offer', this.snapshot());
    } catch (error) {
      await this.abort(error?.code || error?.message || 'capture-failed');
    }
  }

  async #receiveOffer(descriptor) {
    if (this.active) {
      this.send({ type: 'window.abort', id: descriptor?.id || 'busy-offer', reason: 'busy' });
      return false;
    }
    const adapter = this.adapterForId(descriptor?.adapterId);
    const placements = this.getPlacements();
    const target = placements.find((placement) => placement.machineId === this.machineId);
    const source = placements.find((placement) => placement.machineId !== this.machineId);
    if (!adapter || !target || !source) {
      this.send({ type: 'window.abort', id: descriptor?.id || 'invalid-offer', reason: 'adapter-unavailable' });
      return false;
    }
    const state = this.active = {
      role: 'destination', phase: 'preparing', adapter, descriptor, target, source,
      handle: null, aborted: false, ready: false,
    };
    this.setDragging(true);
    try {
      state.handle = await adapter.prepare(descriptor, {
        originVU: offscreenOrigin(descriptor.geometryVU, source, target), targetPlacement: target,
      });
      if (!this.active || state.aborted) {
        if (state.handle) await adapter.close(state.handle);
        return false;
      }
      state.ready = true;
      state.phase = 'ready';
      if (!this.send({ type: 'window.ready', id: descriptor.id })) throw new Error('ready-send-failed');
      return true;
    } catch (error) {
      if (state.handle) await adapter.close(state.handle).catch?.(() => {});
      if (this.active === state) {
        this.send({ type: 'window.abort', id: descriptor.id, reason: error?.code || error?.message || 'prepare-failed' });
        this.#clear();
      }
      return false;
    }
  }

  async #receiveCommit(winner) {
    const state = this.active;
    if (!state?.ready || !['source', 'destination'].includes(winner)) return false;
    state.phase = 'committing';
    if (winner === 'destination') {
      const originVU = clampOriginToPlacement(state.descriptor.geometryVU, state.target);
      await state.adapter.position(state.handle, originVU);
      await state.adapter.focus(state.handle);
    } else {
      await state.adapter.close(state.handle);
    }
    if (!this.send({ type: 'window.committed', id: state.descriptor.id })) return this.abort('committed-send-failed');
    this.emit('committed', { ...this.snapshot(), winner });
    this.#clear();
    return true;
  }

  #clear() {
    this.active = null;
    this.setDragging(false);
  }

  #validGeometry(value) {
    return value && finite(value.x) && finite(value.y) && finite(value.w) && finite(value.h) && value.w > 0 && value.h > 0;
  }
}

module.exports = {
  ARM_DISTANCE_VU,
  MIN_WINDOW,
  PREPARE_WAIT_MS,
  intersectionArea,
  crossedFraction,
  clampOriginToPlacement,
  offscreenOrigin,
  targetForSource,
  motionTowardEdge,
  originDistanceToEdge,
  DragController,
};
