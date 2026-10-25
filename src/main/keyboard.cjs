'use strict';

const { EventEmitter } = require('node:events');

class KeyboardRouter extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.cursor || typeof options.cursor.isOwner !== 'function') throw new TypeError('A cursor controller is required.');
    this.cursor = options.cursor;
    this.native = options.native || {};
    this.send = typeof options.send === 'function' ? options.send : () => false;
    this.synchronizeModifiers = options.synchronizeModifiers === true;
    this.mapRemoteEvent = typeof options.mapRemoteEvent === 'function'
      ? options.mapRemoteEvent : (message) => message;
    this.notice = typeof options.notice === 'function' ? options.notice : () => {};
    this.elevationNoticeShown = false;
    this.remotePressed = new Set();
    this.sourcePressed = new Map();
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
    let mapped = this.mapRemoteEvent(message);
    // Pin the translation until release, even if the user releases its modifier
    // first. Repeats also retain the original shortcut.
    const held = this.sourcePressed.get(message.code);
    if (this.synchronizeModifiers && held && !(message.code >= 0xE0 && message.code <= 0xE7)) mapped = { ...held, down: message.down };

    if (!mapped || !Number.isSafeInteger(mapped.code) || mapped.code < 0 || mapped.code > 65535
      || !Number.isSafeInteger(mapped.modifiers) || mapped.modifiers < 0 || mapped.modifiers > 65535) return false;
    if (message.down && (message.code === 0xE3 || message.code === 0xE7) && !held) this.metaUsed = false;
    if (message.down && !(message.code >= 0xE0 && message.code <= 0xE7)
      && (this.sourcePressed.has(0xE3) || this.sourcePressed.has(0xE7))) this.metaUsed = true;
    if (message.down) this.sourcePressed.set(message.code, mapped);
    else this.sourcePressed.delete(message.code);
    if (this.synchronizeModifiers) this.#syncModifiers(mapped.modifiers, mapped.code);
    if (this.synchronizeModifiers && mapped.code >= 0xE0 && mapped.code <= 0xE7) {
      // Preserve sided modifier presses, including both Shift keys together.
      if (mapped.down && !this.remotePressed.has(mapped.code)) {
        this.native.synthesizeKey?.(mapped.code, true, mapped.modifiers);
        this.remotePressed.add(mapped.code);
      } else if (!mapped.down && this.remotePressed.has(mapped.code)) {
        this.native.synthesizeKey?.(mapped.code, false, mapped.modifiers);
        this.remotePressed.delete(mapped.code);
      }
      if (!message.down) this.#syncModifiers(message.modifiers);
      this.cursor.setModifiers?.(message.modifiers);
      this.#checkElevation();
      if (held && !this.metaUsed && mapped.shortcutOnTap) {
        const tap = mapped.shortcutOnTap;
        this.#syncModifiers(tap.modifiers);
        this.native.synthesizeKey?.(tap.code, true, tap.modifiers);
        this.native.synthesizeKey?.(tap.code, false, tap.modifiers);
        this.#syncModifiers(message.modifiers);
      }
      return true;
    }
    if (mapped.down) this.remotePressed.add(mapped.code);
    else this.remotePressed.delete(mapped.code);
    this.cursor.setModifiers?.(message.modifiers);
    this.#checkElevation();
    this.native.synthesizeKey?.(mapped.code, mapped.down, mapped.modifiers);
    if (this.synchronizeModifiers && !message.down) this.#syncModifiers(message.modifiers);
    return true;
  }

  releaseAll() {
    for (const code of this.remotePressed) this.native.synthesizeKey?.(code, false, 0);
    this.remotePressed.clear();
    this.sourcePressed.clear();
    this.metaUsed = false;
    this.injectedModifiers = undefined;
    this.cursor.setModifiers?.(0);
    this.native.releaseInputState?.();
  }

  #syncModifiers(modifiers, preferredCode) {
    const bitFor = (code) => [2, 1, 4, 8][(code - 0xE0) % 4];
    // Handoffs can inject held modifiers before the router sees any key events.
    let current = this.injectedModifiers ?? this.cursor.modifiers ?? 0;
    for (const [bit, left] of [[1, 0xE1], [2, 0xE0], [4, 0xE2], [8, 0xE3]]) {
      if ((current & bit) && !(modifiers & bit)) {
        const held = [...this.remotePressed].filter((code) => code >= 0xE0 && code <= 0xE7 && bitFor(code) === bit);
        current &= ~bit;
        for (const code of held.length ? held : [left]) {
          this.native.synthesizeKey?.(code, false, current);
          this.remotePressed.delete(code);
        }
      }
    }
    for (const [bit, left] of [[1, 0xE1], [2, 0xE0], [4, 0xE2], [8, 0xE3]]) {
      if (!(current & bit) && (modifiers & bit)) {
        const code = preferredCode >= 0xE0 && preferredCode <= 0xE7 && bitFor(preferredCode) === bit ? preferredCode : left;
        current |= bit;
        this.native.synthesizeKey?.(code, true, current);
        this.remotePressed.add(code);
      }
    }
    this.injectedModifiers = modifiers;
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
