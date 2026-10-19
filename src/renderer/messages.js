'use strict';

const { setText, reconcileChildren } = window.CompuSyncDOM;
const messageElements = new Map();
let listSignature;

const elements = {
  search: document.querySelector('#search'),
  list: document.querySelector('#conversation-list'),
  title: document.querySelector('#conversation-title'),
  subtitle: document.querySelector('#conversation-subtitle'),
  status: document.querySelector('#status'),
  messages: document.querySelector('#messages'),
  older: document.querySelector('#older'),
  composer: document.querySelector('#composer'),
  draft: document.querySelector('#draft'),
  send: document.querySelector('#send'),
};

let state = { available: false, reason: 'Connecting to the Mac…', conversations: [] };
let selectedId = null;
let history = [];
let before = null;
let hasMore = false;
let loading = false;
let refreshing = false;
let historyRequest = 0;
let stateRevision = 0;
let lastConversationRefresh = 0;
let conversationError = '';
let historyError = '';
let sendError = '';

function displayName(conversation) {
  return conversation.name || conversation.participants.map((person) => person.name || person.handle).filter(Boolean).join(', ') || 'Conversation';
}

function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts.at(-1)[0] : name.slice(0, 2)).toUpperCase();
}

function selectedConversation() { return state.conversations.find((item) => item.id === selectedId) || null; }

function renderList() {
  const query = elements.search.value.trim().toLocaleLowerCase();
  const signature = JSON.stringify([query, selectedId, state.conversations]);
  if (listSignature === signature) return;
  listSignature = signature;
  elements.list.replaceChildren();
  for (const conversation of state.conversations) {
    const name = displayName(conversation);
    const handles = conversation.participants.map((person) => person.handle).filter(Boolean).join(', ');
    const participantNames = conversation.participants.map((person) => person.name).filter(Boolean).join(', ');
    if (query && !`${name} ${handles} ${participantNames}`.toLocaleLowerCase().includes(query)) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'conversation-item';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(conversation.id === selectedId));
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = initials(name);
    const copy = document.createElement('span');
    const title = document.createElement('div');
    title.className = 'conversation-name';
    title.textContent = name;
    const detail = document.createElement('div');
    detail.className = 'conversation-detail';
    detail.textContent = handles || conversation.service;
    copy.append(title, detail);
    button.append(avatar, copy);
    button.addEventListener('click', () => selectConversation(conversation.id));
    elements.list.append(button);
  }
}

