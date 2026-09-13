'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile: execFileCallback, spawn: spawnProcess } = require('node:child_process');
const { EXTENSION_ID } = require('./extension-tab-control.cjs');
const { findChromeExecutable } = require('./windows.cjs');

const NATIVE_HOST_NAME = 'app.compusync.chrome';
const NATIVE_HOST_EXECUTABLE = 'compusync-chrome-host.exe';
const EXTENSION_DIRECTORY_NAME = 'chrome-extension';
const NATIVE_HOST_DIRECTORY_NAME = 'chrome-native-messaging';
const EXTENSION_FILES = Object.freeze(['manifest.json', 'service-worker.js']);
const MAX_EXTENSION_FILE_BYTES = 2 * 1024 * 1024;
const MAX_NATIVE_HOST_BYTES = 64 * 1024 * 1024;
const REGISTRY_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;

const SETUP_OFFER = Object.freeze({
  id: 'chrome-extension-setup',
  title: 'Set up Chrome window handoff',
  message: 'Chrome needs the CompuSync extension to hand off windows from your existing Chrome profile.',
  detail: 'CompuSync will prepare the extension, open Chrome\'s Extensions page, and show its folder. Because this unpublished extension is not in the Chrome Web Store, Chrome requires you to turn on Developer mode, click Load unpacked, and select that folder once.',
  confirmLabel: 'Open setup',
  cancelLabel: 'Not now',
});

const SETUP_STEPS = Object.freeze([
  'Turn on Developer mode in the top-right corner of Chrome\'s Extensions page.',
  'Click Load unpacked.',
  'Select the chrome-extension folder that CompuSync opened.',
]);

function appAsarUnpackedPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError('An absolute extension source path is required.');
  return path.resolve(value.replace(/([\\/])app\.asar([\\/])/i, '$1app.asar.unpacked$2'));
}

function defaultExtensionSourceDirectory() {
  return appAsarUnpackedPath(path.resolve(__dirname, 'extension'));
}

function validAbsolutePath(value, description) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 2_048 || /[\r\n\0]/.test(value)) {
    throw new TypeError(`${description} must be an absolute path.`);
  }
  return path.resolve(value);
}

