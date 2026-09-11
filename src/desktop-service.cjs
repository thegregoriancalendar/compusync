'use strict';

const { EventEmitter } = require('node:events');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Workspace, validatePublicPath, DEFAULT_LIMITS } = require('./core/workspace.cjs');
const { CapabilityAuthority, validateCapabilityRequest, isKnownCapability, MAX_CHUNK_BYTES } = require('./core/capabilities.cjs');
const { TransferReceiver } = require('./core/transfer.cjs');
const { ProgramManager } = require('./programs/program-manager.cjs');

const SERVICE_VERSION = 1;
const REQUEST_ID = /^[A-Za-z0-9-]{8,80}$/;
const MAX_PENDING = 32;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ENVELOPE_BYTES = 900 * 1024;
const MAX_FRAME_BYTES = 768 * 1024;
const MAX_IMPORT_ROOTS = 64;

class DesktopServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DesktopServiceError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new DesktopServiceError(code, message);
}

function safeError(error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,48}$/.test(error.code) ? error.code : 'SERVICE_ERROR';
  const messages = {
    ALREADY_EXISTS: 'An item with that name already exists.',
    ENTRY_QUOTA: 'The workspace has reached its item limit.',
    FILE_QUOTA: 'The file exceeds the workspace file limit.',
    WORKSPACE_QUOTA: 'The workspace has reached its storage limit.',
    TEXT_QUOTA: 'The text document is too large.',
    INVALID_UTF8: 'The selected file is not valid UTF-8 text.',
    INVALID_PATH: 'The workspace path is invalid.',
    INVALID_PAYLOAD: 'The request is invalid.',
    UNKNOWN_CAPABILITY: 'That desktop operation is not available.',
    UNAUTHORIZED: 'That desktop operation is not authorized.',
    UNKNOWN_TRANSFER: 'The file transfer is no longer active.',
    HASH_MISMATCH: 'The received file did not pass its integrity check.',
    INCOMPLETE_TRANSFER: 'The file transfer ended before it completed.',
    DATA_UNAVAILABLE: 'The file and program connection is unavailable.',
    REQUEST_TIMEOUT: 'The other laptop did not answer the desktop request.',
    PENDING_LIMIT: 'Too many desktop requests are already active.',
    UNSUPPORTED_PROGRAM: 'Only the bundled text editor is supported.',
    PROGRAM_NOT_FOUND: 'That program is no longer running.',
  };
  return { code, message: messages[code] || 'The desktop request could not be completed.' };
}

function asServiceError(error) {
  if (error instanceof DesktopServiceError) return error;
  const safe = safeError(error);
  return new DesktopServiceError(safe.code, safe.message);
}

function boundedClone(value, maximum = MAX_ENVELOPE_BYTES) {
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch { return null; }
  if (!serialized || Buffer.byteLength(serialized) > maximum) return null;
  try { return JSON.parse(serialized); }
  catch { return null; }
}

function exactObject(value, allowed, required = allowed) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.includes(key))
    && required.every((key) => Object.hasOwn(value, key)));
}

function portableName(value) {
  return validatePublicPath(value, { allowRoot: false, maxDepth: 1, singleSegment: true });
}

function joinPublic(parent, name) {
  const cleanParent = validateCapabilityRequest('workspace.list', { path: parent ?? '' }).path;
  const cleanName = portableName(name);
  return cleanParent ? `${cleanParent}/${cleanName}` : cleanName;
}

function parentOf(publicPath) {
  const parent = path.posix.dirname(publicPath);
  return parent === '.' ? '' : parent;
}

function sanitizeHostName(value) {
  if (typeof value !== 'string') return 'Host laptop';
  return value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80) || 'Host laptop';
}

