'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { TextDecoder } = require('node:util');

const MIB = 1024 * 1024;
const DEFAULT_LIMITS = Object.freeze({
  maxDepth: 32,
  maxEntries: 10_000,
  maxFileBytes: 256 * MIB,
  maxWorkspaceBytes: 1024 * MIB,
  maxTextBytes: 2 * MIB,
});
const INTERNAL_NAME = '.compusync';
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

class WorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new WorkspaceError(code, message);
}

function positiveLimit(value, fallback, name) {
  const next = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(next) || next < 0) fail('INVALID_LIMIT', `${name} must be a non-negative safe integer.`);
  return next;
}

function validateSegment(segment) {
  if (!segment || segment === '.' || segment === '..') fail('INVALID_PATH', 'Workspace paths cannot contain empty or dot segments.');
  if (segment.length > 255) fail('INVALID_PATH', 'A workspace path segment is too long.');
  if (segment.toLowerCase() === INTERNAL_NAME) fail('RESERVED_PATH', `${INTERNAL_NAME} is reserved for internal storage.`);
  if (/[<>:"\\|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment)) fail('INVALID_PATH', 'The workspace path contains a name that is not portable.');
  if (WINDOWS_RESERVED.test(segment)) fail('RESERVED_PATH', 'The workspace path uses a reserved Windows device name.');
}

/**
 * Validate the path used at every public API boundary. Public paths always use
 * POSIX separators, even on Windows, and never reveal the host workspace root.
 */
function validatePublicPath(value, options = {}) {
  const { allowRoot = true, maxDepth = DEFAULT_LIMITS.maxDepth, singleSegment = false } = options;
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) fail('INVALID_PATH', 'Workspace path must be a short text value.');
  if (value === '') {
    if (allowRoot) return '';
    fail('INVALID_PATH', 'The workspace root is not valid for this operation.');
  }
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value) || value.includes('\\')) fail('INVALID_PATH', 'Workspace paths must be relative and use forward slashes.');
  const segments = value.split('/');
  if (singleSegment && segments.length !== 1) fail('INVALID_PATH', 'A single file or directory name is required.');
  if (segments.length > maxDepth) fail('PATH_DEPTH', `Workspace paths may contain at most ${maxDepth} segments.`);
  for (const segment of segments) validateSegment(segment);
  return segments.join('/');
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

class Workspace {
  constructor(root, options = {}) {
    if (typeof root !== 'string' || !root) fail('INVALID_ROOT', 'A workspace root is required.');
    this.root = path.resolve(root);
    this.limits = Object.freeze({
      maxDepth: positiveLimit(options.maxDepth, DEFAULT_LIMITS.maxDepth, 'maxDepth'),
      maxEntries: positiveLimit(options.maxEntries, DEFAULT_LIMITS.maxEntries, 'maxEntries'),
      maxFileBytes: positiveLimit(options.maxFileBytes, DEFAULT_LIMITS.maxFileBytes, 'maxFileBytes'),
      maxWorkspaceBytes: positiveLimit(options.maxWorkspaceBytes, DEFAULT_LIMITS.maxWorkspaceBytes, 'maxWorkspaceBytes'),
      maxTextBytes: positiveLimit(options.maxTextBytes, DEFAULT_LIMITS.maxTextBytes, 'maxTextBytes'),
    });
    if (this.limits.maxTextBytes > this.limits.maxFileBytes) fail('INVALID_LIMIT', 'maxTextBytes cannot exceed maxFileBytes.');
    this.ready = false;
  }

