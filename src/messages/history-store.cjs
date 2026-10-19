'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MAX_CONVERSATIONS, MAX_PARTICIPANTS } = require('./contracts.cjs');

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

function appleDate(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const milliseconds = raw > 1e12 ? raw / 1e6 : raw * 1000;
  return APPLE_EPOCH_MS + milliseconds;
}

function columns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((entry) => entry.name));
}

class MessagesHistoryStore {
  constructor(options = {}) {
    this.databasePath = options.databasePath || path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
    this.DatabaseSync = options.DatabaseSync || null;
    this.database = options.database || null;
    this.ownsDatabase = false;
  }

  canAccess() {
    // access(2) can succeed even when macOS privacy controls deny opening a file.
    try {
      const descriptor = fs.openSync(this.databasePath, 'r');
      fs.closeSync(descriptor);
      return true;
    }
    catch { return false; }
  }

  availability() {
    try {
      this.open().prepare('SELECT name FROM sqlite_master LIMIT 1').get();
      return { available: true, reason: '' };
    } catch (error) {
      return { available: false, reason: error.code === 'MESSAGES_FULL_DISK_ACCESS'
        ? error.message : 'Could not open the Mac Messages database. Fully quit and restart CompuSync on the Mac, then try again.' };
    }
  }

  open() {
    if (this.database) return this.database;
    if (!this.canAccess()) {
      const error = new Error('On the Mac, allow Full Disk Access for the app running CompuSync (Terminal for npm start, or the installed CompuSync app), then fully quit and restart it.');
      error.code = 'MESSAGES_FULL_DISK_ACCESS';
      throw error;
    }
    const DatabaseSync = this.DatabaseSync || require('node:sqlite').DatabaseSync;
    this.database = new DatabaseSync(this.databasePath, { readOnly: true, timeout: 2500 });
    this.ownsDatabase = true;
    return this.database;
  }

  listConversations() {
    const database = this.open();
    const chatColumns = columns(database, 'chat');
    if (!chatColumns.has('guid') || !chatColumns.has('chat_identifier')) {
      const error = new Error('This macOS Messages database format is not supported yet.');
      error.code = 'MESSAGES_SCHEMA_UNSUPPORTED';
      throw error;
    }
    const displayName = chatColumns.has('display_name') ? 'c.display_name' : "''";
    const serviceName = chatColumns.has('service_name') ? 'c.service_name' : "''";
    const chats = database.prepare(`
      SELECT c.ROWID AS rowid, c.guid AS id, c.chat_identifier AS identifier,
             ${displayName} AS name, ${serviceName} AS service
        FROM chat AS c
        LEFT JOIN chat_message_join AS cmj ON cmj.chat_id = c.ROWID
       WHERE c.guid IS NOT NULL AND c.guid != ''
       GROUP BY c.ROWID
       ORDER BY MAX(cmj.message_id) DESC, c.ROWID DESC
       LIMIT ?
    `).all(MAX_CONVERSATIONS);
    const hasParticipants = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_handle_join'").get();
    const participants = hasParticipants ? database.prepare(`
      SELECT DISTINCT h.id AS handle
        FROM chat_handle_join AS chj JOIN handle AS h ON h.ROWID = chj.handle_id
       WHERE chj.chat_id = ? AND h.id IS NOT NULL AND h.id != ''
       ORDER BY h.ROWID LIMIT ?
    `) : null;
    return chats.map((chat) => {
      const people = participants ? participants.all(chat.rowid, MAX_PARTICIPANTS)
        .map(({ handle }) => ({ id: String(handle), name: '', handle: String(handle) })) : [];
      if (!people.length && chat.identifier && !String(chat.identifier).startsWith('chat')) {
        people.push({ id: String(chat.identifier), name: '', handle: String(chat.identifier) });
      }
      const rawService = String(chat.service || String(chat.id).split(';')[0]).toLowerCase();
      const service = ({ imessage: 'iMessage', sms: 'SMS', rcs: 'RCS' })[rawService] || 'unknown';
      return {
        id: String(chat.id), name: String(chat.name || people.map((person) => person.handle).join(', ')).slice(0, 512),
        service, participants: people,
      };
    });
  }

  history({ conversationId, before = null, limit = 100 }) {
    const database = this.open();
    const messageColumns = columns(database, 'message');
    const required = ['guid', 'text', 'date', 'is_from_me', 'handle_id'];
    if (required.some((name) => !messageColumns.has(name))) {
      const error = new Error('This macOS Messages database format is not supported yet.');
      error.code = 'MESSAGES_SCHEMA_UNSUPPORTED';
      throw error;
    }
    const delivered = messageColumns.has('date_delivered') ? 'm.date_delivered' : '0';
    const read = messageColumns.has('date_read') ? 'm.date_read' : '0';
    const beforeSql = before === null ? '' : 'AND m.ROWID < ?';
    const statement = database.prepare(`
      SELECT m.ROWID AS rowid, m.guid AS id, c.guid AS conversation_id,
             COALESCE(h.id, '') AS sender, m.text AS text, m.date AS sent_at,
             m.is_from_me AS from_me, ${delivered} AS delivered_at, ${read} AS read_at
        FROM message AS m
        JOIN chat_message_join AS cmj ON cmj.message_id = m.ROWID
        JOIN chat AS c ON c.ROWID = cmj.chat_id
        LEFT JOIN handle AS h ON h.ROWID = m.handle_id
       WHERE (c.guid = ? OR c.chat_identifier = ?)
         AND m.text IS NOT NULL
         ${beforeSql}
       ORDER BY m.ROWID DESC
       LIMIT ?
    `);
    const parameters = before === null
      ? [conversationId, conversationId, limit + 1]
      : [conversationId, conversationId, before, limit + 1];
    const rows = statement.all(...parameters);
    const hasMore = rows.length > limit;
    return {
      conversationId,
      hasMore,
      messages: rows.slice(0, limit).reverse().map((row) => {
        const fromMe = Boolean(row.from_me);
        const status = !fromMe ? 'received' : Number(row.read_at) > 0 ? 'read'
          : Number(row.delivered_at) > 0 ? 'delivered' : 'sent';
        return {
          id: String(row.id || `row-${row.rowid}`),
          conversationId,
          sender: fromMe ? '' : String(row.sender || ''),
          text: String(row.text || ''),
          sentAt: appleDate(row.sent_at),
          fromMe,
          status,
          rowId: Number(row.rowid),
        };
      }),
    };
  }

  close() {
    if (this.database && this.ownsDatabase) this.database.close();
    this.database = null;
    this.ownsDatabase = false;
  }
}

module.exports = { MessagesHistoryStore, appleDate, APPLE_EPOCH_MS };
