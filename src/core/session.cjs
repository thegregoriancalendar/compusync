'use strict';

const { EventEmitter } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');
const { initialState, reduce, disconnect } = require('./state.cjs');
const { normalizeLayout, buildTopology, normalizeLogicalRect } = require('./geometry.cjs');
const { newSecret, createChannel, handshakeSalt } = require('./wire.cjs');
const { newCode, pairingSecret, CODE_LIFETIME } = require('./pairing.cjs');
const { advertise } = require('./discovery.cjs');

const PROTOCOL_VERSION = 2;
const DRAG_TOKEN = /^[A-Za-z0-9_-]{8,80}$/;
const DATA_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CONTROL_WIRE_MAX = 65536;
const DATA_PLAINTEXT_MAX = 1024 * 1024;
const DATA_WIRE_MAX = 1500000;
const DATA_BACKPRESSURE_MAX = 2 * 1024 * 1024;

const validMember = (member) => member && /^[a-zA-Z0-9-]{1,80}$/.test(member.id) && typeof member.name === 'string' && member.name.length > 0 && member.name.length <= 80;

function sanitizeDataMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || Buffer.byteLength(serialized) > DATA_PLAINTEXT_MAX) return null;
    const clean = JSON.parse(serialized);
    return clean && typeof clean === 'object' && !Array.isArray(clean) ? clean : null;
  } catch {
    return null;
  }
}

function sameRect(first, second) {
  return first && second && first.x === second.x && first.y === second.y
    && first.width === second.width && first.height === second.height;
}

// Rebuild derived topology instead of trusting it from the network. This also
// bounds every collection copied into the renderer-facing client state.
function validateSnapshot(value, members) {
  if (!value || value.version !== 2 || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.open !== 'boolean' || !value.window?.rect || !value.layouts
    || typeof value.layouts !== 'object' || Array.isArray(value.layouts)) return null;
  const ids = members.map((member) => member.id);
  const normalizedRect = normalizeLogicalRect(value.window.rect);
  if (!sameRect(normalizedRect, value.window.rect)) return null;
  const layouts = {};
  for (const [id, candidate] of Object.entries(value.layouts)) {
    if (!ids.includes(id) || Object.keys(layouts).length >= ids.length) return null;
    const layout = normalizeLayout(candidate);
    if (!layout) return null;
    layouts[id] = layout;
  }
  const cursor = value.cursor;
  if (!cursor || !Number.isFinite(cursor.x) || cursor.x < 0 || cursor.x > 1
    || !Number.isFinite(cursor.y) || cursor.y < 0 || cursor.y > 1
    || !Array.isArray(cursor.active) || cursor.active.length > ids.length
    || new Set(cursor.active).size !== cursor.active.length || !cursor.active.every((id) => ids.includes(id))
    || !cursor.buttons || typeof cursor.buttons !== 'object' || Array.isArray(cursor.buttons)
    || !Array.isArray(cursor.trail) || cursor.trail.length > 48) return null;
  for (const [id, buttons] of Object.entries(cursor.buttons)) {
    if (!ids.includes(id) || !Number.isInteger(buttons) || buttons < 0 || buttons > 31) return null;
  }
  if (!cursor.trail.every((point) => point && Number.isFinite(point.x) && point.x >= 0 && point.x <= 1
    && Number.isFinite(point.y) && point.y >= 0 && point.y <= 1 && Number.isFinite(point.t)
    && Number.isSafeInteger(point.serial) && point.serial >= 0)) return null;
  if (!value.scene || !Number.isFinite(value.scene.epoch)) return null;
  if (value.click !== null && (!value.click || !Number.isSafeInteger(value.click.serial)
    || !Number.isFinite(value.click.x) || value.click.x < 0 || value.click.x > 1
    || !Number.isFinite(value.click.y) || value.click.y < 0 || value.click.y > 1)) return null;
  let drag = null;
  if (value.drag !== null) {
    const candidate = value.drag;
    const startRect = normalizeLogicalRect(candidate?.startRect);
    if (!candidate || !DRAG_TOKEN.test(candidate.id) || !ids.includes(candidate.owner)
      || !Number.isFinite(candidate.offsetX) || !Number.isFinite(candidate.offsetY)
      || !sameRect(startRect, candidate.startRect) || !Number.isSafeInteger(candidate.lastSeq)
      || candidate.lastSeq < 0 || !Number.isFinite(candidate.leaseUntil)) return null;
    drag = { ...candidate, startRect };
  }
  return {
    version: 2,
    revision: value.revision,
    open: value.open,
    window: { rect: normalizedRect },
    layouts,
    topology: buildTopology(layouts, ids),
    drag,
    cursor: {
      x: cursor.x,
      y: cursor.y,
      active: [...cursor.active],
      buttons: { ...cursor.buttons },
      trail: cursor.trail.map((point) => ({ ...point })),
    },
    scene: { epoch: value.scene.epoch },
    click: value.click ? { ...value.click } : null,
  };
}