  async init() {
    await fsp.mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootStat = await fsp.lstat(this.root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('INVALID_ROOT', 'The workspace root must be a real directory, not a symbolic link.');
    this.realRoot = await fsp.realpath(this.root);
    this.internalRoot = path.join(this.realRoot, INTERNAL_NAME);
    this.transferRoot = path.join(this.internalRoot, 'transfers');
    this.tempRoot = path.join(this.internalRoot, 'temp');
    await this._ensureInternalDirectory(this.internalRoot);
    await this._ensureInternalDirectory(this.transferRoot);
    await this._ensureInternalDirectory(this.tempRoot);
    this.ready = true;
    await this._scan();
    return this;
  }

  async _ensureInternalDirectory(directory) {
    try {
      const stat = await fsp.lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('UNSAFE_SYMLINK', 'Internal workspace storage is not a real directory.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fsp.mkdir(directory, { mode: 0o700 });
    }
    const real = await fsp.realpath(directory);
    if (!isWithin(this.realRoot, real)) fail('PATH_ESCAPE', 'Internal workspace storage escaped its root.');
  }

  _assertReady() {
    if (!this.ready) fail('NOT_INITIALIZED', 'Initialize the workspace before using it.');
  }

  _public(value, allowRoot = true) {
    return validatePublicPath(value, { allowRoot, maxDepth: this.limits.maxDepth });
  }

  _native(publicPath) {
    return publicPath ? path.join(this.realRoot, ...publicPath.split('/')) : this.realRoot;
  }

  async _walkExisting(publicPath) {
    this._assertReady();
    const clean = this._public(publicPath, true);
    let current = this.realRoot;
    for (const segment of clean ? clean.split('/') : []) {
      current = path.join(current, segment);
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) fail('UNSAFE_SYMLINK', 'Symbolic links are not allowed in the shared workspace.');
    }
    const real = await fsp.realpath(current);
    if (!isWithin(this.realRoot, real)) fail('PATH_ESCAPE', 'The workspace path escaped its root.');
    return { publicPath: clean, nativePath: current, realPath: real, stat: await fsp.lstat(current) };
  }

  async _resolveForCreate(publicPath) {
    this._assertReady();
    const clean = this._public(publicPath, false);
    const segments = clean.split('/');
    const name = segments.pop();
    const parentPublic = segments.join('/');
    const parent = await this._walkExisting(parentPublic);
    if (!parent.stat.isDirectory()) fail('NOT_DIRECTORY', 'The destination parent is not a directory.');
    return { publicPath: clean, nativePath: path.join(parent.realPath, name), parent, name };
  }

  async _scan() {
    this._assertReady();
    const entries = [];
    let bytes = 0;
    const visit = async (nativeDirectory, publicDirectory) => {
      const children = await fsp.readdir(nativeDirectory, { withFileTypes: true });
      for (const child of children) {
        if (!publicDirectory && child.name === INTERNAL_NAME) continue;
        const publicPath = publicDirectory ? `${publicDirectory}/${child.name}` : child.name;
        this._public(publicPath, false);
        const nativePath = path.join(nativeDirectory, child.name);
        const stat = await fsp.lstat(nativePath);
        if (stat.isSymbolicLink()) fail('UNSAFE_SYMLINK', 'Symbolic links are not allowed in the shared workspace.');
        const real = await fsp.realpath(nativePath);
        if (!isWithin(this.realRoot, real)) fail('PATH_ESCAPE', 'A workspace entry escaped its root.');
        let type;
        if (stat.isDirectory()) type = 'directory';
        else if (stat.isFile()) type = 'file';
        else fail('UNSUPPORTED_ENTRY', 'Only regular files and directories can be shared.');
        if (type === 'file') {
          if (stat.size > this.limits.maxFileBytes) fail('FILE_QUOTA', `Files may not exceed ${this.limits.maxFileBytes} bytes.`);
          bytes += stat.size;
        }
        entries.push({ publicPath, name: child.name, type, size: type === 'file' ? stat.size : 0, modifiedAt: stat.mtimeMs });
        if (entries.length > this.limits.maxEntries) fail('ENTRY_QUOTA', `The workspace may contain at most ${this.limits.maxEntries} entries.`);
        if (bytes > this.limits.maxWorkspaceBytes) fail('WORKSPACE_QUOTA', `The workspace may contain at most ${this.limits.maxWorkspaceBytes} bytes.`);
        if (type === 'directory') await visit(nativePath, publicPath);
      }
    };
    await visit(this.realRoot, '');
    return { entries, bytes };
  }

  _entryShape(entry) {
    return { path: entry.publicPath, name: entry.name, type: entry.type, size: entry.size, modifiedAt: entry.modifiedAt };
  }

  async _entry(publicPath) {
    const resolved = await this._walkExisting(publicPath);
    if (resolved.stat.isSymbolicLink()) fail('UNSAFE_SYMLINK', 'Symbolic links are not allowed in the shared workspace.');
    const type = resolved.stat.isDirectory() ? 'directory' : resolved.stat.isFile() ? 'file' : null;
    if (!type) fail('UNSUPPORTED_ENTRY', 'Only regular files and directories can be shared.');
    return this._entryShape({ publicPath: resolved.publicPath, name: path.posix.basename(resolved.publicPath), type, size: type === 'file' ? resolved.stat.size : 0, modifiedAt: resolved.stat.mtimeMs });
  }

  async stats() {
    const snapshot = await this._scan();
    return { entries: snapshot.entries.length, bytes: snapshot.bytes };
  }

  async list(publicDirectory = '', options = {}) {
    const clean = this._public(publicDirectory, true);
    const directory = await this._walkExisting(clean);
    if (!directory.stat.isDirectory()) fail('NOT_DIRECTORY', 'The requested workspace path is not a directory.');
    const recursive = Boolean(options.recursive);
    const prefix = clean ? `${clean}/` : '';
    const snapshot = await this._scan();
    return snapshot.entries
      .filter((entry) => entry.publicPath.startsWith(prefix) && (recursive || !entry.publicPath.slice(prefix.length).includes('/')))
      .map((entry) => this._entryShape(entry))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  tree() {
    return this.list('', { recursive: true });
  }

  async mkdir(publicPath) {
    const destination = await this._resolveForCreate(publicPath);
    const usage = await this.stats();
    if (usage.entries + 1 > this.limits.maxEntries) fail('ENTRY_QUOTA', `The workspace may contain at most ${this.limits.maxEntries} entries.`);
    try {
      await fsp.mkdir(destination.nativePath, { mode: 0o700 });
    } catch (error) {
      if (error.code === 'EEXIST') fail('ALREADY_EXISTS', 'A workspace entry with that name already exists.');
      throw error;
    }
    return this._entry(destination.publicPath);
  }

  async _namesIn(publicDirectory) {
    const directory = await this._walkExisting(publicDirectory);
    if (!directory.stat.isDirectory()) fail('NOT_DIRECTORY', 'The import destination is not a directory.');
    const names = await fsp.readdir(directory.realPath);
    return { directory, lowerNames: new Set(names.map((name) => name.toLowerCase())) };
  }

  _collisionCandidate(preferredName, index) {
    if (!index) return preferredName;
    const extension = path.posix.extname(preferredName);
    const base = preferredName.slice(0, preferredName.length - extension.length);
    const suffix = ` (${index})`;
    const allowedBase = Math.max(1, 255 - extension.length - suffix.length);
    return `${base.slice(0, allowedBase)}${suffix}${extension}`;
  }

  async importFile(sourceHostPath, targetDirectory = '', preferredName = undefined) {
    this._assertReady();
    if (typeof sourceHostPath !== 'string' || !path.isAbsolute(sourceHostPath)) fail('INVALID_SOURCE', 'A local absolute source path is required.');
    const sourceStat = await fsp.lstat(sourceHostPath);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) fail('INVALID_SOURCE', 'Only regular local files can be imported.');
    if (sourceStat.size > this.limits.maxFileBytes) fail('FILE_QUOTA', `Files may not exceed ${this.limits.maxFileBytes} bytes.`);
    const cleanTarget = this._public(targetDirectory, true);
    const requestedName = preferredName === undefined ? path.basename(sourceHostPath) : preferredName;
    validatePublicPath(requestedName, { allowRoot: false, maxDepth: 1, singleSegment: true });
    const usage = await this.stats();
    if (usage.entries + 1 > this.limits.maxEntries) fail('ENTRY_QUOTA', `The workspace may contain at most ${this.limits.maxEntries} entries.`);
    if (usage.bytes + sourceStat.size > this.limits.maxWorkspaceBytes) fail('WORKSPACE_QUOTA', `The workspace may contain at most ${this.limits.maxWorkspaceBytes} bytes.`);

    const { directory, lowerNames } = await this._namesIn(cleanTarget);
    for (let index = 0; index < 100_000; index++) {
      const candidate = this._collisionCandidate(requestedName, index);
      validatePublicPath(candidate, { allowRoot: false, maxDepth: 1, singleSegment: true });
      if (lowerNames.has(candidate.toLowerCase())) continue;
      const nativeDestination = path.join(directory.realPath, candidate);
      try {
        await fsp.copyFile(sourceHostPath, nativeDestination, fs.constants.COPYFILE_EXCL);
        const copied = await fsp.lstat(nativeDestination);
        if (copied.isSymbolicLink() || !copied.isFile() || copied.size > this.limits.maxFileBytes || usage.bytes + copied.size > this.limits.maxWorkspaceBytes) {
          await fsp.rm(nativeDestination, { force: true });
          fail('IMPORT_CHANGED', 'The source file changed or exceeded a workspace limit during import.');
        }
        const publicPath = cleanTarget ? `${cleanTarget}/${candidate}` : candidate;
        return this._entry(publicPath);
      } catch (error) {
        if (error.code === 'EEXIST') { lowerNames.add(candidate.toLowerCase()); continue; }
        throw error;
      }
    }
    fail('COLLISION_LIMIT', 'Could not allocate a collision-free workspace name.');
  }

  importLocal(sourceHostPath, targetDirectory = '', preferredName = undefined) {
    return this.importFile(sourceHostPath, targetDirectory, preferredName);
  }

  async rename(fromPublicPath, toPublicPath) {
    const from = this._public(fromPublicPath, false);
    const to = this._public(toPublicPath, false);
    if (from === to) return this._entry(from);
    if (to.startsWith(`${from}/`)) fail('INVALID_MOVE', 'A directory cannot be moved inside itself.');
    const source = await this._walkExisting(from);
    const destination = await this._resolveForCreate(to);
    const siblings = await fsp.readdir(destination.parent.realPath);
    const sourceParent = path.posix.dirname(from) === '.' ? '' : path.posix.dirname(from);
    const sourceName = path.posix.basename(from);
    const collision = siblings.some((name) => name.toLowerCase() === destination.name.toLowerCase() && !(sourceParent === destination.parent.publicPath && name === sourceName));
    if (collision) fail('ALREADY_EXISTS', 'A workspace entry with that name already exists.');
    try {
      await fsp.rename(source.realPath, destination.nativePath);
    } catch (error) {
      if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') fail('ALREADY_EXISTS', 'A workspace entry with that name already exists.');
      throw error;
    }
    return this._entry(to);
  }

  async delete(publicPath) {
    const clean = this._public(publicPath, false);
    const resolved = await this._walkExisting(clean);
    await fsp.rm(resolved.realPath, { recursive: true, force: false });
    return { path: clean, deleted: true };
  }

  async readText(publicPath) {
    const resolved = await this._walkExisting(this._public(publicPath, false));
    if (!resolved.stat.isFile()) fail('NOT_FILE', 'The requested workspace entry is not a file.');
    if (resolved.stat.size > this.limits.maxTextBytes) fail('TEXT_QUOTA', `Text documents may not exceed ${this.limits.maxTextBytes} bytes.`);
    const contents = await fsp.readFile(resolved.realPath);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(contents);
    } catch {
      fail('INVALID_UTF8', 'The selected file is not valid UTF-8 text.');
    }
  }

