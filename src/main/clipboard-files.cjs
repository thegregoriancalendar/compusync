'use strict';

// Copy and paste files and folders between the paired computers.
//
// A paste cannot wait for the network: Finder and File Explorer read the
// clipboard synchronously. So when files are copied, they are sent right
// away (through the file-transfer engine, purpose 'clipboard') into a private
// cache on the other computer, whose clipboard is then set to those cached
// copies. A normal paste copies them out of the cache. Only the latest copy is
// kept; any newer local clipboard content supersedes a copy still in flight.

const fsp = require('node:fs/promises');
const path = require('node:path');

const MAX_BYTES = 1024 ** 3;
const MAX_FILES = 10_000;
const BUSY_RETRY_MS = 2000;

class ClipboardFiles {
  constructor(options = {}) {
    if (!options.transfer?.offer || !options.native || typeof options.cacheRoot !== 'string') {
      throw new TypeError('ClipboardFiles requires a transfer engine, native adapter, and cache folder.');
    }
    this.transfer = options.transfer;
    this.native = options.native;
    this.cacheRoot = options.cacheRoot;
    this.enabled = options.enabled !== false;
    this.maxBytes = options.maxBytes || MAX_BYTES;
    this.maxFiles = options.maxFiles || MAX_FILES;
    this.logger = options.logger || null;
    this.onNotice = typeof options.onNotice === 'function' ? options.onNotice : () => {};
    this.sync = null;
    this.seen = { generation: null, paths: [] };
    this.pending = null;
    this.lastSent = null;
    this.retryTimer = null;
    this.current = null;
    this.receiving = new Map();
    this.running = false;
    this.onOffer = (offer) => { void this.#offer(offer); };
    this.onComplete = (result) => { void this.#complete(result); };
    this.onFailed = (result) => this.#failed(result);
  }

  // Removes cached copies left by an earlier run. Call once per app launch.
  static async clearCache(cacheRoot) {
    await fsp.rm(cacheRoot, { recursive: true, force: true });
  }

  get available() {
    try { return Boolean(this.native.clipboardFilesAvailable?.()); } catch { return false; }
  }

  // ClipboardSync owns the clipboard queue; it writes received files through
  // its own applyFiles() so the write and its echo suppression are atomic.
  bind(sync) {
    this.sync = sync;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.transfer.on('offer', this.onOffer);
    this.transfer.on('complete', this.onComplete);
    this.transfer.on('failed', this.onFailed);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.retryTimer);
    this.pending = null;
    this.transfer.off('offer', this.onOffer);
    this.transfer.off('complete', this.onComplete);
    this.transfer.off('failed', this.onFailed);
  }

  setEnabled(enabled) {
    this.enabled = enabled !== false;
    if (!this.enabled) this.forget();
  }

  // Files on the local clipboard as { key, paths }, or null. Cheap to call on
  // every poll: the file list is re-read only when the clipboard changed.
  snapshot() {
    if (!this.enabled || !this.available) return null;
    const generation = this.native.clipboardGeneration();
    if (generation !== this.seen.generation) {
      let paths;
      // A busy Windows clipboard is retried on the next poll.
      try { paths = this.native.clipboardFiles(); } catch { return null; }
      this.seen = { generation, paths: Array.isArray(paths) ? paths : [] };
    }
    return this.seen.paths.length ? { key: `files:${generation}`, paths: this.seen.paths } : null;
  }

  // Puts files on the local clipboard; returns the key snapshot() will report.
  write(paths) {
    this.native.setClipboardFiles(paths);
    const generation = this.native.clipboardGeneration();
    this.seen = { generation, paths: paths.slice() };
    return `files:${generation}`;
  }

  send(paths) {
    if (!this.enabled || !this.running) return false;
    this.pending = paths.slice();
    this.#flush();
    return true;
  }

  // Newer local clipboard content (text, an image, other files) replaces any
  // copied files still waiting or in flight, in either direction.
  forget() {
    clearTimeout(this.retryTimer);
    this.pending = null;
    this.lastSent = null;
    if (this.transfer.activePurpose === 'clipboard') void this.transfer.cancel('superseded');
  }

  #log(event, details = {}) {
    try { this.logger?.info?.(event, details); } catch { /* Logging never interrupts the clipboard. */ }
  }

  #flush() {
    const paths = this.pending;
    if (!paths || !this.running || !this.enabled) return;
    if (this.transfer.activePurpose === 'clipboard') void this.transfer.cancel('superseded');
    // A drag in progress keeps the slot; this copy follows when it ends.
    if (this.transfer.busy) return;
    this.pending = null;
    try {
      this.transfer.offer(paths, { purpose: 'clipboard', maxBytes: this.maxBytes, maxFiles: this.maxFiles });
      this.lastSent = paths;
      this.#log('file.clipboard.offered', { items: paths.length });
    } catch (error) {
      this.#log('file.clipboard.offer-failed', { code: error?.code || null });
    }
  }

  async #offer(offer) {
    if (offer.purpose !== 'clipboard') return;
    if (!this.enabled || !this.available || !this.sync) {
      this.transfer.reject(offer.id, 'disabled');
      return;
    }
    if (!(offer.bytes <= this.maxBytes) || !(offer.files <= this.maxFiles)) {
      this.transfer.reject(offer.id, 'too-large');
      return;
    }
    const folder = path.join(this.cacheRoot, offer.id);
    try {
      await fsp.mkdir(folder, { recursive: true, mode: 0o700 });
      this.receiving.set(offer.id, folder);
      await this.transfer.accept(offer.id, folder);
    } catch (error) {
      this.receiving.delete(offer.id);
      this.transfer.reject(offer.id, 'unavailable');
      await fsp.rm(folder, { recursive: true, force: true }).catch(() => {});
      this.#log('file.clipboard.accept-failed', { code: error?.code || null });
    }
  }

  async #complete(result) {
    if (result.purpose !== 'clipboard') return this.#flush();
    if (result.direction === 'send') {
      this.lastSent = null;
      return this.#flush();
    }
    const folder = this.receiving.get(result.id);
    this.receiving.delete(result.id);
    if (!folder) return;
    let applied = false;
    try { applied = Boolean(result.paths.length) && await this.sync.applyFiles(result.paths); }
    catch (error) { this.#log('file.clipboard.apply-failed', { message: error?.message || String(error) }); }
    if (!applied) {
      await fsp.rm(folder, { recursive: true, force: true }).catch(() => {});
      return;
    }
    // The previous copy is no longer on the clipboard.
    const previous = this.current;
    this.current = folder;
    if (previous) await fsp.rm(previous, { recursive: true, force: true }).catch(() => {});
    this.#log('file.clipboard.applied', { files: result.files });
  }

  #failed(result) {
    if (result.purpose === 'clipboard' && result.direction === 'receive') {
      const folder = this.receiving.get(result.id);
      this.receiving.delete(result.id);
      if (folder) void fsp.rm(folder, { recursive: true, force: true }).catch(() => {});
    }
    if (result.purpose === 'clipboard' && result.direction === 'send') {
      if (result.reason === 'too-large') {
        this.onNotice('Copied files are larger than 1 GB or 10,000 files. Drag them to the other laptop instead.');
      } else if (result.reason === 'busy' && this.lastSent && !this.pending) {
        // The peer was mid-drag; offer this copy again shortly.
        this.pending = this.lastSent;
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.#flush(), BUSY_RETRY_MS);
        this.retryTimer.unref?.();
        return;
      }
      this.lastSent = null;
    }
    this.#flush();
  }
}

module.exports = { ClipboardFiles, MAX_BYTES, MAX_FILES };
