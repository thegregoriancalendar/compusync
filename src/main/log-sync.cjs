'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const LOG_VERSION = 1;
const MAX_BACKLOG_BYTES = 128 * 1024;
const MAX_CHUNK_BYTES = 16 * 1024;
const POLL_INTERVAL_MS = 250;
const RETRY_INTERVAL_MS = 1000;
const HELLO_INTERVAL_MS = 2000;
const STREAM_ID = /^[a-f0-9-]{36}$/;
const validOffset = (value) => Number.isSafeInteger(value) && value >= 0;
const validStream = (value) => typeof value === 'string' && STREAM_ID.test(value);

class LogSync {
  constructor({ session, logPath, platform = process.platform, intervalMs = POLL_INTERVAL_MS, onError = () => {} }) {
    if (!session?.on || !session?.sendData || typeof logPath !== 'string' || !logPath) {
      throw new TypeError('LogSync requires a session and a local log path.');
    }
    this.session = session;
    this.logPath = path.resolve(logPath);
    this.peerLogPath = path.join(path.dirname(this.logPath), 'compusync-peer.log');
    if (this.logPath === this.peerLogPath) throw new TypeError('Local and peer logs must be separate files.');
    this.platform = ['darwin', 'win32', 'linux'].includes(platform) ? platform : 'unknown';
    this.intervalMs = intervalMs;
    this.onError = onError;
    this.stream = randomUUID();
    this.size = 0;
    this.identity = null;
    this.requestedOffset = null;
    this.lastHello = 0;
    this.lastChunk = null;
    this.remote = null;
    this.running = false;
    this.polling = false;
    this.receiving = false;
    this.epoch = 0;
    this.lastError = '';
    this.onStatus = () => {
      if (this.#connected()) return;
      this.epoch++;
      this.requestedOffset = null;
      this.lastHello = 0;
      this.lastChunk = null;
    };
    this.onData = (message, memberId) => {
      if (!this.#connected() || message?.version !== LOG_VERSION
        || !['logs.hello', 'logs.request', 'logs.chunk'].includes(message?.type)
        || !this.session.members?.some((member) => member.id === memberId && member.id !== this.session.self.id)) return;
      // ACKs update only an integer and must not wait behind incoming disk IO:
      // both computers can be writing each other's chunks at the same time.
      if (message.type === 'logs.request') {
        if (message.stream === this.stream && validOffset(message.offset) && message.offset <= this.size) {
          this.requestedOffset = Math.max(this.requestedOffset ?? 0, message.offset);
        }
        return;
      }
      if (this.receiving) return;
      // One disk write at a time also bounds work from an overactive peer.
      // Dropped packets are retried from the last acknowledged byte offset.
      this.receiving = true;
      void this.#receive(message, memberId, this.epoch)
        .catch((error) => this.#report(error))
        .finally(() => { this.receiving = false; });
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.session.on('status', this.onStatus);
    this.session.on('data-status', this.onStatus);
    this.session.on('data', this.onData);
    this.timer = setInterval(() => { void this.poll(); }, this.intervalMs);
    this.timer.unref?.();
    void this.poll();
  }

  stop() {
    this.running = false;
    this.epoch++;
    clearInterval(this.timer);
    this.session.removeListener('status', this.onStatus);
    this.session.removeListener('data-status', this.onStatus);
    this.session.removeListener('data', this.onData);
  }

  #connected() {
    return this.running && this.session.phase === 'connected' && this.session.dataPhase === 'connected';
  }

  #send(type, details) {
    return this.#connected() && this.session.sendData({ type, version: LOG_VERSION, ...details });
  }

  #report(error) {
    const message = error?.message || String(error);
    if (message === this.lastError) return;
    this.lastError = message;
    this.onError(error);
  }

