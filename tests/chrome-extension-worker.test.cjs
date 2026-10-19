'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const WORKER = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'main', 'adapters',
  'chrome', 'extension', 'service-worker.js'), 'utf8');

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(value) { for (const listener of listeners) listener(value); },
  };
}

function workerContext(overrides = {}) {
  const onMessage = event();
  const onDisconnect = event();
  const sent = [];
  const port = { onMessage, onDisconnect, postMessage: (message) => sent.push(message) };
  const context = {
    URL,
    Date,
    Promise,
    Uint8Array,
    TextDecoder,
    atob,
    Map,
    Object,
    Number,
    String,
    Array,
    Error,
    setTimeout: () => 1,
    clearTimeout: () => {},
    chrome: {
      runtime: {
        id: 'fpafmookkejpkjlegeppoecbhbgbogcp',
        getManifest: () => ({ version: '3.0.0' }),
        connectNative: (name) => {
          assert.equal(name, 'app.compusync.chrome');
          return port;
        },
        onStartup: event(),
        onInstalled: event(),
      },
      action: { onClicked: event() },
      tabs: {},
      windows: {},
      debugger: {},
      ...overrides,
    },
  };
  context.globalThis = context;
  context.importScripts = (filename) => {
    assert.equal(filename, 'page-state.js');
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'main', 'adapters',
      'chrome', 'extension', filename), 'utf8'), context);
  };
  vm.runInNewContext(WORKER, context);
  return { context, port, sent };
}

async function request(worker, message) {
  worker.port.onMessage.emit(message);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return worker.sent.findLast((candidate) => candidate.id === message.id);
}

test('worker captures page state and refreshes an existing native window without changing its bounds', async () => {
  const state = { version: 1, url: 'https://example.com/', viewport: { w: 800, h: 500 },
    scroll: { x: 0, y: 900 }, fields: [], scrollers: [], details: [] };
  const tab = { id: 10, index: 0, url: state.url, title: 'Example', active: true, pinned: false };
  const operations = [];
  const worker = workerContext({
    windows: { get: async () => ({ id: 7, type: 'normal', tabs: [tab] }),
      update: async () => { throw new Error('State sync must not reposition the window.'); } },
    tabs: {
      update: async (id, update) => { assert.equal(id, 10); Object.assign(tab, update); },
      move: async (id, update) => { assert.equal(id, 10); assert.equal(update.index, 0); },
    },
    debugger: {
      attach: async () => {}, detach: async () => {},
      sendCommand: async (_, method, params) => {
        operations.push([method, params]);
        if (method === 'Page.getNavigationHistory') return {};
        if (params.expression.endsWith(")('capture')")) return { result: { value: state } };
        return { result: { value: { applied: true, scroll: state.scroll } } };
      },
    },
  });
  const capture = await request(worker, { v: 1, id: 'state-capture', method: 'window.capture', params: { windowId: 7 } });
  assert.deepEqual(JSON.parse(JSON.stringify(capture.result.tabs[0].pageState)), state);
  const refresh = await request(worker, { v: 1, id: 'state-refresh', method: 'window.sync', params: {
    windowId: 7, activeIdx: 0, tabs: [{ url: state.url, index: 0, pinned: false, pageState: state }],
  } });
  assert.equal(refresh.ok, true);
  assert.equal(operations.filter(([method]) => method === 'Runtime.evaluate').length, 2);
});

test('native worker connects with fixed identity and only dispatches allowlisted RPC methods', async () => {
  const worker = workerContext({
    windows: { getAll: async () => [] },
    tabs: {},
    debugger: {},
  });
  assert.deepEqual(JSON.parse(JSON.stringify(worker.sent[0])), {
    v: 1,
    type: 'hello',
    extensionId: 'fpafmookkejpkjlegeppoecbhbgbogcp',
    extensionVersion: '3.0.0',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await request(worker, {
    v: 1, id: 1, method: 'windows.list', params: {},
  }))), { v: 1, id: 1, ok: true, result: { windows: [] } });
  assert.deepEqual(JSON.parse(JSON.stringify(await request(worker, {
    v: 1, id: 2, method: 'tabs.executeScript', params: {},
  }))), {
    v: 1,
    id: 2,
    ok: false,
    error: { code: 'INVALID_REQUEST', message: 'The native bridge request is invalid.' },
  });
});

test('native worker reassembles bounded host request chunks before dispatch', async () => {
  const worker = workerContext({ windows: { getAll: async () => [] }, tabs: {}, debugger: {} });
  const payload = Buffer.from(JSON.stringify({ v: 1, id: 'chunked', method: 'windows.list', params: {} }));
  const middle = Math.ceil(payload.length / 2);
  for (const [index, part] of [payload.subarray(0, middle), payload.subarray(middle)].entries()) {
    worker.port.onMessage.emit({ v: 1, type: 'chunk', transferId: 'chunked', index, total: 2, data: part.toString('base64') });
  }
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(worker.sent.find((message) => message.id === 'chunked'))), {
    v: 1, id: 'chunked', ok: true, result: { windows: [] },
  });
});

