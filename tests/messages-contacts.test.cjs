'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { MessagesContactsStore, contactKey } = require('../src/messages/contacts-store.cjs');
const { MessagesMacBridge } = require('../src/messages/mac-bridge.cjs');

function contactsDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'compusync-contacts-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('compusync-contacts-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function createDatabase(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(path.join(directory, 'AddressBook-v22.abcddb'));
  database.exec(`
    CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZMIDDLENAME TEXT,
      ZLASTNAME TEXT, ZNICKNAME TEXT, ZORGANIZATION TEXT);
    CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT);
    CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS TEXT);
  `);
  return database;
}

test('phone and email matching normalizes formatting without guessing international suffixes', () => {
  assert.equal(contactKey('+1 (415) 555-0123'), contactKey('4155550123'));
  assert.equal(contactKey('tel:0014155550123'), contactKey('+14155550123'));
  assert.equal(contactKey(' Ada@Example.test '), contactKey('mailto:ada@example.test'));
  assert.notEqual(contactKey('+44 20 7946 0123'), contactKey('+1 207 946 0123'));
  assert.notEqual(contactKey('4155550123'), contactKey('5550123'));
  assert.equal(contactKey('chat123'), '');
});

test('resolves names across local and account contact databases and returns only requested handles', (t) => {
  const directory = contactsDirectory(t);
  const local = createDatabase(directory);
  local.exec(`
    INSERT INTO ZABCDRECORD VALUES (1, 'Ada', NULL, 'Lovelace', NULL, NULL),
      (2, NULL, NULL, NULL, 'Grandma', NULL), (3, NULL, NULL, NULL, NULL, 'Example Shop');
    INSERT INTO ZABCDPHONENUMBER VALUES (1, 1, '(415) 555-0123'), (2, 2, '+1 415 555 0124');
    INSERT INTO ZABCDEMAILADDRESS VALUES (1, 3, 'support@example.test');
  `);
  local.close();
  const account = createDatabase(path.join(directory, 'Sources', 'icloud'));
  account.exec(`
    INSERT INTO ZABCDRECORD VALUES (1, 'Grace', 'B.', 'Hopper', NULL, NULL);
    INSERT INTO ZABCDEMAILADDRESS VALUES (1, 1, 'GRACE@example.test');
  `);
  account.close();
  const opens = [];
  class ReadOnlyDatabase extends DatabaseSync {
    constructor(file, options) {
      assert.equal(options.readOnly, true);
      opens.push(file);
      super(file, options);
    }
  }
  const store = new MessagesContactsStore({ contactsDirectory: directory, DatabaseSync: ReadOnlyDatabase });
  const names = store.namesFor(['+14155550123', '4155550124', 'grace@example.test', 'unknown@example.test']);
  assert.equal(names.get('+14155550123'), 'Ada Lovelace');
  assert.equal(names.get('4155550124'), 'Grandma');
  assert.equal(names.get('grace@example.test'), 'Grace B. Hopper');
  assert.equal(names.get('unknown@example.test'), '');
  assert.equal(names.has('support@example.test'), false);
  assert.equal(store.namesFor(['support@example.test']).get('support@example.test'), 'Example Shop');
  assert.equal(opens.length, 2, 'Polling must reuse the cached contact index.');
});

test('contact edits refresh and ambiguous numbers never pick an arbitrary name', (t) => {
  const directory = contactsDirectory(t);
  const database = createDatabase(directory);
  database.exec(`
    INSERT INTO ZABCDRECORD VALUES (1, 'Ada', NULL, 'Lovelace', NULL, NULL),
      (2, 'Someone', NULL, 'Else', NULL, NULL);
    INSERT INTO ZABCDPHONENUMBER VALUES (1, 1, '+14155550123'), (2, 2, '+14155550123');
    INSERT INTO ZABCDEMAILADDRESS VALUES (1, 1, 'ada@example.test');
  `);
  let now = 0;
  const store = new MessagesContactsStore({ contactsDirectory: directory, now: () => now });
  assert.equal(store.namesFor(['4155550123']).get('4155550123'), '');
  assert.equal(store.namesFor(['ada@example.test']).get('ada@example.test'), 'Ada Lovelace');
  database.exec("UPDATE ZABCDRECORD SET ZFIRSTNAME = 'Augusta Ada' WHERE Z_PK = 1");
  now = 60_000;
  assert.equal(store.namesFor(['ada@example.test']).get('ada@example.test'), 'Augusta Ada Lovelace');
  database.close();
});

test('missing, unreadable and unsupported contact databases leave chats usable', (t) => {
  const directory = contactsDirectory(t);
  const store = new MessagesContactsStore({ contactsDirectory: directory });
  assert.equal(store.namesFor(['+14155550123']).get('+14155550123'), '');
  const rootDatabase = path.join(directory, 'AddressBook-v22.abcddb');
  fs.writeFileSync(rootDatabase, 'not a database');
  store.refreshAt = 0;
  assert.equal(store.namesFor(['+14155550123']).get('+14155550123'), '');
  const source = createDatabase(path.join(directory, 'Sources', 'valid'));
  source.exec(`
    INSERT INTO ZABCDRECORD VALUES (1, 'Ada', NULL, 'Lovelace', NULL, NULL);
    INSERT INTO ZABCDPHONENUMBER VALUES (1, 1, '+14155550123');
  `);
  source.close();
  store.refreshAt = 0;
  assert.equal(store.namesFor(['+14155550123']).get('+14155550123'), 'Ada Lovelace');
  class DeniedDatabase { constructor() { throw new Error('Permission denied'); } }
  const denied = new MessagesContactsStore({ contactsDirectory: directory, DatabaseSync: DeniedDatabase });
  assert.equal(denied.namesFor(['+14155550123']).get('+14155550123'), '');
});

test('bridge uses contact names for untitled chats and preserves saved group titles', async () => {
  const person = { id: '+14155550123', name: '', handle: '+14155550123' };
  const chats = [
    { id: 'iMessage;-;+14155550123', name: '', service: 'iMessage', participants: [person] },
    { id: 'iMessage;+;named', name: 'Project group', service: 'iMessage', participants: [person] },
    { id: 'iMessage;+;unnamed', name: '', service: 'iMessage', participants: [
      person, { id: 'unknown@example.test', name: '', handle: 'unknown@example.test' },
    ] },
  ];
  const bridge = new MessagesMacBridge({
    platform: 'darwin',
    historyStore: { availability: () => ({ available: true }), listConversations: () => chats },
    contactsStore: { namesFor: () => new Map([[person.handle, 'Ada Lovelace']]) },
  });
  const result = await bridge.listConversations();
  assert.equal(result[0].name, 'Ada Lovelace');
  assert.equal(result[0].participants[0].name, 'Ada Lovelace');
  assert.equal(result[0].participants[0].handle, person.handle);
  assert.equal(result[1].name, 'Project group');
  assert.equal(result[2].name, 'Ada Lovelace, unknown@example.test');
  assert.equal(chats[0].participants[0].name, '', 'Do not mutate the database result.');
  bridge.contactsStore.namesFor = () => { throw new Error('Contacts unavailable'); };
  assert.equal((await bridge.listConversations())[0].name, person.handle);
});