  async poll() {
    if (this.polling || !this.#connected()) return false;
    this.polling = true;
    const epoch = this.epoch;
    let file;
    try {
      file = await fs.open(this.logPath, 'r');
      const stat = await file.stat();
      if (!this.#connected() || epoch !== this.epoch || !stat.isFile()) return false;
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      if (this.identity !== null && (identity !== this.identity || stat.size < this.size)) {
        this.stream = randomUUID();
        this.requestedOffset = null;
        this.lastHello = 0;
        this.lastChunk = null;
      }
      this.identity = identity;
      this.size = stat.size;
      const start = Math.max(0, this.size - MAX_BACKLOG_BYTES);
      if (this.requestedOffset !== null && this.requestedOffset < start) {
        this.requestedOffset = null;
        this.lastHello = 0;
      }
      const now = Date.now();
      if (!this.lastHello || now - this.lastHello >= HELLO_INTERVAL_MS) {
        if (this.#send('logs.hello', { stream: this.stream, platform: this.platform, start, end: this.size })) {
          this.lastHello = now;
        }
      }
      const offset = this.requestedOffset;
      if (offset === null || offset >= this.size
        || (this.lastChunk?.offset === offset && now - this.lastChunk.time < RETRY_INTERVAL_MS)) return false;
      const buffer = Buffer.alloc(Math.min(MAX_CHUNK_BYTES, this.size - offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      if (!bytesRead || !this.#connected() || epoch !== this.epoch) return false;
      // Never advance on send: only the receiver's request acknowledges bytes
      // written to disk. A dropped connection or ACK safely retries the chunk.
      if (!this.#send('logs.chunk', { stream: this.stream, offset, data: buffer.subarray(0, bytesRead).toString('base64') })) return false;
      this.lastChunk = { offset, time: now };
      return true;
    } catch (error) {
      this.#report(error);
      return false;
    } finally {
      try { await file?.close(); }
      catch (error) { this.#report(error); }
      finally { this.polling = false; }
    }
  }

  async #receive(message, memberId, epoch) {
    if (!validStream(message.stream)) return;
    if (message.type === 'logs.hello') {
      if (!validOffset(message.start) || !validOffset(message.end) || message.start > message.end
        || message.end - message.start > MAX_BACKLOG_BYTES
        || !['darwin', 'win32', 'linux', 'unknown'].includes(message.platform)) return;
      const previous = this.remote;
      const sameStream = previous?.memberId === memberId && previous.stream === message.stream;
      if (!sameStream || previous.offset < message.start) {
        const member = this.session.members.find((candidate) => candidate.id === memberId);
        const header = {
          time: new Date().toISOString(), peer: memberId, name: member.name,
          platform: message.platform, stream: message.stream, offset: message.start,
          skippedBytes: sameStream ? message.start - previous.offset : message.start,
        };
        await fs.appendFile(this.peerLogPath, `\n[CompuSync peer log ${JSON.stringify(header)}]\n`);
        if (!this.#connected() || epoch !== this.epoch) return;
        this.remote = { memberId, stream: message.stream, offset: message.start };
      }
    } else if (message.type === 'logs.chunk') {
      const remote = this.remote;
      if (!remote || remote.memberId !== memberId || remote.stream !== message.stream
        || !validOffset(message.offset) || typeof message.data !== 'string'
        || !message.data.length || message.data.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4) return;
      const data = Buffer.from(message.data, 'base64');
      if (!data.length || data.length > MAX_CHUNK_BYTES || data.toString('base64') !== message.data
        || !validOffset(message.offset + data.length)) return;
      if (message.offset === remote.offset) {
        await fs.appendFile(this.peerLogPath, data);
        remote.offset += data.length;
        if (!this.#connected() || epoch !== this.epoch) return;
      }
    }
    if (this.remote?.memberId === memberId && this.remote.stream === message.stream) {
      this.#send('logs.request', { stream: this.remote.stream, offset: this.remote.offset });
    }
  }
}

module.exports = { LogSync, LOG_VERSION, MAX_BACKLOG_BYTES, MAX_CHUNK_BYTES, POLL_INTERVAL_MS, RETRY_INTERVAL_MS };
