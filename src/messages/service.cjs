'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const {
  SERVICE_VERSION, REQUEST_ID, exactObject, conversation, messagesState, command, historyResult,
} = require('./contracts.cjs');

const MAX_PENDING = 16;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;

class MessagesServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MessagesServiceError';
    this.code = code;
  }
}

function boundedClone(value) {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || Buffer.byteLength(serialized) > MAX_ENVELOPE_BYTES) return null;
    return JSON.parse(serialized);
  } catch { return null; }
}

function safeError(error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,48}$/.test(error.code)
    ? error.code : 'MESSAGES_ERROR';
  const allowed = new Set([
    'MESSAGES_UNAVAILABLE', 'MESSAGES_FULL_DISK_ACCESS', 'MESSAGES_SCHEMA_UNSUPPORTED',
    'MESSAGES_INVALID_RESPONSE', 'REQUEST_TIMEOUT', 'DATA_UNAVAILABLE', 'INVALID_REQUEST',
  ]);
  const message = allowed.has(code) && typeof error?.message === 'string'
    ? error.message.slice(0, 500) : 'The Messages request could not be completed.';
  return { code, message };
}

function publicResult(method, value) {
  if (method === 'conversations.list') {
    if (!Array.isArray(value) || value.length > 500) return null;
    const clean = value.map(conversation);
    return clean.includes(null) ? null : clean;
  }
  if (method === 'history.list') {
    if (!value || (value.before !== null && (!Number.isSafeInteger(value.before) || value.before < 1))) return null;
    const clean = historyResult({
      conversationId: value.conversationId,
      messages: value.messages,
      hasMore: value.hasMore,
    });
    return clean ? { ...clean, before: value.before } : null;
  }
  if (method === 'message.send') {
    return exactObject(value, ['accepted', 'clientId']) && value.accepted === true
      && REQUEST_ID.test(value.clientId || '') ? { accepted: true, clientId: value.clientId } : null;
  }
  return null;
}

