'use strict';

const { createHash } = require('node:crypto');

const MAX_TEXT_BYTES = 1024 * 1024;
const POLL_INTERVAL_MS = 250;
const DIGEST = /^[a-f0-9]{64}$/;

function digestText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function cleanTextMessage(message, expectedType) {
  if (!message || message.type !== expectedType || typeof message.text !== 'string'
    || !DIGEST.test(message.digest) || Buffer.byteLength(message.text, 'utf8') > MAX_TEXT_BYTES
    || digestText(message.text) !== message.digest) return null;
  if (expectedType === 'clipboard.apply'
    && (!Number.isSafeInteger(message.revision) || message.revision < 1)) return null;
  return expectedType === 'clipboard.apply'
    ? { type: expectedType, revision: message.revision, digest: message.digest, text: message.text }
    : { type: expectedType, digest: message.digest, text: message.text };
}

class ClipboardSync {
  constructor(options = {}) {
    if (!options.session?.on || !options.session?.sendPeer
      || !options.clipboard?.readText || !options.clipboard?.writeText) {
      throw new TypeError('ClipboardSync requires a session and clipboard adapter.');
    }
    this.session = options.session;
    this.clipboard = options.clipboard;
    this.isHost = (options.role || options.session.config?.role) === 'host';
    this.incomingType = this.isHost ? 'clipboard.offer' : 'clipboard.apply';
    this.enabled = options.enabled !== false;
    this.intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs >= 25
      ? options.intervalMs : POLL_INTERVAL_MS;
    this.logger = options.logger || null;
    this.running = false;
    this.connected = options.session.phase === 'connected';
    this.initialized = false;
    this.observedDigest = null;
    this.revision = 0;
    this.lastAppliedRevision = 0;
    this.pending = null;
    this.queue = Promise.resolve();
    this.pollPending = false;
    this.onStatus = (status) => this.#status(status);
    this.onPeerMessage = (message) => {
      if (message?.type === this.incomingType) void this.#enqueue(() => this.#receive(message));
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.session.on('status', this.onStatus);
    this.session.on('peer-message', this.onPeerMessage);
    this.timer = setInterval(() => { void this.poll(); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
    this.pending = null;
    this.session.removeListener?.('status', this.onStatus);
    this.session.removeListener?.('peer-message', this.onPeerMessage);
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.enabled === next) return;
    this.enabled = next;
    this.pending = null;
    this.initialized = false;
    this.observedDigest = null;
  }

  async poll() {
    if (this.pollPending) return false;
    this.pollPending = true;
    try { return await this.#enqueue(() => this.#poll()); }
    finally { this.pollPending = false; }
  }

  #enqueue(task) {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => {});
    return result;
  }

  async #poll() {
    if (!this.running || !this.enabled) return false;
    try {
      if (this.pending && this.connected && this.session.sendPeer(this.pending)) this.pending = null;
      const hasPlainText = typeof this.clipboard.has !== 'function'
        || await this.clipboard.has('text/plain');
      const text = hasPlainText ? await this.clipboard.readText() : '';
      if (typeof text !== 'string') return false;
      const digest = digestText(text);
      if (!this.initialized) {
        this.initialized = true;
        this.observedDigest = digest;
        return false;
      }
      if (digest === this.observedDigest) return false;
      this.observedDigest = digest;
      const bytes = Buffer.byteLength(text, 'utf8');
      if (!text || bytes > MAX_TEXT_BYTES || !this.connected) return false;
      const message = this.isHost
        ? { type: 'clipboard.apply', revision: ++this.revision, digest, text }
        : { type: 'clipboard.offer', digest, text };
      if (!this.session.sendPeer(message)) this.pending = message;
      this.logger?.info?.('clipboard.sent', { bytes });
      return true;
    } catch (error) {
      this.logger?.warn?.('clipboard.poll.failed', { message: error?.message || String(error) });
      return false;
    }
  }

  #status(status) {
    const connected = status?.phase === 'connected';
    if (this.connected === connected) return;
    this.connected = connected;
    this.pending = null;
    this.initialized = false;
    this.observedDigest = null;
  }

  async #receive(message) {
    if (!this.running || !this.enabled || !this.connected) return false;
    const clean = cleanTextMessage(message, this.incomingType);
    if (!clean) return false;
    if (!this.isHost && clean.revision <= this.lastAppliedRevision) return false;
    if (!this.isHost) this.lastAppliedRevision = clean.revision;
    if (clean.digest !== this.observedDigest) {
      try {
        this.observedDigest = clean.digest;
        this.initialized = true;
        await this.clipboard.writeText(clean.text);
        this.logger?.info?.('clipboard.received', { bytes: Buffer.byteLength(clean.text, 'utf8') });
      } catch (error) {
        this.initialized = false;
        this.logger?.warn?.('clipboard.write.failed', { message: error?.message || String(error) });
        return false;
      }
    }
    if (this.isHost) {
      const applied = {
        type: 'clipboard.apply', revision: ++this.revision,
        digest: clean.digest, text: clean.text,
      };
      if (!this.session.sendPeer(applied)) this.pending = applied;
    }
    return true;
  }
}

module.exports = { ClipboardSync, MAX_TEXT_BYTES, POLL_INTERVAL_MS, digestText, cleanTextMessage };
