'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ChromeDetector,
  detectChrome,
  enumerateNativeChrome,
  probeDebugPorts,
} = require('../src/main/adapters/chrome/detect.cjs');
const { ChromeCdp } = require('../src/main/adapters/chrome/cdp.cjs');
const {
  SESSION_MIGRATION_DETAIL,
  WindowsChromeRelaunch,
  chromeIsRunning,
  createSecureProfile,
  migrateChromeSession,
  relaunchArguments,
  requestChromeClose,
  waitForChromeExit,
} = require('../src/main/adapters/chrome/windows.cjs');

function response(json, ok = true) {
  return { ok, headers: { get: () => 'application/json' }, json: async () => json };
}

test('Chrome detection filters native identity and only probes the fixed loopback range', async () => {
  const windows = enumerateNativeChrome({ enumerateWindows: () => [
    { id: '1', processName: 'chrome.exe', visible: true },
    { id: '2', process_name: 'msedge.exe', visible: true },
    { id: '3', bundleId: 'com.google.Chrome', visible: true },
    { id: '4', processName: 'chrome.exe', visible: false },
  ] });
  assert.deepEqual(windows.map(({ id }) => id), ['1', '3']);

  const calls = [];
  const endpoints = await probeDebugPorts({ fetch: async (url) => {
    calls.push(url);
    const port = Number(new URL(url).port);
    return port === 9230 ? response({ Browser: 'Chrome/140', 'Protocol-Version': '1.3', webSocketDebuggerUrl: 'ws://127.0.0.1:9230/devtools/browser/local-id' }) : response({}, false);
  } });
  assert.equal(calls.length, 29);
  assert.equal(calls[0], 'http://127.0.0.1:9222/json/version');
  assert.equal(calls.at(-1), 'http://127.0.0.1:9250/json/version');
  assert.deepEqual(endpoints.map(({ port }) => port), [9230]);
  await assert.rejects(() => probeDebugPorts({ ports: [9221], fetch: async () => response({}) }), RangeError);

  const result = await detectChrome({
    native: { enumerateWindows: () => [{ id: '1', process_name: 'chrome.exe', visible: true }] },
    ports: [9230],
    fetch: async () => response({ webSocketDebuggerUrl: 'ws://127.0.0.1:9230/devtools/browser/id' }),
  });
  assert.equal(result.detected, true);
  assert.equal(result.controllable, true);
});

test('linked detector scans immediately and never auto-runs while unlinked', async () => {
  let calls = 0;
  const detector = new ChromeDetector({
    native: { enumerateWindows: () => [] },
    fetch: async () => { calls += 1; return response({}, false); },
    timeoutMs: 50,
  });
  assert.equal(calls, 0);
  detector.start();
  await new Promise((resolve) => detector.once('detected', resolve));
  assert.equal(calls, 29);
  detector.stop();
});

class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  static instances = [];
  static commands = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => { this.readyState = 1; this.emit('open'); });
  }

  send(text, callback) {
    const command = JSON.parse(text);
    MockWebSocket.commands.push(command);
    let result = {};
    if (command.method === 'Browser.getWindowForTarget') result = { windowId: command.params.targetId === 'tab-a' ? 9 : 10 };
    else if (command.method === 'Browser.getWindowBounds') result = command.params.windowId === 9
      ? { bounds: { left: 10, top: 20, width: 800, height: 600, windowState: 'normal' } }
      : { bounds: { left: 900, top: 20, width: 800, height: 600, windowState: 'normal' } };
    else if (command.method === 'Target.createTarget') result = { targetId: 'created-target' };
    else if (command.method === 'Target.closeTarget') result = { success: true };
    queueMicrotask(() => this.emit('message', JSON.stringify({ id: command.id, result })));
    callback?.();
  }

  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
}