class MessagesService extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.session) throw new TypeError('MessagesService requires a session.');
    this.session = options.session;
    this.platform = options.platform || process.platform;
    this.bridge = options.bridge || null;
    this.isMac = this.platform === 'darwin';
    if (this.isMac && !this.bridge) throw new TypeError('The macOS Messages service requires a bridge.');
    this.currentState = {
      version: SERVICE_VERSION,
      available: false,
      reason: this.isMac ? 'Messages Companion is starting.' : 'Waiting for the Mac.',
      conversations: [],
    };
    this.pending = new Map();
    this.activeRequests = new Set();
    this.started = false;
    this.stopped = false;
    this.onData = (message, memberId) => { void this._handleData(message, memberId); };
    this.onDataStatus = (status) => this._handleDataStatus(status);
    this.onSessionStatus = (status) => this._handleSessionStatus(status);
  }

  start() {
    if (this.started) return this.state();
    if (this.stopped) throw new MessagesServiceError('SERVICE_STOPPED', 'Messages Companion has stopped.');
    this.session.on('data', this.onData);
    this.session.on('data-status', this.onDataStatus);
    this.session.on('status', this.onSessionStatus);
    if (this.isMac) this._setAvailability();
    this.started = true;
    if (this.isMac && this.session.dataPhase === 'connected') this._broadcastState();
    return this.state();
  }

  state() { return structuredClone(this.currentState); }

  _setAvailability() {
    const availability = this.bridge.state();
    this.currentState = {
      version: SERVICE_VERSION,
      available: Boolean(availability.available),
      reason: String(availability.reason || '').slice(0, 500),
      conversations: this.currentState.conversations,
    };
    this.emit('state', this.state());
  }

  _send(value) {
    const envelope = boundedClone({ type: 'compusync-messages', ...value });
    return Boolean(envelope && this.session.sendData(envelope));
  }

  _broadcastState() {
    return this.isMac && this._send({ kind: 'state', state: this.state() });
  }

  async _dispatch(method, payload) {
    const request = command(method, payload);
    if (!request) throw new MessagesServiceError('INVALID_REQUEST', 'The Messages request is invalid.');
    if (method === 'conversations.list') {
      const conversations = await this.bridge.listConversations();
      this._setAvailability();
      this.currentState.conversations = conversations;
      this.emit('state', this.state());
      this._broadcastState();
      return conversations;
    }
    if (method === 'history.list') return this.bridge.history(request);
    if (method === 'message.send') return this.bridge.sendText(request);
    throw new MessagesServiceError('INVALID_REQUEST', 'The Messages request is invalid.');
  }

  request(method, payload = {}) {
    if (!this.started || this.stopped) return Promise.reject(new MessagesServiceError('SERVICE_STOPPED', 'Messages Companion is not running.'));
    if (this.isMac) return this._dispatch(method, payload);
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new MessagesServiceError('PENDING_LIMIT', 'Too many Messages requests are active.'));
    const clean = command(method, payload);
    if (!clean) return Promise.reject(new MessagesServiceError('INVALID_REQUEST', 'The Messages request is invalid.'));
    const requestId = `request-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new MessagesServiceError('REQUEST_TIMEOUT', 'The Mac did not answer the Messages request.'));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(requestId, { method, resolve, reject, timer });
      if (!this._send({ kind: 'request', requestId, method, payload: clean })) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new MessagesServiceError('DATA_UNAVAILABLE', 'The Mac is not connected.'));
      }
    });
  }

  async _handleData(message, memberId) {
    if (this.stopped || message?.type !== 'compusync-messages') return;
    if (this.isMac) {
      if (!memberId || message.kind !== 'request'
        || !exactObject(message, ['type', 'kind', 'requestId', 'method', 'payload'])
        || !REQUEST_ID.test(message.requestId || '') || this.activeRequests.size >= MAX_PENDING
        || this.activeRequests.has(message.requestId)) return;
      this.activeRequests.add(message.requestId);
      try {
        const result = publicResult(message.method, await this._dispatch(message.method, message.payload));
        if (result === null) throw new MessagesServiceError('INVALID_RESULT', 'Messages returned an invalid result.');
        this._send({ kind: 'result', requestId: message.requestId, ok: true, result });
      } catch (error) {
        this._send({ kind: 'result', requestId: message.requestId, ok: false, error: safeError(error) });
      } finally { this.activeRequests.delete(message.requestId); }
      return;
    }
    if (message.kind === 'state' && exactObject(message, ['type', 'kind', 'state'])) {
      const state = messagesState(message.state);
      if (state) {
        this.currentState = state;
        this.emit('state', this.state());
      }
      return;
    }
    if (message.kind !== 'result'
      || !exactObject(message, ['type', 'kind', 'requestId', 'ok', 'result', 'error'], ['type', 'kind', 'requestId', 'ok'])
      || !REQUEST_ID.test(message.requestId || '') || typeof message.ok !== 'boolean') return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (!message.ok) {
      const safe = safeError(message.error);
      pending.reject(new MessagesServiceError(safe.code, safe.message));
      return;
    }
    const result = publicResult(pending.method, message.result);
    if (result === null) pending.reject(new MessagesServiceError('INVALID_RESULT', 'The Mac returned an invalid Messages result.'));
    else pending.resolve(result);
  }

  _handleDataStatus(status) {
    if (this.stopped || !status) return;
    if (this.isMac && status.phase === 'connected') {
      this._setAvailability();
      this._broadcastState();
    }
    if (!this.isMac && status.phase === 'disconnected') this._rejectPending('DATA_UNAVAILABLE', 'The Mac disconnected.');
  }

  _handleSessionStatus(status) {
    if (!this.isMac && status?.phase !== 'connected') this._rejectPending('DATA_UNAVAILABLE', 'The Mac disconnected.');
  }

  _rejectPending(code, message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new MessagesServiceError(code, message));
    }
    this.pending.clear();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.session.off?.('data', this.onData);
    this.session.off?.('data-status', this.onDataStatus);
    this.session.off?.('status', this.onSessionStatus);
    this._rejectPending('SERVICE_STOPPED', 'Messages Companion stopped.');
    this.bridge?.close?.();
  }
}

module.exports = { MessagesService, MessagesServiceError, publicResult, safeError };
