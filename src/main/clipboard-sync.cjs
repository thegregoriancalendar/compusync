'use strict';

const { createHash } = require('node:crypto');

const MAX_TEXT_BYTES = 1024 * 1024;
// Images travel base64-encoded inside one peer message, whose JSON is capped at
// 4 MiB by the session. Keep the raw bytes under 3 MiB minus envelope room.
const MAX_IMAGE_BYTES = 3 * 1024 * 1024 - 64 * 1024;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg']);
const JPEG_QUALITIES = [92, 80, 65];
const IMAGE_CHECK_MS = 1000;
const POLL_INTERVAL_MS = 250;
const DIGEST = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function digestText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function digestBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function cleanTextMessage(message, expectedType) {
  if (!message || message.type !== expectedType || message.kind !== undefined || typeof message.text !== 'string'
    || !DIGEST.test(message.digest) || Buffer.byteLength(message.text, 'utf8') > MAX_TEXT_BYTES
    || digestText(message.text) !== message.digest) return null;
  if (expectedType === 'clipboard.apply'
    && (!Number.isSafeInteger(message.revision) || message.revision < 1)) return null;
  return expectedType === 'clipboard.apply'
    ? { type: expectedType, revision: message.revision, digest: message.digest, text: message.text }
    : { type: expectedType, digest: message.digest, text: message.text };
}

// Returns the validated message plus decoded bytes, or null.
function cleanImageMessage(message, expectedType) {
  if (!message || message.type !== expectedType || message.kind !== 'image' || !IMAGE_MIMES.has(message.mime)
    || typeof message.data !== 'string' || !message.data
    || message.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !BASE64.test(message.data)
    || !DIGEST.test(message.digest)) return null;
  if (expectedType === 'clipboard.apply'
    && (!Number.isSafeInteger(message.revision) || message.revision < 1)) return null;
  const bytes = Buffer.from(message.data, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || digestBytes(bytes) !== message.digest) return null;
  const clean = { type: expectedType, kind: 'image', mime: message.mime, digest: message.digest, data: message.data };
  if (expectedType === 'clipboard.apply') clean.revision = message.revision;
  return { message: clean, bytes };
}

// Electron's async clipboard exposes images as PNG blobs. Change detection
// hashes the clipboard's PNG bytes; JPEG is only a transport fallback.
function createElectronImageAdapter(clipboard, nativeImage, ClipboardItem) {
  const readPng = async () => {
    if (!await clipboard.has('image/png')) return null;
    for (const item of await clipboard.read()) {
      if (!item.types.includes('image/png')) continue;
      const bytes = Buffer.from(await (await item.getType('image/png')).arrayBuffer());
      if (bytes.length) return bytes;
    }
    return null;
  };
  return {
    async read() {
      const png = await readPng();
      if (!png) return null;
      return {
        digest: digestBytes(png),
        encode: () => {
          if (png.length <= MAX_IMAGE_BYTES) return { mime: 'image/png', bytes: png };
          const image = nativeImage.createFromBuffer(png);
          if (image.isEmpty()) return null;
          for (const quality of JPEG_QUALITIES) {
            const jpeg = image.toJPEG(quality);
            if (jpeg.length <= MAX_IMAGE_BYTES) return { mime: 'image/jpeg', bytes: jpeg };
          }
          return null;
        },
      };
    },
    async write(bytes, mime) {
      let png = bytes;
      if (mime !== 'image/png') {
        const image = nativeImage.createFromBuffer(bytes);
        if (image.isEmpty()) throw new Error('Received clipboard image could not be decoded.');
        png = image.toPNG();
      }
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
      // Baseline on what the OS actually stores so the next poll does not echo it.
      const stored = await readPng();
      return digestBytes(stored || png);
    },
  };
}

