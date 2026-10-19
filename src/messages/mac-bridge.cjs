'use strict';

const { MessagesAutomation } = require('./mac-automation.cjs');
const { MessagesHistoryStore } = require('./history-store.cjs');
const { MessagesContactsStore } = require('./contacts-store.cjs');
const { conversation, historyResult, command } = require('./contracts.cjs');

class MessagesMacBridge {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.automation = options.automation || new MessagesAutomation(options);
    this.historyStore = options.historyStore || new MessagesHistoryStore(options);
    this.contactsStore = options.contactsStore || new MessagesContactsStore(options);
  }

  state() {
    if (this.platform !== 'darwin') return { available: false, reason: 'Messages is hosted by the Mac.' };
    return this.historyStore.availability();
  }

  async listConversations() {
    const availability = this.state();
    if (!availability.available) {
      const error = new Error(availability.reason);
      error.code = 'MESSAGES_UNAVAILABLE';
      throw error;
    }
    const raw = this.historyStore.listConversations();
    if (!Array.isArray(raw)) throw new Error('Messages returned an invalid conversation list.');
    let names = new Map();
    try { names = this.contactsStore.namesFor(raw.flatMap((chat) => chat.participants.map((person) => person.handle))); }
    catch { /* Conversation access is independent of contact access. */ }
    return raw.map((chat) => {
      const participants = chat.participants.map((person) => ({ ...person, name: names.get(person.handle) || person.name }));
      const name = chat.name || participants.map((person) => person.name || person.handle).filter(Boolean).join(', ').slice(0, 512);
      return conversation({ ...chat, name, participants });
    }).filter(Boolean);
  }

  async history(payload) {
    const request = command('history.list', payload);
    if (!request) throw new Error('Invalid Messages history request.');
    const raw = this.historyStore.history(request);
    // rowId is private pagination metadata. Keep it out of the renderer-facing
    // message object and use the oldest row as the next `before` cursor.
    const before = raw.messages.length ? raw.messages[0].rowId : null;
    const result = historyResult({
      conversationId: raw.conversationId,
      hasMore: raw.hasMore,
      messages: raw.messages.map(({ rowId: _rowId, ...message }) => message),
    });
    if (!result) throw new Error('Messages history contained unsupported data.');
    return { ...result, before };
  }

  async sendText(payload) {
    const request = command('message.send', payload);
    if (!request) throw new Error('Invalid outgoing message.');
    return this.automation.sendText(request);
  }

  close() { this.historyStore.close(); }
}

module.exports = { MessagesMacBridge };
