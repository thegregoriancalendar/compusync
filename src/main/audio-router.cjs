'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID, randomBytes } = require('node:crypto');
const { AUDIO_VERSION, sanitizeAudioMessage } = require('../core/audio-contract.cjs');

class AudioRouter extends EventEmitter {
  constructor({ session, engine, platform = process.platform, outputId = '' }) {
    super();
    this.session = session;
    this.engine = engine;
    this.platform = platform;
    this.canCapture = platform === 'darwin' && engine.canSend;
    this.outputId = outputId;
    this.outputs = [];
    this.peer = null;
    this.route = null;
    this.timing = null;
    this.phase = 'idle';
    this.message = 'Audio stays on each laptop.';
    this.connected = false;
    this.helloSent = false;
    this.onStatus = () => this.connectionChanged();
    this.onMessage = (message, memberId) => this.receive(message, memberId);
    this.onEngine = (event) => this.engineEvent(event);
  }

  state() {
    return { phase: this.phase, message: this.message, active: Boolean(this.route),
      canStart: this.connected && this.canCapture && this.peer?.canReceive === true && !this.route,
      peerReady: Boolean(this.peer), canCapture: this.canCapture, available: this.engine.available,
      outputId: this.outputId, outputs: this.outputs, timing: this.timing };
  }

  update(phase, message) {
    this.phase = phase;
    this.message = message;
    this.emit('state', this.state());
  }

  start() {
    this.session.on('status', this.onStatus);
    this.session.on('peer-message', this.onMessage);
    this.engine.on('event', this.onEngine);
    this.connectionChanged();
  }

  hello() {
    this.helloSent = this.session.sendPeer({ type: 'audio.hello', version: AUDIO_VERSION,
      platform: ['darwin', 'win32'].includes(this.platform) ? this.platform : 'unsupported',
      canSend: this.canCapture, canReceive: this.engine.available && this.platform === 'win32' });
  }

  connectionChanged() {
    const connected = this.session.phase === 'connected';
    if (connected === this.connected) return;
    this.connected = connected;
    this.peer = null;
    this.helloSent = false;
    if (connected) this.hello();
    else this.stopRoute('Audio stopped because the laptops disconnected.', false);
    this.emit('state', this.state());
  }

  receive(value, memberId) {
    if (!this.connected || !this.session.members?.some((member) => member.id === memberId
      && member.id !== this.session.self.id)) return;
    const message = sanitizeAudioMessage(value);
    if (!message) return;
    if (message.type === 'audio.hello') {
      const first = !this.peer;
      this.peer = message;
      // Reply once as well as announcing on connect: either listener may start first.
      if (first || !this.helloSent) this.hello();
      this.emit('state', this.state());
      return;
    }
    if (message.type === 'audio.stop') {
      if (this.route?.id === message.id) this.stopRoute('Audio sharing stopped.', false);
      return;
    }
    if (message.type === 'audio.offer') {
      if (this.platform !== 'win32' || this.peer?.platform !== 'darwin' || !this.peer.canSend) return;
      if (this.route) return; // A route has exactly one offer; ignore duplicates and glare.
      const route = this.route = { id: message.id, role: 'receiver' };
      this.update('connecting', 'Connecting to Mac audio…');
      this.armTimeout(route, 90_000);
      const key = randomBytes(32).toString('hex');
      void this.engine.receive({ id: route.id, key, peerIp: this.session.peerAddress(), outputId: this.outputId })
        .then((port) => { if (this.route === route) this.send({ type: 'audio.ready', id: route.id, port, key }); })
        .catch((error) => this.fail(route, error));
    } else if (message.type === 'audio.ready' && this.route?.id === message.id
      && this.route.role === 'sender' && !this.route.ready) {
      const route = this.route;
      route.ready = true;
      void this.engine.send({ id: route.id, key: message.key, peerIp: this.session.peerAddress(), port: message.port })
        .then(() => {
          if (this.route === route && this.phase !== 'streaming') {
            this.update('connecting', 'Connecting Mac audio to Windows…');
            this.armTimeout(route);
          }
        }).catch((error) => this.fail(route, error));
    } else if (message.type === 'audio.started' && this.route?.id === message.id && this.route.role === 'sender' && this.route.ready) {
      clearTimeout(this.timer);
      this.update('streaming', 'Playing Mac audio on both laptops on a shared schedule.');
    }
  }

