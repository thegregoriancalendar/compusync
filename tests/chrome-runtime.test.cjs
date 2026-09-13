'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ChromeAdapterRuntime } = require('../src/main/adapters/chrome/runtime.cjs');

class Bridge extends EventEmitter {
  constructor(connected = false) { super(); this.connected = connected; this.started = 0; }
  async start() { this.started += 1; }
  async stop() {}
}

test('Chrome runtime never launches Chrome at startup and ignores non-Chrome windows', async () => {
  const bridge = new Bridge();
  let launches = 0;
  const runtime = new ChromeAdapterRuntime({
    platform: 'win32', machineId: 'win', bridge,
    setup: { prepare: async () => {}, launch: async () => { launches += 1; } },
  });
  runtime.start();
  await runtime.scan();
  assert.equal(bridge.started, 1);
  assert.equal(launches, 0);
  assert.equal(runtime.adapterForWindow({ processName: 'notepad.exe' }), null);
  runtime.stop();
});

test('macOS runtime never constructs the Windows extension bridge', () => {
  const adapter = { cdp: null };
  const runtime = new ChromeAdapterRuntime({
    platform: 'darwin', machineId: 'mac', createAdapter: () => adapter,
  });
  assert.equal(runtime.bridge, null);
  assert.equal(runtime.adapterForId('chrome'), adapter);
  runtime.stop();
});

test('missing Windows helper stays non-crossing while explicit setup connects without relaunching Chrome', async () => {
  const events = [];
  const bridge = new Bridge();
  const adapter = { capture: async () => 'captured' };
  const setup = {
    prepare: async () => events.push('prepare'), offer: async () => ({ id: 'offer' }),
    launch: async () => events.push('launch'),
    open: async () => { events.push('open'); bridge.connected = true; bridge.emit('ready'); },
  };
  const runtime = new ChromeAdapterRuntime({
    platform: 'win32', machineId: 'win', bridge, setup,
    requestExtensionSetup: async () => { events.push('consent'); return true; },
    createAdapter: () => adapter, sleep: async () => {},
  });
  runtime.start();
  assert.equal(runtime.adapterForWindow({ processName: 'chrome.exe' }), null);
  const value = await runtime.adapterForId('chrome')
    .capture({ id: 'window' }, { x: 0, y: 0, w: 800, h: 600 });
  assert.equal(value, 'captured');
  assert.deepEqual(events, ['prepare', 'consent', 'open']);
  runtime.stop();
});

test('incoming Windows handoff cold-launches Chrome, waits for the bridge, and skips setup', async () => {
  const events = [];
  const bridge = new Bridge();
  const adapter = { prepare: async () => { events.push('window'); return 'prepared'; } };
  const runtime = new ChromeAdapterRuntime({
    platform: 'win32', bridge,
    setup: {
      prepare: async () => events.push('prepare'),
      launch: async () => {
        events.push('launch');
        bridge.connected = true;
        bridge.emit('ready');
      },
      open: async () => events.push('setup'),
    },
    requestExtensionSetup: async () => { events.push('prompt'); return true; },
    createAdapter: () => adapter,
  });
  const result = await runtime.adapterForId('chrome').prepare({}, {});
  assert.equal(result, 'prepared');
  assert.deepEqual(events, ['prepare', 'launch', 'window']);
  runtime.stop();
});

test('missing helper after cold launch falls through to the existing setup flow', async () => {
  const events = [];
  const bridge = new Bridge();
  const adapter = { prepare: async () => 'prepared' };
  const runtime = new ChromeAdapterRuntime({
    platform: 'win32', bridge, coldLaunchTimeoutMs: 1,
    setup: {
      prepare: async () => events.push('prepare'),
      launch: async () => events.push('launch'),
      offer: async () => ({}),
      open: async () => {
        events.push('setup');
        bridge.connected = true;
        bridge.emit('ready');
      },
    },
    requestExtensionSetup: async () => { events.push('prompt'); return true; },
    createAdapter: () => adapter,
  });
  assert.equal(await runtime.adapterForId('chrome').prepare({}, {}), 'prepared');
  assert.deepEqual(events, ['prepare', 'launch', 'prompt', 'setup']);
  runtime.stop();
});

test('Windows destination reports a typed Chrome launch failure without opening extension setup', async () => {
  const bridge = new Bridge();
  let prompts = 0;
  const runtime = new ChromeAdapterRuntime({
    platform: 'win32', bridge,
    setup: {
      prepare: async () => {},
      launch: async () => { throw Object.assign(new Error('spawn failed'), { code: 'CHROME_LAUNCH_FAILED' }); },
    },
    requestExtensionSetup: async () => { prompts += 1; return true; },
  });
  await assert.rejects(
    () => runtime.adapterForId('chrome').prepare({}, {}),
    { code: 'CHROME_LAUNCH_FAILED' },
  );
  assert.equal(prompts, 0);
  runtime.stop();
});

test('declining Chrome helper setup never restarts or closes Chrome', async () => {
  const bridge = new Bridge();
  let opened = 0;
  const runtime = new ChromeAdapterRuntime({
    platform: 'win32', bridge,
    setup: { prepare: async () => {}, offer: async () => ({}), open: async () => { opened += 1; } },
    requestExtensionSetup: async () => false,
  });
  runtime.start();
  await assert.rejects(
    () => runtime.adapterForId('chrome').prepare({}, {}),
    { code: 'CHROME_EXTENSION_SETUP_REQUIRED' },
  );
  assert.equal(opened, 0);
  runtime.stop();
});

test('first Windows app use offers the guided helper setup once even before a drag', async () => {
  const bridge = new Bridge();
  let prompts = 0, opens = 0;
  const runtime = new ChromeAdapterRuntime({
    platform: 'win32', bridge, promptOnStart: true, sleep: async () => {},
    setup: { prepare: async () => {}, offer: () => ({}), open: async () => { opens += 1; } },
    requestExtensionSetup: async () => { prompts += 1; return true; },
  });
  runtime.setLinked(false);
  await runtime.scan();
  runtime.setLinked(true);
  assert.equal(prompts, 1);
  assert.equal(opens, 1);
  runtime.stop();
});
