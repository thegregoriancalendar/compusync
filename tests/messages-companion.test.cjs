'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { conversation, message, command, messagesState } = require('../src/messages/contracts.cjs');
const { MessagesAutomation, SCRIPT } = require('../src/messages/mac-automation.cjs');
const { MessagesHistoryStore, APPLE_EPOCH_MS } = require('../src/messages/history-store.cjs');
const { MessagesService } = require('../src/messages/service.cjs');
const { MessagesMacBridge } = require('../src/messages/mac-bridge.cjs');

const sampleConversation = {
  id: 'iMessage;-;chat123', name: 'Ada', service: 'iMessage',
  participants: [{ id: 'person-1', name: 'Ada', handle: '+15551234567' }],
};

test('Messages contracts permit only bounded companion data and supported commands', () => {
  assert.deepEqual(conversation(sampleConversation), sampleConversation);
  assert.equal(conversation({ ...sampleConversation, secret: 'no' }), null);
  assert.ok(message({
    id: 'message-1', conversationId: sampleConversation.id, sender: 'Ada', text: 'hello',
    sentAt: Date.now(), fromMe: false, status: 'received',
  }));
  assert.deepEqual(command('message.send', {
    conversationId: sampleConversation.id, text: 'hello', clientId: 'client-12345678',
  }), { conversationId: sampleConversation.id, text: 'hello', clientId: 'client-12345678' });
  assert.equal(command('message.react', {}), null);
  assert.equal(command('message.send', {
    conversationId: sampleConversation.id, text: ' ', clientId: 'client-12345678',
  }), null);
  assert.ok(messagesState({ version: 1, available: true, reason: '', conversations: [sampleConversation] }));
});

test('Messages automation passes opaque values as arguments instead of script source', async () => {
  const calls = [];
  const automation = new MessagesAutomation({
    platform: 'darwin',
    execute: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: JSON.stringify({ accepted: true, clientId: 'client-12345678' }), stderr: '' };
    },
  });
  const hostileText = `hello'); Application('Finder').quit(); //`;
  const result = await automation.sendText({
    conversationId: 'iMessage;-;chat123', text: hostileText, clientId: 'client-12345678',
  });
  assert.equal(result.accepted, true);
  assert.equal(calls[0].file, '/usr/bin/osascript');
  assert.equal(calls[0].args[3], SCRIPT);
  assert.equal(calls[0].args[5], 'sendText');
  assert.equal(JSON.parse(calls[0].args[6]).text, hostileText);
  assert.equal(SCRIPT.includes(hostileText), false);
});

test('read-only history store returns bounded text messages in chronological order', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compusync-messages-'));
  const databasePath = path.join(root, 'chat.db');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE chat (guid TEXT, chat_identifier TEXT);
    CREATE TABLE handle (id TEXT);
    CREATE TABLE message (guid TEXT, text TEXT, date INTEGER, is_from_me INTEGER, handle_id INTEGER, date_delivered INTEGER, date_read INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    INSERT INTO chat (guid, chat_identifier) VALUES ('iMessage;-;chat123', 'chat123');
    INSERT INTO handle (id) VALUES ('+15551234567');
    INSERT INTO message (guid, text, date, is_from_me, handle_id, date_delivered, date_read)
      VALUES ('m1', 'incoming', 1000000000, 0, 1, 0, 0),
             ('m2', 'outgoing', 2000000000, 1, 0, 2000000001, 0);
    INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1), (1, 2);
  `);
  database.close();
  const store = new MessagesHistoryStore({ databasePath, DatabaseSync });
  const result = store.history({ conversationId: sampleConversation.id, limit: 10 });
  assert.deepEqual(result.messages.map((item) => item.text), ['incoming', 'outgoing']);
  assert.equal(result.messages[0].sender, '+15551234567');
  assert.equal(result.messages[0].sentAt, APPLE_EPOCH_MS + 1_000_000_000 * 1000);
  assert.equal(result.messages[1].status, 'delivered');
  assert.equal(result.hasMore, false);
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('Mac conversation loading reads chat.db without requiring Messages Automation', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE chat (guid TEXT, chat_identifier TEXT, display_name TEXT, service_name TEXT);
    CREATE TABLE handle (id TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    INSERT INTO chat VALUES ('iMessage;-;older', '+15550000001', '', 'iMessage'),
                            ('iMessage;+;chat123', 'chat123', 'Project group', 'iMessage');
    INSERT INTO handle VALUES ('+15550000001'), ('ada@example.test');
    INSERT INTO chat_handle_join VALUES (1, 1), (2, 1), (2, 2);
    INSERT INTO chat_message_join VALUES (1, 1), (2, 2);
  `);
  const store = new MessagesHistoryStore({ database });
  const bridge = new MessagesMacBridge({
    platform: 'darwin', historyStore: store,
    automation: { listConversations() { throw new Error('Automation must not gate reading.'); } },
  });
  try {
    assert.equal(bridge.state().available, true);
    const conversations = await bridge.listConversations();
    assert.equal(conversations.length, 2);
    assert.equal(conversations[0].name, 'Project group');
    assert.equal(conversations[0].participants.length, 2);
    assert.equal(conversations[1].name, '+15550000001');
    assert.equal(conversations[1].service, 'iMessage');
    database.exec('INSERT INTO chat_message_join VALUES (1, 3)');
    assert.equal((await bridge.listConversations())[0].id, 'iMessage;-;older');
  } finally { database.close(); }
});