function isContainedBy(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function userDataDirectory(options = {}) {
  const configured = options.userDataDirectory || options.app?.getPath?.('userData');
  if (configured) return validAbsolutePath(configured, 'CompuSync user-data directory');
  const localAppData = options.localAppData || options.env?.LOCALAPPDATA || process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error('CompuSync user-data directory is unavailable.');
  return path.resolve(localAppData, 'Compusync');
}

function devRootDirectory(options = {}) {
  return validAbsolutePath(options.devRoot || path.resolve(__dirname, '..', '..', '..', '..'), 'CompuSync development root');
}

function nativeHostExecutable(options = {}) {
  if (options.hostExecutable) return validAbsolutePath(options.hostExecutable, 'Chrome native host executable');
  const isPackaged = options.isPackaged ?? options.app?.isPackaged ?? false;
  if (isPackaged) {
    const resourcesPath = validAbsolutePath(options.resourcesPath || process.resourcesPath, 'Electron resources directory');
    return path.join(resourcesPath, 'native', NATIVE_HOST_EXECUTABLE);
  }
  return path.join(devRootDirectory(options), 'native', NATIVE_HOST_EXECUTABLE);
}

async function realDirectory(fsLike, directory, description, create = false) {
  if (create) await fsLike.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  let info;
  try { info = await fsLike.promises.lstat(directory); }
  catch (error) {
    if (error?.code === 'ENOENT') throw Object.assign(new Error(`${description} was not found.`), { code: 'CHROME_EXTENSION_FILE_MISSING' });
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw Object.assign(new Error(`${description} must be a real directory.`), { code: 'CHROME_EXTENSION_UNSAFE_PATH' });
  }
  return directory;
}

async function regularFile(fsLike, filename, description, maxBytes = MAX_EXTENSION_FILE_BYTES) {
  let info;
  try { info = await fsLike.promises.lstat(filename); }
  catch (error) {
    if (error?.code === 'ENOENT') throw Object.assign(new Error(`${description} was not found.`), { code: 'CHROME_EXTENSION_FILE_MISSING' });
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maxBytes) {
    throw Object.assign(new Error(`${description} is not a safe extension file.`), { code: 'CHROME_EXTENSION_UNSAFE_FILE' });
  }
  return info;
}

async function atomicWrite(fsLike, filename, contents) {
  const directory = path.dirname(filename);
  const temp = path.join(directory, `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fsLike.promises.writeFile(temp, contents, { flag: 'wx', mode: 0o600 });
    await fsLike.promises.rename(temp, filename);
    await fsLike.promises.chmod(filename, 0o600).catch(() => {});
  } finally {
    await fsLike.promises.rm(temp, { force: true }).catch(() => {});
  }
}

function validateExtensionManifest(contents) {
  let manifest;
  try { manifest = JSON.parse(contents.toString('utf8')); }
  catch { throw Object.assign(new Error('The bundled Chrome extension manifest is invalid.'), { code: 'CHROME_EXTENSION_MANIFEST_INVALID' }); }
  if (manifest?.manifest_version !== 3 || manifest?.background?.service_worker !== 'service-worker.js'
    || !Array.isArray(manifest.permissions) || !manifest.permissions.includes('nativeMessaging')) {
    throw Object.assign(new Error('The bundled Chrome extension manifest is not the expected CompuSync extension.'), { code: 'CHROME_EXTENSION_MANIFEST_INVALID' });
  }
  return manifest;
}

async function stageExtension(options = {}) {
  const fsLike = options.fs || fs;
  const sourceDirectory = validAbsolutePath(options.sourceDirectory || defaultExtensionSourceDirectory(), 'Extension source directory');
  const root = userDataDirectory(options);
  const destinationDirectory = validAbsolutePath(options.destinationDirectory || path.join(root, EXTENSION_DIRECTORY_NAME), 'Extension destination directory');
  if (!isContainedBy(root, destinationDirectory)) throw new TypeError('Extension destination directory must be inside CompuSync user data.');
  await realDirectory(fsLike, sourceDirectory, 'Bundled Chrome extension');
  await realDirectory(fsLike, root, 'CompuSync user-data directory', true);
  await realDirectory(fsLike, destinationDirectory, 'Managed Chrome extension directory', true);

  const contentsByName = new Map();
  for (const name of EXTENSION_FILES) {
    const source = path.join(sourceDirectory, name);
    await regularFile(fsLike, source, `Bundled extension file ${name}`);
    contentsByName.set(name, await fsLike.promises.readFile(source));
  }
  validateExtensionManifest(contentsByName.get('manifest.json'));

  for (const name of EXTENSION_FILES) {
    const destination = path.join(destinationDirectory, name);
    try {
      const existing = await fsLike.promises.lstat(destination);
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw Object.assign(new Error(`Managed extension file ${name} is unsafe.`), { code: 'CHROME_EXTENSION_UNSAFE_PATH' });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await atomicWrite(fsLike, destination, contentsByName.get(name));
  }
  return destinationDirectory;
}

function nativeHostManifest(hostExecutable) {
  if (path.basename(hostExecutable).toLowerCase() !== NATIVE_HOST_EXECUTABLE) {
    throw new TypeError(`Chrome native host executable must be named ${NATIVE_HOST_EXECUTABLE}.`);
  }
  return {
    name: NATIVE_HOST_NAME,
    description: 'CompuSync Chrome window handoff bridge',
    path: validAbsolutePath(hostExecutable, 'Chrome native host executable'),
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
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
    let child;
    try { child = execFile(executable, args, options, (error, stdout, stderr) => done(error, { stdout, stderr })); }
    catch (error) { done(error); return; }
    if (child?.then) child.then((value) => done(null, value), done);
  });
}

async function writeNativeHostManifest(options = {}) {
  const fsLike = options.fs || fs;
  const platform = options.platform || process.platform;
  if (platform !== 'win32') throw new Error('Chrome native host registration is only available on Windows.');
  const root = userDataDirectory(options);
  const manifestDirectory = validAbsolutePath(options.manifestDirectory || path.join(root, NATIVE_HOST_DIRECTORY_NAME), 'Native host manifest directory');
  if (!isContainedBy(root, manifestDirectory)) throw new TypeError('Native host manifest directory must be inside CompuSync user data.');
  const hostExecutable = nativeHostExecutable(options);
  await realDirectory(fsLike, root, 'CompuSync user-data directory', true);
  await realDirectory(fsLike, manifestDirectory, 'Native host manifest directory', true);
  await regularFile(fsLike, hostExecutable, 'Chrome native host executable', MAX_NATIVE_HOST_BYTES);
  const filename = path.join(manifestDirectory, `${NATIVE_HOST_NAME}.json`);
  try {
    const existing = await fsLike.promises.lstat(filename);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw Object.assign(new Error('Chrome native host manifest path is unsafe.'), { code: 'CHROME_EXTENSION_UNSAFE_PATH' });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const manifest = nativeHostManifest(hostExecutable);
  await atomicWrite(fsLike, filename, `${JSON.stringify(manifest, null, 2)}\n`);
  return { filename, manifest };
}

async function registerNativeHost(manifestFilename, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') throw new Error('Chrome native host registration is only available on Windows.');
  const filename = validAbsolutePath(manifestFilename, 'Native host manifest path');
  const execFile = options.execFile || execFileCallback;
  try {
    await execFilePromise(execFile, 'reg.exe', [
      'ADD', REGISTRY_KEY, '/ve', '/t', 'REG_SZ', '/d', filename, '/f',
    ], { windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 });
  } catch (cause) {
    throw Object.assign(new Error('CompuSync could not register its Chrome native messaging host for this Windows account.'), {
      code: 'CHROME_NATIVE_HOST_REGISTRATION_FAILED', cause,
    });
  }
  return filename;
}

function launchChromeExtensions(options = {}) {
  const fsLike = options.fs || fs;
  const executable = options.chromeExecutable || findChromeExecutable({ fs: fsLike, env: options.env });
  if (!executable) throw Object.assign(new Error('Google Chrome was not found in a standard install location.'), { code: 'CHROME_NOT_FOUND' });
  const resolved = validAbsolutePath(executable, 'Chrome executable');
  let info;
  try { info = fsLike.statSync(resolved); } catch {}
  if (!info?.isFile()) throw Object.assign(new Error('Google Chrome executable was not found.'), { code: 'CHROME_NOT_FOUND' });
  const spawn = options.spawn || spawnProcess;
  const child = spawn(resolved, ['chrome://extensions/'], {
    detached: true, stdio: 'ignore', windowsHide: true, shell: false,
  });
  child?.once?.('error', () => {});
  child?.unref?.();
  return resolved;
}

async function revealExtensionDirectory(directory, options = {}) {
  const resolved = validAbsolutePath(directory, 'Extension directory');
  const shell = options.shell;
  if (typeof shell?.showItemInFolder === 'function') {
    shell.showItemInFolder(path.join(resolved, 'manifest.json'));
    return resolved;
  }
  if (typeof shell?.openPath === 'function') {
    const error = await shell.openPath(resolved);
    if (error) throw Object.assign(new Error(`Could not open the Chrome extension folder: ${error}`), { code: 'CHROME_EXTENSION_REVEAL_FAILED' });
    return resolved;
  }
  throw new TypeError('Electron shell access is required to reveal the extension folder.');
}

class WindowsChromeExtensionSetup {
  constructor(options = {}) {
    this.options = { ...options };
    this.platform = options.platform || process.platform;
  }

  offer() {
    if (this.platform !== 'win32') return null;
    return { ...SETUP_OFFER };
  }

  async prepare() {
    if (this.platform !== 'win32') throw new Error('Chrome extension setup is only available on Windows.');
    const extensionDirectory = await stageExtension({ ...this.options, platform: this.platform });
    const host = await writeNativeHostManifest({ ...this.options, platform: this.platform });
    await registerNativeHost(host.filename, { ...this.options, platform: this.platform });
    return { extensionDirectory, nativeHostManifest: host.filename, hostExecutable: host.manifest.path };
  }

  async open() {
    const prepared = await this.prepare();
    const chromeExecutable = launchChromeExtensions({ ...this.options, platform: this.platform });
    await revealExtensionDirectory(prepared.extensionDirectory, this.options);
    return {
      ...prepared,
      chromeExecutable,
      manualInstallationRequired: true,
      steps: [...SETUP_STEPS],
    };
  }
}

module.exports = {
  EXTENSION_DIRECTORY_NAME,
  EXTENSION_FILES,
  MAX_EXTENSION_FILE_BYTES,
  MAX_NATIVE_HOST_BYTES,
  NATIVE_HOST_DIRECTORY_NAME,
  NATIVE_HOST_EXECUTABLE,
  NATIVE_HOST_NAME,
  REGISTRY_KEY,
  SETUP_OFFER,
  SETUP_STEPS,
  WindowsChromeExtensionSetup,
  appAsarUnpackedPath,
  createWindowsChromeExtensionSetup: (options) => new WindowsChromeExtensionSetup(options),
  defaultExtensionSourceDirectory,
  launchChromeExtensions,
  nativeHostExecutable,
  nativeHostManifest,
  registerNativeHost,
  revealExtensionDirectory,
  stageExtension,
  userDataDirectory,
  writeNativeHostManifest,
};
