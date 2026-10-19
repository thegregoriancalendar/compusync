'use strict';

const { EventEmitter } = require('node:events');
const os = require('node:os');

function supportsMacCapture(release = os.release()) {
  const [major, minor] = release.split('.').map(Number);
  return major > 23 || (major === 23 && minor >= 6);
}

class RustAudioEngine extends EventEmitter {
  constructor({ binding, platform = process.platform, packaged = false, release = os.release() } = {}) {
    super();
    this.native = binding?.NativeAudio ? new binding.NativeAudio() : null;
    this.available = Boolean(this.native);
    this.canSend = this.available && platform === 'darwin' && supportsMacCapture(release);
    this.platform = platform;
    this.packaged = packaged;
    this.route = null;
  }

  async receive({ id, key, peerIp, outputId }) {
    if (!this.available || this.platform !== 'win32') throw new Error('Rebuild the native addon on Windows to enable audio playback.');
    const route = this.route = { id, role: 'receiver', connected: false };
    const port = await this.native.startReceiver(key, peerIp || '', outputId);
    if (this.route === route) this.poll(route);
    return port;
  }

  async send({ id, key, peerIp, port }) {
    if (!this.canSend) throw new Error('Mac audio capture needs the rebuilt native addon and macOS 14.6 or later.');
    // Electron's development runtime lacks our usage description and can yield
    // a dead capture stream. Use the app bundle built with the audio plist key.
    if (!this.packaged) throw new Error('For system audio capture, run the packaged CompuSync app on the Mac. Build it with npm run build and open the app in dist; npm start uses an Electron bundle without the required audio permission description.');
    const route = this.route = { id, role: 'sender', startedAt: Date.now() };
    await this.native.startSender(key, peerIp || '', port);
    if (this.route === route) this.poll(route);
  }

  poll(route) {
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.route !== route) return;
      try {
        const state = this.native.status();
        if (state.error || !state.running) {
          this.emit('event', { type: 'error', id: route.id, message: state.error || 'Native audio stopped unexpectedly.' });
        } else if (route.role === 'receiver' && state.packets > 0 && !route.connected) {
          route.connected = true;
          this.emit('event', { type: 'connected', id: route.id });
        } else if (route.role === 'sender' && !state.capturedFrames && Date.now() - route.startedAt > 10_000) {
          this.emit('event', { type: 'error', id: route.id,
            message: 'No Mac system audio samples were captured. Play sound on the Mac and check CompuSync’s System Audio Recording permission, then try again.' });
        }
      } catch (error) { this.emit('event', { type: 'error', id: route.id, message: error.message }); }
    }, 500);
    this.timer.unref?.();
  }

  async listOutputs() {
    if (!this.native) throw new Error('Rebuild the native addon to list audio outputs.');
    this.emit('event', { type: 'outputs', outputs: this.native.outputs() });
  }

  stop() {
    this.route = null;
    clearInterval(this.timer);
    this.native?.stop(); // Also cancels a start still waiting on OS permissions.
  }
}

module.exports = { RustAudioEngine, supportsMacCapture };
