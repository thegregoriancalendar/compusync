'use strict';

const api = window.compusyncEditor;
const title = document.getElementById('title');
const text = document.getElementById('text');
const saveButton = document.getElementById('save');
const status = document.getElementById('status');
let programId;
let savedText = '';
let saving = false;

function setStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}

function updateDirtyState() {
  if (saving || !programId) return;
  const dirty = text.value !== savedText;
  saveButton.disabled = !dirty;
  setStatus(dirty ? 'Unsaved changes' : 'Saved');
}

async function save() {
  if (!programId || saving || text.value === savedText) return;
  saving = true;
  saveButton.disabled = true;
  setStatus('Saving…');
  const pendingText = text.value;
  try {
    const result = await api.save(pendingText);
    if (!result?.ok) throw new Error(result?.error || 'Could not save this document.');
    savedText = pendingText;
    setStatus(text.value === savedText ? 'Saved' : 'Saved; newer changes pending');
  } catch (error) {
    setStatus(error.message || 'Could not save this document.', true);
  } finally {
    saving = false;
    saveButton.disabled = text.value === savedText;
  }
}

text.addEventListener('input', updateDirtyState);
saveButton.addEventListener('click', save);
document.addEventListener('keydown', (event) => {
  if ((event.controlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    save();
  }
});

api.bootstrap().then((details) => {
  programId = details.programId;
  title.textContent = details.title;
  document.title = `${details.title} · Text Editor`;
  savedText = details.text;
  text.value = details.text;
  text.disabled = false;
  saveButton.disabled = true;
  setStatus('Saved');
  text.focus();
}).catch(() => {
  title.textContent = 'Unable to open document';
  setStatus('The document could not be loaded.', true);
});