test('window.capture returns ordered tab metadata and detaches the active debugger target', async () => {
  const operations = [];
  const tabs = [
    { id: 8, index: 1, url: 'https://two.example/', title: 'Two', pinned: false, active: false },
    { id: 7, index: 0, url: 'https://one.example/', title: 'One', pinned: true, active: true },
  ];
  const worker = workerContext({
    windows: {
      get: async (windowId, options) => ({
        id: windowId, type: 'normal', state: 'normal', focused: true,
        left: 10, top: 20, width: 800, height: 600,
        tabs: options.populate ? tabs : [],
      }),
    },
    tabs: {},
    debugger: {
      attach: async ({ tabId }) => operations.push(['attach', tabId]),
      sendCommand: async ({ tabId }, method) => {
        assert.equal(method, 'Page.getNavigationHistory');
        return { currentIndex: 0, entries: [{ id: tabId, url: `https://${tabId}.example/` }] };
      },
      detach: async ({ tabId }) => operations.push(['detach', tabId]),
    },
  });
  const response = await request(worker, { v: 1, id: 'capture', method: 'window.capture', params: { windowId: 5 } });
  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(response.result.tabs.map((tab) => [tab.tabId, tab.index, tab.history]))), [
    [7, 0, { currentIndex: 0, entries: ['https://7.example/'] }],
    [8, 1, null],
  ]);
  assert.deepEqual(operations.filter(([operation]) => operation === 'detach'), [['detach', 7], ['detach', 7]]);
});

test('window.prepare removes the entire prepared window when tab restoration fails', async () => {
  const operations = [];
  const worker = workerContext({
    windows: {
      create: async () => ({ id: 44, tabs: [{ id: 100 }] }),
      remove: async (windowId) => operations.push(['remove', windowId]),
    },
    tabs: {
      create: async () => { throw new Error('creation failed'); },
      update: async () => {},
      move: async () => {},
    },
    debugger: {},
  });
  const response = await request(worker, {
    v: 1,
    id: 'prepare',
    method: 'window.prepare',
    params: {
      bounds: { left: 10, top: 20, width: 800, height: 600 },
      state: 'normal',
      activeIdx: 0,
      tabs: [
        { url: 'https://one.example/', pinned: true, index: 0 },
        { url: 'https://two.example/', pinned: false, index: 1 },
      ],
    },
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'CHROME_EXTENSION_FAILED');
  assert.deepEqual(operations, [['remove', 44]]);
});

test('split prepare allows live position requests while tab restoration is pending', async () => {
  const operations = [];
  let releaseTabCreation;
  const tabCreation = new Promise((resolve) => { releaseTabCreation = resolve; });
  const preparedWindow = {
    id: 44, type: 'normal', state: 'normal', focused: false,
    left: -900, top: 20, width: 800, height: 600,
    tabs: [{ id: 100, index: 0, url: 'https://one.example/', pinned: false, active: true }],
  };
  const worker = workerContext({
    windows: {
      create: async (options) => ({ ...preparedWindow, ...options, id: 44, tabs: preparedWindow.tabs }),
      update: async (windowId, value) => {
        operations.push(['window.update', windowId, value]);
        Object.assign(preparedWindow, value);
        return preparedWindow;
      },
      get: async () => ({ ...preparedWindow, tabs: [
        preparedWindow.tabs[0],
        { id: 101, index: 1, url: 'https://two.example/', pinned: false, active: false },
      ] }),
      remove: async (windowId) => operations.push(['window.remove', windowId]),
    },
    tabs: {
      create: async () => {
        operations.push(['tab.create.started']);
        await tabCreation;
        return { id: 101 };
      },
      update: async (tabId, value) => operations.push(['tab.update', tabId, value]),
      move: async (tabId, value) => operations.push(['tab.move', tabId, value]),
    },
    debugger: {},
  });
  const params = {
    bounds: { left: -900, top: 20, width: 800, height: 600 },
    state: 'normal', activeIdx: 0,
    tabs: [
      { url: 'https://one.example/', pinned: false, index: 0 },
      { url: 'https://two.example/', pinned: false, index: 1 },
    ],
  };
  const begun = await request(worker, {
    v: 1, id: 'begin', method: 'window.prepare.begin', params,
  });
  assert.equal(begun.ok, true);
  assert.equal(begun.result.windowId, 44);

  worker.port.onMessage.emit({
    v: 1, id: 'finish', method: 'window.prepare.finish', params: { windowId: 44 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(operations.some(([operation]) => operation === 'tab.create.started'));

  const positioned = await request(worker, {
    v: 1, id: 'position', method: 'window.position',
    params: { windowId: 44, bounds: { left: 50, top: 60, width: 800, height: 600 } },
  });
  assert.equal(positioned.ok, true);
  assert.equal(worker.sent.some((message) => message.id === 'finish'), false);
  assert.ok(operations.some(([operation, , value]) => operation === 'window.update' && value.left === 50));

  releaseTabCreation();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const finished = worker.sent.find((message) => message.id === 'finish');
  assert.equal(finished.ok, true);
  assert.equal(finished.result.left, 50);
});

test('extension manifest has no browsing host or content-script access', () => {
  const manifest = require('../src/main/adapters/chrome/extension/manifest.json');
  assert.deepEqual(manifest.permissions, ['debugger', 'nativeMessaging', 'tabs']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
});
