'use strict';

const { EventEmitter } = require('node:events');

class KeyboardRouter extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.cursor || typeof options.cursor.isOwner !== 'function') throw new TypeError('A cursor controller is required.');
    this.cursor = options.cursor;
    this.native = options.native || {};
    this.send = typeof options.send === 'function' ? options.send : () => false;
    this.notice = typeof options.notice === 'function' ? options.notice : () => {};
    this.elevationNoticeShown = false;
    this.remotePressed = new Set();
  }

  localKey(code, down, modifiers = 0) {
    if (!this.cursor.linked || !Number.isSafeInteger(code) || code < 0 || code > 65535
      || typeof down !== 'boolean' || !Number.isSafeInteger(modifiers)
      || modifiers < 0 || modifiers > 65535) return false;
    if (this.cursor.isOwner()) return false;
    return this.send({ type: 'key.event', code, down, modifiers }) !== false;
  }

  receive(message) {
    if (!this.cursor.linked || !this.cursor.isOwner() || message?.type !== 'key.event'
      || !Number.isSafeInteger(message.code) || message.code < 0 || message.code > 65535
      || typeof message.down !== 'boolean' || !Number.isSafeInteger(message.modifiers)
      || message.modifiers < 0 || message.modifiers > 65535) return false;
    if (message.down) this.remotePressed.add(message.code);
    else this.remotePressed.delete(message.code);
    this.#checkElevation();
    this.native.synthesizeKey?.(message.code, message.down, message.modifiers);
    return true;
  }

  releaseAll() {
    for (const code of this.remotePressed) this.native.synthesizeKey?.(code, false, 0);
    this.remotePressed.clear();
    this.native.releaseInputState?.();
  }

  resetElevationNotice() {
    this.elevationNoticeShown = false;
  }

  #checkElevation() {
    if (this.elevationNoticeShown || typeof this.native.isForegroundElevated !== 'function') return;
    try {
      const elevated = this.native.isForegroundElevated();
      if (elevated && typeof elevated.then === 'function') {
        elevated.then((value) => { if (value) this.#showElevationNotice(); }).catch(() => {});
      } else if (elevated) this.#showElevationNotice();
    } catch {
      // Elevation detection is advisory; input routing must stay operational.
    }
  }

  #showElevationNotice() {
    if (this.elevationNoticeShown) return;
    this.elevationNoticeShown = true;
    const message = 'Windows blocks shared keyboard input in elevated (administrator) windows.';
    this.notice(message);
    this.emit('notice', { type: 'elevated-window', message });
  }
}

module.exports = { KeyboardRouter };