function renderMessages({ preserveScroll = false } = {}) {
  const previousHeight = elements.messages.scrollHeight;
  const wasAtBottom = previousHeight - elements.messages.scrollTop - elements.messages.clientHeight < 40;
  const rows = [];
  const ids = new Set();
  for (const item of history) {
    ids.add(item.id);
    let parts = messageElements.get(item.id);
    if (!parts) {
      const row = document.createElement('article');
      const sender = document.createElement('div');
      sender.className = 'sender';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      const metadata = document.createElement('div');
      metadata.className = 'metadata';
      row.append(sender, bubble, metadata);
      parts = { row, sender, bubble, metadata };
      messageElements.set(item.id, parts);
    }
    const { row, sender, bubble, metadata } = parts;
    row.className = `message ${item.fromMe ? 'outgoing' : 'incoming'}`;
    sender.hidden = item.fromMe || !item.sender;
    const senderName = selectedConversation()?.participants.find((person) => person.handle === item.sender)?.name;
    setText(sender, senderName || item.sender || '');
    setText(bubble, item.text);
    const date = item.sentAt ? new Date(item.sentAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '';
    setText(metadata, item.fromMe ? `${date}${date ? ' · ' : ''}${item.status}` : date);
    rows.push(row);
  }
  for (const id of messageElements.keys()) if (!ids.has(id)) messageElements.delete(id);
  reconcileChildren(elements.messages, rows);
  if (preserveScroll) elements.messages.scrollTop += elements.messages.scrollHeight - previousHeight;
  else if (wasAtBottom) elements.messages.scrollTop = elements.messages.scrollHeight;
  elements.older.hidden = !hasMore;
}

function renderState() {
  renderList();
  const conversation = selectedConversation();
  const error = sendError || historyError || conversationError;
  elements.composer.hidden = !conversation || !state.available;
  if (!state.available) {
    setText(elements.status, error || state.reason || 'Messages is not available from the Mac.');
    setText(elements.title, 'Messages Companion');
    setText(elements.subtitle, 'Mac connection required');
  } else if (!conversation) {
    setText(elements.status, error || (state.conversations.length ? 'Select a conversation.' : 'No conversations available.'));
    setText(elements.title, 'Messages Companion');
    setText(elements.subtitle, '');
  } else {
    setText(elements.status, error || (loading ? 'Updating…' : ''));
    setText(elements.title, displayName(conversation));
    setText(elements.subtitle, conversation.participants.map((person) => person.handle).filter(Boolean).join(', ') || conversation.service);
  }
}

async function refreshConversations() {
  if (refreshing) return;
  refreshing = true;
  lastConversationRefresh = Date.now();
  try {
    const conversations = await window.compusyncMessages.command('conversations.list', {});
    state = { ...state, available: true, reason: '', conversations };
    conversationError = '';
    if (selectedId && !selectedConversation()) selectConversation(null);
  } catch (error) {
    conversationError = error.message || 'Could not load conversations.';
  } finally {
    refreshing = false;
    renderState();
  }
}

async function loadHistory({ earlier = false, quiet = false } = {}) {
  if (!selectedId || loading) return;
  const request = ++historyRequest;
  const conversationId = selectedId;
  loading = true;
  if (!quiet) renderState();
  try {
    const result = await window.compusyncMessages.command('history.list', {
      conversationId,
      before: earlier ? before : null,
      limit: 120,
    });
    if (request !== historyRequest || selectedId !== result.conversationId) return;
    historyError = '';
    history = earlier ? [...result.messages, ...history] : result.messages;
    before = result.before;
    hasMore = result.hasMore;
    renderMessages({ preserveScroll: earlier });
  } catch (error) {
    if (request === historyRequest) historyError = error.message || 'Could not load messages.';
  } finally {
    if (request === historyRequest) {
      loading = false;
      renderState();
    }
  }
}

function selectConversation(id) {
  if (selectedId === id) return;
  selectedId = id;
  historyRequest++;
  loading = false;
  historyError = '';
  sendError = '';
  history = [];
  before = null;
  hasMore = false;
  renderState();
  renderMessages();
  void loadHistory();
}

elements.search.addEventListener('input', renderList);
elements.older.addEventListener('click', () => loadHistory({ earlier: true }));
elements.draft.addEventListener('input', () => {
  elements.draft.style.height = 'auto';
  elements.draft.style.height = `${Math.min(elements.draft.scrollHeight, 130)}px`;
});
elements.draft.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});
elements.composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = elements.draft.value.trim();
  if (!text || !selectedId) return;
  elements.send.disabled = true;
  try {
    await window.compusyncMessages.command('message.send', {
      conversationId: selectedId,
      text,
      clientId: `client-${crypto.randomUUID()}`,
    });
    sendError = '';
    elements.draft.value = '';
    elements.draft.dispatchEvent(new Event('input'));
    setTimeout(() => loadHistory({ quiet: true }), 400);
  } catch (error) {
    sendError = error.message || 'Message was not sent.';
  } finally { elements.send.disabled = false; renderState(); }
});

window.compusyncMessages.onState((next) => {
  const becameAvailable = next.available && !state.available;
  stateRevision++;
  state = next;
  renderState();
  if (becameAvailable) void refreshConversations();
});

const bootstrapRevision = stateRevision;
window.compusyncMessages.bootstrap().then((initial) => {
  if (stateRevision === bootstrapRevision) state = initial;
  renderState();
  return refreshConversations();
}).catch((error) => {
  conversationError = error.message || 'Messages Companion could not start.';
  renderState();
});

setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (selectedId && state.available) void loadHistory({ quiet: true });
  if (!state.available || conversationError || Date.now() - lastConversationRefresh >= 10_000) void refreshConversations();
}, 2000);