class Session extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.self = { id: config.id, name: config.name };
    this.state = initialState(config.id, Date.now(), config.layout);
    if (config.startClosed) this.state.open = false;
    this.members = [this.self];
    this.connections = new Map();
    this.phase = 'starting';
    this.message = '';
    this.stopped = false;
    this.retryDelay = 500;
    this.port = config.port;
    this.clockOffsetMs = 0;
    this.pairingAttempts = [];
    this.pairingInFlight = 0;
    this.pairingCode = null;
    this.dataPhase = 'disconnected';
    this.dataRetryDelay = 250;
    this.dataToken = null;
  }

  status() {
    return { role: this.config.role, phase: this.phase, message: this.message, peers: this.members.filter((m) => m.id !== this.self.id), port: this.port };
  }

  setStatus(phase, message = '') {
    this.phase = phase;
    this.message = message;
    this.emit('status', this.status());
  }

  setDataStatus(phase, message = '', memberId = null) {
    this.dataPhase = phase;
    this.emit('data-status', { phase, message, memberId });
  }

  async start() {
    if (this.config.role === 'host') await this.startHost();
    else this.connect();
  }

  async startHost() {
    this.server = new WebSocketServer({
      host: this.config.bindHost || '0.0.0.0', port: this.config.port,
      // The shared listener must admit bulk frames. Each channel below still
      // enforces its own authenticated wire limit, including control's 64 KiB.
      maxPayload: DATA_WIRE_MAX, perMessageDeflate: false,
      // A browser page must not be able to connect to the local service.
      verifyClient: ({ origin }, done) => done(!origin, 403, 'Desktop clients only'),
    });
    this.server.on('connection', (socket) => this.accept(socket));
    await new Promise((resolve, reject) => {
      this.server.once('listening', resolve);
      this.server.once('error', reject);
    });
    this.server.on('error', (error) => this.setStatus('error', error.message));
    this.port = this.server.address().port;
    this.refreshCode();
    if (this.config.discovery !== false) {
      try {
        this.discovery = await advertise(() => this.canPair() ? { id: this.self.id, port: this.port } : null);
      } catch { this.discoveryError = 'Automatic discovery is unavailable. Use the laptop address in Connection help.'; }
    }
    this.setStatus('hosting');
    this.heartbeat = setInterval(() => {
      for (const socket of this.server.clients) {
        if (socket.isAlive === false) { socket.terminate(); continue; }
        socket.isAlive = false;
        socket.ping();
      }
    }, 3000);
    this.heartbeat.unref();
    this.emit('state', this.state);
  }

  canPair() {
    return !this.stopped && !this.connections.size && this.pairingCode && Date.now() < this.pairingExpiresAt;
  }

  refreshCode() {
    clearTimeout(this.pairingTimer);
    this.pairingCode = newCode();
    this.pairingExpiresAt = Date.now() + CODE_LIFETIME;
    this.pairingTimer = setTimeout(() => this.emit('status', this.status()), CODE_LIFETIME);
    this.pairingTimer.unref();
    this.emit('status', this.status());
  }

  invitation() {
    return { code: this.canPair() ? this.pairingCode : '', expiresAt: this.pairingExpiresAt || 0, discoveryError: this.discoveryError || '' };
  }

  accept(socket) {
    if (this.server.clients.size > 8) { socket.close(1013, 'Busy'); return; }
    const salt = newSecret();
    let channel;
    let mode = 'session', purpose = 'control', codeForAttempt, deriving = false;
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    let member, dataMemberId;
    let rateStart = Date.now();
    let messages = 0;
    const timeout = setTimeout(() => socket.terminate(), 5000);
    socket.send(JSON.stringify({ type: 'challenge', version: PROTOCOL_VERSION, salt }));
    socket.on('message', async (raw) => {
      try {
        if (deriving || mode === 'done') throw new Error('Unexpected message.');
        if (Date.now() - rateStart > 1000) { rateStart = Date.now(); messages = 0; }
        if (++messages > 300) throw new Error('Too many messages.');
        if (!channel) {
          if (raw.length > CONTROL_WIRE_MAX) throw new Error('Handshake too large.');
          const keyMessage = JSON.parse(raw.toString());
          if (keyMessage.type !== 'key') throw new Error('Missing key handshake.');
          purpose = keyMessage.purpose ?? 'control';
          if (!['control', 'data'].includes(purpose)) throw new Error('Invalid channel purpose.');
          const combined = handshakeSalt(salt, keyMessage.salt);
          if (keyMessage.mode === 'pair') {
            if (purpose !== 'control') throw new Error('Invalid pairing channel.');
            this.pairingAttempts = this.pairingAttempts.filter((time) => Date.now() - time < 60000);
            if (!this.canPair() || this.pairingAttempts.length >= 6 || this.pairingInFlight >= 2) throw new Error('Pairing unavailable.');
            this.pairingAttempts.push(Date.now());
            mode = 'pair';
            codeForAttempt = this.pairingCode;
            deriving = true;
            this.pairingInFlight++;
            let secret;
            try { secret = await pairingSecret(codeForAttempt, combined); }
            finally { deriving = false; this.pairingInFlight--; }
            if (socket.readyState !== WebSocket.OPEN || this.stopped) return;
            channel = createChannel(secret, combined, true);
            socket.send(channel.seal({ type: 'pair-ready' }));
          } else {
            mode = purpose === 'data' ? 'data' : 'session';
            channel = createChannel(this.config.secret, combined, true, purpose === 'data'
              ? { context: 'data', maxMessage: DATA_WIRE_MAX }
              : undefined);
          }
          return;
        }
        const message = channel.open(raw);
        if (mode === 'pair') {
          if (message.type !== 'claim' || !this.canPair() || this.pairingCode !== codeForAttempt) throw new Error('Code no longer valid.');
          mode = 'done';
          this.pairingCode = null;
          clearTimeout(this.pairingTimer);
          socket.send(channel.seal({ type: 'paired', secret: this.config.secret }));
          this.emit('status', this.status());
          socket.close(1000, 'Paired');
          return;
        }
        if (mode === 'data') {
          if (!dataMemberId) {
            const connection = this.connections.get(message?.memberId);
            if (message?.type !== 'data-hello' || !connection || !DATA_TOKEN.test(message.token)
              || message.token !== connection.dataToken || connection.dataSocket) throw new Error('Invalid data binding.');
            dataMemberId = message.memberId;
            clearTimeout(timeout);
            connection.dataSocket = socket;
            connection.dataChannel = channel;
            socket.send(channel.seal({ type: 'data-ready' }));
            this.setDataStatus('connected', '', dataMemberId);
          } else {
            if (message?.type !== 'data-message') throw new Error('Unknown data message.');
            const clean = sanitizeDataMessage(message.message);
            if (!clean) throw new Error('Invalid data message.');
            this.emit('data', clean, dataMemberId);
          }
          return;
        }
        if (!member) {
          if (message.type !== 'hello' || !validMember(message.member) || message.member.id === this.self.id) throw new Error('Invalid identity.');
          if (this.connections.size > 0) {
            socket.send(channel.seal({ type: 'rejected', message: 'Two laptops are already connected. Disconnect the other laptop first.' }));
            socket.close(1008, 'Session full');
            return;
          }
          member = { id: message.member.id, name: message.member.name };
          clearTimeout(timeout);
          const dataToken = newSecret();
          this.connections.set(member.id, { socket, channel, dataToken, dataSocket: null, dataChannel: null });
          this.members = [this.self, member];
          socket.send(channel.seal({ type: 'welcome', state: this.state, members: this.members, serverTime: Date.now(), dataToken }));
          this.setStatus('connected');
          this.publish();
        } else if (message.type === 'action') {
          this.apply(member.id, message.action);
        } else {
          throw new Error('Unknown message.');
        }
      } catch {
        socket.close(1008, 'Invalid authentication or message');
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timeout);
      if (dataMemberId) {
        const connection = this.connections.get(dataMemberId);
        if (connection?.dataSocket === socket) {
          connection.dataSocket = null;
          connection.dataChannel = null;
          this.setDataStatus('disconnected', '', dataMemberId);
        }
        return;
      }
      if (!member || this.connections.get(member.id)?.socket !== socket) return;
      if (this.connections.get(member.id)?.dataSocket) {
        this.connections.get(member.id).dataSocket.terminate();
        this.setDataStatus('disconnected', '', member.id);
      }
      this.connections.delete(member.id);
      this.members = [this.self];
      this.state = disconnect(this.state, member.id, [this.self.id]);
      this.scheduleDragLease();
      if (!this.stopped) { this.setStatus('hosting', 'The other laptop disconnected. Waiting for it to reconnect.'); this.publish(); }
    });
  }

  connect() {
    if (this.stopped) return;
    this.setStatus('connecting', 'Connecting to the other laptop…');
    const socket = new WebSocket(`ws://${this.config.host}:${this.config.port}`, { handshakeTimeout: 5000, maxPayload: 16384, perMessageDeflate: false });
    this.socket = socket;
    this.channel = null;
    let authenticated = false;
    let failure = 'Connection lost. Reconnecting automatically…';
    let lastTraffic = Date.now();
    const timer = setTimeout(() => { failure = 'The other laptop did not finish pairing. Check the invitation.'; socket.terminate(); }, 6000);
    const watchdog = setInterval(() => { if (Date.now() - lastTraffic > 11000) socket.terminate(); }, 3000);
    watchdog.unref();
    socket.on('ping', () => { lastTraffic = Date.now(); });
    socket.on('message', (raw) => {
      lastTraffic = Date.now();
      try {
        if (!this.channel) {
          const challenge = JSON.parse(raw.toString());
          if (challenge.type !== 'challenge' || challenge.version !== PROTOCOL_VERSION) throw new Error('Incompatible version.');
          const peerSalt = newSecret();
          this.channel = createChannel(this.config.secret, handshakeSalt(challenge.salt, peerSalt), false);
          socket.send(JSON.stringify({ type: 'key', salt: peerSalt }));
          socket.send(this.channel.seal({ type: 'hello', member: this.self }));
          return;
        }
        const message = this.channel.open(raw);
        if (message.type === 'rejected') { failure = message.message; socket.close(); return; }
        if (!['welcome', 'snapshot'].includes(message.type) || !Array.isArray(message.members) || message.members.length !== 2 || !message.members.every(validMember) || !message.members.some((m) => m.id === this.self.id)) throw new Error('Invalid state.');
        if (!authenticated && message.type !== 'welcome') throw new Error('Missing welcome.');
        if (!authenticated && !DATA_TOKEN.test(message.dataToken)) throw new Error('Missing data binding.');
        const nextState = validateSnapshot(message.state, message.members);
        if (!nextState) throw new Error('Invalid state.');
        this.state = nextState;
        this.members = message.members;
        if (Number.isFinite(message.serverTime)) {
          const offset = message.serverTime - Date.now();
          this.clockOffsetMs = authenticated ? this.clockOffsetMs * .9 + offset * .1 : offset;
        }
        if (!authenticated) {
          authenticated = true;
          clearTimeout(timer);
          this.retryDelay = 500;
          this.setStatus('connected');
          this.dataToken = message.dataToken;
          this.connectData();
        }
        this.emit('state', this.state);
      } catch {
        failure = 'Pairing failed. Copy a fresh invitation from the other laptop.';
        socket.close(1008, 'Invalid message');
      }
    });
    socket.on('error', (error) => {
      failure = error.code === 'ECONNREFUSED' ? 'The other laptop is unavailable. Keep CompuSync running on it.' : 'Cannot reach the other laptop. Check Wi-Fi, its address, and the firewall.';
    });
    socket.on('close', (_code, reason) => {
      clearTimeout(timer);
      clearInterval(watchdog);
      this.closeData();
      this.channel = null;
      if (this.stopped) return;
      if (!authenticated && reason.toString().includes('authentication')) failure = 'Pairing failed. Copy a fresh invitation from the other laptop.';
      this.members = [this.self];
      this.state = structuredClone(this.state);
      this.state.cursor.active = [];
      this.state.cursor.buttons = {};
      if (this.state.drag) {
        this.state.window.rect = this.state.drag.startRect;
        this.state.drag = null;
      }
      this.emit('state', this.state);
      this.setStatus('reconnecting', failure);
      this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(5000, this.retryDelay * 2);
    });
  }

  closeData() {
    clearTimeout(this.dataRetryTimer);
    this.dataRetryTimer = null;
    const socket = this.dataSocket;
    this.dataSocket = null;
    this.dataChannel = null;
    this.dataToken = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
    if (this.dataPhase !== 'disconnected') this.setDataStatus('disconnected');
  }

  connectData() {
    if (this.stopped || this.config.role !== 'join' || this.phase !== 'connected'
      || !DATA_TOKEN.test(this.dataToken) || this.dataSocket) return;
    clearTimeout(this.dataRetryTimer);
    this.dataRetryTimer = null;
    const token = this.dataToken;
    const socket = new WebSocket(`ws://${this.config.host}:${this.config.port}`, {
      handshakeTimeout: 5000,
      maxPayload: DATA_WIRE_MAX,
      perMessageDeflate: false,
    });
    this.dataSocket = socket;
    this.dataChannel = null;
    this.setDataStatus('connecting');
    let channel;
    let authenticated = false;
    const timer = setTimeout(() => socket.terminate(), 6000);
    socket.on('message', (raw) => {
      try {
        if (!channel) {
          if (raw.length > CONTROL_WIRE_MAX) throw new Error('Handshake too large.');
          const challenge = JSON.parse(raw.toString());
          if (challenge.type !== 'challenge' || challenge.version !== PROTOCOL_VERSION) throw new Error('Incompatible version.');
          const peerSalt = newSecret();
          channel = createChannel(this.config.secret, handshakeSalt(challenge.salt, peerSalt), false, { context: 'data', maxMessage: DATA_WIRE_MAX });
          socket.send(JSON.stringify({ type: 'key', purpose: 'data', salt: peerSalt }));
          socket.send(channel.seal({ type: 'data-hello', memberId: this.self.id, token }));
          return;
        }
        const packet = channel.open(raw);
        if (!authenticated) {
          if (packet?.type !== 'data-ready') throw new Error('Missing data welcome.');
          authenticated = true;
          clearTimeout(timer);
          this.dataChannel = channel;
          this.dataRetryDelay = 250;
          this.setDataStatus('connected', '', this.members.find((member) => member.id !== this.self.id)?.id || null);
          return;
        }
        if (packet?.type !== 'data-message') throw new Error('Unknown data message.');
        const clean = sanitizeDataMessage(packet.message);
        if (!clean) throw new Error('Invalid data message.');
        this.emit('data', clean, this.members.find((member) => member.id !== this.self.id)?.id || null);
      } catch {
        socket.close(1008, 'Invalid data message');
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timer);
      if (this.dataSocket !== socket) return;
      this.dataSocket = null;
      this.dataChannel = null;
      if (this.stopped || this.phase !== 'connected' || this.dataToken !== token) {
        this.setDataStatus('disconnected');
        return;
      }
      this.setDataStatus('reconnecting', 'Bulk data connection interrupted.');
      this.dataRetryTimer = setTimeout(() => this.connectData(), this.dataRetryDelay);
      this.dataRetryTimer.unref();
      this.dataRetryDelay = Math.min(3000, this.dataRetryDelay * 2);
    });
  }

  sendData(message) {
    if (this.stopped) return false;
    const clean = sanitizeDataMessage(message);
    if (!clean) return false;
    let socket, channel;
    if (this.config.role === 'host') {
      const connection = this.connections.values().next().value;
      socket = connection?.dataSocket;
      channel = connection?.dataChannel;
    } else {
      socket = this.dataSocket;
      channel = this.dataChannel;
    }
    if (!socket || !channel || socket.readyState !== WebSocket.OPEN
      || socket.bufferedAmount > DATA_BACKPRESSURE_MAX) return false;
    try {
      socket.send(channel.seal({ type: 'data-message', message: clean }));
      return true;
    } catch {
      return false;
    }
  }

  action(action) {
    if (this.stopped) return false;
    if (this.config.role === 'host') return this.apply(this.self.id, action);
    if (this.phase !== 'connected' || !this.channel || this.socket?.readyState !== WebSocket.OPEN) return false;
    if (this.socket.bufferedAmount > 65536) { this.socket.terminate(); return false; }
    this.socket.send(this.channel.seal({ type: 'action', action }));
    return true;
  }

  apply(id, action) {
    const next = reduce(this.state, id, action, this.members.map((m) => m.id));
    if (next === this.state) return false;
    this.state = next;
    this.scheduleDragLease();
    this.publish();
    return true;
  }

  scheduleDragLease() {
    clearTimeout(this.dragLeaseTimer);
    this.dragLeaseTimer = null;
    if (this.config.role !== 'host' || !this.state.drag) return;
    const { owner, id, leaseUntil } = this.state.drag;
    this.dragLeaseTimer = setTimeout(() => {
      if (!this.state.drag || this.state.drag.owner !== owner || this.state.drag.id !== id) return;
      if (this.state.drag.leaseUntil > Date.now()) { this.scheduleDragLease(); return; }
      this.apply(owner, { type: 'drag-cancel', id });
    }, Math.max(1, leaseUntil - Date.now() + 1));
    this.dragLeaseTimer.unref();
  }

  publish() {
    this.emit('state', this.state);
    // Coalesce movement into at most 125 snapshots/s; lifecycle events still
    // arrive within one frame. Never build an unbounded slow-client queue.
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      for (const { socket, channel } of this.connections.values()) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        if (socket.bufferedAmount > 65536) { socket.terminate(); continue; }
        socket.send(channel.seal({ type: 'snapshot', state: this.state, members: this.members, serverTime: Date.now() }));
      }
    }, 8);
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.broadcastTimer);
    clearTimeout(this.dragLeaseTimer);
    clearInterval(this.heartbeat);
    clearTimeout(this.pairingTimer);
    this.closeData();
    this.discovery?.stop();
    this.socket?.terminate();
    if (this.server) {
      for (const socket of this.server.clients) socket.terminate();
      await new Promise((resolve) => this.server.close(resolve));
    }
    this.connections.clear();
    this.removeAllListeners();
  }
}

module.exports = {
  Session,
  PROTOCOL_VERSION,
  validateSnapshot,
  sanitizeDataMessage,
  DATA_PLAINTEXT_MAX,
  DATA_WIRE_MAX,
  DATA_BACKPRESSURE_MAX,
};