test('CDP keeps a browser socket, caches target grouping, joins native geometry, and closes page sockets', async () => {
  MockWebSocket.instances = [];
  MockWebSocket.commands = [];
  const targets = [
    { id: 'tab-a', type: 'page', title: 'A', url: 'https://one.example/path?secret=yes', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/tab-a' },
    { id: 'tab-b', type: 'page', title: 'B', url: 'https://two.example/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/tab-b' },
    { id: 'tools', type: 'page', title: 'Tools', url: 'devtools://devtools/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/tools' },
  ];
  const client = new ChromeCdp({
    port: 9222,
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/browser-id',
    WebSocket: MockWebSocket,
    fetch: async (url) => {
      assert.equal(url, 'http://127.0.0.1:9222/json/list');
      return response(targets);
    },
  });
  await client.connect();
  assert.equal(MockWebSocket.instances.length, 1);
  await client.browserCommand('Target.getTargets', {});
  const groups = await client.groupTabsByWindow();
  assert.deepEqual(groups.map(({ windowId }) => windowId), [9, 10]);
  await client.groupTabsByWindow(targets.slice(0, 2));
  assert.equal(MockWebSocket.commands.filter(({ method }) => method === 'Browser.getWindowForTarget').length, 2);

  const joined = await client.joinNativeWindows([
    { id: 'hwnd-9', bounds: { x: 12, y: 18, width: 800, height: 600 } },
    { id: 'hwnd-10', bounds: { x: 900, y: 20, width: 800, height: 600 } },
  ], groups);
  assert.deepEqual(joined.map(({ nativeWindow }) => nativeWindow.id), ['hwnd-9', 'hwnd-10']);

  const pageResult = await client.withPage('tab-a', async (command) => {
    await command('Page.enable', {});
    return 'done';
  });
  assert.equal(pageResult, 'done');
  assert.equal(MockWebSocket.instances.length, 2);
  assert.equal(MockWebSocket.instances[1].readyState, 3);

  MockWebSocket.instances[0].emit('message', JSON.stringify({ method: 'Target.targetDestroyed', params: { targetId: 'tab-a' } }));
  await client.getWindowForTarget('tab-a');
  assert.equal(MockWebSocket.commands.filter((command) => command.method === 'Browser.getWindowForTarget' && command.params.targetId === 'tab-a').length, 2);

  const created = await client.createWindow('https://new.example/', { x: -900, y: 20, w: 700, h: 500 });
  assert.deepEqual(created, { targetId: 'created-target', windowId: 10 });
  assert.equal(await client.closeTarget(created.targetId), true);
  await client.focusTarget('tab-b', { id: 'hwnd-10' }, { focusWindow: (id) => assert.equal(id, 'hwnd-10') });
  client.close();
  assert.equal(MockWebSocket.instances[0].readyState, 3);
});

test('Windows helper offers only on a crossing, remembers declines, and gates launching on explicit acceptance', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'compusync-chrome-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const chrome = path.join(root, 'chrome.exe');
  await fs.promises.writeFile(chrome, 'test');
  const store = new Map();
  const launches = [];
  const restartEvents = [];
  let runningChecks = 0;
  const helper = new WindowsChromeRelaunch({
    platform: 'win32', store, chromeExecutable: chrome, localAppData: root,
    username: 'Tester', userDomain: 'MACHINE',
    execFile: (_file, args, _options, callback) => {
      assert.equal(args[1], '/inheritance:r');
      callback(null, '', '');
    },
    spawn: (executable, args, options) => {
      restartEvents.push('launch');
      launches.push({ executable, args, options });
      return { unref() {} };
    },
    closeChrome: async () => { restartEvents.push('close'); },
    isChromeRunning: async () => {
      restartEvents.push('check');
      runningChecks += 1;
      return runningChecks === 1;
    },
    delay: async () => { restartEvents.push('wait'); },
    migrateSession: async (source, target) => {
      restartEvents.push('migrate');
      assert.equal(source, path.join(root, 'Google', 'Chrome', 'User Data'));
      assert.equal(target, path.join(root, 'Compusync', 'browser-profile'));
      return { migrated: true, files: 2, bytes: 20, copied: ['Sessions'] };
    },
  });
  assert.equal(launches.length, 0);
  assert.deepEqual(restartEvents, []);
  assert.equal(helper.offer({ crossingAttempt: false, chromeRunning: true, cdpAvailable: false }), null);
  const offer = helper.offer({ crossingAttempt: true, chromeRunning: true, cdpAvailable: false });
  assert.match(offer.message, /one-time restart/);
  assert.equal(offer.detail, SESSION_MIGRATION_DETAIL);
  assert.deepEqual(restartEvents, []);
  await helper.rememberDecision(false);
  assert.equal(helper.offer({ crossingAttempt: true, chromeRunning: true, cdpAvailable: false }), null);
  assert.deepEqual(restartEvents, []);
  await assert.rejects(() => helper.launchAccepted({ crossingAttempt: true, accepted: false }), { code: 'CHROME_RELAUNCH_NOT_ACCEPTED' });
  assert.equal(launches.length, 0);
  assert.deepEqual(restartEvents, []);
  await helper.launchAccepted({ crossingAttempt: true, accepted: true });
  assert.equal(launches.length, 1);
  assert.deepEqual(restartEvents, ['close', 'check', 'wait', 'check', 'migrate', 'launch']);
  assert.ok(launches[0].args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(launches[0].args.some((arg) => arg.startsWith('--user-data-dir=')));
  assert.equal(launches[0].options.shell, false);

  const failedLaunches = [];
  const missingSession = new WindowsChromeRelaunch({
    platform: 'win32', chromeExecutable: chrome, localAppData: root,
    username: 'Tester', userDomain: 'MACHINE',
    execFile: (_file, _args, _options, callback) => callback(null, '', ''),
    closeChrome: async () => {}, isChromeRunning: async () => false,
    migrateSession: async () => ({ migrated: false, files: 0, bytes: 0 }),
    spawn: (...args) => { failedLaunches.push(args); return { unref() {} }; },
  });
  await assert.rejects(() => missingSession.launchAccepted({ crossingAttempt: true, accepted: true }), {
    code: 'CHROME_SESSION_NOT_FOUND',
  });
  assert.equal(failedLaunches.length, 0);
});

test('session migration copies only current tab state into the isolated Default profile', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'compusync-session-migrate-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const normal = path.join(root, 'normal-user-data');
  const isolated = path.join(root, 'isolated-user-data');
  const normalDefault = path.join(normal, 'Default');
  await fs.promises.mkdir(path.join(normalDefault, 'Sessions'), { recursive: true });
  await fs.promises.writeFile(path.join(normalDefault, 'Sessions', 'Session_123'), 'window and tab state');
  await fs.promises.writeFile(path.join(normalDefault, 'Sessions', 'Tabs_123'), 'tab state');
  await fs.promises.writeFile(path.join(normalDefault, 'Last Session'), 'legacy session');
  await fs.promises.writeFile(path.join(normalDefault, 'Cookies'), 'must not migrate');
  await fs.promises.mkdir(path.join(normalDefault, 'Login Data'), { recursive: true });
  await fs.promises.writeFile(path.join(normalDefault, 'Login Data', 'password'), 'must not migrate');
  await fs.promises.mkdir(path.join(isolated, 'Default'), { recursive: true });
  await fs.promises.writeFile(path.join(isolated, 'Default', 'Cookies'), 'isolated cookies stay');
  await fs.promises.writeFile(path.join(isolated, 'Default', 'Last Tabs'), 'stale session is removed');

  const result = await migrateChromeSession({ sourceUserDataDir: normal, targetUserDataDir: isolated });
  assert.equal(result.migrated, true);
  assert.deepEqual(result.copied, ['Sessions', 'Last Session']);
  assert.equal(await fs.promises.readFile(path.join(isolated, 'Default', 'Sessions', 'Tabs_123'), 'utf8'), 'tab state');
  assert.equal(await fs.promises.readFile(path.join(isolated, 'Default', 'Last Session'), 'utf8'), 'legacy session');
  assert.equal(await fs.promises.readFile(path.join(isolated, 'Default', 'Cookies'), 'utf8'), 'isolated cookies stay');
  await assert.rejects(() => fs.promises.access(path.join(isolated, 'Default', 'Login Data')));
  await assert.rejects(() => fs.promises.access(path.join(isolated, 'Default', 'Last Tabs')));

  const absent = path.join(root, 'absent');
  assert.deepEqual(await migrateChromeSession({
    sourceUserDataDir: absent, targetUserDataDir: path.join(root, 'unused-target'), required: false,
  }), { migrated: false, files: 0, bytes: 0 });
  await assert.rejects(() => migrateChromeSession({
    sourceUserDataDir: absent, targetUserDataDir: path.join(root, 'required-target'),
  }), { code: 'CHROME_SESSION_NOT_FOUND' });
});

