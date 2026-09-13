'use strict';

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { execFile: execFileCallback, spawn: spawnProcess } = require('node:child_process');
const { DEBUG_PORT_MIN, DEBUG_PORT_MAX, isChromeWindow } = require('./detect.cjs');

const DECISION_KEY = 'chromeWindowsRelaunchDecision';
const SIGNED_OUT_NOTICE_KEY = 'chromeIsolatedProfileNoticeShown';
const OFFER_MESSAGE = 'Chrome needs a one-time restart to enable window handoff. Your tabs will be restored.';
const SESSION_MIGRATION_DETAIL = 'Compusync copies only Chrome session files. Cookies, credentials, extensions, preferences, and sign-in data stay in your normal profile. After Chrome reopens, drag the window across again.';
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_CLOSE_POLL_MS = 100;
const MAX_SESSION_FILES = 512;
const MAX_SESSION_BYTES = 512 * 1024 * 1024;
const SESSION_ENTRY_NAMES = ['Sessions', 'Last Session', 'Last Tabs'];

function standardChromePaths(env = process.env) {
  return [
    env.ProgramFiles && path.join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
}

function findChromeExecutable(options = {}) {
  const fsLike = options.fs || fs;
  const candidates = options.candidates || standardChromePaths(options.env);
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || path.basename(candidate).toLowerCase() !== 'chrome.exe') continue;
    try { if (fsLike.statSync(candidate).isFile()) return path.resolve(candidate); } catch {}
  }
  return null;
}

function profileDirectory(options = {}) {
  const localAppData = options.localAppData || options.env?.LOCALAPPDATA || process.env.LOCALAPPDATA;
  if (!localAppData || typeof localAppData !== 'string') throw new Error('LOCALAPPDATA is unavailable.');
  return path.resolve(localAppData, 'Compusync', 'browser-profile');
}

function normalUserDataDirectory(options = {}) {
  const localAppData = options.localAppData || options.env?.LOCALAPPDATA || process.env.LOCALAPPDATA;
  if (!localAppData || typeof localAppData !== 'string') throw new Error('LOCALAPPDATA is unavailable.');
  return path.resolve(localAppData, 'Google', 'Chrome', 'User Data');
}

function validatePort(port) {
  const result = Number(port ?? DEBUG_PORT_MIN);
  if (!Number.isInteger(result) || result < DEBUG_PORT_MIN || result > DEBUG_PORT_MAX) {
    throw new RangeError(`Chrome debug port must be ${DEBUG_PORT_MIN}-${DEBUG_PORT_MAX}.`);
  }
  return result;
}

function unpackedExtensionDirectory(source) {
  return source.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

function defaultExtensionDirectory() {
  return unpackedExtensionDirectory(path.resolve(__dirname, 'extension'));
}

function relaunchArguments(userDataDir, port = DEBUG_PORT_MIN) {
  if (typeof userDataDir !== 'string' || !path.isAbsolute(userDataDir) || userDataDir.length > 1_024) {
    throw new TypeError('An absolute isolated profile directory is required.');
  }
  const cleanPort = validatePort(port);
  return [
    `--remote-debugging-port=${cleanPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userDataDir}`,
    '--restore-last-session',
    '--no-first-run',
    '--no-default-browser-check',
  ];
}

function execFilePromise(execFile, executable, args, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    let result;
    try {
      result = execFile(executable, args, options, (error, stdout, stderr) => done(error, { stdout, stderr }));
    } catch (error) { done(error); return; }
    if (result?.then) result.then((value) => done(null, value), done);
  });
}

function nativeChromeWindows(native) {
  if (typeof native?.enumerateWindows !== 'function') return null;
  const windows = native.enumerateWindows();
  if (!Array.isArray(windows)) throw new TypeError('Native window enumeration must return an array.');
  return windows.filter((window) => isChromeWindow(window) && window.visible !== false);
}

async function nativeChromeIsRunning(native) {
  return nativeChromeWindows(native)?.length > 0;
}

