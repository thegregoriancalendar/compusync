'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
    try { fs.accessSync(this.databasePath, fs.constants.R_OK); return true; }
    catch { return false; }
  }

  open() {
    if (this.database) return this.database;
    if (!this.canAccess()) {
      const error = new Error('Allow Full Disk Access on the Mac to make Messages history available.');
      error.code = 'MESSAGES_FULL_DISK_ACCESS';
      throw error;
    }
    const DatabaseSync = this.DatabaseSync || require('node:sqlite').DatabaseSync;
    this.database = new DatabaseSync(this.databasePath, { readOnly: true, timeout: 2500 });
    this.ownsDatabase = true;
    return this.database;
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