test('default restart helpers request non-forced taskkill and verify a bounded Chrome exit', async () => {
  const calls = [];
  const execFile = (file, args, _options, callback) => {
    calls.push({ file, args });
    const stdout = file === 'tasklist.exe' ? '"chrome.exe","123","Console","1","10,000 K"' : '';
    callback(null, stdout, '');
  };
  await requestChromeClose({ execFile });
  assert.deepEqual(calls[0], { file: 'taskkill.exe', args: ['/IM', 'chrome.exe', '/T'] });
  assert.equal(calls[0].args.includes('/F'), false);
  assert.equal(await chromeIsRunning({ execFile }), true);

  let checks = 0;
  const waits = [];
  await waitForChromeExit(async () => ++checks < 3, {
    timeoutMs: 100, pollMs: 50, delay: async (ms) => waits.push(ms),
  });
  assert.equal(checks, 3);
  assert.deepEqual(waits, [50, 50]);
  await assert.rejects(() => waitForChromeExit(async () => true, {
    timeoutMs: 100, pollMs: 50, delay: async () => {},
  }), { code: 'CHROME_EXIT_TIMEOUT' });
});

test('profile helpers constrain debug ports and enforce private directory setup', async (t) => {
  assert.ok(relaunchArguments('C:\\isolated', 9250).includes('--remote-debugging-port=9250'));
  assert.throws(() => relaunchArguments('C:\\isolated', 9251), RangeError);
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'compusync-profile-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'profile');
  await createSecureProfile(directory, { platform: 'linux' });
  const mode = (await fs.promises.stat(directory)).mode & 0o777;
  if (process.platform !== 'win32') assert.equal(mode, 0o700);
  else assert.equal((await fs.promises.stat(directory)).isDirectory(), true);
});
