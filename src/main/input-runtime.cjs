'use strict';

// Keeps transport integration deliberately small: the authenticated Session
// sanitizes messages, then this router hands M0 traffic to its state owner.
function routePeerInput(components, message, peerMachineId = null) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || typeof message.type !== 'string') return false;
  try {
    if (message.type === 'heartbeat') return components.watchdog?.receiveHeartbeat(message) || false;
    if (message.type === 'layout.update') {
      if (!components.cursor) return false;
      components.cursor.setPlacements(message.placements);
      return true;
    }
    if (message.type === 'key.event') return components.keyboard?.receive(message) || false;
    if (message.type.startsWith('cursor.')) return components.cursor?.receive(message, peerMachineId) || false;
    return false;
  } catch {
    // The Session channel authenticates its sender, but authentication does
    // not make malformed application data safe. Peer input must fail closed.
    return false;
  }
}

function bindPeerInput(emitter, components, eventName = 'peer-message') {
  if (!emitter?.on) throw new TypeError('An event emitter is required.');
  const handler = (message, peerMachineId) => routePeerInput(components, message, peerMachineId);
  emitter.on(eventName, handler);
  return () => emitter.off?.(eventName, handler);
}

module.exports = { routePeerInput, bindPeerInput };