async function requestChromeClose(options = {}) {
  const native = options.native;
  if (typeof native?.enumerateWindows === 'function' && typeof native?.closeWindow === 'function') {
    try {
      const windows = nativeChromeWindows(native);
      const ids = [...new Set(windows.map((window) => window.id).filter((id) => id != null).map(String))];
      for (const id of ids) await native.closeWindow(id);
      return true;
    } catch (error) {
      const wrapped = new Error('Chrome did not accept the graceful window close request.');
      wrapped.code = 'CHROME_CLOSE_FAILED';
      wrapped.cause = error;
      throw wrapped;
    }
  }
  const execFile = options.execFile || execFileCallback;
  try {
    await execFilePromise(execFile, 'taskkill.exe', ['/IM', 'chrome.exe', '/T'], {
      windowsHide: true, timeout: Math.min(Number(options.timeoutMs) || DEFAULT_CLOSE_TIMEOUT_MS, 10_000),
    });
    return true;
  } catch (error) {
    const wrapped = new Error('Chrome did not accept the graceful restart request.');
    wrapped.code = 'CHROME_CLOSE_FAILED';
    wrapped.cause = error;
    throw wrapped;
  }
}

async function chromeIsRunning(options = {}) {
  const execFile = options.execFile || execFileCallback;
  let result;
  try {
    result = await execFilePromise(execFile, 'tasklist.exe', ['/FI', 'IMAGENAME eq chrome.exe', '/FO', 'CSV', '/NH'], {
      windowsHide: true, timeout: 2_000, maxBuffer: 64 * 1024,
    });
  } catch (error) {
    const wrapped = new Error('Could not verify that Chrome exited.');
    wrapped.code = 'CHROME_EXIT_CHECK_FAILED';
    wrapped.cause = error;
    throw wrapped;
  }
  const output = typeof result === 'string' ? result : String(result?.stdout || '');
  return /^\s*"chrome\.exe"\s*,/im.test(output);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForChromeExit(checkRunning, options = {}) {
  if (typeof checkRunning !== 'function') throw new TypeError('A Chrome process check is required.');
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || DEFAULT_CLOSE_TIMEOUT_MS, 100), 10_000);
  const pollMs = Math.min(Math.max(Number(options.pollMs) || DEFAULT_CLOSE_POLL_MS, 10), timeoutMs);
  const wait = options.delay || delay;
  const checks = Math.ceil(timeoutMs / pollMs) + 1;
  for (let index = 0; index < checks; index += 1) {
    if (!await checkRunning()) return true;
    if (index < checks - 1) await wait(pollMs);
  }
  const error = new Error('Chrome did not exit before the restart timeout.');
  error.code = 'CHROME_EXIT_TIMEOUT';
  throw error;
}

function migrationError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function assertMigrationPath(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 1_024) {
    throw migrationError('CHROME_SESSION_PATH_INVALID', `${name} must be an absolute path.`);
  }
  return path.resolve(value);
}

