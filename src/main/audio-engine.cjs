'use strict';

const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { AUDIO_VERSION } = require('../core/audio-contract.cjs');

function supportsMacCapture(release = os.release()) {
  const [major, minor] = release.split('.').map(Number);
  return major > 23 || (major === 23 && minor >= 6);
}

class RustAudioEngine extends EventEmitter {
  constructor({ binding, bindingPath, platform = process.platform, release = os.release() } = {}) {
    super();
    this.native = binding?.NativeAudio ? new binding.NativeAudio() : null;
    this.available = this.native?.protocolVersion?.() === AUDIO_VERSION;
    this.supportsStereoSplit = this.available && typeof this.native?.setPlaybackChannel === 'function';
    this.canSend = this.available && (platform === 'win32' || (platform === 'darwin' && supportsMacCapture(release)));
    this.canReceive = this.available && ['darwin', 'win32'].includes(platform);
    this.guardPath = bindingPath ? path.join(path.dirname(bindingPath), 'compusync-recovery-guard.exe') : '';
    this.platform = platform;
    this.route = null;
  }

  prepareRouting() {
    if (this.platform !== 'win32' || !this.available) return Promise.resolve();
    if (!this.guardPath) return Promise.reject(new Error('Windows audio recovery helper is unavailable. Rebuild the native addon.'));
    this.prepared ||= new Promise((resolve, reject) => {
      execFile(this.guardPath, ['--audio-recover'], { windowsHide: true }, (error, stdout) => {
        if (error) { this.prepared = null; reject(new Error(stdout.trim().replace(/^ERROR /, '') || 'Windows audio recovery helper is unavailable. Rebuild the native addon.')); }
        else resolve();
      });
    });
    return this.prepared;
  }

  async receive({ id, key, peerIp, outputId, channel = 'stereo' }) {
    if (!this.canReceive) throw new Error('Rebuild the native addon to enable audio playback.');
    const route = this.route = { id, role: 'receiver', connected: false, channel };
    await this.prepareRouting();
    if (this.route !== route) throw new Error('Audio start cancelled.');
    this.setPlaybackChannel(route.channel);
    const port = await this.native.startReceiver(key, peerIp || '', outputId);
    if (this.route === route) this.poll(route);
    return port;
  }

  async send({ id, key, peerIp, port, outputId = '', sourceId = '', channel = 'stereo' }) {
    if (!this.canSend) throw new Error('Synchronized Mac audio needs the rebuilt native addon and macOS 14.6 or later.');
    const route = this.route = { id, role: 'sender', startedAt: Date.now(), channel };
    await this.prepareRouting();
    if (this.route !== route) throw new Error('Audio start cancelled.');
    this.setPlaybackChannel(route.channel);
    // The pinned Electron runtime includes NSAudioCaptureUsageDescription, so
    // development launches can request the same native OS permission as a build.
    await this.native.startSender(key, peerIp || '', port, outputId, sourceId, this.guardPath);
    if (this.route === route) this.poll(route);
  }

  poll(route) {
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.route !== route) return;
      try {
        const state = this.native.status();
        const warning = state.running && typeof state.warning === 'string' ? state.warning.slice(0, 500) : null;
        if (warning !== (route.warning || null)) {
          route.warning = warning;
          this.emit('event', { type: 'warning', id: route.id, message: warning });
        }
        this.emit('event', { type: 'timing', id: route.id, timing: {
          clockReady: state.running && state.clockReady, playing: state.running && state.playedFrames > 0,
          delayMs: state.playoutDelayMs, rttMs: state.clockRttMs,
          uncertaintyMs: state.clockUncertaintyMs, phaseErrorMs: state.phaseErrorMs,
          latePackets: state.latePackets, resyncs: state.resyncs,
        } });
        if (state.error || !state.running) {
          this.emit('event', { type: 'error', id: route.id, message: state.error || 'Native audio stopped unexpectedly.' });
        } else if (route.role === 'receiver' && state.clockReady && state.playedFrames > 0 && !route.connected) {
          route.connected = true;
          this.emit('event', { type: 'connected', id: route.id });
        } else if (route.role === 'sender' && !state.capturedFrames && Date.now() - route.startedAt > 10_000) {
          this.emit('event', { type: 'error', id: route.id,
            message: this.platform === 'win32' ? 'No Windows audio samples were captured. Check VB-CABLE and the selected output, then retry.' : 'No Mac system audio samples were captured. Play sound on the Mac and check System Audio Recording permission for CompuSync, Electron, or the terminal used to launch it, then restart the app and try again.' });
        }
      } catch (error) { this.emit('event', { type: 'error', id: route.id, message: error.message }); }
    }, 500);
    this.timer.unref?.();
  }

  async listOutputs() {
    if (!this.available) throw new Error('Rebuild the native addon to enable synchronized audio.');
    this.emit('event', { type: 'outputs', outputs: this.native.outputs() });
  }

  routingStatus(sourceId = '', outputId = '') {
    if (!this.available) return { ready: false, reason: 'Rebuild the native addon on both laptops.', buses: [] };
    return this.native.routingStatus(sourceId, outputId);
  }

  volume(outputId) {
    if (typeof this.native?.volume !== 'function') throw new Error('Update the native addon to enable volume controls.');
    return this.native.volume(outputId);
  }

  setVolume(outputId, level) {
    if (typeof this.native?.setVolume !== 'function') throw new Error('Update the native addon to enable volume controls.');
    return this.native.setVolume(outputId, level);
  }

  setPlaybackChannel(channel) {
    if (!['stereo', 'left', 'right'].includes(channel)) throw new Error('Choose a valid audio channel.');
    if (!this.supportsStereoSplit) {
      if (channel !== 'stereo') throw new Error('Rebuild the native addon to enable split stereo.');
      return;
    }
    this.native.setPlaybackChannel(channel);
    if (this.route) this.route.channel = channel;
  }

  stop() {
    this.route = null;
    this.prepared = null;
    clearInterval(this.timer);
    this.native?.stop(); // Also cancels a start still waiting on OS permissions.
    if (this.supportsStereoSplit) this.native.setPlaybackChannel('stereo');
  }
}

module.exports = { RustAudioEngine, supportsMacCapture };
