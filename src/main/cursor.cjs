'use strict';

const { EventEmitter } = require('node:events');
const {
  normalizePlacement,
  ensureNonOverlapping,
  containsPoint,
  clampToPlacement,
  ownerAt,
  toLocal,
  crossingTarget,
} = require('./virtualspace.cjs');

const DEFAULT_ACCELERATION = Object.freeze({ base: 1, threshold: .5, slope: .04 });
const DEFAULT_FRAME_MS = 1000 / 60;
const BUTTON_BITS = Object.freeze({ left: 1, right: 2, middle: 4, x1: 8, x2: 16 });
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const noOp = () => {};

function normalizeAcceleration(value = {}) {
  const acceleration = {
    base: finite(value.base) ? value.base : DEFAULT_ACCELERATION.base,
    threshold: finite(value.threshold) ? value.threshold : DEFAULT_ACCELERATION.threshold,
    slope: finite(value.slope) ? value.slope : DEFAULT_ACCELERATION.slope,
  };
  if (acceleration.base < 0 || acceleration.base > 20
    || acceleration.threshold < 0 || acceleration.threshold > 1000
    || acceleration.slope < 0 || acceleration.slope > 20) throw new TypeError('Invalid acceleration curve.');
  return acceleration;
}

function accelerateDelta(dx, dy, dt, curve = DEFAULT_ACCELERATION) {
  if (!finite(dx) || !finite(dy) || !finite(dt)) throw new TypeError('Invalid cursor delta.');
  const elapsed = Math.max(.1, dt);
  const speed = Math.hypot(dx, dy) / elapsed;
  const gain = speed < curve.threshold
    ? curve.base
    : curve.base + (speed - curve.threshold) * curve.slope;
  return { dx: dx * gain, dy: dy * gain, gain };
}

function safeCall(target, method, ...args) {
  if (typeof target?.[method] !== 'function') return undefined;
  return target[method](...args);
}

class CursorController extends EventEmitter {
  constructor(options = {}) {
    super();
    if (typeof options.machineId !== 'string' || !options.machineId.length) throw new TypeError('machineId is required.');
    this.machineId = options.machineId;
    this.native = options.native || {};
    this.send = typeof options.send === 'function' ? options.send : () => false;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.frameMs = finite(options.frameMs) && options.frameMs > 0 ? options.frameMs : DEFAULT_FRAME_MS;
    this.placements = this.#normalizePlacements(options.placements || []);
    this.config = {
      acceleration: normalizeAcceleration(options.acceleration),
      edgeResistanceVU: finite(options.edgeResistanceVU)
        ? Math.max(0, Math.min(1000, options.edgeResistanceVU)) : 0,
    };
    const initialOwner = options.ownerMachineId || ownerAt(options.initialPosition || {}, this.placements)
      || this.placements[0]?.machineId || this.machineId;
    this.ownerMachineId = initialOwner;
    const ownerPlacement = this.placementFor(initialOwner) || this.placementFor(this.machineId) || this.placements[0];
    this.virtualCursor = ownerPlacement
      ? clampToPlacement(options.initialPosition || ownerPlacement.origin, ownerPlacement)
      : { x: 0, y: 0 };
    this.linked = options.linked !== false;
    this.dragging = false;
    this.started = false;
    this.frameTimer = null;
    this.pendingLocal = { dx: 0, dy: 0 };
    this.pendingRemote = { dx: 0, dy: 0 };
    this.edgePressure = null;
    this.localButtons = 0;
    this.remoteButtons = 0;
    this.modifiers = 0;
  }

