'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile: execFileCallback, spawn: spawnProcess } = require('node:child_process');
const { DEBUG_PORT_MIN, DEBUG_PORT_MAX } = require('./detect.cjs');

const DECISION_KEY = 'chromeWindowsRelaunchDecision';
const SIGNED_OUT_NOTICE_KEY = 'chromeIsolatedProfileNoticeShown';
const OFFER_MESSAGE = 'Chrome needs a one-time restart to enable window handoff. Your tabs will be restored.';

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

function validatePort(port) {
  const result = Number(port ?? DEBUG_PORT_MIN);
  if (!Number.isInteger(result) || result < DEBUG_PORT_MIN || result > DEBUG_PORT_MAX) {
    throw new RangeError(`Chrome debug port must be ${DEBUG_PORT_MIN}-${DEBUG_PORT_MAX}.`);
  }
  return result;
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
    this.spawn = options.spawn || spawnProcess;
    this.port = validatePort(options.port);
    this.localAppData = options.localAppData;
    this.chromeExecutable = options.chromeExecutable;
    this.username = options.username;
    this.userDomain = options.userDomain;
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
      message: 'The isolated Chrome profile starts signed out. Sign in there if you want synced bookmarks and credentials.',
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
    const child = this.spawn(plan.executable, plan.args, {
      detached: true, stdio: 'ignore', windowsHide: true, shell: false,
    });
    child?.unref?.();
    return { port: plan.port, userDataDir: plan.userDataDir };
  }
}

module.exports = {
  DECISION_KEY,
  OFFER_MESSAGE,
  SIGNED_OUT_NOTICE_KEY,
  WindowsChromeRelaunch,
  createWindowsChromeRelaunch: (options) => new WindowsChromeRelaunch(options),
  createSecureProfile,
  findChromeExecutable,
  profileDirectory,
  relaunchArguments,
  standardChromePaths,
};