function containedBy(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function existingRealEntry(fsLike, entryPath) {
  try {
    const info = await fsLike.promises.lstat(entryPath);
    if (info.isSymbolicLink()) throw migrationError('CHROME_SESSION_UNSAFE_ENTRY', 'Chrome session data contains a symbolic link or junction.');
    return info;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function copySessionEntry(source, destination, state, fsLike) {
  const info = await existingRealEntry(fsLike, source);
  if (!info) return false;
  state.files += 1;
  if (state.files > MAX_SESSION_FILES) throw migrationError('CHROME_SESSION_TOO_LARGE', 'Chrome session contains too many files.');
  if (info.isDirectory()) {
    await fsLike.promises.mkdir(destination, { recursive: true, mode: 0o700 });
    const entries = await fsLike.promises.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw migrationError('CHROME_SESSION_UNSAFE_ENTRY', 'Chrome session data contains a symbolic link or junction.');
      await copySessionEntry(path.join(source, entry.name), path.join(destination, entry.name), state, fsLike);
    }
    return true;
  }
  if (!info.isFile()) throw migrationError('CHROME_SESSION_UNSAFE_ENTRY', 'Chrome session data contains an unsupported entry.');
  state.bytes += info.size;
  if (state.bytes > MAX_SESSION_BYTES) throw migrationError('CHROME_SESSION_TOO_LARGE', 'Chrome session data exceeds the safe migration limit.');
  await fsLike.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  await fsLike.promises.chmod(destination, 0o600);
  return true;
}

async function migrateChromeSession(options = {}) {
  const fsLike = options.fs || fs;
  const sourceUserDataDir = assertMigrationPath(options.sourceUserDataDir, 'Normal Chrome user-data directory');
  const targetUserDataDir = assertMigrationPath(options.targetUserDataDir, 'Isolated Chrome user-data directory');
  if (sourceUserDataDir === targetUserDataDir || containedBy(sourceUserDataDir, targetUserDataDir) || containedBy(targetUserDataDir, sourceUserDataDir)) {
    throw migrationError('CHROME_SESSION_PATH_INVALID', 'Normal and isolated Chrome profiles must be separate.');
  }
  const sourceDefault = path.join(sourceUserDataDir, 'Default');
  const targetDefault = path.join(targetUserDataDir, 'Default');
  const sourceRootInfo = await existingRealEntry(fsLike, sourceUserDataDir);
  if (!sourceRootInfo?.isDirectory()) {
    if (options.required === false) return { migrated: false, files: 0, bytes: 0 };
    throw migrationError('CHROME_SESSION_NOT_FOUND', 'Chrome did not produce session data to restore.');
  }
  await fsLike.promises.mkdir(targetUserDataDir, { recursive: true, mode: 0o700 });
  const targetRootInfo = await existingRealEntry(fsLike, targetUserDataDir);
  if (!targetRootInfo?.isDirectory()) throw migrationError('CHROME_SESSION_PATH_INVALID', 'Isolated Chrome profile is not a real directory.');
  const sourceInfo = await existingRealEntry(fsLike, sourceDefault);
  if (!sourceInfo?.isDirectory()) {
    if (options.required === false) return { migrated: false, files: 0, bytes: 0 };
    throw migrationError('CHROME_SESSION_NOT_FOUND', 'Chrome did not produce session data to restore.');
  }
  await fsLike.promises.mkdir(targetDefault, { recursive: true, mode: 0o700 });
  const targetInfo = await existingRealEntry(fsLike, targetDefault);
  if (!targetInfo?.isDirectory()) throw migrationError('CHROME_SESSION_PATH_INVALID', 'Isolated Chrome Default profile is not a real directory.');

  const staging = path.join(targetDefault, `.compusync-session-${randomUUID()}`);
  if (!containedBy(targetDefault, staging)) throw migrationError('CHROME_SESSION_PATH_INVALID', 'Invalid session staging directory.');
  const state = { files: 0, bytes: 0 };
  const copied = [];
  await fsLike.promises.mkdir(staging, { mode: 0o700 });
  try {
    const sessionsSource = path.join(sourceDefault, 'Sessions');
    if (await copySessionEntry(sessionsSource, path.join(staging, 'Sessions'), state, fsLike)) copied.push('Sessions');
    for (const legacyName of SESSION_ENTRY_NAMES.slice(1)) {
      if (await copySessionEntry(path.join(sourceDefault, legacyName), path.join(staging, legacyName), state, fsLike)) copied.push(legacyName);
    }
    if (copied.length === 0 || state.bytes === 0) {
      if (options.required === false) return { migrated: false, files: 0, bytes: 0 };
      throw migrationError('CHROME_SESSION_NOT_FOUND', 'Chrome did not produce session data to restore.');
    }
    // Replace only session state. All other isolated-profile data remains
    // untouched, so credentials and cookies are never imported.
    for (const name of SESSION_ENTRY_NAMES) {
      const destination = path.join(targetDefault, name);
      if (!containedBy(targetDefault, destination)) throw migrationError('CHROME_SESSION_PATH_INVALID', 'Invalid session destination.');
      await fsLike.promises.rm(destination, { recursive: true, force: true });
      if (copied.includes(name)) await fsLike.promises.rename(path.join(staging, name), destination);
    }
    return { migrated: true, files: state.files, bytes: state.bytes, copied };
  } catch (error) {
    if (error?.code?.startsWith?.('CHROME_SESSION_')) throw error;
    throw migrationError('CHROME_SESSION_MIGRATION_FAILED', 'Chrome session data could not be migrated safely.', error);
  } finally {
    await fsLike.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function createSecureProfile(directory, options = {}) {
  const fsLike = options.fs || fs;
  const platform = options.platform || process.platform;
  const execFile = options.execFile || execFileCallback;
  await fsLike.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fsLike.promises.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Chrome profile path must be a real directory.');
  await fsLike.promises.chmod(directory, 0o700);
  if (platform === 'win32') {
    const username = options.username || os.userInfo().username;
    const domain = options.userDomain || process.env.USERDOMAIN;
    if (!username || /[\r\n]/.test(username) || (domain && /[\r\n]/.test(domain))) throw new Error('Unable to determine the Windows account for the profile ACL.');
    const account = domain ? `${domain}\\${username}` : username;
    try {
      await execFilePromise(execFile, 'icacls.exe', [
        directory, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`,
        '/remove:g', '*S-1-1-0', '*S-1-5-11', '*S-1-5-32-545',
        '/T', '/C', '/Q',
      ], {
        windowsHide: true, timeout: 5_000,
      });
    } catch {
      throw Object.assign(new Error('Could not secure the Chrome profile for the current Windows user.'), { code: 'CHROME_PROFILE_ACL_FAILED' });
    }
  }
  return directory;
}

function storeRead(store, key) {
  if (!store) return undefined;
  if (typeof store.get === 'function') return store.get(key);
  return store[key];
}

async function storeWrite(store, key, value) {
  if (!store) return;
  if (typeof store.set === 'function') await store.set(key, value);
  else store[key] = value;
}

class WindowsChromeRelaunch {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.store = options.store;
    this.fs = options.fs || fs;
    this.env = options.env || process.env;
    this.execFile = options.execFile || execFileCallback;
    this.native = options.native;
    this.spawn = options.spawn || spawnProcess;
    this.port = validatePort(options.port);
    this.localAppData = options.localAppData;
    this.chromeExecutable = options.chromeExecutable;
    this.username = options.username;
    this.userDomain = options.userDomain;
    this.closeChrome = options.closeChrome || (() => requestChromeClose({
      native: this.native, execFile: this.execFile, timeoutMs: this.closeTimeoutMs,
    }));
    this.checkChromeRunning = options.isChromeRunning || (typeof this.native?.enumerateWindows === 'function'
      ? () => nativeChromeIsRunning(this.native)
      : () => chromeIsRunning({ execFile: this.execFile }));
    this.closeTimeoutMs = Math.min(Math.max(Number(options.closeTimeoutMs) || DEFAULT_CLOSE_TIMEOUT_MS, 100), 10_000);
    this.closePollMs = Math.min(Math.max(Number(options.closePollMs) || DEFAULT_CLOSE_POLL_MS, 10), this.closeTimeoutMs);
    this.delay = options.delay || delay;
    this.normalUserDataDir = options.normalUserDataDir || normalUserDataDirectory({ env: this.env, localAppData: this.localAppData });
    this.migrateSession = options.migrateSession || ((sourceUserDataDir, targetUserDataDir) => migrateChromeSession({
      fs: this.fs, sourceUserDataDir, targetUserDataDir, required: true,
    }));
  }

  decision() {
    const value = storeRead(this.store, DECISION_KEY);
    return value === 'accepted' || value === true ? 'accepted' : value === 'declined' || value === false ? 'declined' : null;
  }

  shouldOffer(context = {}) {
    return this.platform === 'win32'
      && context.crossingAttempt === true
      && context.chromeRunning === true
      && context.cdpAvailable !== true
      && this.decision() === null;
  }

  offer(context = {}) {
    if (!this.shouldOffer(context)) return null;
    return {
      id: 'chrome-windows-relaunch',
      title: 'Restart Chrome for window handoff',
      message: OFFER_MESSAGE,
      detail: SESSION_MIGRATION_DETAIL,
      confirmLabel: 'Restart Chrome',
      cancelLabel: 'Not now',
    };
  }

  async rememberDecision(accepted) {
    await storeWrite(this.store, DECISION_KEY, accepted ? 'accepted' : 'declined');
    return accepted ? 'accepted' : 'declined';
  }

  isolatedProfileNotice() {
    if (storeRead(this.store, SIGNED_OUT_NOTICE_KEY)) return null;
    return {
      id: 'chrome-isolated-profile-signed-out',
      title: 'Chrome profile for handoff',
      message: 'Your tabs were restored without copying cookies or credentials. The isolated Chrome profile starts signed out; sign in there if you want synced bookmarks and credentials.',
    };
  }

  async markIsolatedProfileNoticeShown() {
    await storeWrite(this.store, SIGNED_OUT_NOTICE_KEY, true);
  }

  executable() {
    if (this.chromeExecutable) {
      if (path.basename(this.chromeExecutable).toLowerCase() !== 'chrome.exe') throw new TypeError('Chrome executable must be chrome.exe.');
      try { if (this.fs.statSync(this.chromeExecutable).isFile()) return path.resolve(this.chromeExecutable); } catch {}
      return null;
    }
    return findChromeExecutable({ fs: this.fs, env: this.env });
  }

  plan() {
    if (this.platform !== 'win32') throw new Error('Windows Chrome relaunch is only available on Windows.');
    const executable = this.executable();
    if (!executable) throw Object.assign(new Error('Google Chrome was not found in a standard install location.'), { code: 'CHROME_NOT_FOUND' });
    const userDataDir = profileDirectory({ localAppData: this.localAppData, env: this.env });
    return { executable, userDataDir, port: this.port, args: relaunchArguments(userDataDir, this.port) };
  }

  async prepareAcceptedRelaunch(options = {}) {
    if (options.crossingAttempt !== true || options.accepted !== true) {
      throw Object.assign(new Error('Chrome relaunch requires explicit acceptance on a crossing attempt.'), { code: 'CHROME_RELAUNCH_NOT_ACCEPTED' });
    }
    const plan = this.plan();
    await createSecureProfile(plan.userDataDir, {
      fs: this.fs, platform: this.platform, execFile: this.execFile,
      username: this.username, userDomain: this.userDomain,
    });
    await this.rememberDecision(true);
    return plan;
  }

  async launchAccepted(options = {}) {
    const plan = await this.prepareAcceptedRelaunch(options);
    try {
      await this.closeChrome();
    } catch (error) {
      // A process may exit between the request and taskkill. Only ignore the
      // taskkill error when the bounded process check confirms Chrome is gone.
      if (await this.checkChromeRunning()) throw error;
    }
    await waitForChromeExit(this.checkChromeRunning, {
      timeoutMs: this.closeTimeoutMs, pollMs: this.closePollMs, delay: this.delay,
    });
    let migration;
    try { migration = await this.migrateSession(this.normalUserDataDir, plan.userDataDir); }
    catch (error) {
      if (error?.code?.startsWith?.('CHROME_SESSION_')) throw error;
      throw migrationError('CHROME_SESSION_MIGRATION_FAILED', 'Chrome session data could not be migrated safely.', error);
    }
    if (migration?.migrated !== true) {
      throw migrationError('CHROME_SESSION_NOT_FOUND', 'Chrome did not produce session data to restore.');
    }
    const child = this.spawn(plan.executable, plan.args, {
      detached: true, stdio: 'ignore', windowsHide: true, shell: false,
    });
    child?.unref?.();
    return { port: plan.port, userDataDir: plan.userDataDir, restarted: true, session: migration };
  }
}

module.exports = {
  DECISION_KEY,
  DEFAULT_CLOSE_TIMEOUT_MS,
  OFFER_MESSAGE,
  SESSION_MIGRATION_DETAIL,
  SIGNED_OUT_NOTICE_KEY,
  WindowsChromeRelaunch,
  createWindowsChromeRelaunch: (options) => new WindowsChromeRelaunch(options),
  createSecureProfile,
  defaultExtensionDirectory,
  chromeIsRunning,
  findChromeExecutable,
  migrateChromeSession,
  nativeChromeIsRunning,
  nativeChromeWindows,
  normalUserDataDirectory,
  profileDirectory,
  requestChromeClose,
  relaunchArguments,
  standardChromePaths,
  unpackedExtensionDirectory,
  waitForChromeExit,
};