  #normalizePlacements(values) {
    if (!Array.isArray(values)) throw new TypeError('placements must be an array.');
    const placements = values.map(normalizePlacement);
    if (placements.some((placement) => !placement)
      || new Set(placements.map((placement) => placement.machineId)).size !== placements.length) {
      throw new TypeError('Invalid screen placements.');
    }
    return ensureNonOverlapping(placements);
  }

  placementFor(machineId) {
    return this.placements.find((placement) => placement.machineId === machineId) || null;
  }

  isOwner() {
    return this.ownerMachineId === this.machineId;
  }

  state() {
    return {
      linked: this.linked,
      ownerMachineId: this.ownerMachineId,
      virtualCursor: { ...this.virtualCursor },
      buttons: this.localButtons | this.remoteButtons,
      modifiers: this.modifiers,
      dragging: this.dragging,
      config: { acceleration: { ...this.config.acceleration }, edgeResistanceVU: this.config.edgeResistanceVU },
    };
  }

  start() {
    if (this.started) return;
    this.started = true;
    if (this.linked) this.#enableCapture();
    this.#applyPhysicalOwnership();
    this.frameTimer = setInterval(() => this.flush(), this.frameMs);
    this.frameTimer.unref?.();
  }

  stop(reason = 'stop') {
    if (!this.started) return;
    this.started = false;
    clearInterval(this.frameTimer);
    this.frameTimer = null;
    this.setLinked(false, reason);
  }

  setPlacements(values) {
    this.placements = this.#normalizePlacements(values);
    let ownerPlacement = this.placementFor(this.ownerMachineId);
    if (!ownerPlacement) {
      ownerPlacement = this.placementFor(this.machineId) || this.placements[0] || null;
      this.ownerMachineId = ownerPlacement?.machineId || this.machineId;
    }
    if (ownerPlacement) this.virtualCursor = clampToPlacement(this.virtualCursor, ownerPlacement);
    this.edgePressure = null;
    this.#applyPhysicalOwnership();
    this.emit('layout', this.state());
  }

  setConfig(value = {}) {
    if (value.acceleration) {
      this.config.acceleration = normalizeAcceleration(value.acceleration);
      safeCall(this.native, 'configureAcceleration', this.config.acceleration);
    }
    if (value.edgeResistanceVU !== undefined) {
      if (!finite(value.edgeResistanceVU) || value.edgeResistanceVU < 0 || value.edgeResistanceVU > 1000) {
        throw new TypeError('Invalid edge resistance.');
      }
      this.config.edgeResistanceVU = value.edgeResistanceVU;
    }
    return this.state().config;
  }

  setLinked(linked, reason = 'user') {
    const next = Boolean(linked);
    if (this.linked === next) return false;
    this.linked = next;
    this.edgePressure = null;
    this.pendingLocal = { dx: 0, dy: 0 };
    this.pendingRemote = { dx: 0, dy: 0 };
    if (next) this.#enableCapture();
    else this.#disableCapture();
    this.#applyPhysicalOwnership();
    this.emit('mode', { linked: next, reason });
    return true;
  }

  toggleLinked(reason = 'hotkey') {
    this.setLinked(!this.linked, reason);
    return this.linked;
  }

  setDragging(dragging) {
    this.dragging = Boolean(dragging);
    if (this.dragging) this.edgePressure = null;
  }

  setModifiers(modifiers) {
    if (!Number.isSafeInteger(modifiers) || modifiers < 0 || modifiers > 65535) return false;
    this.modifiers = modifiers;
    return true;
  }

  localDelta(dx, dy, dt = this.frameMs, timestamp = this.now(), options = {}) {
    if (!this.linked || !finite(dx) || !finite(dy) || !finite(dt)) return false;
    const accelerated = options.accelerated
      ? { dx, dy }
      : accelerateDelta(dx, dy, dt, this.config.acceleration);
    this.send({ type: 'cursor.delta', dx: accelerated.dx, dy: accelerated.dy, t: timestamp });
    if (this.isOwner()) {
      this.pendingLocal.dx += accelerated.dx;
      this.pendingLocal.dy += accelerated.dy;
    }
    return true;
  }

  localButton(button, down) {
    const bit = BUTTON_BITS[button];
    if (!this.linked || !bit || typeof down !== 'boolean') return false;
    this.localButtons = down ? this.localButtons | bit : this.localButtons & ~bit;
    this.send({ type: 'cursor.button', button, down });
    return true;
  }

  receive(message, peerMachineId = null) {
    if (!this.linked || !message || typeof message !== 'object') return false;
    if (message.type === 'cursor.delta') {
      if (!this.isOwner() || !finite(message.dx) || !finite(message.dy)) return false;
      this.pendingRemote.dx += message.dx;
      this.pendingRemote.dy += message.dy;
      return true;
    }
    if (message.type === 'cursor.position') {
      if (this.isOwner() || (peerMachineId && peerMachineId !== this.ownerMachineId)
        || !finite(message.x) || !finite(message.y)) return false;
      const owner = this.placementFor(this.ownerMachineId);
      if (!owner) return false;
      this.virtualCursor = clampToPlacement({ x: message.x, y: message.y }, owner);
      this.emit('position', this.state());
      return true;
    }
    if (message.type === 'cursor.handoff') return this.#receiveHandoff(message, peerMachineId);
    if (message.type === 'cursor.button') {
      const bit = BUTTON_BITS[message.button];
      if (!bit || typeof message.down !== 'boolean') return false;
      this.remoteButtons = message.down ? this.remoteButtons | bit : this.remoteButtons & ~bit;
      if (this.isOwner()) safeCall(this.native, 'synthesizeButton', message.button, message.down);
      return true;
    }
    return false;
  }

  flush(timestamp = this.now()) {
    if (!this.linked || !this.isOwner()) return false;
    const dx = this.pendingLocal.dx + this.pendingRemote.dx;
    const dy = this.pendingLocal.dy + this.pendingRemote.dy;
    this.pendingLocal = { dx: 0, dy: 0 };
    this.pendingRemote = { dx: 0, dy: 0 };
    if (dx || dy) this.#moveAuthoritative(dx, dy);
    if (this.isOwner()) {
      this.send({ type: 'cursor.position', x: this.virtualCursor.x, y: this.virtualCursor.y, t: timestamp });
      this.emit('position', this.state());
    }
    return true;
  }

  toggleOwnership() {
    if (!this.linked || this.placements.length < 2) return false;
    const owner = this.placementFor(this.ownerMachineId);
    const target = this.isOwner()
      ? this.placements.find((placement) => placement.machineId !== this.ownerMachineId)
      : this.placementFor(this.machineId);
    if (!owner || !target) return false;
    const relativeX = (this.virtualCursor.x - owner.origin.x) / owner.size.w;
    const relativeY = (this.virtualCursor.y - owner.origin.y) / owner.size.h;
    const position = clampToPlacement({
      x: target.origin.x + relativeX * target.size.w,
      y: target.origin.y + relativeY * target.size.h,
    }, target);
    if (this.isOwner()) this.#handoff(target, position, 'hotkey');
    else {
      this.virtualCursor = position;
      this.ownerMachineId = target.machineId;
      this.edgePressure = null;
      const buttons = this.localButtons | this.remoteButtons;
      this.send({ type: 'cursor.handoff', x: position.x, y: position.y, buttons, modifiers: this.modifiers });
      this.#applyPhysicalOwnership();
      safeCall(this.native, 'assumeInputState', buttons, this.modifiers);
      this.emit('ownership', { ownerMachineId: target.machineId, reason: 'hotkey', virtualCursor: { ...position }, buttons, modifiers: this.modifiers });
    }
    return true;
  }

  #enableCapture() {
    if (!this.started) return;
    safeCall(this.native, 'configureAcceleration', this.config.acceleration);
    safeCall(this.native, 'startCursorCapture', {
      // Native capture owns the shared acceleration curve on the input hot
      // path. Mark its output so JS never applies the curve a second time.
      onDelta: (dx, dy, dt, timestamp) => this.localDelta(dx, dy, dt, timestamp, { accelerated: true }),
      onButton: (button, down) => this.localButton(button, down),
      onModifiers: (modifiers) => this.setModifiers(modifiers),
    });
  }

  #disableCapture() {
    safeCall(this.native, 'stopCursorCapture');
    safeCall(this.native, 'releaseInputState');
    safeCall(this.native, 'showCursor');
    safeCall(this.native, 'releaseCursor');
  }

  #applyPhysicalOwnership() {
    if (!this.linked || this.isOwner()) {
      safeCall(this.native, 'releaseCursor');
      if (this.linked) {
        const placement = this.placementFor(this.machineId);
        if (placement) safeCall(this.native, 'warpCursor', toLocal(this.virtualCursor, placement));
      }
      safeCall(this.native, 'showCursor');
    } else {
      safeCall(this.native, 'hideCursor');
      safeCall(this.native, 'parkCursor');
    }
  }

  #moveAuthoritative(dx, dy) {
    const owner = this.placementFor(this.ownerMachineId);
    if (!owner) return;
    const candidate = { x: this.virtualCursor.x + dx, y: this.virtualCursor.y + dy };
    if (containsPoint(owner, candidate)) {
      this.edgePressure = null;
      this.virtualCursor = candidate;
      safeCall(this.native, 'warpCursor', toLocal(candidate, owner));
      return;
    }
    const crossing = crossingTarget(owner, candidate, this.placements);
    if (!crossing) {
      this.edgePressure = null;
      this.virtualCursor = clampToPlacement(candidate, owner);
      safeCall(this.native, 'warpCursor', toLocal(this.virtualCursor, owner));
      return;
    }
    const pressure = crossing.edge === 'right'
      ? Math.max(0, candidate.x - (owner.origin.x + owner.size.w))
      : crossing.edge === 'left'
        ? Math.max(0, owner.origin.x - candidate.x)
        : Math.max(0, candidate.y - (owner.origin.y + owner.size.h));
    const key = `${crossing.edge}:${crossing.placement.machineId}`;
    if (this.edgePressure?.key !== key) this.edgePressure = { key, amount: 0 };
    this.edgePressure.amount += pressure;
    const resistance = this.dragging ? 0 : this.config.edgeResistanceVU;
    if (this.edgePressure.amount < resistance) {
      this.virtualCursor = clampToPlacement(candidate, owner);
      safeCall(this.native, 'warpCursor', toLocal(this.virtualCursor, owner));
      return;
    }
    const excess = Math.max(0, this.edgePressure.amount - resistance);
    const position = { ...candidate };
    if (crossing.edge === 'right') position.x = crossing.placement.origin.x + excess;
    else if (crossing.edge === 'left') position.x = crossing.placement.origin.x + crossing.placement.size.w - excess;
    else position.y = crossing.placement.origin.y + excess;
    this.#handoff(crossing.placement, clampToPlacement(position, crossing.placement), 'edge');
  }

  #handoff(target, position, reason) {
    safeCall(this.native, 'hideCursor');
    safeCall(this.native, 'parkCursor');
    this.virtualCursor = position;
    this.ownerMachineId = target.machineId;
    this.edgePressure = null;
    const buttons = this.localButtons | this.remoteButtons;
    this.send({
      type: 'cursor.handoff',
      x: position.x,
      y: position.y,
      buttons,
      modifiers: this.modifiers,
    });
    this.emit('ownership', { ownerMachineId: target.machineId, reason, virtualCursor: { ...position }, buttons, modifiers: this.modifiers });
  }

  #receiveHandoff(message, peerMachineId) {
    if (!finite(message.x) || !finite(message.y)
      || !Number.isSafeInteger(message.buttons) || !Number.isSafeInteger(message.modifiers)) return false;
    const targetId = ownerAt({ x: message.x, y: message.y }, this.placements);
    if (!targetId || (peerMachineId && peerMachineId !== this.ownerMachineId && peerMachineId !== targetId)) return false;
    const target = this.placementFor(targetId);
    this.ownerMachineId = targetId;
    this.virtualCursor = clampToPlacement({ x: message.x, y: message.y }, target);
    this.remoteButtons = (this.remoteButtons & message.buttons) | (message.buttons & ~this.localButtons);
    this.modifiers = message.modifiers;
    this.edgePressure = null;
    if (this.isOwner()) {
      safeCall(this.native, 'releaseCursor');
      safeCall(this.native, 'warpCursor', toLocal(this.virtualCursor, target));
      safeCall(this.native, 'showCursor');
      safeCall(this.native, 'assumeInputState', message.buttons, message.modifiers);
    } else {
      safeCall(this.native, 'hideCursor');
      safeCall(this.native, 'parkCursor');
    }
    this.emit('ownership', {
      ownerMachineId: targetId,
      reason: 'handoff',
      virtualCursor: { ...this.virtualCursor },
      buttons: message.buttons,
      modifiers: message.modifiers,
    });
    return true;
  }
}

module.exports = {
  DEFAULT_ACCELERATION,
  DEFAULT_FRAME_MS,
  BUTTON_BITS,
  normalizeAcceleration,
  accelerateDelta,
  CursorController,
  createNoopNativeAdapter: () => ({
    showCursor: noOp,
    hideCursor: noOp,
    parkCursor: noOp,
    releaseCursor: noOp,
    warpCursor: noOp,
    startCursorCapture: noOp,
    stopCursorCapture: noOp,
    releaseInputState: noOp,
  }),
};
