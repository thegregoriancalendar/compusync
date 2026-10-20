'use strict';

// Flattened Quartz events preserve the Dock's gesture phases and progress,
// including a reversed/cancelled swipe. Both ends must be Macs.
const MAX_GESTURE_BYTES = 16384;
function validGestureData(data) {
  return typeof data === 'string' && data.length > 0
    && data.length <= MAX_GESTURE_BYTES * 2 && data.length % 2 === 0
    && /^[0-9a-f]+$/.test(data);
}

class TrackpadGestureRouter {
  constructor({ cursor, native, send, platforms }) {
    this.cursor = cursor;
    this.native = native;
    this.send = send;
    this.platforms = platforms;
  }

  supported() {
    const { source, destination } = this.platforms();
    return source === 'darwin' && destination === 'darwin';
  }

  configure() {
    this.native.setGestureForwarding?.(this.supported());
  }

  localGesture(data) {
    if (!this.supported() || !this.cursor.linked || this.cursor.isOwner()
      || !validGestureData(data)) return false;
    return this.send({ type: 'gesture.trackpad', data }) !== false;
  }

  receive(message) {
    if (!this.supported() || !this.cursor.linked || !this.cursor.isOwner()
      || message?.type !== 'gesture.trackpad' || !validGestureData(message.data)
      || typeof this.native.synthesizeGesture !== 'function') return false;
    this.native.synthesizeGesture(message.data);
    return true;
  }
}

module.exports = { TrackpadGestureRouter, validGestureData, MAX_GESTURE_BYTES };
