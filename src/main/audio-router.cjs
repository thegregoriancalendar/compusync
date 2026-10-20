'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID, randomBytes } = require('node:crypto');
const { AUDIO_VERSION, sanitizeAudioMessage, sanitizeVolume, validVolumeLevel, validPlaybackMode } = require('../core/audio-contract.cjs');
const { stereoAssignment } = require('../renderer/screen-layout.js');
const { supportedPair, deviceSlots } = require('../shared/devices.js');

class AudioRouter extends EventEmitter {
  constructor({ session, engine, platform = process.platform, outputId = '', sourceId = '', playbackMode = 'stereo', layoutSettings = {} }) {
    super();
    this.session = session;
    this.engine = engine;
    this.platform = platform;
    this.canCapture = ['darwin', 'win32'].includes(platform) && engine.canSend;
    this.sourceId = sourceId;
    this.routing = { ready: platform !== 'win32', buses: [] };
    this.outputId = outputId;
    this.playbackMode = validPlaybackMode(playbackMode) ? playbackMode : 'stereo';
    this.layoutSettings = layoutSettings;
    this.outputs = [];
    this.peer = null;
    this.route = null;
    this.timing = null;
    this.phase = 'idle';
    this.message = 'Audio stays on each laptop.';
    this.connected = false;
    this.helloSent = false;
    this.volume = null;
    this.peerVolume = null;
    this.volumeRequests = new Map();
    this.onStatus = () => this.connectionChanged();
    this.onMessage = (message, memberId) => this.receive(message, memberId);
    this.onEngine = (event) => this.engineEvent(event);
    this.onLayout = () => {
      const signature = JSON.stringify(Object.entries(this.session.state?.layouts || {}).map(([id, layout]) => [id, layout.revision]));
      if (signature === this.layoutSignature) return;
      this.layoutSignature = signature;
      this.layoutChanged();
    };
  }

  state() {
    const split = this.splitState();
    return { role: this.route?.role || null, phase: this.phase, message: this.message, active: Boolean(this.route),
      canStart: this.connected && this.canCapture && this.peer?.canReceive === true && this.compatiblePeer() && this.routing.ready && !this.route
        && (this.playbackMode !== 'split-stereo' || split.ready),
      playbackMode: this.route?.mode || this.playbackMode, stereoSplitAvailable: this.engine.supportsStereoSplit === true,
      stereoSplit: this.route?.channels ? { ready: true, channels: this.deviceChannels(this.route) } : split,
      peerReady: Boolean(this.peer), canCapture: this.canCapture, available: this.engine.available,
      sourceId: this.sourceId, routing: this.routing, outputId: this.outputId, outputs: this.outputs, timing: this.timing,
      warning: this.route?.warning || null,
      volumes: Object.fromEntries(this.session.members.map((member) => [member.id,
        member.id === this.session.self.id ? this.volume : this.peerVolume])) };
  }

  compatiblePeer() {
    return supportedPair(this.platform, this.peer?.platform)
      && (this.platform !== this.peer.platform || this.peer.deviceRouting === true);
  }

  slots() {
    return deviceSlots(this.session.members.map((member) => ({ ...member,
      platform: member.id === this.session.self.id ? this.platform : this.peer?.platform || member.platform,
    })), this.session.state?.layouts);
  }

  deviceChannels(route) {
    if (route.channelBasis === 'device') return route.channels;
    const slots = this.slots();
    return Object.fromEntries(Object.entries(slots).filter(([, device]) => device).map(([slot, device]) => [device.id, route.channels[slot]]));
  }

  validRouteChannels(message) {
    if (message.mode !== 'split-stereo') return true;
    if (message.channelBasis !== 'device') return this.platform !== this.peer?.platform;
    return this.peer?.deviceRouting === true && this.session.members.length === 2
      && this.session.members.every((member) => Object.hasOwn(message.channels, member.id));
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
    this.session.on('state', this.onLayout);
    this.refreshRouting();
    if (this.engine.available) {
      void Promise.resolve(this.engine.prepareRouting?.()).then(() => this.refreshOutputs())
        .catch((error) => { if (!this.route) this.update('error', error.message); });
    }
    this.refreshVolume();
    this.volumeTimer = setInterval(() => this.refreshVolume(), 1000);
    this.volumeTimer.unref?.();
    this.connectionChanged();
  }

