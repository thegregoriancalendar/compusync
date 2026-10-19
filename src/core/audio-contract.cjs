'use strict';

const AUDIO_VERSION = 2;
const ROUTE_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const AUDIO_KEY = /^[a-f0-9]{64}$/;

// Only negotiation crosses the existing encrypted connection. Rust owns the
// audio devices and a separate AES-GCM-authenticated UDP stream.

function sanitizeAudioMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.type === 'audio.hello') {
    if (value.version !== AUDIO_VERSION || !['darwin', 'win32', 'unsupported'].includes(value.platform)
      || typeof value.canSend !== 'boolean' || typeof value.canReceive !== 'boolean') return null;
    return { type: value.type, version: AUDIO_VERSION, platform: value.platform,
      canSend: value.platform === 'darwin' && value.canSend,
      canReceive: value.platform === 'win32' && value.canReceive };
  }
  if (!ROUTE_ID.test(value.id || '')) return null;
  if (value.type === 'audio.offer' || value.type === 'audio.started' || value.type === 'audio.stop') {
    return { type: value.type, id: value.id };
  }
  if (value.type === 'audio.ready' && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535
    && AUDIO_KEY.test(value.key || '')) return { type: value.type, id: value.id, port: value.port, key: value.key };
  return null;
}

module.exports = { AUDIO_VERSION, sanitizeAudioMessage };
