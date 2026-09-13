'use strict';

const { execFile } = require('node:child_process');

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SCRIPT = String.raw`
function stringValue(value) {
  try { return value == null ? '' : String(value); } catch (_) { return ''; }
}

function participantValue(person) {
  var id = '', name = '', handle = '';
  try { id = stringValue(person.id()); } catch (_) {}
  try { name = stringValue(person.fullName()); } catch (_) {}
  try { handle = stringValue(person.handle()); } catch (_) {}
  if (!name) name = handle;
  return { id: id || handle, name: name, handle: handle };
}

function run(argv) {
  if (argv.length !== 2) throw new Error('Invalid Messages bridge request.');
  var operation = argv[0];
  var payload = JSON.parse(argv[1]);
  var messages = Application('Messages');

  if (operation === 'listConversations') {
    return JSON.stringify(messages.chats().slice(0, 500).map(function (chat) {
      var id = '', name = '', service = 'unknown', participants = [];
      try { id = stringValue(chat.id()); } catch (_) {}
      try { name = stringValue(chat.name()); } catch (_) {}
      try { participants = chat.participants().slice(0, 64).map(participantValue); } catch (_) {}
      try {
        var rawService = stringValue(chat.account().serviceType());
        if (/imessage/i.test(rawService)) service = 'iMessage';
        else if (/rcs/i.test(rawService)) service = 'RCS';
        else if (/sms/i.test(rawService)) service = 'SMS';
      } catch (_) {}
      if (!name) name = participants.map(function (person) { return person.name || person.handle; }).filter(Boolean).join(', ');
      return { id: id, name: name, service: service, participants: participants };
    }).filter(function (chat) { return Boolean(chat.id); }));
  }

  if (operation === 'sendText') {
    var selected = messages.chats().filter(function (chat) {
      try { return stringValue(chat.id()) === payload.conversationId; } catch (_) { return false; }
    });
    if (!selected.length) throw new Error('Conversation is no longer available.');
    messages.send(payload.text, { to: selected[0] });
    return JSON.stringify({ accepted: true, clientId: payload.clientId });
  }

  throw new Error('Unsupported Messages bridge operation.');
}
`;

function defaultExecutor(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout, stderr });
    });
  });
}

class MessagesAutomation {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.execute = options.execute || defaultExecutor;
    this.timeoutMs = options.timeoutMs || 10_000;
  }

  async invoke(operation, payload = {}) {
    if (this.platform !== 'darwin') {
      const error = new Error('Messages automation is only available on macOS.');
      error.code = 'MESSAGES_UNAVAILABLE';
      throw error;
    }
    const { stdout } = await this.execute('/usr/bin/osascript', [
      '-l', 'JavaScript', '-e', SCRIPT, '--', operation, JSON.stringify(payload),
    ], { timeout: this.timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true });
    try { return JSON.parse(String(stdout).trim()); }
    catch {
      const error = new Error('Messages returned an invalid automation response.');
      error.code = 'MESSAGES_INVALID_RESPONSE';
      throw error;
    }
  }

  listConversations() { return this.invoke('listConversations'); }
  sendText(payload) { return this.invoke('sendText', payload); }
}

module.exports = { MessagesAutomation, SCRIPT, MAX_OUTPUT_BYTES };