  send(message) {
    const clean = sanitizeAudioMessage(message);
    if (!clean || !this.session.sendPeer(clean)) throw new Error('The audio connection was interrupted. Try again.');
  }

  startRoute() {
    if (!this.state().canStart) throw new Error(this.platform === 'darwin'
      ? 'Connect to a Windows laptop running this version of CompuSync first. Mac audio requires the rebuilt native addon and macOS 14.6 or later.'
      : 'Start audio sharing from Connection & settings on the Mac.');
    const route = this.route = { id: randomUUID(), role: 'sender' };
    this.update('starting', 'Starting Mac audio capture. Approve the macOS audio permission if prompted.');
    this.armTimeout(route, 90_000);
    try { this.send({ type: 'audio.offer', id: route.id }); }
    catch (error) { this.fail(route, error); }
  }

  armTimeout(route, duration = 20_000) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(route, new Error('Audio could not connect. Check audio permissions and allow CompuSync through the firewall, then try again.')), duration);
    this.timer.unref?.();
  }

  engineEvent(event) {
    if (event?.type === 'outputs') {
      if (!Array.isArray(event.outputs) || event.outputs.length > 100) return;
      this.outputs = event.outputs.filter((output) => typeof output?.id === 'string' && output.id.length <= 256
        && typeof output.label === 'string' && output.label.length <= 256);
      this.emit('state', this.state());
      return;
    }
    if (!this.route || event?.id !== this.route.id) return;
    if (event.type === 'timing') {
      this.timing = event.timing;
      this.emit('state', this.state());
    } else if (event.type === 'connected' && this.route.role === 'receiver') {
      clearTimeout(this.timer);
      try { this.send({ type: 'audio.started', id: this.route.id }); }
      catch (error) { this.fail(this.route, error); return; }
      this.update('receiving', 'Playing Mac audio on a shared schedule with the Mac.');
    } else if (event.type === 'error') {
      this.fail(this.route, new Error(typeof event.message === 'string' ? event.message.slice(0, 500) : 'Audio stopped unexpectedly.'));
    }
  }

  fail(route, error) {
    if (this.route !== route) return;
    this.stopRoute();
    this.update('error', error?.message || 'Audio could not start. Try again.');
  }

  stopRoute(message = 'Audio stays on each laptop.', notify = true) {
    clearTimeout(this.timer);
    const route = this.route;
    this.route = null;
    this.timing = null;
    if (route && notify && this.connected) this.session.sendPeer({ type: 'audio.stop', id: route.id });
    this.engine.stop();
    this.update('idle', message);
  }

  async refreshOutputs() {
    if (this.platform !== 'win32') return;
    await this.engine.listOutputs();
  }

  async setOutput(id) {
    if (this.platform !== 'win32' || typeof id !== 'string' || id.length > 256) throw new Error('Choose a Windows audio output.');
    if (this.route) throw new Error('Stop audio sharing before changing the Windows output.');
    if (id && !this.outputs.some((output) => output.id === id)) throw new Error('Refresh the audio outputs and choose an available device.');
    this.outputId = id;
    this.emit('state', this.state());
  }

  stop() {
    this.stopRoute();
    this.session.removeListener('status', this.onStatus);
    this.session.removeListener('peer-message', this.onMessage);
    this.engine.removeListener('event', this.onEngine);
    this.connected = false;
  }
}

module.exports = { AudioRouter };
