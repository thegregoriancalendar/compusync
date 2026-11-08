'use strict';

// Streams dragged files and folders between the paired computers.
//
// Control (Session.sendPeer, reliable and ordered):
//   file.offer  S→R { id, count, names, purpose?, bytes?, files? }
//                   purpose 'drag' (default) or 'clipboard'; clipboard offers
//                   are sent after the walk and declare totals the receiver
//                   enforces
//   file.accept R→S { id }                 receiver chose a folder; start
//   file.reject R→S { id, reason }
//   file.ack    R→S { id, bytes, frames }  receiver has written this much
//   file.done   R→S { id }                 every file verified and in place
//   file.cancel S↔R { id, reason }
// Data socket (ordered with each other, separate from control):
//   file.manifest JSON  { id, files, bytes, entries }  totals for progress
//   file.frame    binary header + bytes, one entry at a time, pre-order
//   file.end      JSON  { id }                           no more entries
//
// The sender only streams after an accept and never has more than a bounded
// window of unacknowledged bytes in flight, so neither side ever holds a
// whole file in memory. The receiver writes each file to a hidden partial in
// its destination folder, checks the SHA-256 the sender computed while
// reading, and then links it to a name that never overwrites anything.

const { EventEmitter } = require('node:events');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

const PROTOCOL_VERSION = 1;
const MiB = 1024 * 1024;
const CHUNK_BYTES = 4 * MiB;
const WINDOW_BYTES = 32 * MiB;
const WINDOW_FRAMES = 512;
const ACK_BYTES = 4 * MiB;
const ACK_FRAMES = 64;
// The host closes a data socket that exceeds 1200 messages/s. Leave room for
// other features sharing the socket.
const FRAMES_PER_SECOND = 800;
const STALL_MS = 60_000;
const OFFER_TIMEOUT_MS = 5 * 60_000;
const OFFER_NAMES_MAX = 16;
const ITEMS_MAX = 10_000;
const ENTRIES_MAX = 500_000;
const PATH_MAX = 4096;
const DEPTH_MAX = 128;
const NAME_BYTES_MAX = 255;
const COLLISION_LIMIT = 10_000;
const PROGRESS_INTERVAL_MS = 100;
const ID = /^[A-Za-z0-9_-]{16,64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REASON = /^[a-z-]{1,40}$/;
const PURPOSES = new Set(['drag', 'clipboard']);
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EINVAL', 'EMLINK']);
const EMPTY = Buffer.alloc(0);
const EMPTY_SHA256 = createHash('sha256').digest('hex');

class FileTransferError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FileTransferError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new FileTransferError(code, message); };
const count = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Splits a sender-supplied relative path into segments, rejecting anything
// that could name a location outside the destination folder.
function validateRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > PATH_MAX || value.includes('\0')) {
    fail('INVALID_PATH', 'Transfer path is empty, too long, or contains NUL.');
  }
  // A drive root ("C:", "C:\…"). Other colons are legal Mac names and are
  // replaced by sanitizeSegment on Windows, so "C:foo" cannot go anywhere.
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:([\\/]|$)/.test(value)) {
    fail('INVALID_PATH', 'Transfer paths must be relative.');
  }
  const segments = value.split('/');
  if (segments.length > DEPTH_MAX) fail('INVALID_PATH', 'Transfer path is nested too deeply.');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') fail('INVALID_PATH', 'Transfer path has an empty or relative segment.');
  }
  return segments;
}

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(result + character) > maxBytes) break;
    result += character;
  }
  return result;
}

function splitExtension(name, isDirectory) {
  const extension = isDirectory ? '' : path.extname(name);
  // Keep pathological "extensions" (a long tail after the last dot) in the base.
  return extension && extension.length <= 32 ? [name.slice(0, -extension.length), extension] : [name, ''];
}

// One path segment as it may be created on this computer.
function sanitizeSegment(segment, platform = process.platform, isDirectory = false) {
  let name = String(segment).replace(/[\u0000-\u001f\u007f]/g, '_');
  if (platform === 'win32') {
    name = name.replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '');
    if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  } else {
    name = name.replace(/\//g, '_');
  }
  if (!name || name === '.' || name === '..') name = '_';
  const [base, extension] = splitExtension(name, isDirectory);
  return truncateUtf8(base, NAME_BYTES_MAX - Buffer.byteLength(extension)) + extension;
}