  hello() {
    this.helloSent = this.session.sendPeer({ type: 'audio.hello', version: AUDIO_VERSION,
      deviceRouting: true,
      platform: ['darwin', 'win32'].includes(this.platform) ? this.platform : 'unsupported',
      canSend: this.canCapture, canReceive: this.engine.available && ['darwin', 'win32'].includes(this.platform),
      ...(this.engine.supportsStereoSplit ? { stereoSplit: true } : {}) });
  }

  connectionChanged() {
    const connected = this.session.phase === 'connected';
    if (connected === this.connected) return;
    this.connected = connected;
    this.peer = null;
    this.peerVolume = null;
    this.clearVolumeRequests();
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
      const member = this.session.members.find((candidate) => candidate.id === memberId);
      if (member.platform && member.platform !== message.platform) return;
      const first = !this.peer;
      this.peer = message;
      // Reply once as well as announcing on connect: either listener may start first.
      if (first || !this.helloSent) this.hello();
      if (first) this.publishVolume();
      this.emit('state', this.state());
      return;
    }
    if (message.type.startsWith('audio.volume-')) {
      if (!this.peer) return;
      if (message.type === 'audio.volume-state') {
        this.peerVolume = message.volume;
        this.emit('state', this.state());
      } else if (message.type === 'audio.volume-set') {
        let volume;
        try { volume = this.setLocalVolume(message.level); }
        catch (error) { volume = { error: this.volumeError(error) }; }
        this.session.sendPeer({ type: 'audio.volume-result', id: message.id, volume });
      } else if (message.type === 'audio.volume-result') {
        const request = this.volumeRequests.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.volumeRequests.delete(message.id);
        if (message.volume.error) request.reject(new Error(message.volume.error));
        else {
          this.peerVolume = message.volume;
          this.emit('state', this.state());
          request.resolve();
        }
      }
      return;
    }
    if (message.type === 'audio.stop') {
      if (this.route?.id === message.id) this.stopRoute('Audio sharing stopped.', false);
      return;
    }
    if (message.type === 'audio.channels') {
      if (this.route?.id !== message.id || this.route.role !== 'receiver' || this.route.mode !== 'split-stereo') return;
      if (!this.validRouteChannels(message) || message.channelBasis !== this.route.channelBasis) return;
      try {
        this.engine.setPlaybackChannel(this.channelFor(message));
        this.route.channels = message.channels;
        this.emit('state', this.state());
      } catch (error) { this.fail(this.route, error); }
      return;
    }
    if (message.type === 'audio.offer') {
      if (!this.engine.available || !this.peer?.canSend || !this.compatiblePeer()) return;
      if (!this.validRouteChannels(message) || (message.mode === 'split-stereo' && (!this.engine.supportsStereoSplit || !this.peer.stereoSplit))) {
        this.session.sendPeer({ type: 'audio.stop', id: message.id });
        return;
      }
      if (this.route) {
        if (this.route.role !== 'sender' || this.route.ready || message.id >= this.route.id) return;
        this.stopRoute('Resolving simultaneous audio requests.');
      }
      const route = this.route = { id: message.id, role: 'receiver', mode: message.mode || 'stereo', channels: message.channels, channelBasis: message.channelBasis };
      this.update('connecting', `Connecting to ${this.peer.platform === 'win32' ? 'Windows' : 'Mac'} audio...`);
      this.armTimeout(route, 90_000);
      const key = randomBytes(32).toString('hex');
      void this.engine.receive({ id: route.id, key, peerIp: this.session.peerAddress(), outputId: this.outputId, channel: this.channelFor(route) })
        .then((port) => { if (this.route === route) this.send({ type: 'audio.ready', id: route.id, port, key }); })
        .catch((error) => this.fail(route, error));
    } else if (message.type === 'audio.ready' && this.route?.id === message.id
      && this.route.role === 'sender' && !this.route.ready) {
      const route = this.route;
      route.ready = true;
      void this.engine.send({ id: route.id, key: message.key, peerIp: this.session.peerAddress(), port: message.port, outputId: route.outputId, sourceId: this.sourceId, channel: this.channelFor(route) })
        .then(() => {
          if (this.route === route && this.phase !== 'streaming') {
            this.update('connecting', 'Synchronizing both audio outputs...');
            this.armTimeout(route);
          }
        }).catch((error) => this.fail(route, error));
    } else if (message.type === 'audio.started' && this.route?.id === message.id && this.route.role === 'sender' && this.route.ready) {
      clearTimeout(this.timer);
      this.update('streaming', `Playing ${this.platform === 'win32' ? 'Windows' : 'Mac'} audio on both laptops on a shared schedule.`);
    }
  }

  send(message) {
    const clean = sanitizeAudioMessage(message);
    if (!clean || !this.session.sendPeer(clean)) throw new Error('The audio connection was interrupted. Try again.');
  }

  startRoute() {
    this.refreshRouting();
    const split = this.splitState();
    if (this.playbackMode === 'split-stereo' && !split.ready) throw new Error(split.reason);
    if (!this.state().canStart) throw new Error(this.platform === 'darwin'
      ? 'Connect to a Mac or Windows laptop running this version of CompuSync first. Mac audio requires the rebuilt native addon and macOS 14.6 or later.'
      : this.routing.reason || 'Connect to a Mac running the same current build and refresh audio devices first.');
    const route = this.route = { id: randomUUID(), role: 'sender', mode: this.playbackMode,
      ...(this.playbackMode === 'split-stereo' ? this.wireChannels(split.channels) : {}),
      outputId: this.platform === 'win32' ? this.routing.outputId || this.outputId : '' };
    this.update('starting', this.platform === 'win32' ? 'Preparing Windows audio routing and recovery.' : 'Starting Mac audio capture. Approve the macOS audio permission if prompted.');
    this.armTimeout(route, 90_000);
    try { this.send({ type: 'audio.offer', id: route.id,
      ...(route.mode === 'split-stereo' ? { mode: route.mode, channels: route.channels, ...(route.channelBasis ? { channelBasis: route.channelBasis } : {}) } : {}) }); }
    catch (error) { this.fail(route, error); }
  }

  splitState() {
    if (!this.engine.supportsStereoSplit) return { ready: false, reason: 'Rebuild the native addon to enable split stereo.' };
    if (!this.connected || !this.peer?.stereoSplit) return { ready: false, reason: 'Connect both laptops with split stereo support. Update and rebuild both native addons.' };
    return stereoAssignment(this.session.state?.layouts, this.layoutSettings, this.session.members);
  }

  wireChannels(channels, deviceRouting = this.peer?.deviceRouting) {
    if (deviceRouting) return { channels, channelBasis: 'device' };
    const slots = this.slots();
    return { channels: { mac: channels[slots.mac?.id], windows: channels[slots.windows?.id] } };
  }

  channelFor(route) {
    return route.channels?.[route.channelBasis === 'device' ? this.session.self.id : this.platform === 'darwin' ? 'mac' : 'windows'] || 'stereo';
  }

  setPlaybackMode(mode) {
    if (!validPlaybackMode(mode)) throw new Error('Choose a valid audio playback mode.');
    if (this.route) throw new Error('Stop audio sharing before changing the playback mode.');
    if (mode === 'split-stereo' && !this.engine.supportsStereoSplit) throw new Error('Rebuild the native addon to enable split stereo.');
    this.playbackMode = mode;
    this.emit('state', this.state());
  }

  layoutChanged(settings = this.layoutSettings) {
    this.layoutSettings = settings;
    const route = this.route;
    // The source owns assignments so both outputs always use one layout, even
    // while layout updates are still travelling across the paired connection.
    if (route?.role === 'sender' && route.mode === 'split-stereo') {
      const split = this.splitState();
      if (!split.ready) { this.stopRoute(split.reason); return; }
      const next = this.wireChannels(split.channels, route.channelBasis === 'device');
      if (JSON.stringify(next.channels) !== JSON.stringify(route.channels)) {
        try {
          this.send({ type: 'audio.channels', id: route.id, mode: route.mode, ...next });
          this.engine.setPlaybackChannel(this.channelFor(next));
          Object.assign(route, next);
        } catch (error) { this.fail(route, error); return; }
      }
    }
    this.emit('state', this.state());
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
    } else if (event.type === 'warning') {
      this.route.warning = typeof event.message === 'string' ? event.message.slice(0, 500) : null;
      this.emit('state', this.state());
    } else if (event.type === 'connected' && this.route.role === 'receiver') {
      clearTimeout(this.timer);
      try { this.send({ type: 'audio.started', id: this.route.id }); }
      catch (error) { this.fail(this.route, error); return; }
      this.update('receiving', `Playing ${this.peer?.platform === 'win32' ? 'Windows' : 'Mac'} audio on a shared schedule with the source laptop.`);
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
    if (this.route) throw new Error('Stop audio sharing before refreshing devices.');
    await this.engine.prepareRouting?.();
    if (this.route) return;
    this.refreshRouting();
    await this.engine.listOutputs();
    this.refreshVolume();
  }

  async setOutput(id) {
    if (!['win32', 'darwin'].includes(this.platform) || typeof id !== 'string' || id.length > 256) throw new Error('Choose an audio output.');
    if (this.route) throw new Error('Stop audio sharing before changing the output.');
    if (id && !this.outputs.some((output) => output.id === id)) throw new Error('Refresh the audio outputs and choose an available device.');
    if (id && this.routing.buses?.some((bus) => bus.id === id)) throw new Error('Choose physical speakers or headphones, not the Windows capture bus.');
    this.outputId = id;
    this.refreshRouting();
    this.refreshVolume();
    this.emit('state', this.state());
  }

  refreshRouting() {
    try { this.routing = this.engine.routingStatus?.(this.sourceId, this.outputId) || { ready: this.platform !== 'win32', buses: [] }; }
    catch (error) { this.routing = { ready: false, buses: [], reason: error.message }; }
    this.emit('state', this.state());
  }

  async setSource(id) {
    if (this.platform !== 'win32' || typeof id !== 'string' || id.length > 256) throw new Error('Choose a Windows capture bus.');
    if (this.route) throw new Error('Stop sharing before changing the capture bus.');
    if (id && !this.routing.buses?.some((bus) => bus.id === id)) throw new Error('Refresh and select an installed VB-CABLE capture bus.');
    this.sourceId = id; this.refreshRouting();
  }

  volumeOutputId() {
    return this.route?.role === 'sender' ? this.route.outputId || '' : this.outputId;
  }

  volumeError(error) {
    return (error?.message || 'Output volume is unavailable.').slice(0, 500);
  }

  refreshVolume() {
    let volume;
    try {
      volume = sanitizeVolume(this.engine.volume(this.volumeOutputId()));
      if (!volume) throw new Error('Output volume is unavailable.');
    } catch (error) { volume = { error: this.volumeError(error) }; }
    if (JSON.stringify(volume) === JSON.stringify(this.volume)) return;
    this.volume = volume;
    this.publishVolume();
    this.emit('state', this.state());
  }

  publishVolume() {
    if (this.connected && this.peer && this.volume) {
      this.session.sendPeer({ type: 'audio.volume-state', volume: this.volume });
    }
  }

  setLocalVolume(level) {
    const volume = sanitizeVolume(this.engine.setVolume(this.volumeOutputId(), level));
    if (!volume || volume.error) throw new Error(volume?.error || 'Output volume could not be changed.');
    this.volume = volume;
    this.publishVolume();
    this.emit('state', this.state());
    return volume;
  }

  async setVolume(deviceId, level) {
    if (!deviceId || !this.session.members.some((member) => member.id === deviceId) || !validVolumeLevel(level)) {
      throw new Error('Choose a laptop and a volume between 0 and 100.');
    }
    if (deviceId === this.session.self.id) { this.setLocalVolume(level); return; }
    if (!this.connected || !this.peer || !this.peerVolume || this.peerVolume.error) {
      throw new Error('Connect to the other laptop with volume controls available first.');
    }
    if (this.volumeRequests.size >= 16) throw new Error('Wait for the previous volume adjustment to finish.');
    const id = randomUUID();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.volumeRequests.delete(id);
        reject(new Error('The other laptop did not confirm the volume change. Try again.'));
      }, 5000);
      timer.unref?.();
      this.volumeRequests.set(id, { resolve, reject, timer });
      try { this.send({ type: 'audio.volume-set', id, level }); }
      catch (error) {
        clearTimeout(timer);
        this.volumeRequests.delete(id);
        reject(error);
      }
    });
  }

  clearVolumeRequests() {
    for (const request of this.volumeRequests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('The other laptop disconnected before confirming the volume change.'));
    }
    this.volumeRequests.clear();
  }

  stop() {
    clearInterval(this.volumeTimer);
    this.clearVolumeRequests();
    this.stopRoute();
    this.session.removeListener('status', this.onStatus);
    this.session.removeListener('peer-message', this.onMessage);
    this.engine.removeListener('event', this.onEngine);
    this.session.removeListener('state', this.onLayout);
    this.connected = false;
  }
}

module.exports = { AudioRouter };
