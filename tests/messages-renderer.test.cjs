'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'messages.js'), 'utf8');
const conversation = {
  id: 'iMessage;-;chat123', name: 'Ada', service: 'iMessage', participants: [],
};
const available = { available: true, reason: '', conversations: [] };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function renderer({ bootstrap = async () => available, command }) {
  const elements = new Map();
  function element() {
    return {
      textContent: '', value: '', hidden: false, style: {}, children: [], listeners: {},
      scrollHeight: 0, scrollTop: 0,
      replaceChildren(...children) { this.children = children; },
      append(...children) { this.children.push(...children); },
      setAttribute() {},
      addEventListener(name, callback) { this.listeners[name] = callback; },
    };
  }
  let onState, interval;
  let now = 0;
  const context = {
    window: { compusyncMessages: { bootstrap, command, onState(callback) { onState = callback; } } },
    document: {
      visibilityState: 'visible',
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, element());
        return elements.get(selector);
      },
      createElement: element,
    },
    Date: { now: () => now },
    setInterval(callback) { interval = callback; },
    setTimeout() {},
  };
  vm.runInNewContext(source, context);
  return {
    get: (selector) => elements.get(selector),
    state: (value) => onState(value),
    tick(milliseconds = 2000) { now += milliseconds; interval(); },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('connecting after companion opens loads conversations and refreshes new chats', async () => {
  const firstRequest = deferred();
  let calls = 0;
  const ui = renderer({
    bootstrap: async () => ({ available: false, reason: 'Waiting for the Mac.', conversations: [] }),
    command: () => ++calls === 1 ? firstRequest.promise : Promise.resolve([conversation]),
  });
  await flush();
  ui.state(available);
  ui.tick();
  assert.equal(calls, 1, 'Only one conversation request may be pending.');
  firstRequest.resolve([conversation]);
  await flush();
  assert.equal(ui.get('#conversation-list').children.length, 1);
  ui.tick(10_000);
  await flush();
  assert.equal(calls, 2, 'Available companions must keep discovering new conversations.');
});

test('a failed conversation request stays visible and retries while Mac is available', async () => {
  let fail = true;
  const ui = renderer({ command: async () => {
    if (fail) throw new Error('Allow access on the Mac.');
    return [conversation];
  } });
  await flush();
  assert.equal(ui.get('#status').textContent, 'Allow access on the Mac.');
  ui.state(available);
  assert.equal(ui.get('#status').textContent, 'Allow access on the Mac.');
  fail = false;
  ui.tick();
  await flush();
  assert.equal(ui.get('#conversation-list').children.length, 1);
  assert.equal(ui.get('#status').textContent, 'Select a conversation.');
});

test('history errors survive state renders and clear after recovery', async () => {
  let fail = true;
  const ui = renderer({ command: async (method, payload) => {
    if (method === 'conversations.list') return [conversation];
    if (fail) throw new Error('Could not read history on the Mac.');
    return { conversationId: payload.conversationId, messages: [], before: null, hasMore: false };
  } });
  await flush();
  ui.get('#conversation-list').children[0].listeners.click();
  await flush();
  assert.equal(ui.get('#status').textContent, 'Could not read history on the Mac.');
  ui.state({ ...available, conversations: [conversation] });
  assert.equal(ui.get('#status').textContent, 'Could not read history on the Mac.');
  fail = false;
  ui.tick();
  await flush();
  assert.equal(ui.get('#status').textContent, '');
});

test('late bootstrap cannot replace a newer connected state', async () => {
  const bootstrap = deferred();
  const ui = renderer({ bootstrap: () => bootstrap.promise, command: async () => [conversation] });
  ui.state(available);
  await flush();
  bootstrap.resolve({ available: false, reason: 'Outdated connection state.', conversations: [] });
  await flush();
  assert.equal(ui.get('#status').textContent, 'Select a conversation.');
  assert.equal(ui.get('#conversation-list').children.length, 1);
});

test('resolved contact names appear in the list, header and incoming sender label', async () => {
  const contact = {
    ...conversation, name: 'Ada Lovelace',
    participants: [{ id: '+14155550123', handle: '+14155550123', name: 'Ada Lovelace' }],
  };
  const ui = renderer({ command: async (method, payload) => method === 'conversations.list' ? [contact] : {
    conversationId: payload.conversationId, before: 1, hasMore: false,
    messages: [{ id: 'm1', sender: '+14155550123', text: 'Hello', sentAt: 0, fromMe: false, status: 'received' }],
  } });
  await flush();
  const button = ui.get('#conversation-list').children[0];
  assert.equal(button.children[1].children[0].textContent, 'Ada Lovelace');
  button.listeners.click();
  await flush();
  assert.equal(ui.get('#conversation-title').textContent, 'Ada Lovelace');
  assert.equal(ui.get('#messages').children[0].children[0].textContent, 'Ada Lovelace');
});

test('saved group titles remain searchable by a participant contact name', async () => {
  const group = {
    ...conversation, name: 'Project group',
    participants: [{ id: 'ada@example.test', handle: 'ada@example.test', name: 'Ada Lovelace' }],
  };
  const ui = renderer({ command: async () => [group] });
  await flush();
  ui.get('#search').value = 'lovelace';
  ui.get('#search').listeners.input();
  const buttons = ui.get('#conversation-list').children;
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].children[1].children[0].textContent, 'Project group');
});
