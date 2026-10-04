'use strict';

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
  elements.list.replaceChildren();
  for (const conversation of state.conversations) {
    const name = displayName(conversation);
    const handles = conversation.participants.map((person) => person.handle).filter(Boolean).join(', ');
    if (query && !`${name} ${handles}`.toLocaleLowerCase().includes(query)) continue;
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
  elements.messages.replaceChildren();
  for (const item of history) {
    const row = document.createElement('article');
    row.className = `message ${item.fromMe ? 'outgoing' : 'incoming'}`;
    if (!item.fromMe && item.sender) {
      const sender = document.createElement('div');
      sender.className = 'sender';
      sender.textContent = item.sender;
      row.append(sender);
    }
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = item.text;
    const metadata = document.createElement('div');
    metadata.className = 'metadata';
    const date = item.sentAt ? new Date(item.sentAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '';
    metadata.textContent = item.fromMe ? `${date}${date ? ' · ' : ''}${item.status}` : date;
    row.append(bubble, metadata);
    elements.messages.append(row);
  }
  if (preserveScroll) elements.messages.scrollTop += elements.messages.scrollHeight - previousHeight;
  else elements.messages.scrollTop = elements.messages.scrollHeight;
  elements.older.hidden = !hasMore;
}

function renderState() {
  renderList();
  const conversation = selectedConversation();
  elements.composer.hidden = !conversation || !state.available;
  if (!state.available) {
    elements.status.textContent = state.reason || 'Messages is not available from the Mac.';
    elements.title.textContent = 'Messages Companion';
    elements.subtitle.textContent = 'Mac connection required';
  } else if (!conversation) {
    elements.status.textContent = state.conversations.length ? 'Select a conversation.' : 'No conversations available.';
  } else {
    elements.status.textContent = loading ? 'Updating…' : '';
    elements.title.textContent = displayName(conversation);
    elements.subtitle.textContent = conversation.participants.map((person) => person.handle).filter(Boolean).join(', ') || conversation.service;
  }
}

async function refreshConversations() {
  try {
    const conversations = await window.compusyncMessages.command('conversations.list', {});
    state = { ...state, available: true, reason: '', conversations };
    if (selectedId && !selectedConversation()) selectedId = null;
  } catch (error) {
    elements.status.textContent = error.message || 'Could not load conversations.';
  }
  renderState();
}

async function loadHistory({ earlier = false, quiet = false } = {}) {
  if (!selectedId || loading) return;
  loading = true;
  if (!quiet) renderState();
  try {
    const result = await window.compusyncMessages.command('history.list', {
      conversationId: selectedId,
      before: earlier ? before : null,
      limit: 120,
    });
    if (selectedId !== result.conversationId) return;
    history = earlier ? [...result.messages, ...history] : result.messages;
    before = result.before;
    hasMore = result.hasMore;
    renderMessages({ preserveScroll: earlier });
  } catch (error) {
    elements.status.textContent = error.message || 'Could not load messages.';
  } finally {
    loading = false;
    renderState();
  }
}

function selectConversation(id) {
  if (selectedId === id) return;
  selectedId = id;
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
    elements.draft.value = '';
    elements.draft.dispatchEvent(new Event('input'));
    setTimeout(() => loadHistory({ quiet: true }), 400);
  } catch (error) {
    elements.status.textContent = error.message || 'Message was not sent.';
  } finally { elements.send.disabled = false; }
});

window.compusyncMessages.onState((next) => {
  state = next;
  renderState();
});

window.compusyncMessages.bootstrap().then((initial) => {
  state = initial;
  renderState();
  if (state.available) return refreshConversations();
}).catch((error) => { elements.status.textContent = error.message || 'Messages Companion could not start.'; });

setInterval(() => {
  if (selectedId && document.visibilityState === 'visible') void loadHistory({ quiet: true });
  else if (!state.available && document.visibilityState === 'visible') void refreshConversations();
}, 2000);