function publicFrame(value) {
  if (!exactObject(value, ['programId', 'serial', 'width', 'height', 'format', 'data'])
    || typeof value.programId !== 'string' || !REQUEST_ID.test(value.programId)
    || !Number.isSafeInteger(value.serial) || value.serial < 1
    || !Number.isInteger(value.width) || value.width < 1 || value.width > 4096
    || !Number.isInteger(value.height) || value.height < 1 || value.height > 4096
    || value.format !== 'jpeg' || typeof value.data !== 'string'
    || value.data.length > Math.ceil(MAX_FRAME_BYTES / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) return null;
  const bytes = Buffer.from(value.data, 'base64');
  if (!bytes.length || bytes.length > MAX_FRAME_BYTES || bytes.toString('base64') !== value.data) return null;
  return { programId: value.programId, serial: value.serial, width: value.width, height: value.height, format: 'jpeg', data: value.data };
}

function publicEntry(value) {
  if (!exactObject(value, ['path', 'name', 'type', 'size', 'modifiedAt'])
    || !['file', 'directory'].includes(value.type) || !Number.isSafeInteger(value.size) || value.size < 0
    || !Number.isFinite(value.modifiedAt)) return null;
  try {
    const publicPath = validatePublicPath(value.path, { allowRoot: false });
    const name = portableName(value.name);
    if (path.posix.basename(publicPath) !== name) return null;
    return { path: publicPath, name, type: value.type, size: value.size, modifiedAt: value.modifiedAt };
  } catch { return null; }
}

function transferProgress(value) {
  if (!exactObject(value, ['transferId', 'received', 'size']) || !REQUEST_ID.test(value.transferId)
    || !Number.isSafeInteger(value.received) || value.received < 0
    || !Number.isSafeInteger(value.size) || value.size < value.received) return null;
  return { transferId: value.transferId, received: value.received, size: value.size };
}

function publicProgram(value) {
  if (!exactObject(value, ['id', 'appId', 'title', 'documentPath', 'width', 'height', 'modifiedAt'])
    || typeof value.id !== 'string' || !REQUEST_ID.test(value.id)
    || value.appId !== 'text-editor' || typeof value.title !== 'string' || value.title.length > 160
    || !Number.isInteger(value.width) || value.width < 1 || value.width > 4096
    || !Number.isInteger(value.height) || value.height < 1 || value.height > 4096
    || (value.modifiedAt !== null && value.modifiedAt !== undefined && !Number.isFinite(value.modifiedAt))) return null;
  try {
    return {
      id: value.id,
      appId: 'text-editor',
      title: value.title,
      documentPath: validatePublicPath(value.documentPath, { allowRoot: false }),
      width: value.width,
      height: value.height,
      modifiedAt: value.modifiedAt ?? null,
    };
  } catch { return null; }
}

function validateDesktopState(value) {
  if (!value || value.version !== SERVICE_VERSION || !exactObject(value.host, ['name']) || typeof value.host.name !== 'string'
    || value.host.name.length > 80 || !Number.isSafeInteger(value.workspaceSerial) || value.workspaceSerial < 0
    || !Array.isArray(value.entries) || value.entries.length > DEFAULT_LIMITS.maxEntries
    || !Array.isArray(value.programs) || value.programs.length > 32
    || !Array.isArray(value.transfers) || value.transfers.length > 4
    || !Array.isArray(value.catalog) || value.catalog.length > 16
    || (value.requiresList !== undefined && typeof value.requiresList !== 'boolean')) return null;
  const entries = value.entries.map(publicEntry);
  const programs = value.programs.map(publicProgram);
  if (entries.some((entry) => !entry) || programs.some((program) => !program)) return null;
  const transfers = [];
  for (const item of value.transfers) {
    if (!exactObject(item, ['transferId', 'name', 'target', 'received', 'size']) || !REQUEST_ID.test(item.transferId)
      || typeof item.name !== 'string' || !Number.isSafeInteger(item.received) || item.received < 0
      || !Number.isSafeInteger(item.size) || item.size < item.received) return null;
    try {
      transfers.push({
        transferId: item.transferId,
        name: portableName(item.name),
        target: validatePublicPath(item.target ?? '', { allowRoot: true }),
        received: item.received,
        size: item.size,
      });
    } catch { return null; }
  }
  if (value.catalog.some((item) => !exactObject(item, ['id', 'name', 'kind'])
    || item.id !== 'text-editor' || item.name !== 'Text Editor' || item.kind !== 'editor')) return null;
  const catalog = value.catalog.map(() => ({ id: 'text-editor', name: 'Text Editor', kind: 'editor' }));
  return {
    version: SERVICE_VERSION,
    host: { name: sanitizeHostName(value.host.name) },
    workspaceSerial: value.workspaceSerial,
    entries,
    programs,
    transfers,
    catalog,
    ...(value.requiresList ? { requiresList: true } : {}),
  };
}

function publicResult(method, value) {
  if (method === 'workspace.list') {
    if (!Array.isArray(value) || value.length > DEFAULT_LIMITS.maxEntries) return null;
    const entries = value.map(publicEntry);
    return entries.some((entry) => !entry) ? null : entries;
  }
  if (method === 'workspace.mkdir' || method === 'workspace.rename') return publicEntry(value);
  if (method === 'workspace.delete') {
    if (!exactObject(value, ['path', 'deleted']) || value.deleted !== true) return null;
    try { return { path: validatePublicPath(value.path, { allowRoot: false }), deleted: true }; }
    catch { return null; }
  }
  if (method === 'transfer.start' || method === 'transfer.chunk') return transferProgress(value);
  if (method === 'transfer.finish') {
    if (!exactObject(value, ['transferId', 'entry']) || !REQUEST_ID.test(value.transferId)) return null;
    const entry = publicEntry(value.entry);
    return entry ? { transferId: value.transferId, entry } : null;
  }
  if (method === 'transfer.abort') {
    if (!exactObject(value, ['transferId', 'aborted']) || !REQUEST_ID.test(value.transferId) || value.aborted !== true) return null;
    return { transferId: value.transferId, aborted: true };
  }
  if (method === 'program.launch') return publicProgram(value);
  if (method === 'program.input') {
    return exactObject(value, ['accepted']) && typeof value.accepted === 'boolean' ? { accepted: value.accepted } : null;
  }
  if (method === 'program.close') {
    return exactObject(value, ['closed']) && typeof value.closed === 'boolean' ? { closed: value.closed } : null;
  }
  return null;
}

class DesktopService extends EventEmitter {
  constructor({ session, workspaceRoot, hostName, BrowserWindow, ipcMain, programRendererPath } = {}) {
    super();
    if (!session?.on || typeof session.sendData !== 'function' || typeof workspaceRoot !== 'string' || !workspaceRoot) {
      throw new TypeError('DesktopService requires a session and workspaceRoot.');
    }
    this.session = session;
    this.workspaceRoot = workspaceRoot;
    this.hostName = sanitizeHostName(hostName);
    this.BrowserWindow = BrowserWindow;
    this.ipcMain = ipcMain;
    this.programRendererPath = programRendererPath;
    this.isHost = session.config?.role === 'host' || session.status?.().role === 'host';
    this.pending = new Map();
    this.hostRequests = new Set();
    this.workspaceSerial = 0;
    this.currentState = {
      version: SERVICE_VERSION,
      host: { name: this.isHost ? this.hostName : 'Host laptop' },
      workspaceSerial: 0,
      entries: [],
      programs: [],
      transfers: [],
      catalog: [{ id: 'text-editor', name: 'Text Editor', kind: 'editor' }],
    };
    this.started = false;
    this.stopped = false;
    this.stateQueue = Promise.resolve();
    this.onData = (message, memberId) => { this._handleData(message, memberId).catch(() => {}); };
    this.onDataStatus = (status) => { this._handleDataStatus(status).catch(() => {}); };
    this.onSessionStatus = (status) => this._handleSessionStatus(status);
  }

  async start() {
    if (this.started) return this.state();
    if (this.stopped) fail('SERVICE_STOPPED', 'The desktop service has stopped.');
    this.session.on('data', this.onData);
    this.session.on('data-status', this.onDataStatus);
    this.session.on('status', this.onSessionStatus);
    if (this.isHost) {
      this.workspace = await new Workspace(this.workspaceRoot).init();
      this.authority = new CapabilityAuthority();
      this.receiver = await new TransferReceiver(this.workspace).init();
      this.programManager = new ProgramManager({
        BrowserWindow: this.BrowserWindow,
        ipcMain: this.ipcMain,
        workspace: this.workspace,
        rendererPath: this.programRendererPath,
      });
      this.programManager.on('programs', () => { this._updateState().catch(() => {}); });
      this.programManager.on('saved', () => { this._updateState({ mutations: 1 }).catch(() => {}); });
      this.programManager.on('frame', (frame) => this._publishFrame(frame));
      await this._updateState({ broadcast: false });
    }
    this.started = true;
    this.emit('state', this.state());
    if (this.isHost && this.session.dataPhase === 'connected') this._broadcastState();
    if (!this.isHost && this.session.dataPhase === 'connected') this._request('workspace.list', { path: '' }).catch(() => {});
    return this.state();
  }

  state() {
    return structuredClone(this.currentState);
  }

  _assertRunning() {
    if (!this.started || this.stopped) fail('SERVICE_STOPPED', 'The desktop service is not running.');
  }

  _transferState() {
    if (!this.receiver) return [];
    return this.receiver.active().map(({ transferId, name, target, received, size }) => ({ transferId, name, target, received, size }));
  }

  _updateState({ mutations = 0, broadcast = true } = {}) {
    const update = this.stateQueue.then(async () => {
      if (this.stopped || !this.workspace) return this.state();
      this.workspaceSerial += mutations;
      const entries = await this.workspace.tree();
      this.currentState = {
        version: SERVICE_VERSION,
        host: { name: this.hostName },
        workspaceSerial: this.workspaceSerial,
        entries,
        programs: this.programManager?.programs() || [],
        transfers: this._transferState(),
        catalog: this.programManager?.catalog() || [{ id: 'text-editor', name: 'Text Editor', kind: 'editor' }],
      };
      this.emit('state', this.state());
      if (broadcast) this._broadcastState();
      return this.state();
    });
    this.stateQueue = update.catch(() => {});
    return update;
  }

  _wireState() {
    const state = this.state();
    if (boundedClone({ kind: 'desktop-state', state })) return state;
    return { ...state, entries: [], requiresList: true };
  }

  _broadcastState() {
    if (!this.isHost || this.stopped) return false;
    return this._send({ kind: 'desktop-state', state: this._wireState() });
  }

  _publishFrame(value) {
    const frame = publicFrame(value);
    if (!frame || this.stopped) return false;
    this.emit('frame', structuredClone(frame));
    // Session.sendData is deliberately non-queueing. False means this complete
    // frame is dropped and the next full frame can recover presentation.
    return this._send({ kind: 'program-frame', frame });
  }

  _send(envelope) {
    const clean = boundedClone(envelope);
    return Boolean(clean && this.session.sendData(clean));
  }

  async _handleData(message, memberId) {
    if (this.stopped || !message || typeof message !== 'object' || Array.isArray(message)) return;
    if (this.isHost) {
      if (!exactObject(message, ['kind', 'requestId', 'method', 'payload']) || message.kind !== 'desktop-request'
        || !REQUEST_ID.test(message.requestId) || typeof message.method !== 'string') return;
      if (this.hostRequests.has(message.requestId) || this.hostRequests.size >= MAX_PENDING) {
        this._send({ kind: 'desktop-result', requestId: message.requestId, ok: false, error: safeError({ code: 'PENDING_LIMIT' }) });
        return;
      }
      this.hostRequests.add(message.requestId);
      let result;
      try {
        if (!memberId) fail('UNAUTHORIZED', 'Missing authenticated member.');
        result = await this._dispatch(message.method, message.payload, memberId);
        result = publicResult(message.method, result);
        if (result === null) fail('INVALID_RESULT', 'Desktop handler returned an invalid result.');
        const response = boundedClone({ kind: 'desktop-result', requestId: message.requestId, ok: true, result });
        if (!response) throw new DesktopServiceError('RESULT_TOO_LARGE', 'Desktop result is too large.');
        this._send(response);
      } catch (error) {
        this._send({ kind: 'desktop-result', requestId: message.requestId, ok: false, error: safeError(error) });
      } finally {
        this.hostRequests.delete(message.requestId);
      }
      return;
    }
    if (message.kind === 'desktop-result') {
      if (!exactObject(message, ['kind', 'requestId', 'ok', 'result', 'error'], ['kind', 'requestId', 'ok'])
        || !REQUEST_ID.test(message.requestId) || typeof message.ok !== 'boolean') return;
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.ok) {
        const result = publicResult(pending.method, message.result);
        if (result === null) pending.reject(asServiceError({ code: 'INVALID_RESULT' }));
        else pending.resolve(result);
      }
      else {
        const safe = safeError(message.error);
        pending.reject(new DesktopServiceError(safe.code, safe.message));
      }
      return;
    }
    if (message.kind === 'desktop-state') {
      if (!exactObject(message, ['kind', 'state'])) return;
      const state = validateDesktopState(message.state);
      if (!state) return;
      this.currentState = state;
      this.emit('state', this.state());
      return;
    }
    if (message.kind === 'program-frame') {
      if (!exactObject(message, ['kind', 'frame'])) return;
      const frame = publicFrame(message.frame);
      if (frame) this.emit('frame', frame);
    }
  }

  async _handleDataStatus(status) {
    if (this.stopped || !status || typeof status !== 'object') return;
    if (this.isHost) {
      if (status.phase === 'connected') this._broadcastState();
      else if (status.phase === 'disconnected' && status.memberId && this.receiver) {
        const aborted = await this.receiver.abortOwner(status.memberId).catch(() => 0);
        if (aborted) await this._updateState();
      }
    } else if (status.phase === 'connected') {
      this._request('workspace.list', { path: '' }).catch(() => {});
    } else if (status.phase === 'disconnected') this._rejectPending('DATA_UNAVAILABLE');
  }

  _handleSessionStatus(status) {
    if (this.stopped || !status || typeof status !== 'object') return;
    if (!this.isHost && status.phase !== 'connected') this._rejectPending('DATA_UNAVAILABLE');
    if (this.isHost && status.phase !== 'connected' && status.phase !== 'hosting') this.receiver?.abortAll().then((count) => count && this._updateState()).catch(() => {});
  }

  _rejectPending(code) {
    const error = asServiceError({ code });
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  _request(method, payload) {
    this._assertRunning();
    if (this.isHost) return this._dispatch(method, payload, this.session.self?.id || 'host');
    if (this.pending.size >= MAX_PENDING) return Promise.reject(asServiceError({ code: 'PENDING_LIMIT' }));
    const requestId = `request-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(asServiceError({ code: 'REQUEST_TIMEOUT' }));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer, method });
      if (!this._send({ kind: 'desktop-request', requestId, method, payload })) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(asServiceError({ code: 'DATA_UNAVAILABLE' }));
      }
    });
  }

  async _dispatch(method, payload, actor) {
    if (!this.isHost || !this.authority) fail('UNAUTHORIZED', 'Only the host can perform desktop operations.');
    if (!isKnownCapability(method)) fail('UNKNOWN_CAPABILITY', 'Unknown desktop capability.');
    const request = this.authority.validate(method, payload);
    switch (method) {
      case 'workspace.list':
        return this.workspace.list(request.path);
      case 'workspace.mkdir': {
        const entry = await this.workspace.mkdir(request.path);
        await this._updateState({ mutations: 1 });
        return entry;
      }
      case 'workspace.rename': {
        const entry = await this.workspace.rename(request.from, request.to);
        await this._updateState({ mutations: 1 });
        return entry;
      }
      case 'workspace.delete': {
        const result = await this.workspace.delete(request.path);
        await this._updateState({ mutations: 1 });
        return result;
      }
      case 'transfer.start': {
        const result = await this.receiver.start(request, actor);
        await this._updateState();
        this.emit('transfer', { ...result, message: `Receiving ${request.name}…` });
        return result;
      }
      case 'transfer.chunk': {
        try {
          const result = await this.receiver.chunk(request, actor);
          this.emit('transfer', { ...structuredClone(result), message: 'Receiving file…' });
          return result;
        } catch (error) {
          await this._updateState();
          this.emit('transfer', { transferId: request.transferId, error: safeError(error).message });
          throw error;
        }
      }
      case 'transfer.finish': {
        try {
          const result = await this.receiver.finish(request, actor);
          await this._updateState({ mutations: 1 });
          this.emit('transfer', { transferId: result.transferId, received: result.entry.size, size: result.entry.size, done: true, message: `Imported ${result.entry.name}.` });
          return result;
        } catch (error) {
          await this._updateState();
          this.emit('transfer', { transferId: request.transferId, error: safeError(error).message });
          throw error;
        }
      }
      case 'transfer.abort': {
        const result = await this.receiver.abort(request, actor);
        await this._updateState();
        this.emit('transfer', { transferId: result.transferId, error: 'Transfer cancelled.' });
        return result;
      }
      case 'program.launch':
        return this.programManager.launch(request.path, request.app);
      case 'program.input':
        return { accepted: this.programManager.input(request.programId, request.input) };
      case 'program.close':
        return { closed: this.programManager.close(request.programId) };
      default:
        fail('UNKNOWN_CAPABILITY', 'Unknown desktop capability.');
    }
  }

  async handleCommand(command, data = {}) {
    this._assertRunning();
    try {
      switch (command) {
        case 'list':
          return await this._request('workspace.list', { path: data?.path ?? '' });
        case 'mkdir':
          return await this._request('workspace.mkdir', { path: joinPublic(data?.parent ?? '', data?.name) });
        case 'rename': {
          const source = validatePublicPath(data?.path, { allowRoot: false });
          return await this._request('workspace.rename', { from: source, to: joinPublic(parentOf(source), data?.name) });
        }
        case 'delete':
          return await this._request('workspace.delete', { path: data?.path });
        case 'program-launch':
          return await this._request('program.launch', { app: data?.kind ?? 'text-editor', path: data?.path });
        case 'program-input':
          return await this._request('program.input', { programId: data?.programId, input: data?.input });
        case 'program-close':
          return await this._request('program.close', { programId: data?.programId });
        default:
          fail('UNKNOWN_COMMAND', 'Unknown desktop command.');
      }
    } catch (error) {
      throw asServiceError(error);
    }
  }

  async _enumerateSources(absoluteLocalPaths) {
    if (!Array.isArray(absoluteLocalPaths) || !absoluteLocalPaths.length || absoluteLocalPaths.length > MAX_IMPORT_ROOTS) fail('INVALID_SOURCE', 'Choose one or more local files or directories.');
    const roots = [];
    let count = 0;
    let bytes = 0;
    const visit = async (nativePath, rootReal, parts, output) => {
      const stat = await fsp.lstat(nativePath);
      if (stat.isSymbolicLink()) fail('UNSAFE_SYMLINK', 'Symbolic links cannot be imported.');
      const real = await fsp.realpath(nativePath);
      const relative = path.relative(rootReal, real);
      if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) fail('PATH_ESCAPE', 'The import escaped its selected root.');
      for (const part of parts) portableName(part);
      if (parts.length > DEFAULT_LIMITS.maxDepth) fail('PATH_DEPTH', 'The imported directory is too deep.');
      if (!stat.isFile() && !stat.isDirectory()) fail('INVALID_SOURCE', 'Only regular files and directories can be imported.');
      if (stat.isFile()) {
        if (stat.size > DEFAULT_LIMITS.maxFileBytes) fail('FILE_QUOTA', 'A selected file exceeds the import limit.');
        bytes += stat.size;
        if (bytes > DEFAULT_LIMITS.maxWorkspaceBytes) fail('WORKSPACE_QUOTA', 'The selected import exceeds the workspace storage limit.');
      }
      if (++count > DEFAULT_LIMITS.maxEntries) fail('ENTRY_QUOTA', 'The selected import contains too many items.');
      output.push({ source: real, parts, type: stat.isDirectory() ? 'directory' : 'file', size: stat.isFile() ? stat.size : 0 });
      if (stat.isDirectory()) {
        const children = (await fsp.readdir(real)).sort((a, b) => a.localeCompare(b));
        for (const name of children) await visit(path.join(real, name), rootReal, [...parts, name], output);
      }
    };
    for (const source of absoluteLocalPaths) {
      if (typeof source !== 'string' || !path.isAbsolute(source)) fail('INVALID_SOURCE', 'Local imports require absolute paths selected on this laptop.');
      const name = path.basename(source);
      portableName(name);
      const real = await fsp.realpath(source);
      const output = [];
      await visit(source, real, [name], output);
      roots.push(output);
    }
    return roots;
  }

  async _collisionDirectory(target, name, remote) {
    const list = remote ? await this.handleCommand('list', { path: target }) : await this.workspace.list(target);
    const used = new Set(list.map((entry) => entry.name.toLowerCase()));
    for (let index = 0; index < 100_000; index++) {
      const suffix = index ? ` (${index})` : '';
      const candidate = `${name.slice(0, Math.max(1, 255 - suffix.length))}${suffix}`;
      portableName(candidate);
      if (used.has(candidate.toLowerCase())) continue;
      try {
        const entry = remote
          ? await this.handleCommand('mkdir', { parent: target, name: candidate })
          : await this.workspace.mkdir(joinPublic(target, candidate));
        return entry;
      } catch (error) {
        if (error.code !== 'ALREADY_EXISTS') throw error;
        used.add(candidate.toLowerCase());
      }
    }
    fail('COLLISION_LIMIT', 'Could not create a collision-free import folder.');
  }

  async _hashFile(source, expectedSize) {
    const handle = await fsp.open(source, 'r');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(MAX_CHUNK_BYTES);
    let offset = 0;
    try {
      while (offset < expectedSize) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expectedSize - offset), offset);
        if (!bytesRead) fail('SOURCE_CHANGED', 'The selected file changed while it was being read.');
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const current = await handle.stat();
      if (current.size !== expectedSize) fail('SOURCE_CHANGED', 'The selected file changed while it was being read.');
      return hash.digest('hex');
    } finally { await handle.close(); }
  }

  async _sendFile(source, target, name, size) {
    const transferId = `transfer-${randomUUID()}`;
    const sha256 = await this._hashFile(source, size);
    await this._request('transfer.start', { transferId, name, target, size, sha256 });
    const handle = await fsp.open(source, 'r');
    let offset = 0;
    try {
      const buffer = Buffer.allocUnsafe(MAX_CHUNK_BYTES);
      while (offset < size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
        if (!bytesRead) fail('SOURCE_CHANGED', 'The selected file changed while it was being transferred.');
        const data = buffer.subarray(0, bytesRead);
        const progress = await this._request('transfer.chunk', { transferId, offset, data: data.toString('base64') });
        if (progress?.received !== offset + bytesRead) fail('TRANSFER_ACK', 'The host returned an invalid transfer acknowledgement.');
        offset += bytesRead;
        this.emit('transfer', { transferId, received: offset, size });
      }
      const current = await handle.stat();
      if (current.size !== size) fail('SOURCE_CHANGED', 'The selected file changed while it was being transferred.');
      const result = await this._request('transfer.finish', { transferId });
      this.emit('transfer', { transferId, received: size, size, done: true, message: `Imported ${name}.` });
      return result;
    } catch (error) {
      await this._request('transfer.abort', { transferId }).catch(() => {});
      this.emit('transfer', { transferId, error: safeError(error).message });
      throw error;
    } finally { await handle.close(); }
  }

  async importPaths(absoluteLocalPaths, target = '') {
    this._assertRunning();
    try {
      const cleanTarget = validateCapabilityRequest('workspace.list', { path: target }).path;
      const roots = await this._enumerateSources(absoluteLocalPaths);
      const imported = [];
      if (this.isHost) {
        let mutations = 0;
        try {
          for (const root of roots) {
            const first = root[0];
            if (first.type === 'file') {
              imported.push(await this.workspace.importFile(first.source, cleanTarget, first.parts[0]));
              mutations++;
              continue;
            }
            const top = await this._collisionDirectory(cleanTarget, first.parts[0], false);
            imported.push(top);
            mutations++;
            for (const item of root.slice(1)) {
              const relative = item.parts.slice(1);
              const destination = [top.path, ...relative].join('/');
              if (item.type === 'directory') imported.push(await this.workspace.mkdir(destination));
              else imported.push(await this.workspace.importFile(item.source, parentOf(destination), path.posix.basename(destination)));
              mutations++;
            }
          }
        } finally {
          if (mutations) await this._updateState({ mutations });
        }
        if (imported.length) this.emit('transfer', { done: true, message: `Imported ${imported.length} item${imported.length === 1 ? '' : 's'}.` });
        return imported;
      }

      for (const root of roots) {
        const first = root[0];
        if (first.type === 'file') {
          imported.push((await this._sendFile(first.source, cleanTarget, first.parts[0], first.size)).entry);
          continue;
        }
        const top = await this._collisionDirectory(cleanTarget, first.parts[0], true);
        imported.push(top);
        for (const item of root.slice(1)) {
          const relative = item.parts.slice(1);
          const destination = [top.path, ...relative].join('/');
          if (item.type === 'directory') imported.push(await this.handleCommand('mkdir', { parent: parentOf(destination), name: path.posix.basename(destination) }));
          else imported.push((await this._sendFile(item.source, parentOf(destination), path.posix.basename(destination), item.size)).entry);
        }
      }
      return imported;
    } catch (error) {
      throw asServiceError(error);
    }
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.session.removeListener?.('data', this.onData);
    this.session.removeListener?.('data-status', this.onDataStatus);
    this.session.removeListener?.('status', this.onSessionStatus);
    this._rejectPending('DATA_UNAVAILABLE');
    await this.receiver?.abortAll().catch(() => {});
    await this.programManager?.stop().catch(() => {});
    this.removeAllListeners();
  }
}

module.exports = {
  DesktopService,
  DesktopServiceError,
  SERVICE_VERSION,
  MAX_PENDING,
  REQUEST_TIMEOUT_MS,
  MAX_ENVELOPE_BYTES,
  MAX_FRAME_BYTES,
  validateDesktopState,
  publicResult,
};
