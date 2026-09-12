'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {
  APPLY_EXPRESSION,
  CAPTURE_EXPRESSION,
  EXTENSION_ID,
  ChromeExtensionTabControl,
} = require('../src/main/adapters/chrome/extension-tab-control.cjs');
const { createChromeHandoffAdapter } = require('../src/main/adapters/chrome/index.cjs');

function fakeCdp(values) {
  const calls = [];
  const extensionDirectory = path.resolve(__dirname, '..', 'src', 'main', 'adapters', 'chrome', 'extension');
  return {
    calls,
    async browserCommand(method, params) {
      calls.push({ method, params });
      if (method === 'Extensions.getExtensions') return values.missing
        ? { extensions: [] }
        : { extensions: [{ id: EXTENSION_ID, path: extensionDirectory, enabled: true }] };
      if (method === 'Extensions.loadUnpacked') return { id: EXTENSION_ID };
      throw new Error(`unexpected ${method}`);
    },
    async withExtensionServiceWorker(id, callback) {
      assert.equal(id, EXTENSION_ID);
      return callback(async (method, params) => {
        calls.push({ method, params });
        if (method !== 'Runtime.evaluate') throw new Error(`unexpected ${method}`);
        if (params.expression.startsWith(`${CAPTURE_EXPRESSION}(`)) return { result: { value: values.capture } };
        if (params.expression.startsWith(`${APPLY_EXPRESSION}(`)) return { result: { value: values.apply ?? true } };
        return { result: { value: true } };
      });
    },
  };
}

test('production tab bridge captures exact target order/pin/active state without URL matching', async () => {
  const cdp = fakeCdp({ capture: [
    { targetId: 'duplicate-b', index: 0, pinned: true, active: true },
    { targetId: 'duplicate-a', index: 1, pinned: false, active: false },
  ] });
  const bridge = new ChromeExtensionTabControl({ cdp, extensionDirectory: path.resolve(__dirname, '..', 'src', 'main', 'adapters', 'chrome', 'extension') });
  const state = await bridge.captureWindow({
    windowId: 12,
    tabs: [
      { id: 'duplicate-a', url: 'https://same.example/private?one' },
      { id: 'duplicate-b', url: 'https://same.example/private?two' },
    ],
  });
  assert.deepEqual(state.map((tab) => tab.targetId), ['duplicate-b', 'duplicate-a']);
  assert.deepEqual(state.map((tab) => [tab.index, tab.pinned, tab.active]), [
    [0, true, true], [1, false, false],
  ]);
  assert.doesNotMatch(JSON.stringify(cdp.calls), /same\.example|private|one|two/);
  assert.match(CAPTURE_EXPRESSION, /compusyncCapture/);
});

test('production tab bridge validates results and applies pin/order by opaque target id', async () => {
  const cdp = fakeCdp({ capture: [
    { targetId: 'tab-a', index: 0, pinned: false, active: true },
    { targetId: 'alien', index: 1, pinned: false, active: false },
  ] });
  const bridge = new ChromeExtensionTabControl({ cdp, extensionDirectory: path.resolve(__dirname, '..', 'src', 'main', 'adapters', 'chrome', 'extension') });
  await assert.rejects(() => bridge.captureWindow({
    windowId: 4, tabs: [{ id: 'tab-a' }, { id: 'tab-b' }],
  }), { code: 'CHROME_TAB_STATE_INVALID' });
  await bridge.setPinned({ targetId: 'tab-b', windowId: 4, index: 1, pinned: true });
  const installed = cdp.calls.find((call) => call.params?.expression?.startsWith(`${APPLY_EXPRESSION}(`)
    && call.params.expression.includes('tab-b'));
  assert.ok(installed);
  assert.match(APPLY_EXPRESSION, /compusyncApply/);
  await assert.rejects(() => bridge.setPinned({ targetId: 'tab-b', windowId: 4, index: -1, pinned: true }), TypeError);
});

test('Windows adapter automatically shares the CDP extension bridge with capture and prepare', () => {
  const cdp = { withExtensionServiceWorker() {} };
  const adapter = createChromeHandoffAdapter({ platform: 'win32', cdp });
  assert.equal(adapter.tabControl.constructor.name, 'ChromeExtensionTabControl');
  assert.equal(adapter.capturer.tabControl, adapter.tabControl);
  assert.equal(adapter.preparer.tabControl, adapter.tabControl);
});

test('production tab bridge installs the bundled extension over existing loopback CDP only when absent', async () => {
  const cdp = fakeCdp({ missing: true, capture: [{ targetId: 'tab-a', index: 0, pinned: false, active: true }] });
  const extensionDirectory = path.resolve(__dirname, '..', 'src', 'main', 'adapters', 'chrome', 'extension');
  const bridge = new ChromeExtensionTabControl({ cdp, extensionDirectory });
  await bridge.captureWindow({ windowId: 2, tabs: [{ id: 'tab-a' }] });
  assert.deepEqual(cdp.calls.find((call) => call.method === 'Extensions.loadUnpacked').params, {
    path: extensionDirectory, enableInIncognito: false,
  });
});

test('bundled extension exposes only the local tab/debugger bridge permissions', () => {
  const manifest = require('../src/main/adapters/chrome/extension/manifest.json');
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['debugger']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.action.popup, undefined);
  assert.equal(path.extname(manifest.background.service_worker), '.js');
  const packageJson = require('../package.json');
  assert.ok(packageJson.build.asarUnpack.includes('src/main/adapters/chrome/extension/**/*'));
});

test('bundled worker joins duplicate tabs by tabId and applies pin then exact index', async () => {
  const operations = [];
  const listeners = [];
  const context = {
    chrome: {
      runtime: { onStartup: { addListener: (listener) => listeners.push(listener) } },
      action: { onClicked: { addListener: (listener) => listeners.push(listener) } },
      tabs: {
        query: async (query) => {
          assert.equal(query.windowId, 22);
          return [
            { id: 90, index: 1, pinned: false, active: false },
            { id: 91, index: 0, pinned: true, active: true },
          ];
        },
        get: async (tabId) => ({ id: tabId, windowId: 22 }),
        update: async (tabId, value) => operations.push(['update', tabId, value]),
        move: async (tabId, value) => operations.push(['move', tabId, value]),
      },
      debugger: { getTargets: async () => [
        { id: 'duplicate-a', tabId: 90 }, { id: 'duplicate-b', tabId: 91 },
      ] },
    },
    setTimeout,
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'main', 'adapters', 'chrome', 'extension', 'service-worker.js'), 'utf8'), context);
  const captured = await context.compusyncCapture({ windowId: 22 });
  assert.deepEqual(JSON.parse(JSON.stringify(captured)), [
    { targetId: 'duplicate-a', index: 1, pinned: false, active: false },
    { targetId: 'duplicate-b', index: 0, pinned: true, active: true },
  ]);
  await context.compusyncApply({ targetId: 'duplicate-b', windowId: 22, index: 0, pinned: true });
  assert.deepEqual(JSON.parse(JSON.stringify(operations)), [
    ['update', 91, { pinned: true }], ['move', 91, { windowId: 22, index: 0 }],
  ]);
  assert.equal(listeners.length, 2);
});