  async writeText(publicPath, text) {
    const clean = this._public(publicPath, false);
    if (typeof text !== 'string') fail('INVALID_TEXT', 'Text document contents must be a string.');
    const contents = Buffer.from(text, 'utf8');
    if (contents.length > this.limits.maxTextBytes || contents.length > this.limits.maxFileBytes) fail('TEXT_QUOTA', `Text documents may not exceed ${this.limits.maxTextBytes} bytes.`);
    const destination = await this._resolveForCreate(clean);
    let oldSize = 0;
    let createsEntry = true;
    try {
      const existing = await this._walkExisting(clean);
      if (!existing.stat.isFile()) fail('NOT_FILE', 'Text can only replace a regular file.');
      oldSize = existing.stat.size;
      createsEntry = false;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const usage = await this.stats();
    if (createsEntry && usage.entries + 1 > this.limits.maxEntries) fail('ENTRY_QUOTA', `The workspace may contain at most ${this.limits.maxEntries} entries.`);
    if (usage.bytes - oldSize + contents.length > this.limits.maxWorkspaceBytes) fail('WORKSPACE_QUOTA', `The workspace may contain at most ${this.limits.maxWorkspaceBytes} bytes.`);

    const temp = path.join(this.tempRoot, `${randomUUID()}.tmp`);
    try {
      await fsp.writeFile(temp, contents, { flag: 'wx', mode: 0o600 });
      if (!createsEntry) {
        const current = await fsp.lstat(destination.nativePath);
        if (current.isSymbolicLink() || !current.isFile()) fail('UNSAFE_SYMLINK', 'The destination changed before it could be saved.');
      }
      await fsp.rename(temp, destination.nativePath);
    } finally {
      await fsp.rm(temp, { force: true }).catch(() => {});
    }
    return this._entry(clean);
  }

  // Trusted core services use this path for bounded partials. It must never be
  // returned through renderer IPC or sent to a peer.
  internalTransferDirectory() {
    this._assertReady();
    return this.transferRoot;
  }
}

module.exports = { Workspace, WorkspaceError, validatePublicPath, DEFAULT_LIMITS, INTERNAL_NAME };