class ClipboardSync {
  constructor(options = {}) {
    if (!options.session?.on || !options.session?.sendPeer
      || !options.clipboard?.readText || !options.clipboard?.writeText) {
      throw new TypeError('ClipboardSync requires a session and clipboard adapter.');
    }
    this.session = options.session;
    this.clipboard = options.clipboard;
    this.images = options.images?.read && options.images?.write ? options.images : null;
    this.isHost = (options.role || options.session.config?.role) === 'host';
    this.incomingType = this.isHost ? 'clipboard.offer' : 'clipboard.apply';
    this.enabled = options.enabled !== false;
    this.intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs >= 25
      ? options.intervalMs : POLL_INTERVAL_MS;
    this.imageEvery = Math.max(1, Math.round(IMAGE_CHECK_MS / this.intervalMs));
    this.pollCount = 0;
    this.logger = options.logger || null;
    this.running = false;
    this.connected = options.session.phase === 'connected';
    this.initialized = false;
    // `text:<sha>` or `image:<pixel sha>` describing the local clipboard.
    this.observedKey = null;
    // Wire digest of the last image exchanged, and the local key it produced.
    this.imageWire = null;
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
    this.#reset();
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
      const imageTick = this.pollCount++ % this.imageEvery === 0;
      const hasPlainText = typeof this.clipboard.has !== 'function'
        || await this.clipboard.has('text/plain');
      const text = hasPlainText ? await this.clipboard.readText() : '';
      if (typeof text !== 'string') return false;
      let key, image = null;
      if (text || !this.images) key = `text:${digestText(text)}`;
      else {
        // Image reads decode the whole bitmap; check them at a slower cadence.
        if (!imageTick) return false;
        image = await this.images.read();
        key = image ? `image:${image.digest}` : `text:${digestText('')}`;
      }
      if (!this.initialized) {
        this.initialized = true;
        this.observedKey = key;
        return false;
      }
      if (key === this.observedKey) return false;
      this.observedKey = key;
      if (!this.connected) return false;
      return image ? this.#sendImage(image, key) : this.#sendText(text);
    } catch (error) {
      this.logger?.warn?.('clipboard.poll.failed', { message: error?.message || String(error) });
      return false;
    }
  }

  #sendText(text) {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (!text || bytes > MAX_TEXT_BYTES) return false;
    const digest = digestText(text);
    this.#send(this.isHost
      ? { type: 'clipboard.apply', revision: ++this.revision, digest, text }
      : { type: 'clipboard.offer', digest, text });
    this.logger?.info?.('clipboard.sent', { bytes });
    return true;
  }

  #sendImage(image, key) {
    const encoded = image.encode();
    if (!encoded) {
      this.logger?.info?.('clipboard.image.too-large', {});
      return false;
    }
    const digest = digestBytes(encoded.bytes);
    const body = { kind: 'image', mime: encoded.mime, digest, data: encoded.bytes.toString('base64') };
    this.imageWire = { digest, key };
    this.#send(this.isHost
      ? { type: 'clipboard.apply', revision: ++this.revision, ...body }
      : { type: 'clipboard.offer', ...body });
    this.logger?.info?.('clipboard.sent', { kind: 'image', mime: encoded.mime, bytes: encoded.bytes.length });
    return true;
  }

  #send(message) {
    if (!this.session.sendPeer(message)) this.pending = message;
  }

  #reset() {
    this.initialized = false;
    this.observedKey = null;
    this.imageWire = null;
  }

  #status(status) {
    const connected = status?.phase === 'connected';
    if (this.connected === connected) return;
    this.connected = connected;
    this.pending = null;
    this.#reset();
  }

  async #receive(message) {
    if (!this.running || !this.enabled || !this.connected) return false;
    const isImage = message.kind === 'image';
    const cleaned = isImage ? cleanImageMessage(message, this.incomingType) : null;
    const clean = isImage ? cleaned?.message : cleanTextMessage(message, this.incomingType);
    if (!clean) return false;
    if (!this.isHost && clean.revision <= this.lastAppliedRevision) return false;
    if (!this.isHost) this.lastAppliedRevision = clean.revision;
    if (isImage && !this.images) return false;
    const current = isImage
      ? this.imageWire?.digest === clean.digest && this.imageWire.key === this.observedKey
      : this.observedKey === `text:${clean.digest}`;
    if (!current) {
      try {
        this.initialized = true;
        if (isImage) {
          this.observedKey = `image:${await this.images.write(cleaned.bytes, clean.mime)}`;
          this.imageWire = { digest: clean.digest, key: this.observedKey };
          this.logger?.info?.('clipboard.received', { kind: 'image', mime: clean.mime, bytes: cleaned.bytes.length });
        } else {
          this.observedKey = `text:${clean.digest}`;
          await this.clipboard.writeText(clean.text);
          this.logger?.info?.('clipboard.received', { bytes: Buffer.byteLength(clean.text, 'utf8') });
        }
      } catch (error) {
        this.#reset();
        this.logger?.warn?.('clipboard.write.failed', { message: error?.message || String(error) });
        return false;
      }
    }
    if (this.isHost) {
      const { type, ...body } = clean;
      this.#send({ ...body, type: 'clipboard.apply', revision: ++this.revision });
    }
    return true;
  }
}

module.exports = {
  ClipboardSync, MAX_TEXT_BYTES, MAX_IMAGE_BYTES, POLL_INTERVAL_MS,
  digestText, cleanTextMessage, cleanImageMessage, createElectronImageAdapter,
};
