'use strict';

const AUDIO_VERSION = 3;
const ROUTE_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const AUDIO_KEY = /^[a-f0-9]{64}$/;
const validVolumeLevel = (level) => Number.isInteger(level) && level >= 0 && level <= 100;
const validPlaybackMode = (mode) => ['stereo', 'split-stereo'].includes(mode);
const validChannels = (channels) => channels && ['left', 'right'].includes(channels.mac)
  && ['left', 'right'].includes(channels.windows) && channels.mac !== channels.windows;

function sanitizeVolume(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.error === 'string' && value.error.length > 0 && value.error.length <= 500) {
    return { error: value.error };
  }
  if (!validVolumeLevel(value.level) || typeof value.muted !== 'boolean'
    || typeof value.label !== 'string' || value.label.length > 256) return null;
  return { level: value.level, muted: value.muted, label: value.label };
}

// Only negotiation crosses the existing encrypted connection. Rust owns the
// audio devices and a separate AES-GCM-authenticated UDP stream.

function sanitizeAudioMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.type === 'audio.hello') {
    if (value.version !== AUDIO_VERSION || !['darwin', 'win32', 'unsupported'].includes(value.platform)
      || typeof value.canSend !== 'boolean' || typeof value.canReceive !== 'boolean'
      || (value.stereoSplit !== undefined && typeof value.stereoSplit !== 'boolean')) return null;
    return { type: value.type, version: AUDIO_VERSION, platform: value.platform,
      canSend: value.platform !== 'unsupported' && value.canSend,
      canReceive: value.platform !== 'unsupported' && value.canReceive,
      ...(value.stereoSplit === true ? { stereoSplit: true } : {}) };
  }
  if (value.type === 'audio.volume-state') {
    const volume = sanitizeVolume(value.volume);
    return volume ? { type: value.type, volume } : null;
  }
  if (!ROUTE_ID.test(value.id || '')) return null;
  if (value.type === 'audio.volume-set' && validVolumeLevel(value.level)) {
    return { type: value.type, id: value.id, level: value.level };
  }
  if (value.type === 'audio.volume-result') {
    const volume = sanitizeVolume(value.volume);
    return volume ? { type: value.type, id: value.id, volume } : null;
  }
  if (value.type === 'audio.channels' || (value.type === 'audio.offer' && value.mode !== undefined)) {
    if (!validPlaybackMode(value.mode)) return null;
    if (value.mode === 'split-stereo') {
      if (!validChannels(value.channels)) return null;
      return { type: value.type, id: value.id, mode: value.mode,
        channels: { mac: value.channels.mac, windows: value.channels.windows } };
    }
    if (value.type === 'audio.channels') return null;
  }
  if (value.type === 'audio.offer' || value.type === 'audio.started' || value.type === 'audio.stop') {
    return { type: value.type, id: value.id };
  }
  if (value.type === 'audio.ready' && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535
    && AUDIO_KEY.test(value.key || '')) return { type: value.type, id: value.id, port: value.port, key: value.key };
  return null;
}

module.exports = { AUDIO_VERSION, sanitizeAudioMessage, sanitizeVolume, validVolumeLevel, validPlaybackMode };
