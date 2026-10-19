'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REFRESH_MS = 60_000;
const MAX_CONTACT_ROWS = 50_000;
const DATABASE_FILE = /^AddressBook-v\d+\.abcddb$/;

function contactKey(value) {
  if (typeof value !== 'string') return '';
  const handle = value.trim().replace(/^(?:mailto|tel):/i, '');
  if (handle.includes('@')) return `email:${handle.toLowerCase()}`;
  if (!/^\+?[\d\s().-]+$/.test(handle)) return '';
  let digits = handle.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  // NANP numbers are commonly saved without +1. Do not suffix-match other
  // country codes: that can assign a different person's name to a conversation.
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits.length >= 3 && digits.length <= 15 ? `phone:${digits}` : '';
}

function cleanName(value) {
  return String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 256);
}

function columns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((entry) => entry.name));
}

function directoryEntries(directory) {
  try { return fs.readdirSync(directory, { withFileTypes: true }); }
  catch { return []; }
}

class MessagesContactsStore {
  constructor(options = {}) {
    this.directory = options.contactsDirectory || path.join(os.homedir(), 'Library', 'Application Support', 'AddressBook');
    this.DatabaseSync = options.DatabaseSync || null;
    this.now = options.now || Date.now;
    this.refreshAt = 0;
    this.names = new Map();
  }

  _paths() {
    const sources = path.join(this.directory, 'Sources');
    const directories = [this.directory, ...directoryEntries(sources)
      .filter((entry) => entry.isDirectory()).slice(0, 128).map((entry) => path.join(sources, entry.name))];
    return directories.flatMap((directory) => directoryEntries(directory)
      .filter((entry) => entry.isFile() && DATABASE_FILE.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
      .slice(0, 1).map((entry) => path.join(directory, entry.name)));
  }

  _read(database, names) {
    const recordColumns = columns(database, 'ZABCDRECORD');
    if (!recordColumns.has('Z_PK')) return;
    const fields = ['ZFIRSTNAME', 'ZMIDDLENAME', 'ZLASTNAME', 'ZNICKNAME', 'ZORGANIZATION'];
    const selectNames = fields.map((field) => recordColumns.has(field) ? `r.${field}` : `NULL AS ${field}`).join(', ');
    for (const [table, valueColumn] of [['ZABCDPHONENUMBER', 'ZFULLNUMBER'], ['ZABCDEMAILADDRESS', 'ZADDRESS']]) {
      const addressColumns = columns(database, table);
      if (!addressColumns.has('ZOWNER') || !addressColumns.has(valueColumn)) continue;
      const rows = database.prepare(`
        SELECT a.${valueColumn} AS handle, ${selectNames}
          FROM ${table} AS a JOIN ZABCDRECORD AS r ON r.Z_PK = a.ZOWNER
         WHERE a.${valueColumn} IS NOT NULL
         ORDER BY a.Z_PK LIMIT ?
      `).all(MAX_CONTACT_ROWS);
      for (const row of rows) {
        const key = contactKey(row.handle);
        const fullName = [row.ZFIRSTNAME, row.ZMIDDLENAME, row.ZLASTNAME].map(cleanName).filter(Boolean).join(' ');
        const name = cleanName(fullName || row.ZNICKNAME || row.ZORGANIZATION);
        if (!key || !name) continue;
        // Conflicting cards stay as handles instead of displaying a wrong name.
        if (!names.has(key)) names.set(key, name);
        else if (names.get(key) !== name) names.set(key, '');
      }
    }
  }

  namesFor(handles) {
    const now = this.now();
    if (now >= this.refreshAt) {
      this.refreshAt = now + REFRESH_MS;
      const names = new Map();
      for (const databasePath of this._paths()) {
        let database;
        try {
          const DatabaseSync = this.DatabaseSync || require('node:sqlite').DatabaseSync;
          database = new DatabaseSync(databasePath, { readOnly: true, timeout: 500 });
          this._read(database, names);
        } catch { /* Optional contact access must never prevent loading chats. */ }
        finally { database?.close(); }
      }
      this.names = names;
    }
    // Return only names for participants of the requested conversations.
    return new Map(handles.map((handle) => [handle, this.names.get(contactKey(handle)) || '']));
  }
}

module.exports = { MessagesContactsStore, contactKey };
