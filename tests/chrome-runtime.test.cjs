'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ChromeAdapterRuntime } = require('../src/main/adapters/chrome/runtime.cjs');

class Detector extends EventEmitter {
  constructor(result) { super(); this.result = result; this.linked = []; }
  setLinked(value) { this.linked.push(value); }
  async scan() { return this.result; }
}

test('Chrome runtime never relaunches at startup and ignores non-Chrome windows', () => {
  let launches = 0;
  const runtime = new ChromeAdapterRuntime({ platform: 'win32', machineId: 'win', detector: new Detector({ detected: true, endpoint: null }),
    relaunch: { decision: () => null, launchAccepted: async () => { launches += 1; } } });
  runtime.start();
  assert.equal(launches, 0);
  assert.equal(runtime.adapterForWindow({ processName: 'notepad.exe' }), null);
  runtime.stop();
});

test('first Windows capture requests consent then connects only to detected loopback CDP', async () => {
  const detector = new Detector({ detected: true, endpoint: null });
  const events = [];
  const cdp = new EventEmitter();
  cdp.port = 9222;
  cdp.connect = async () => { events.push('connect'); };
  cdp.close = () => {};
  const adapter = { cdp, capture: async () => 'captured' };
  const relaunch = {
    value: null,
    decision() { return this.value; },
    offer: () => ({ id: 'offer' }),
    rememberDecision(value) { this.value = value ? 'accepted' : 'declined'; },
    launchAccepted: async () => { events.push('launch'); detector.result = { detected: true, endpoint: { port: 9222, webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/id' } }; },
    isolatedProfileNotice: () => null,
  };
  const runtime = new ChromeAdapterRuntime({ platform: 'win32', machineId: 'win', detector, relaunch,
    requestRelaunch: async () => { events.push('consent'); return true; }, createAdapter: () => adapter, sleep: async () => {} });
  const value = await runtime.adapterForWindow({ processName: 'chrome.exe' }).capture({ id: 'window' }, { x: 0, y: 0, w: 800, h: 600 });
  assert.equal(value, 'captured');
  assert.deepEqual(events, ['consent', 'launch', 'connect']);
  runtime.stop();
});
