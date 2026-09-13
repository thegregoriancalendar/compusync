'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  EXTENSION_FILES,
  NATIVE_HOST_NAME,
  REGISTRY_KEY,
  WindowsChromeExtensionSetup,
  appAsarUnpackedPath,
  launchChromeForHandoff,
  nativeHostExecutable,
  registerNativeHost,
  stageExtension,
  writeNativeHostManifest,
} = require('../src/main/adapters/chrome/setup.cjs');

const EXTENSION_ID = 'fpafmookkejpkjlegeppoecbhbgbogcp';

async function fixture() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'compusync-extension-setup-'));
  const source = path.join(root, 'source');
  const userData = path.join(root, 'user-data');
  const host = path.join(root, 'compusync-chrome-host.exe');
  const chrome = path.join(root, 'chrome.exe');
  await fs.promises.mkdir(source, { recursive: true });
  await fs.promises.writeFile(path.join(source, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'CompuSync Tab Bridge',
    background: { service_worker: 'service-worker.js' },
    permissions: ['nativeMessaging'],
  }));
  await fs.promises.writeFile(path.join(source, 'service-worker.js'), 'globalThis.compusync = true;\n');
  await fs.promises.writeFile(path.join(source, 'not-allowlisted.txt'), 'do not copy');
  await fs.promises.writeFile(host, 'native host');
  await fs.promises.writeFile(chrome, 'chrome');
  return { root, source, userData, host, chrome };
}

test('packaged extension source is redirected out of app.asar', () => {
  const packed = path.resolve('fixtures', 'resources', 'app.asar', 'src', 'main', 'adapters', 'chrome', 'extension');
  const unpacked = appAsarUnpackedPath(packed);
  assert.match(unpacked, /app\.asar\.unpacked/);
  assert.doesNotMatch(unpacked, /[\\/]app\.asar[\\/]/);
});

test('stages only allowlisted extension files in the stable user-data folder', async (t) => {
  const value = await fixture();
  t.after(() => fs.promises.rm(value.root, { recursive: true, force: true }));
  const destination = await stageExtension({ sourceDirectory: value.source, userDataDirectory: value.userData });
  assert.equal(destination, path.join(value.userData, 'chrome-extension'));
  assert.deepEqual((await fs.promises.readdir(destination)).sort(), [...EXTENSION_FILES].sort());
  assert.equal(await fs.promises.readFile(path.join(destination, 'service-worker.js'), 'utf8'), 'globalThis.compusync = true;\n');

  await fs.promises.writeFile(path.join(value.source, 'service-worker.js'), 'globalThis.compusync = "updated";\n');
  assert.equal(await stageExtension({ sourceDirectory: value.source, userDataDirectory: value.userData }), destination);
  assert.equal(await fs.promises.readFile(path.join(destination, 'service-worker.js'), 'utf8'), 'globalThis.compusync = "updated";\n');
  assert.equal((await fs.promises.readdir(destination)).some((name) => name.endsWith('.tmp')), false);
});

test('rejects an existing non-file at a managed extension filename', async (t) => {
  const value = await fixture();
  t.after(() => fs.promises.rm(value.root, { recursive: true, force: true }));
  const destination = path.join(value.userData, 'chrome-extension');
  await fs.promises.mkdir(path.join(destination, 'manifest.json'), { recursive: true });
  await assert.rejects(
    stageExtension({ sourceDirectory: value.source, userDataDirectory: value.userData }),
    (error) => error.code === 'CHROME_EXTENSION_UNSAFE_PATH',
  );
});

test('writes a native host manifest for the fixed extension id and registers it under HKCU', async (t) => {
  const value = await fixture();
  t.after(() => fs.promises.rm(value.root, { recursive: true, force: true }));
  const result = await writeNativeHostManifest({
    platform: 'win32', userDataDirectory: value.userData, hostExecutable: value.host,
  });
  assert.deepEqual(JSON.parse(await fs.promises.readFile(result.filename, 'utf8')), {
    name: NATIVE_HOST_NAME,
    description: 'CompuSync Chrome window handoff bridge',
    path: value.host,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  });

  const calls = [];
  await registerNativeHost(result.filename, {
    platform: 'win32',
    execFile(executable, args, options, callback) {
      calls.push({ executable, args, options });
      callback(null, '', '');
      return {};
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, 'reg.exe');
  assert.deepEqual(calls[0].args, ['ADD', REGISTRY_KEY, '/ve', '/t', 'REG_SZ', '/d', result.filename, '/f']);
  assert.equal(calls[0].options.windowsHide, true);
});

test('resolves packaged and development native host executables', () => {
  const resourcesPath = path.resolve('fixtures', 'resources');
  const devRoot = path.resolve('fixtures', 'repo');
  assert.equal(nativeHostExecutable({ isPackaged: true, resourcesPath }), path.join(resourcesPath, 'native', 'compusync-chrome-host.exe'));
  assert.equal(nativeHostExecutable({ isPackaged: false, devRoot }), path.join(devRoot, 'native', 'compusync-chrome-host.exe'));
});

test('setup offer is honest and open prepares the bridge then guides Load unpacked', async (t) => {
  const value = await fixture();
  t.after(() => fs.promises.rm(value.root, { recursive: true, force: true }));
  const registry = [];
  const spawned = [];
  const revealed = [];
  const setup = new WindowsChromeExtensionSetup({
    platform: 'win32',
    sourceDirectory: value.source,
    userDataDirectory: value.userData,
    hostExecutable: value.host,
    chromeExecutable: value.chrome,
    execFile(executable, args, options, callback) {
      registry.push({ executable, args, options });
      callback(null, '', '');
      return {};
    },
    spawn(executable, args, options) {
      spawned.push({ executable, args, options });
      return { once() {}, unref() {} };
    },
    shell: { showItemInFolder(filename) { revealed.push(filename); } },
  });
  const offer = setup.offer();
  assert.match(offer.detail, /not in the Chrome Web Store/);
  assert.match(offer.detail, /Load unpacked/);
  const result = await setup.open();
  assert.equal(result.manualInstallationRequired, true);
  assert.equal(result.extensionDirectory, path.join(value.userData, 'chrome-extension'));
  assert.equal(result.steps.length, 3);
  assert.equal(registry.length, 1);
  assert.deepEqual(spawned[0].args, ['chrome://extensions/']);
  assert.equal(spawned[0].options.shell, false);
  assert.equal(revealed[0], path.join(result.extensionDirectory, 'manifest.json'));
});

test('handoff launch starts normal-profile Chrome without a visible startup window', async (t) => {
  const value = await fixture();
  t.after(() => fs.promises.rm(value.root, { recursive: true, force: true }));
  const spawned = [];
  const executable = launchChromeForHandoff({
    chromeExecutable: value.chrome,
    spawn(file, args, options) {
      spawned.push({ file, args, options });
      return { once() {}, unref() {} };
    },
  });
  assert.equal(executable, value.chrome);
  assert.deepEqual(spawned[0].args, [
    '--no-startup-window', '--no-first-run', '--no-default-browser-check',
  ]);
  assert.equal(spawned[0].options.shell, false);
  assert.equal(spawned[0].options.windowsHide, true);
  assert.doesNotMatch(spawned[0].args.join(' '), /user-data-dir|profile-directory|remote-debugging/i);
});

test('extension setup is unavailable off Windows', async () => {
  const setup = new WindowsChromeExtensionSetup({ platform: 'darwin' });
  assert.equal(setup.offer(), null);
  await assert.rejects(setup.prepare(), /only available on Windows/);
});
