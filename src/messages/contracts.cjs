'use strict';

const SERVICE_VERSION = 1;
const MAX_CONVERSATIONS = 500;
const MAX_MESSAGES = 500;
const MAX_PARTICIPANTS = 64;
const MAX_TEXT_BYTES = 32 * 1024;
const REQUEST_ID = /^[A-Za-z0-9-]{8,80}$/;

function exactObject(value, allowed, required = allowed) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.includes(key))
    && required.every((key) => Object.hasOwn(value, key)));
}

function boundedText(value, maximum, { empty = true } = {}) {
  if (typeof value !== 'string' || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return null;
  if (!empty && !value.trim()) return null;
  return value;
}

function opaqueId(value) {
  return boundedText(value, 512, { empty: false });
}

function participant(value) {
  if (!exactObject(value, ['id', 'name', 'handle'], ['id', 'name', 'handle'])) return null;
  const id = opaqueId(value.id);
  const name = boundedText(value.name, 256);
  const handle = boundedText(value.handle, 256);
  return id && name !== null && handle !== null ? { id, name, handle } : null;
}

function conversation(value) {
  if (!exactObject(value, ['id', 'name', 'service', 'participants'], ['id', 'name', 'service', 'participants'])
    || !Array.isArray(value.participants) || value.participants.length > MAX_PARTICIPANTS) return null;
  const id = opaqueId(value.id);
  const name = boundedText(value.name, 512);
  const service = ['iMessage', 'SMS', 'RCS', 'unknown'].includes(value.service) ? value.service : null;
  const participants = value.participants.map(participant);
  return id && name !== null && service && !participants.includes(null)
    ? { id, name, service, participants } : null;
}

function message(value) {
  if (!exactObject(value, ['id', 'conversationId', 'sender', 'text', 'sentAt', 'fromMe', 'status'])
    || !Number.isFinite(value.sentAt) || value.sentAt < 0 || typeof value.fromMe !== 'boolean') return null;
  const id = opaqueId(value.id);
  const conversationId = opaqueId(value.conversationId);
  const sender = boundedText(value.sender, 256);
  const text = boundedText(value.text, MAX_TEXT_BYTES);
  const status = ['sent', 'delivered', 'read', 'received', 'unknown'].includes(value.status) ? value.status : null;
  return id && conversationId && sender !== null && text !== null && status
    ? { id, conversationId, sender, text, sentAt: value.sentAt, fromMe: value.fromMe, status } : null;
}

function messagesState(value) {
  if (!exactObject(value, ['version', 'available', 'reason', 'conversations'])
    || value.version !== SERVICE_VERSION || typeof value.available !== 'boolean'
    || !Array.isArray(value.conversations) || value.conversations.length > MAX_CONVERSATIONS) return null;
  const reason = boundedText(value.reason, 500);
  const conversations = value.conversations.map(conversation);
  return reason !== null && !conversations.includes(null)
    ? { version: SERVICE_VERSION, available: value.available, reason, conversations } : null;
}

function command(method, payload) {
  if (typeof method !== 'string') return null;
  if (method === 'conversations.list') {
    return exactObject(payload, [], []) ? {} : null;
  }
  if (method === 'history.list') {
    if (!exactObject(payload, ['conversationId', 'before', 'limit'], ['conversationId'])) return null;
    const conversationId = opaqueId(payload.conversationId);
    const before = payload.before === undefined || payload.before === null
      ? null : Number.isSafeInteger(payload.before) && payload.before > 0 ? payload.before : false;
    const limit = payload.limit === undefined ? 100 : payload.limit;
    return conversationId && before !== false && Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_MESSAGES
      ? { conversationId, before, limit } : null;
  }
  if (method === 'message.send') {
    if (!exactObject(payload, ['conversationId', 'text', 'clientId'])) return null;
    const conversationId = opaqueId(payload.conversationId);
    const clientId = REQUEST_ID.test(payload.clientId || '') ? payload.clientId : null;
    const text = boundedText(payload.text, MAX_TEXT_BYTES, { empty: false });
    return conversationId && clientId && text && Buffer.byteLength(text, 'utf8') <= MAX_TEXT_BYTES
      ? { conversationId, text, clientId } : null;
  }
  return null;
}

function historyResult(value) {
  if (!exactObject(value, ['conversationId', 'messages', 'hasMore']) || !opaqueId(value.conversationId)
    || !Array.isArray(value.messages) || value.messages.length > MAX_MESSAGES || typeof value.hasMore !== 'boolean') return null;
  const messages = value.messages.map(message);
  return messages.includes(null) ? null : { conversationId: value.conversationId, messages, hasMore: value.hasMore };
}

module.exports = {
  SERVICE_VERSION,
  MAX_CONVERSATIONS,
  MAX_MESSAGES,
  MAX_TEXT_BYTES,
  REQUEST_ID,
  exactObject,
  conversation,
  message,
  messagesState,
  command,
  historyResult,
};