test('conversation loading supports older database schemas and reports unreadable databases', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE chat (guid TEXT, chat_identifier TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    INSERT INTO chat VALUES ('SMS;-;+15550000001', '+15550000001');
  `);
  try {
    const store = new MessagesHistoryStore({ database });
    assert.equal(store.listConversations()[0].participants[0].handle, '+15550000001');
    assert.equal(store.listConversations()[0].service, 'SMS');
  } finally { database.close(); }
  const missing = new MessagesHistoryStore({ databasePath: path.join(os.tmpdir(), `absent-${process.pid}`, 'chat.db') });
  assert.equal(missing.availability().available, false);
  assert.match(missing.availability().reason, /Terminal for npm start/);
});

test('denied Automation produces actionable guidance without exposing subprocess output', async () => {
  const automation = new MessagesAutomation({
    platform: 'darwin',
    execute: async () => { throw Object.assign(new Error('command failed'), {
      stderr: 'Not authorized to send Apple events to Messages. (-1743) private-data',
    }); },
  });
  await assert.rejects(automation.sendText({}), (error) => {
    assert.equal(error.code, 'MESSAGES_AUTOMATION_DENIED');
    assert.match(error.message, /Privacy & Security > Automation/);
    assert.equal(error.message.includes('private-data'), false);
    return true;
  });
});

class FakeSession extends EventEmitter {
  constructor(id) {
    super();
    this.self = { id };
    this.dataPhase = 'connected';
  }

  connect(peer) { this.peer = peer; }
  sendData(message) {
    if (!this.peer) return false;
    queueMicrotask(() => this.peer.emit('data', structuredClone(message), this.self.id));
    return true;
  }
}

test('Windows client invokes only supported operations on the Mac authority', async () => {
  const macSession = new FakeSession('mac');
  const windowsSession = new FakeSession('windows');
  macSession.connect(windowsSession);
  windowsSession.connect(macSession);
  const sent = [];
  const bridge = {
    state: () => ({ available: true, reason: '' }),
    listConversations: async () => [sampleConversation],
    history: async ({ conversationId }) => ({
      conversationId, before: 1, hasMore: false,
      messages: [{ id: 'm1', conversationId, sender: 'Ada', text: 'hello', sentAt: 1, fromMe: false, status: 'received' }],
    }),
    sendText: async (payload) => { sent.push(payload); return { accepted: true, clientId: payload.clientId }; },
    close() {},
  };
  const windows = new MessagesService({ session: windowsSession, platform: 'win32' });
  const mac = new MessagesService({ session: macSession, platform: 'darwin', bridge });
  windows.start();
  mac.start();
  const conversations = await windows.request('conversations.list', {});
  assert.deepEqual(conversations, [sampleConversation]);
  const history = await windows.request('history.list', { conversationId: sampleConversation.id, limit: 50 });
  assert.equal(history.messages[0].text, 'hello');
  await windows.request('message.send', {
    conversationId: sampleConversation.id, text: 'Hi', clientId: 'client-12345678',
  });
  assert.equal(sent[0].text, 'Hi');
  bridge.sendText = async () => { throw Object.assign(new Error('Allow Automation for Messages.'), {
    code: 'MESSAGES_AUTOMATION_DENIED',
  }); };
  await assert.rejects(windows.request('message.send', {
    conversationId: sampleConversation.id, text: 'Hi', clientId: 'client-12345678',
  }), /Allow Automation for Messages/);
  windowsSession.emit('data-status', { phase: 'disconnected' });
  assert.equal(windows.state().available, false);
  assert.match(windows.state().reason, /disconnected/);
  await assert.rejects(windows.request('message.react', {}), /invalid/i);
  windows.stop();
  mac.stop();
});
