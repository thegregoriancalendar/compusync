'use strict';

const { EventEmitter } = require('node:events');
const net = require('node:net');
const { randomUUID } = require('node:crypto');

const PIPE_NAME = '\\\\.\\pipe\\compusync-chrome-v3';
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_INBOUND_MESSAGE_BYTES = 5 * 1024 * 1024;
const CHUNK_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

function protocolError(code, message) {
  return Object.assign(new Error(message), { code });
}

function encodeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (!payload.length || payload.length > MAX_MESSAGE_BYTES) {
    throw protocolError('CHROME_BRIDGE_MESSAGE_TOO_LARGE', 'Chrome bridge message is too large.');
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

class FrameDecoder {
  constructor(onMessage, options = {}) {
    this.onMessage = onMessage;
    this.maxBytes = options.maxBytes || MAX_INBOUND_MESSAGE_BYTES;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk) || !chunk.length) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (!length || length > this.maxBytes) {
        throw protocolError('CHROME_BRIDGE_INVALID_FRAME', 'Chrome bridge sent an invalid frame.');
      }
      if (this.buffer.length < length + 4) return;
      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      let message;
      try { message = JSON.parse(payload.toString('utf8')); }
      catch { throw protocolError('CHROME_BRIDGE_INVALID_JSON', 'Chrome bridge sent invalid JSON.'); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        throw protocolError('CHROME_BRIDGE_INVALID_MESSAGE', 'Chrome bridge sent an invalid message.');
      }
      this.onMessage(message);
    }
  }
}

function encodeRequestFrames(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length <= MAX_MESSAGE_BYTES) return [encodeMessage(message)];
  if (payload.length > MAX_INBOUND_MESSAGE_BYTES) {
    throw protocolError('CHROME_BRIDGE_MESSAGE_TOO_LARGE', 'Chrome bridge request is too large.');
  }
  const total = Math.ceil(payload.length / CHUNK_BYTES);
  return Array.from({ length: total }, (_, index) => encodeMessage({
    v: 1, type: 'chunk', transferId: message.id, index, total,
    data: payload.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString('base64'),
  }));
}

class ChromeNativeMessagingServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pipeName = options.pipeName || PIPE_NAME;
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : REQUEST_TIMEOUT_MS;
    this.net = options.net || net;
    this.server = null;
    this.connections = new Set();
    this.readyConnection = null;
    this.pending = new Map();
  }

  get connected() { return Boolean(this.readyConnection && !this.readyConnection.destroyed); }

  async start() {
    if (this.server) return this;
    const server = this.net.createServer((socket) => this.#accept(socket));
    this.server = server;
    server.on('error', (error) => this.emit('error', error));
    await new Promise((resolve, reject) => {
      const failed = (error) => { server.off('listening', resolve); reject(error); };
      server.once('error', failed);
      server.once('listening', () => { server.off('error', failed); resolve(); });
      server.listen(this.pipeName);
    });
    return this;
  }

  #accept(socket) {
    socket.setNoDelay?.(true);
    this.connections.add(socket);
    const decoder = new FrameDecoder((message) => this.#message(socket, message));
    socket.on('data', (chunk) => {
      try { decoder.push(chunk); }
      catch (error) { this.emit('error', error); socket.destroy(); }
    });
    const closed = () => this.#disconnect(socket);
    socket.once('close', closed);
    socket.once('error', (error) => {
      if (this.connections.has(socket)) this.emit('error', error);
    });
  }

  #message(socket, message) {
    if (message.v !== 1) return;
    if (message.type === 'hello') {
      this.readyConnection = socket;
      this.emit('ready', {
        extensionId: String(message.extensionId || ''),
        extensionVersion: String(message.extensionVersion || ''),
      });
      return;
    }
    if (typeof message.id !== 'string') return;
    const pending = this.pending.get(message.id);
    if (!pending || pending.socket !== socket) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok === true) pending.resolve(message.result);
    else pending.reject(protocolError(
      typeof message.error?.code === 'string' ? message.error.code : 'CHROME_EXTENSION_ERROR',
      typeof message.error?.message === 'string' ? message.error.message : 'The Chrome helper could not complete the request.',
    ));
  }

  #disconnect(socket) {
    this.connections.delete(socket);
    if (this.readyConnection === socket) {
      this.readyConnection = null;
      this.emit('disconnect');
    }
    for (const [id, pending] of this.pending) {
      if (pending.socket !== socket) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(protocolError('CHROME_EXTENSION_DISCONNECTED', 'The Chrome helper disconnected.'));
    }
  }

  request(method, params = {}) {
    if (!this.connected) {
      return Promise.reject(protocolError('CHROME_EXTENSION_UNAVAILABLE', 'Install or reload the CompuSync Chrome helper first.'));
    }
    if (typeof method !== 'string' || !/^[a-z]+(?:\.[a-z]+)*$/.test(method)) {
      return Promise.reject(new TypeError('A valid Chrome bridge method is required.'));
    }
    const socket = this.readyConnection;
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(protocolError('CHROME_EXTENSION_TIMEOUT', 'The Chrome helper timed out.'));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { socket, resolve, reject, timer });
      try {
        for (const frame of encodeRequestFrames({ v: 1, id, method, params })) socket.write(frame);
      }
      catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async stop() {
    const server = this.server;
    this.server = null;
    this.readyConnection = null;
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(protocolError('CHROME_EXTENSION_DISCONNECTED', 'The Chrome helper stopped.'));
    }
    if (server) await new Promise((resolve) => server.close(resolve));
  }
}

module.exports = {
  ChromeNativeMessagingServer,
  FrameDecoder,
  CHUNK_BYTES,
  MAX_INBOUND_MESSAGE_BYTES,
  MAX_MESSAGE_BYTES,
  PIPE_NAME,
  REQUEST_TIMEOUT_MS,
  encodeMessage,
  encodeRequestFrames,
  protocolError,
};
