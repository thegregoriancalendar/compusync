'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { validateCapabilityRequest, MAX_CHUNK_BYTES } = require('./capabilities.cjs');

const OWNER = /^[A-Za-z0-9_-]{1,80}$/;

class TransferError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TransferError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new TransferError(code, message);
}

function ownerId(value) {
  if (typeof value !== 'string' || !OWNER.test(value)) fail('INVALID_OWNER', 'Transfer owner is invalid.');
  return value;
}

function positive(value, fallback, name) {
  const next = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(next) || next < 1) fail('INVALID_LIMIT', `${name} must be a positive safe integer.`);
  return next;
}

class TransferReceiver {
  constructor(workspace, options = {}) {
    if (!workspace || typeof workspace.importFile !== 'function' || typeof workspace.internalTransferDirectory !== 'function') fail('INVALID_WORKSPACE', 'TransferReceiver requires a Workspace instance.');
    this.workspace = workspace;
    this.maxTransfers = positive(options.maxTransfers, 4, 'maxTransfers');
    this.maxChunkBytes = positive(options.maxChunkBytes, MAX_CHUNK_BYTES, 'maxChunkBytes');
    if (this.maxChunkBytes > MAX_CHUNK_BYTES) fail('INVALID_LIMIT', `maxChunkBytes cannot exceed ${MAX_CHUNK_BYTES}.`);
    this.maxFileBytes = positive(options.maxFileBytes, workspace.limits?.maxFileBytes || 256 * 1024 * 1024, 'maxFileBytes');
    if (workspace.limits && this.maxFileBytes > workspace.limits.maxFileBytes) fail('INVALID_LIMIT', 'Transfer file limit cannot exceed the workspace file limit.');
    this.transfers = new Map();
    this.ready = false;
  }