// "name.ext" → "name (n).ext", staying within the file-system name limit.
function collisionName(name, n, isDirectory = false) {
  if (!n) return name;
  const suffix = ` (${n})`;
  const [base, extension] = splitExtension(name, isDirectory);
  return truncateUtf8(base, NAME_BYTES_MAX - Buffer.byteLength(suffix + extension)) + suffix + extension;
}

function assertInside(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('INVALID_PATH', 'Resolved transfer path escapes its destination.');
  }
}

async function createDirectoryExclusive(root, parent, name) {
  for (let n = 0; n < COLLISION_LIMIT; n++) {
    const candidate = path.join(parent, collisionName(name, n, true));
    assertInside(root, candidate);
    try {
      await fsp.mkdir(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  return fail('COLLISION_LIMIT', 'Too many items with the same name.');
}

// Moves a verified partial to the first free name. link() fails with EEXIST
// instead of replacing, so an existing file is never overwritten; volumes
// without hard links fall back to check-then-rename.
async function finalizeExclusive(root, partial, parent, name) {
  for (let n = 0; n < COLLISION_LIMIT; n++) {
    const candidate = path.join(parent, collisionName(name, n));
    assertInside(root, candidate);
    try {
      await fsp.link(partial, candidate);
      await fsp.unlink(partial);
      return candidate;
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      if (!LINK_UNSUPPORTED.has(error?.code)) throw error;
      try { await fsp.lstat(candidate); continue; } catch (missing) { if (missing?.code !== 'ENOENT') throw missing; }
      await fsp.rename(partial, candidate);
      return candidate;
    }
  }
  return fail('COLLISION_LIMIT', 'Too many items with the same name.');
}

function reasonOf(error) {
  if (error instanceof FileTransferError) {
    return {
      INVALID_PATH: 'invalid', PROTOCOL: 'invalid', HASH_MISMATCH: 'hash-mismatch',
      SOURCE_CHANGED: 'source-changed', TOO_MANY: 'too-many', TOO_LARGE: 'too-large', COLLISION_LIMIT: 'io',
      DISCONNECTED: 'disconnected', STALLED: 'stalled',
    }[error.code] || 'failed';
  }
  return ['ENOENT', 'EACCES', 'EPERM'].includes(error?.code) ? 'source-missing' : 'io';
}

class FileTransfer extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.session?.on || !options.session?.sendPeer || !options.session?.sendDataFrame) {
      throw new TypeError('FileTransfer requires a Session.');
    }
    this.session = options.session;
    this.platform = options.platform || process.platform;
    this.chunkBytes = options.chunkBytes || CHUNK_BYTES;
    this.windowBytes = options.windowBytes || WINDOW_BYTES;
    this.framesPerSecond = options.framesPerSecond || FRAMES_PER_SECOND;
    this.stallMs = options.stallMs || STALL_MS;
    this.logger = options.logger || null;
    this.active = null;
    this.running = false;
    this.onPeer = (message, memberId) => this.#peer(message, memberId);
    this.onData = (message, memberId) => this.#data(message, memberId);
    this.onFrame = (header, payload, memberId) => this.#frame(header, payload, memberId);
    this.onStatus = (status) => { if (status?.phase !== 'connected') this.#abortActive('disconnected'); };
    this.onDataStatus = (status) => {
      if (status?.phase !== 'connected' && this.active?.phase === 'transferring') this.#abortActive('disconnected');
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.session.on('peer-message', this.onPeer);
    this.session.on('data', this.onData);
    this.session.on('data-frame', this.onFrame);
    this.session.on('status', this.onStatus);
    this.session.on('data-status', this.onDataStatus);
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    this.session.removeListener?.('peer-message', this.onPeer);
    this.session.removeListener?.('data', this.onData);
    this.session.removeListener?.('data-frame', this.onFrame);
    this.session.removeListener?.('status', this.onStatus);
    this.session.removeListener?.('data-status', this.onDataStatus);
    const active = this.active;
    if (active) {
      this.#send({ type: 'file.cancel', id: active.id, reason: 'cancelled' });
      await this.#abort(active, 'cancelled');
    }
  }

  get busy() {
    return Boolean(this.active);
  }

  // 'drag' or 'clipboard' for the transfer in progress, else null.
  get activePurpose() {
    return this.active?.purpose || null;
  }

  state() {
    const t = this.active || this.lastFinished;
    if (!t) return null;
    return {
      id: t.id, direction: t.direction, purpose: t.purpose, phase: t.phase, names: t.names.slice(0, OFFER_NAMES_MAX),
      count: t.count, totalBytes: t.totalBytes, totalFiles: t.totalFiles,
      bytes: t.bytes, files: t.files, reason: t.reason || null,
    };
  }

  // Sender: announce local files or folders. Returns the transfer id.
  // A 'clipboard' offer is announced only once its folders are walked, with
  // totals the receiver can refuse; it fails locally as 'too-large' when it
  // exceeds maxBytes/maxFiles. Drag offers go out at once.
  offer(paths, { purpose = 'drag', maxBytes = Infinity, maxFiles = Infinity } = {}) {
    if (!this.running) fail('STOPPED', 'File transfer is not running.');
    if (this.active) fail('BUSY', 'Another file transfer is already in progress.');
    if (!PURPOSES.has(purpose)) fail('INVALID_OFFER', 'Unknown transfer purpose.');
    if (!Array.isArray(paths) || !paths.length || paths.length > ITEMS_MAX) fail('INVALID_OFFER', 'Choose between 1 and 10000 items.');
    const sources = [...new Set(paths.map((value) => {
      if (typeof value !== 'string' || !path.isAbsolute(value)) fail('INVALID_OFFER', 'Items must be absolute paths.');
      return path.resolve(value);
    }))];
    const names = sources.map((source) => path.basename(source));
    for (const name of names) {
      try { if (validateRelativePath(name).length !== 1) throw new Error(); }
      catch { fail('INVALID_OFFER', 'An item has no usable name.'); }
    }
    const t = this.#create(randomBytes(18).toString('base64url'), 'send', names, sources.length, purpose);
    t.sources = sources;
    t.ackedBytes = 0;
    t.ackedFrames = 0;
    t.sentBytes = 0;
    t.sentFrames = 0;
    t.ackWaiters = [];
    t.pace = { start: 0, frames: 0 };
    // Walking starts now so totals are ready by the time the receiver accepts.
    t.walk = this.#walk(t);
    t.walk.catch(() => {});
    const message = { type: 'file.offer', v: PROTOCOL_VERSION, id: t.id, count: t.count, names: names.slice(0, OFFER_NAMES_MAX) };
    this.active = t;
    if (purpose === 'clipboard') {
      t.walk.then(() => {
        if (t.aborted) return;
        if (t.totalBytes > maxBytes || t.totalFiles > maxFiles) return void this.#abort(t, 'too-large');
        if (!this.#send({ ...message, purpose, bytes: t.totalBytes, files: t.totalFiles })) return void this.#abort(t, 'disconnected');
        this.#arm(t, OFFER_TIMEOUT_MS, 'expired');
        this.#progress(t, true);
      }, (error) => { if (!t.aborted) void this.#abort(t, reasonOf(error)); });
    } else {
      if (!this.#send(message)) {
        this.active = null;
        fail('DISCONNECTED', 'The other computer is not connected.');
      }
      this.#arm(t, OFFER_TIMEOUT_MS, 'expired');
    }
    this.#log('file.offered', { items: t.count, purpose });
    this.#progress(t, true);
    return t.id;
  }

  // Receiver: write the offered items into an existing folder.
  async accept(id, targetDirectory) {
    const t = this.active;
    if (!t || t.id !== id || t.direction !== 'receive' || t.phase !== 'offered') fail('UNKNOWN_TRANSFER', 'That transfer is no longer waiting.');
    if (typeof targetDirectory !== 'string' || !path.isAbsolute(targetDirectory)) fail('INVALID_TARGET', 'The destination must be an absolute folder path.');
    const target = path.resolve(targetDirectory);
    const stat = await fsp.stat(target);
    if (!stat.isDirectory()) fail('INVALID_TARGET', 'The destination is not a folder.');
    if (this.active !== t || t.phase !== 'offered') fail('UNKNOWN_TRANSFER', 'That transfer is no longer waiting.');
    t.target = target;
    t.phase = 'transferring';
    if (!this.#send({ type: 'file.accept', id })) {
      await this.#abort(t, 'disconnected');
      fail('DISCONNECTED', 'The other computer is not connected.');
    }
    // The sender may still be walking a large folder; frames reset this to
    // the stall timeout.
    this.#arm(t, OFFER_TIMEOUT_MS, 'stalled');
    this.#log('file.accepted', { items: t.count });
    this.#progress(t, true);
    return target;
  }

  reject(id, reason = 'rejected') {
    const t = this.active;
    if (!t || t.id !== id || t.direction !== 'receive' || t.phase !== 'offered') return false;
    this.#send({ type: 'file.reject', id, reason: REASON.test(reason) ? reason : 'rejected' });
    void this.#abort(t, reason);
    return true;
  }

  // Either side: stop the active transfer and tell the peer.
  async cancel(reason = 'cancelled') {
    const t = this.active;
    if (!t) return false;
    this.#send({ type: 'file.cancel', id: t.id, reason: REASON.test(reason) ? reason : 'cancelled' });
    await this.#abort(t, reason);
    return true;
  }

  #create(id, direction, names, total, purpose = 'drag') {
    return {
      id, direction, purpose, names, count: total, phase: 'offered', reason: null,
      totalBytes: null, totalFiles: null, bytes: 0, files: 0,
      aborted: false, timer: null, lastProgress: 0, memberId: null,
    };
  }

  #send(message) {
    try { return this.session.sendPeer(message) !== false; } catch { return false; }
  }

  #arm(t, ms, reason) {
    clearTimeout(t.timer);
    t.timer = setTimeout(() => {
      if (this.active !== t) return;
      this.#send({ type: 'file.cancel', id: t.id, reason });
      void this.#abort(t, reason);
    }, ms);
    t.timer.unref?.();
  }

  #progress(t, force = false) {
    const now = Date.now();
    if (!force && now - t.lastProgress < PROGRESS_INTERVAL_MS) return;
    t.lastProgress = now;
    this.emit('progress', this.state());
  }

  #log(event, details) {
    try { this.logger?.info?.(event, details); } catch { /* Logging never interrupts a transfer. */ }
  }

  #abortActive(reason) {
    if (this.active) void this.#abort(this.active, reason);
  }

  async #abort(t, reason) {
    if (t.aborted) return t.cleanup;
    t.aborted = true;
    clearTimeout(t.timer);
    t.phase = reason === 'cancelled' || reason === 'rejected' ? 'cancelled' : 'failed';
    t.reason = reason;
    for (const waiter of t.ackWaiters || []) waiter();
    if (t.ackWaiters) t.ackWaiters = [];
    // Free the slot now so a replacement (a new copy, a drag preempting a
    // clipboard transfer) can start; cleanup only touches this transfer's files.
    if (this.active === t) this.active = null;
    this.lastFinished = t;
    t.cleanup = (t.direction === 'receive' ? this.#cleanupReceive(t) : Promise.resolve())
      .catch((error) => this.#log('file.cleanup.failed', { message: error?.message || String(error) }))
      .finally(() => {
        this.#log('file.aborted', { direction: t.direction, purpose: t.purpose, reason });
        this.emit('failed', { id: t.id, direction: t.direction, purpose: t.purpose, reason, kept: t.kept || [] });
        this.#progress(t, true);
      });
    return t.cleanup;
  }

  #finish(t, details) {
    clearTimeout(t.timer);
    t.phase = 'done';
    if (this.active === t) this.active = null;
    this.lastFinished = t;
    this.#log('file.completed', { direction: t.direction, purpose: t.purpose, files: t.files, bytes: t.bytes });
    this.emit('complete', { id: t.id, direction: t.direction, purpose: t.purpose, files: t.files, bytes: t.bytes, ...details });
    this.#progress(t, true);
  }

  // ---- control messages ---------------------------------------------------

  #peer(message, memberId) {
    if (!this.running || typeof message?.type !== 'string' || !message.type.startsWith('file.') || !ID.test(message.id)) return;
    const t = this.active;
    if (message.type === 'file.offer') return this.#receiveOffer(message, memberId);
    if (!t || t.id !== message.id) return;
    if (t.memberId && memberId && memberId !== t.memberId) return;
    if (message.type === 'file.cancel' || message.type === 'file.reject') {
      void this.#abort(t, REASON.test(message.reason) ? message.reason : 'cancelled');
    } else if (t.direction === 'send') {
      if (message.type === 'file.accept' && t.phase === 'offered') {
        t.memberId = memberId || null;
        t.phase = 'transferring';
        this.#arm(t, OFFER_TIMEOUT_MS, 'stalled');
        void this.#pump(t).catch((error) => {
          if (t.aborted) return;
          const reason = reasonOf(error);
          this.#send({ type: 'file.cancel', id: t.id, reason });
          void this.#abort(t, reason);
        });
      } else if (message.type === 'file.ack' && t.phase !== 'offered'
        && count(message.bytes, t.sentBytes) && count(message.frames, t.sentFrames)) {
        t.ackedBytes = Math.max(t.ackedBytes, message.bytes);
        t.ackedFrames = Math.max(t.ackedFrames, message.frames);
        this.#arm(t, this.stallMs, 'stalled');
        const waiters = t.ackWaiters;
        t.ackWaiters = [];
        for (const waiter of waiters) waiter();
      } else if (message.type === 'file.done' && t.phase === 'finishing') {
        this.#finish(t, {});
      }
    }
  }

  #receiveOffer(message, memberId) {
    const purpose = message.purpose ?? 'drag';
    // Clipboard offers must declare totals; the receiver enforces them.
    const declared = purpose === 'clipboard' ? { bytes: message.bytes, files: message.files } : null;
    const valid = message.v === PROTOCOL_VERSION && count(message.count, ITEMS_MAX) && message.count > 0
      && Array.isArray(message.names) && message.names.length <= Math.min(OFFER_NAMES_MAX, message.count)
      && message.names.every((name) => typeof name === 'string' && name.length <= 1024)
      && PURPOSES.has(purpose) && (!declared || (count(declared.bytes) && count(declared.files, ENTRIES_MAX)));
    if (!valid) {
      this.#send({ type: 'file.reject', id: message.id, reason: 'invalid' });
      return;
    }
    if (this.active) {
      this.#send({ type: 'file.reject', id: message.id, reason: 'busy' });
      return;
    }
    const t = this.#create(message.id, 'receive', message.names.slice(), message.count, purpose);
    t.declared = declared;
    if (declared) {
      t.totalBytes = declared.bytes;
      t.totalFiles = declared.files;
    }
    t.memberId = memberId || null;
    t.chain = Promise.resolve();
    t.dirs = new Map();
    t.partials = new Set();
    t.itemRoots = [];
    t.itemNames = [];
    t.item = -1;
    t.nextEntry = 0;
    t.current = null;
    t.wireBytes = 0;
    t.wireFrames = 0;
    t.ackedBytes = 0;
    t.ackedFrames = 0;
    t.ended = false;
    this.active = t;
    this.#arm(t, OFFER_TIMEOUT_MS, 'expired');
    this.#log('file.offer.received', { items: t.count, purpose });
    this.emit('offer', { id: t.id, purpose, count: t.count, names: t.names.slice(), bytes: declared?.bytes ?? null, files: declared?.files ?? null });
    this.#progress(t, true);
  }

  // ---- sender -------------------------------------------------------------

  async #walk(t) {
    const entries = [];
    let files = 0;
    let bytes = 0;
    let skipped = 0;
    const push = (entry) => {
      if (entries.length >= ENTRIES_MAX) fail('TOO_MANY', 'Too many files in one drag.');
      entries.push(entry);
    };
    const visit = async (directory, relative, item, depth) => {
      if (depth > DEPTH_MAX) { skipped++; return; }
      const children = (await fsp.readdir(directory, { withFileTypes: true }))
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      for (const child of children) {
        if (t.aborted) return;
        const source = path.join(directory, child.name);
        const childRelative = `${relative}/${child.name}`;
        if (child.isDirectory()) {
          push({ source, relative: childRelative, kind: 'directory', item });
          await visit(source, childRelative, item, depth + 1);
        } else if (child.isFile()) {
          const stat = await fsp.lstat(source);
          push({ source, relative: childRelative, kind: 'file', item });
          files++;
          bytes += stat.size;
        } else skipped++;
      }
    };
    for (const [item, source] of t.sources.entries()) {
      // A dragged symlink is followed once; links inside folders are skipped
      // so a cycle can never make the walk unbounded.
      const stat = await fsp.stat(source);
      const relative = t.names[item];
      if (stat.isDirectory()) {
        push({ source, relative, kind: 'directory', item });
        await visit(source, relative, item, 1);
      } else if (stat.isFile()) {
        push({ source, relative, kind: 'file', item });
        files++;
        bytes += stat.size;
      } else skipped++;
    }
    t.totalFiles = files;
    t.totalBytes = bytes;
    t.skipped = skipped;
    return entries;
  }

  async #pump(t) {
    const entries = await t.walk;
    if (t.aborted) return;
    this.#arm(t, this.stallMs, 'stalled');
    await this.#sendJson(t, { type: 'file.manifest', id: t.id, files: t.totalFiles, bytes: t.totalBytes, entries: entries.length });
    this.#progress(t, true);
    const buffer = Buffer.allocUnsafe(this.chunkBytes);
    for (const [index, entry] of entries.entries()) {
      if (t.aborted) return;
      const first = { type: 'file.frame', id: t.id, entry: index, item: entry.item, path: entry.relative, kind: entry.kind };
      if (entry.kind === 'directory') {
        await this.#sendFrame(t, first, EMPTY);
        continue;
      }
      const handle = await fsp.open(entry.source, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) fail('SOURCE_CHANGED', 'A dragged file was replaced while sending.');
        const size = stat.size;
        const hash = createHash('sha256');
        Object.assign(first, {
          size, offset: 0, mtimeMs: Math.trunc(stat.mtimeMs),
          executable: this.platform !== 'win32' && (stat.mode & 0o111) !== 0,
        });
        if (!size) {
          await this.#sendFrame(t, { ...first, sha256: EMPTY_SHA256 }, EMPTY);
        }
        for (let offset = 0; offset < size;) {
          const length = Math.min(buffer.length, size - offset);
          let read = 0;
          while (read < length) {
            const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
            if (!bytesRead) fail('SOURCE_CHANGED', 'A dragged file got shorter while sending.');
            read += bytesRead;
          }
          const payload = buffer.subarray(0, length);
          hash.update(payload);
          const header = offset ? { type: 'file.frame', id: t.id, entry: index, item: entry.item, offset } : first;
          if (offset + length === size) header.sha256 = hash.digest('hex');
          // sealFrame copies the payload, so the read buffer is reusable.
          await this.#sendFrame(t, header, payload);
          offset += length;
          t.bytes += length;
          this.#progress(t);
        }
        t.files++;
      } finally {
        await handle.close().catch(() => {});
      }
    }
    if (t.aborted) return;
    t.phase = 'finishing';
    await this.#sendJson(t, { type: 'file.end', id: t.id });
    this.#progress(t, true);
  }

  async #ready(t) {
    if (t.aborted) fail('DISCONNECTED', 'Transfer stopped.');
    while (t.sentBytes - t.ackedBytes > this.windowBytes || t.sentFrames - t.ackedFrames > WINDOW_FRAMES) {
      await new Promise((resolve) => t.ackWaiters.push(resolve));
      if (t.aborted) fail('DISCONNECTED', 'Transfer stopped.');
    }
    if (!(await this.session.dataDrained())) fail('DISCONNECTED', 'The data connection closed.');
    if (t.aborted) fail('DISCONNECTED', 'Transfer stopped.');
    const now = Date.now();
    if (now - t.pace.start >= 1000) t.pace = { start: now, frames: 0 };
    if (++t.pace.frames > this.framesPerSecond) {
      await delay(1000 - (now - t.pace.start));
      t.pace = { start: Date.now(), frames: 1 };
      if (t.aborted) fail('DISCONNECTED', 'Transfer stopped.');
    }
  }

  async #sendFrame(t, header, payload) {
    await this.#ready(t);
    if (!this.session.sendDataFrame(header, payload)) fail('DISCONNECTED', 'The data connection closed.');
    t.sentBytes += payload.length;
    t.sentFrames++;
  }

  async #sendJson(t, message) {
    await this.#ready(t);
    if (!this.session.sendData(message)) fail('DISCONNECTED', 'The data connection closed.');
  }

  // ---- receiver -----------------------------------------------------------

  #receiving(id, memberId) {
    const t = this.active;
    if (!t || t.direction !== 'receive' || t.id !== id || t.phase !== 'transferring' || t.aborted) return null;
    if (t.memberId && memberId && memberId !== t.memberId) return null;
    return t;
  }

  #enqueue(t, operation) {
    t.chain = t.chain.then(() => (t.aborted ? undefined : operation())).catch((error) => {
      if (t.aborted) return;
      const reason = reasonOf(error);
      this.#log('file.receive.failed', { reason, code: error?.code || null });
      this.#send({ type: 'file.cancel', id: t.id, reason });
      void this.#abort(t, reason);
    });
  }

  #data(message, memberId) {
    if (!this.running || (message?.type !== 'file.manifest' && message?.type !== 'file.end')) return;
    const t = this.#receiving(message.id, memberId);
    if (!t) return;
    if (message.type === 'file.manifest') {
      if (!count(message.files) || !count(message.bytes) || !count(message.entries, ENTRIES_MAX)) {
        this.#enqueue(t, () => fail('PROTOCOL', 'Invalid transfer manifest.'));
        return;
      }
      if (t.declared && (message.bytes > t.declared.bytes || message.files > t.declared.files)) {
        this.#enqueue(t, () => fail('TOO_LARGE', 'The transfer is larger than it announced.'));
        return;
      }
      t.totalFiles = message.files;
      t.totalBytes = message.bytes;
      t.totalEntries = message.entries;
      this.#progress(t, true);
      return;
    }
    this.#enqueue(t, async () => {
      if (t.current || (t.totalEntries !== undefined && t.nextEntry !== t.totalEntries)) {
        fail('PROTOCOL', 'The transfer ended before every file arrived.');
      }
      t.ended = true;
      this.#send({ type: 'file.done', id: t.id });
      this.#finish(t, { target: t.target, paths: t.itemRoots.filter(Boolean) });
    });
  }

  #frame(header, payload, memberId) {
    if (!this.running || header?.type !== 'file.frame') return;
    const t = this.#receiving(header.id, memberId);
    if (!t) return;
    this.#arm(t, this.stallMs, 'stalled');
    this.#enqueue(t, () => this.#write(t, header, payload));
  }

  async #write(t, header, payload) {
    if (!count(header.entry, ENTRIES_MAX) || !count(header.item, t.count - 1)) fail('PROTOCOL', 'Invalid frame position.');
    if (!t.current || header.entry !== t.current.entry) await this.#beginEntry(t, header, payload);
    const current = t.current;
    if (current) {
      if (header.offset !== current.received) fail('PROTOCOL', 'File bytes arrived out of order.');
      if (current.received + payload.length > current.size) fail('PROTOCOL', 'A file sent more bytes than it declared.');
      for (let written = 0; written < payload.length;) {
        const { bytesWritten } = await current.handle.write(payload, written, payload.length - written, current.received + written);
        if (!bytesWritten) fail('IO', 'The destination stopped accepting data.');
        written += bytesWritten;
      }
      current.hash.update(payload);
      current.received += payload.length;
      t.bytes += payload.length;
      if (header.sha256 !== undefined) await this.#finishFile(t, header);
      else if (current.received === current.size && current.size) fail('PROTOCOL', 'A file ended without its checksum.');
    } else if (payload.length) fail('PROTOCOL', 'A folder carried file bytes.');
    t.wireBytes += payload.length;
    t.wireFrames++;
    if (t.wireBytes - t.ackedBytes >= ACK_BYTES || t.wireFrames - t.ackedFrames >= ACK_FRAMES) {
      t.ackedBytes = t.wireBytes;
      t.ackedFrames = t.wireFrames;
      this.#send({ type: 'file.ack', id: t.id, bytes: t.wireBytes, frames: t.wireFrames });
    }
    this.#progress(t);
  }

  async #beginEntry(t, header, payload) {
    if (t.current) fail('PROTOCOL', 'A file was interrupted by the next entry.');
    if (header.entry !== t.nextEntry) fail('PROTOCOL', 'Entries arrived out of order.');
    if (header.item < t.item || header.item > t.item + 1) fail('PROTOCOL', 'Items arrived out of order.');
    if (header.kind !== 'file' && header.kind !== 'directory') fail('PROTOCOL', 'Unknown entry kind.');
    const segments = validateRelativePath(header.path);
    const topLevel = segments.length === 1;
    // Each item starts with its own top-level entry; the rest stay under it.
    if (topLevel !== (header.item === t.item + 1)) fail('PROTOCOL', 'Item boundaries are inconsistent.');
    if (topLevel) {
      t.item = header.item;
      t.itemNames[header.item] = segments[0];
    } else if (segments[0] !== t.itemNames[header.item]) fail('PROTOCOL', 'An entry left its item.');
    const parentKey = segments.slice(0, -1).join('/');
    const parent = topLevel ? t.target : t.dirs.get(parentKey);
    if (!parent) fail('PROTOCOL', 'An entry arrived before its folder.');
    const isDirectory = header.kind === 'directory';
    const name = sanitizeSegment(segments.at(-1), this.platform, isDirectory);
    t.nextEntry++;
    if (isDirectory) {
      if (payload.length || header.size !== undefined) fail('PROTOCOL', 'A folder carried file data.');
      const created = await createDirectoryExclusive(t.target, parent, name);
      t.dirs.set(header.path, created);
      if (topLevel) t.itemRoots[header.item] = created;
      return;
    }
    if (!count(header.size) || header.offset !== 0) fail('PROTOCOL', 'Invalid file header.');
    if (t.declared) {
      // Reserve each file's declared size up front: nothing past the
      // announced clipboard totals is ever written.
      t.reservedBytes = (t.reservedBytes || 0) + header.size;
      t.reservedFiles = (t.reservedFiles || 0) + 1;
      if (t.reservedBytes > t.declared.bytes || t.reservedFiles > t.declared.files) fail('TOO_LARGE', 'The transfer is larger than it announced.');
    }
    const partial = path.join(parent, `.compusync-${randomBytes(8).toString('hex')}.part`);
    assertInside(t.target, partial);
    const handle = await fsp.open(partial, 'wx');
    t.partials.add(partial);
    t.current = {
      entry: header.entry, item: header.item, topLevel, parent, name, partial, handle,
      size: header.size, received: 0, hash: createHash('sha256'),
      mtimeMs: count(header.mtimeMs) ? header.mtimeMs : null, executable: header.executable === true,
    };
  }

  async #finishFile(t, header) {
    const current = t.current;
    if (!SHA256.test(header.sha256) || current.received !== current.size) fail('PROTOCOL', 'A checksum arrived before the whole file.');
    if (current.hash.digest('hex') !== header.sha256) fail('HASH_MISMATCH', 'A received file did not match its checksum.');
    await current.handle.close();
    current.handle = null;
    if (current.executable && this.platform !== 'win32') await fsp.chmod(current.partial, 0o755);
    const final = await finalizeExclusive(t.target, current.partial, current.parent, current.name);
    t.partials.delete(current.partial);
    if (current.mtimeMs !== null) {
      const mtime = new Date(current.mtimeMs);
      await fsp.utimes(final, mtime, mtime).catch(() => {});
    }
    if (current.topLevel) t.itemRoots[current.item] = final;
    t.current = null;
    t.files++;
  }

  async #cleanupReceive(t) {
    // Let an in-flight write settle; every queued operation now no-ops.
    await t.chain;
    if (t.current?.handle) await t.current.handle.close().catch(() => {});
    t.current = null;
    for (const partial of t.partials) await fsp.rm(partial, { force: true });
    t.partials.clear();
    // Completed items stay, like an interrupted Finder copy. A folder item
    // still being written is removed whole: this transfer created it with an
    // exclusive mkdir, so nothing else lives there. A top-level file item is
    // recorded only once it is verified and in place, so it is complete.
    const root = t.itemRoots[t.item];
    if (!t.ended && root && t.dirs.get(t.itemNames[t.item]) === root) {
      await fsp.rm(root, { recursive: true, force: true });
      t.itemRoots[t.item] = undefined;
    }
    t.kept = t.itemRoots.filter(Boolean);
  }
}

module.exports = {
  FileTransfer,
  FileTransferError,
  validateRelativePath,
  sanitizeSegment,
  collisionName,
  PROTOCOL_VERSION,
  CHUNK_BYTES,
};
