'use strict';

const MAX_SCROLL_DELTA = 1000;
const finiteDelta = (value) => typeof value === 'number' && Number.isFinite(value)
  && Math.abs(value) <= MAX_SCROLL_DELTA;

class ScrollRouter {
  constructor(options = {}) {
    if (!options.cursor || typeof options.cursor.isOwner !== 'function') {
      throw new TypeError('A cursor controller is required.');
    }
    this.cursor = options.cursor;
    this.native = options.native || {};
    this.send = typeof options.send === 'function' ? options.send : () => false;
  }

  localScroll(dy) {
    if (!this.cursor.linked || !finiteDelta(dy) || dy === 0 || this.cursor.isOwner()) return false;
    return this.send({ type: 'scroll.delta', dy }) !== false;
  }

  receive(message) {
    if (!this.cursor.linked || !this.cursor.isOwner() || message?.type !== 'scroll.delta'
      || !finiteDelta(message.dy) || message.dy === 0) return false;
    this.native.synthesizeScroll?.(message.dy);
    return true;
  }
}

module.exports = { ScrollRouter, MAX_SCROLL_DELTA, finiteDelta };