  async init() {
    if (!this.workspace.ready) await this.workspace.init();
    this.partialRoot = this.workspace.internalTransferDirectory();
    const rootStat = await fsp.lstat(this.partialRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('UNSAFE_STORAGE', 'Transfer storage must be a real directory.');
    const children = await fsp.readdir(this.partialRoot);
    for (const child of children) {
      const target = path.join(this.partialRoot, child);
      if (path.dirname(target) !== this.partialRoot) fail('UNSAFE_STORAGE', 'Invalid transfer cleanup target.');
      await fsp.rm(target, { recursive: true, force: true });
    }
    this.ready = true;
    return this;
  }

  _assertReady() {
    if (!this.ready) fail('NOT_INITIALIZED', 'Initialize the transfer receiver before using it.');
  }

  _record(transferId, owner) {
    const record = this.transfers.get(transferId);
    if (!record) fail('UNKNOWN_TRANSFER', 'Transfer is not active.');
    if (record.owner !== ownerId(owner)) fail('TRANSFER_OWNER', 'Transfer belongs to another connection.');
    return record;
  }

  _enqueue(record, operation) {
    const result = record.tail.then(async () => {
      if (this.transfers.get(record.id) !== record) fail('UNKNOWN_TRANSFER', 'Transfer is not active.');
      return operation(record);
    });
    record.tail = result.catch(() => {});
    return result;
  }

  async _cleanup(record) {
    if (record.handle) {
      const handle = record.handle;
      record.handle = null;
      await handle.close().catch(() => {});
    }
    await fsp.rm(record.partialPath, { force: true }).catch(() => {});
    // Keep the transfer active until its file is actually closed and removed.
    // Callers use active() to know when disconnect cleanup is complete; deleting
    // the record first exposed a race where a stale .part file was still present.
    if (this.transfers.get(record.id) === record) this.transfers.delete(record.id);
  }

  async start(payload, owner = 'peer') {
    this._assertReady();
    const cleanOwner = ownerId(owner);
    let request;
    try { request = validateCapabilityRequest('transfer.start', payload); }
    catch (error) { fail('INVALID_START', error.message); }
    if (request.size > this.maxFileBytes) fail('FILE_QUOTA', `Transfers may not exceed ${this.maxFileBytes} bytes.`);
    if (this.transfers.has(request.transferId)) fail('DUPLICATE_TRANSFER', 'Transfer ID is already active.');
    if (this.transfers.size >= this.maxTransfers) fail('TRANSFER_LIMIT', `At most ${this.maxTransfers} transfers may be active.`);
    // Resolve now so invalid or symlinked destinations fail before disk use.
    await this.workspace.list(request.target);
    const partialPath = path.join(this.partialRoot, `${randomUUID()}.part`);
    let handle;
    try {
      handle = await fsp.open(partialPath, 'wx', 0o600);
      const record = {
        id: request.transferId,
        owner: cleanOwner,
        name: request.name,
        target: request.target,
        size: request.size,
        expectedHash: request.sha256,
        received: 0,
        hash: createHash('sha256'),
        partialPath,
        handle,
        tail: Promise.resolve(),
      };
      this.transfers.set(record.id, record);
      return { transferId: record.id, received: 0, size: record.size };
    } catch (error) {
      await handle?.close().catch(() => {});
      await fsp.rm(partialPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async chunk(payload, owner = 'peer') {
    this._assertReady();
    const cleanOwner = ownerId(owner);
    const rawId = payload && typeof payload === 'object' ? payload.transferId : undefined;
    const existing = typeof rawId === 'string' ? this.transfers.get(rawId) : null;
    let request;
    try { request = validateCapabilityRequest('transfer.chunk', payload); }
    catch (error) {
      if (existing?.owner === cleanOwner) await this._enqueue(existing, (record) => this._cleanup(record)).catch(() => {});
      fail('INVALID_CHUNK', error.message);
    }
    const record = this._record(request.transferId, cleanOwner);
    return this._enqueue(record, async (current) => {
      try {
        const data = Buffer.from(request.data, 'base64');
        if (data.length > this.maxChunkBytes) fail('CHUNK_QUOTA', `Transfer chunks may not exceed ${this.maxChunkBytes} bytes.`);
        if (request.offset !== current.received) fail('CHUNK_OFFSET', 'Transfer chunk offset does not match the next expected byte.');
        if (current.received + data.length > current.size) fail('TRANSFER_OVERFLOW', 'Transfer chunk exceeds the declared file size.');
        let written = 0;
        while (written < data.length) {
          const result = await current.handle.write(data, written, data.length - written, current.received + written);
          if (!result.bytesWritten) fail('WRITE_FAILED', 'Transfer partial could not be written.');
          written += result.bytesWritten;
        }
        current.hash.update(data);
        current.received += data.length;
        return { transferId: current.id, received: current.received, size: current.size };
      } catch (error) {
        await this._cleanup(current);
        throw error;
      }
    });
  }

  async finish(payload, owner = 'peer') {
    this._assertReady();
    const cleanOwner = ownerId(owner);
    let request;
    try { request = validateCapabilityRequest('transfer.finish', payload); }
    catch (error) { fail('INVALID_FINISH', error.message); }
    const record = this._record(request.transferId, cleanOwner);
    return this._enqueue(record, async (current) => {
      try {
        if (current.received !== current.size) fail('INCOMPLETE_TRANSFER', 'Transfer ended before its declared size was received.');
        const actualHash = current.hash.digest('hex');
        if (actualHash !== current.expectedHash) fail('HASH_MISMATCH', 'Transfer SHA-256 did not match its declaration.');
        await current.handle.sync();
        await current.handle.close();
        current.handle = null;
        const entry = await this.workspace.importFile(current.partialPath, current.target, current.name);
        await this._cleanup(current);
        return { transferId: current.id, entry };
      } catch (error) {
        await this._cleanup(current);
        throw error;
      }
    });
  }

  async abort(payload, owner = 'peer') {
    this._assertReady();
    const cleanOwner = ownerId(owner);
    let request;
    try { request = validateCapabilityRequest('transfer.abort', payload); }
    catch (error) { fail('INVALID_ABORT', error.message); }
    const record = this._record(request.transferId, cleanOwner);
    return this._enqueue(record, async (current) => {
      await this._cleanup(current);
      return { transferId: current.id, aborted: true };
    });
  }

  async abortOwner(owner = 'peer') {
    this._assertReady();
    const cleanOwner = ownerId(owner);
    const records = [...this.transfers.values()].filter((record) => record.owner === cleanOwner);
    await Promise.all(records.map((record) => this._enqueue(record, (current) => this._cleanup(current)).catch(() => {})));
    return records.length;
  }

  async abortAll() {
    this._assertReady();
    const records = [...this.transfers.values()];
    await Promise.all(records.map((record) => this._enqueue(record, (current) => this._cleanup(current)).catch(() => {})));
    return records.length;
  }

  active() {
    return [...this.transfers.values()].map((record) => ({ transferId: record.id, owner: record.owner, name: record.name, target: record.target, received: record.received, size: record.size }));
  }
}

module.exports = { TransferReceiver, TransferError };
