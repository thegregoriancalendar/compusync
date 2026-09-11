'use strict';

const { EventEmitter } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');
const { initialState, reduce, disconnect } = require('./state.cjs');
const { newSecret, createChannel, handshakeSalt } = require('./wire.cjs');

const validMember = (member) => member && /^[a-zA-Z0-9-]{1,80}$/.test(member.id) && typeof member.name === 'string' && member.name.length > 0 && member.name.length <= 80;

class Session extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.self = { id: config.id, name: config.name };
    this.state = initialState(config.id);
    if (config.startClosed) { this.state.open = false; this.state.views = []; }
    this.members = [this.self];
    this.connections = new Map();
    this.phase = 'starting';
    this.message = '';
    this.stopped = false;
    this.retryDelay = 500;
    this.port = config.port;
    this.clockOffsetMs = 0;
  }

  status() {
    return { role: this.config.role, phase: this.phase, message: this.message, peers: this.members.filter((m) => m.id !== this.self.id), port: this.port };
  }

  setStatus(phase, message = '') {
    this.phase = phase;
    this.message = message;
    this.emit('status', this.status());
  }

  async start() {
    if (this.config.role === 'host') await this.startHost();
    else this.connect();
  }

  async startHost() {
    this.server = new WebSocketServer({
      host: this.config.bindHost || '0.0.0.0', port: this.config.port,
      maxPayload: 16384, perMessageDeflate: false,
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

  accept(socket) {
    if (this.server.clients.size > 8) { socket.close(1013, 'Busy'); return; }
    const salt = newSecret();
    let channel;
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    let member;
    let rateStart = Date.now();
    let messages = 0;
    const timeout = setTimeout(() => socket.terminate(), 5000);
    socket.send(JSON.stringify({ type: 'challenge', version: 1, salt }));
    socket.on('message', (raw) => {
      try {
        if (Date.now() - rateStart > 1000) { rateStart = Date.now(); messages = 0; }
        if (++messages > 300) throw new Error('Too many messages.');
        if (!channel) {
          const keyMessage = JSON.parse(raw.toString());
          if (keyMessage.type !== 'key') throw new Error('Missing key handshake.');
          channel = createChannel(this.config.secret, handshakeSalt(salt, keyMessage.salt), true);
          return;
        }
        const message = channel.open(raw);
        if (!member) {
          if (message.type !== 'hello' || !validMember(message.member) || message.member.id === this.self.id) throw new Error('Invalid identity.');
          if (this.connections.size > 0) {
            socket.send(channel.seal({ type: 'rejected', message: 'Two laptops are already connected. Disconnect the other laptop first.' }));
            socket.close(1008, 'Session full');
            return;
          }
          member = { id: message.member.id, name: message.member.name };
          clearTimeout(timeout);
          this.connections.set(member.id, { socket, channel });
          this.members = [this.self, member];
          if (this.state.open) this.state = reduce(this.state, member.id, { type: 'show' }, this.members.map((m) => m.id));
          socket.send(channel.seal({ type: 'welcome', state: this.state, members: this.members, serverTime: Date.now() }));
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
      if (!member || this.connections.get(member.id)?.socket !== socket) return;
      this.connections.delete(member.id);
      this.members = [this.self];
      this.state = disconnect(this.state, member.id, [this.self.id]);
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
          if (challenge.type !== 'challenge' || challenge.version !== 1) throw new Error('Incompatible version.');
          const peerSalt = newSecret();
          this.channel = createChannel(this.config.secret, handshakeSalt(challenge.salt, peerSalt), false);
          socket.send(JSON.stringify({ type: 'key', salt: peerSalt }));
          socket.send(this.channel.seal({ type: 'hello', member: this.self }));
          return;
        }
        const message = this.channel.open(raw);
        if (message.type === 'rejected') { failure = message.message; socket.close(); return; }
        if (!['welcome', 'snapshot'].includes(message.type) || !message.state || message.state.version !== 1 || !Array.isArray(message.members) || message.members.length !== 2 || !message.members.every(validMember) || !message.members.some((m) => m.id === this.self.id)) throw new Error('Invalid state.');
        if (!authenticated && message.type !== 'welcome') throw new Error('Missing welcome.');
        this.state = message.state;
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
      this.channel = null;
      if (this.stopped) return;
      if (!authenticated && reason.toString().includes('authentication')) failure = 'Pairing failed. Copy a fresh invitation from the other laptop.';
      this.members = [this.self];
      this.state = structuredClone(this.state);
      this.state.cursor.active = [];
      this.state.cursor.buttons = {};
      this.emit('state', this.state);
      this.setStatus('reconnecting', failure);
      this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(5000, this.retryDelay * 2);
    });
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
    this.publish();
    return true;
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
    clearInterval(this.heartbeat);
    this.socket?.terminate();
    if (this.server) {
      for (const socket of this.server.clients) socket.terminate();
      await new Promise((resolve) => this.server.close(resolve));
    }
    this.connections.clear();
    this.removeAllListeners();
  }
}

module.exports = { Session };
