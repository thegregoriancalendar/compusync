'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { pageState, sanitizePageState } = require('../src/main/adapters/chrome/extension/page-state.js');
const { sanitizePeerMessage } = require('../src/main/messages.cjs');

const url = 'https://example.com/form';
function snapshot() {
  return { version: 1, url, viewport: { w: 1000, h: 700 }, scroll: { x: 0, y: 850 },
    fields: [{ path: 'html:nth-child(1)>body:nth-child(2)>input:nth-child(1)', kind: 'text', value: 'draft' }],
    scrollers: [], details: [] };
}
function descriptor(state = snapshot()) {
  return { schemaVersion: 1, id: 'one-window', adapterId: 'chrome', origin: 'win', capturedAt: 1,
    geometryVU: { x: 0, y: 0, w: 800, h: 600 }, state: 'normal',
    payload: { activeIdx: 0, tabs: [{ index: 0, url, title: '', pinned: false, pageState: state }] } };
}

test('active page state survives offer and final-state wire validation', () => {
  const offer = sanitizePeerMessage({ type: 'window.offer', descriptor: descriptor() });
  assert.deepEqual(offer.descriptor.payload.tabs[0].pageState, snapshot());
  const update = sanitizePeerMessage({ type: 'window.state', id: 'one-window', payload: descriptor().payload });
  assert.deepEqual(update.payload, offer.descriptor.payload);
});

test('page-state validation rejects mismatched sites, executable selectors, secrets and unbounded data', () => {
  const cases = [
    { ...snapshot(), url: 'https://other.example/' },
    { ...snapshot(), scroll: { x: 0, y: Infinity } },
    { ...snapshot(), fields: [{ path: 'input,script', kind: 'text', value: 'x' }] },
    { ...snapshot(), fields: [{ ...snapshot().fields[0], kind: 'password' }] },
    { ...snapshot(), fields: [{ ...snapshot().fields[0], value: 'x'.repeat(4097) }] },
    { ...snapshot(), scrollers: Array(41).fill({ path: 'div:nth-child(1)', x: 0, y: 1 }) },
  ];
  for (const state of cases) {
    assert.equal(sanitizePageState(state, url), null);
    assert.equal(sanitizePeerMessage({ type: 'window.offer', descriptor: descriptor(state) }), null);
  }
});

test('fixed page program restores ordinary drafts but refuses sensitive controls, changed sites and action replay', () => {
  const elements = [
    { localName: 'input', type: 'text', value: 'old' },
    { localName: 'input', type: 'password', value: 'local-secret' },
    { localName: 'input', type: 'text', name: 'csrf-token', value: 'local-token' },
    { localName: 'input', type: 'checkbox', checked: false },
  ];
  const context = {
    location: { href: url }, scrollX: 0, scrollY: 0,
    document: { readyState: 'complete', querySelector: (selector) => elements[Number(selector) - 1] },
    window: { scrollTo: ({ left, top }) => { context.scrollX = left; context.scrollY = top; } },
    input: { ...snapshot(), fields: [
      { path: '1', kind: 'text', value: 'new draft' },
      { path: '2', kind: 'text', value: 'peer-secret' },
      { path: '3', kind: 'text', value: 'peer-token' },
      { path: '4', kind: 'checkbox', checked: true },
    ] },
  };
  const restore = () => vm.runInNewContext(`(${pageState.toString()})('restore',input)`, context);
  assert.equal(restore().applied, true);
  assert.equal(elements[0].value, 'new draft');
  assert.equal(elements[1].value, 'local-secret');
  assert.equal(elements[2].value, 'local-token');
  assert.equal(elements[3].checked, true);
  assert.equal(context.scrollY, 850);
  context.location.href = 'https://other.example/';
  elements[0].value = 'keep';
  assert.equal(restore().applied, false);
  assert.equal(elements[0].value, 'keep');
});
