'use strict';

const api = window.compusync;
const $ = (id) => document.getElementById(id);
let details;
let selectedTab = false;
let copyTimer;

function tab(join) {
  selectedTab = true;
  $('share-tab').setAttribute('aria-selected', String(!join));
  $('join-tab').setAttribute('aria-selected', String(join));
  $('share-panel').hidden = join;
  $('join-panel').hidden = !join;
}

function render(next) {
  details = next;
  const { status } = next;
  const connected = status.phase === 'connected';
  $('status-dot').className = `dot ${status.phase}`;
  $('status').textContent = connected ? `Connected to ${status.peers[0]?.name || 'your other laptop'}` : {
    starting: 'Getting ready', hosting: 'Ready to pair', connecting: 'Connecting…', reconnecting: 'Waiting for your other laptop', error: 'Connection needs attention',
  }[status.phase] || 'Not connected';
  $('status-description').textContent = status.message || (connected ? 'Your window and cursor are shared live.' : status.role === 'host' ? `${next.name} · Share the invitation below.` : 'Keep CompuSync open on the other laptop.');
  $('hosting').hidden = status.role !== 'host' || status.phase === 'error';
  $('create-host').hidden = !$('hosting').hidden;
  const code = next.invitation?.code || '';
  $('invitation').value = code;
  $('copy').disabled = !code;
  $('new-code').disabled = connected;
  $('code-status').textContent = connected ? 'Paired. This connection is saved for next time.' : code ? '' : 'Code expired or used. Choose New code to pair again.';
  $('host-addresses').textContent = next.addresses.map((host) => `${host}:${next.port}`).join(' · ');
  $('discovery-error').textContent = next.invitation?.discoveryError || '';
  $('edge').value = next.edge;
  $('auto-launch').checked = next.autoLaunch;
  $('auto-launch').disabled = !next.packaged;
  $('launch-note').hidden = next.packaged;
  $('send').disabled = !connected || !next.state?.open;
  if (!selectedTab) tab(status.role === 'join');
}

async function command(name, data) {
  $('error').hidden = true;
  try {
    const result = await api.command(name, data);
    if (!result.ok) throw new Error(result.error);
    return true;
  } catch (error) {
    $('error').textContent = error.message;
    $('error').hidden = false;
    return false;
  }
}

$('share-tab').addEventListener('click', () => tab(false));
$('join-tab').addEventListener('click', () => tab(true));
for (const id of ['share-tab', 'join-tab']) $(id).addEventListener('keydown', (event) => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { const join = id === 'share-tab'; tab(join); $(join ? 'join-tab' : 'share-tab').focus(); }
});
$('new-code').addEventListener('click', () => command('new-code'));
$('copy').addEventListener('click', async () => {
  if (await command('copy')) {
    $('copy-status').textContent = 'Copied';
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { $('copy-status').textContent = ''; }, 2000);
  }
});
$('join').addEventListener('click', async () => {
  $('join').disabled = true;
  $('join').textContent = 'Finding laptop…';
  await command('join', { invitation: $('join-code').value, address: $('join-address').value, port: $('join-port').value });
  $('join').disabled = false;
  $('join').textContent = 'Connect laptops';
});
$('join-code').addEventListener('input', () => {
  const field = $('join-code');
  const before = field.value.slice(0, field.selectionStart).replace(/[^a-z0-9]/gi, '').length;
  const characters = field.value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 8);
  field.value = characters.slice(0, 4) + (characters.length > 4 ? '-' + characters.slice(4) : '');
  const caret = Math.min(field.value.length, before + (before > 4 ? 1 : 0));
  field.setSelectionRange(caret, caret);
});
$('join-code').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !$('join').disabled) $('join').click(); });
$('host').addEventListener('click', async () => {
  $('host').disabled = true;
  await command('host', { port: $('port').value });
  $('host').disabled = false;
});
for (const id of ['edge', 'auto-launch']) $(id).addEventListener('change', () => command('preferences', { edge: $('edge').value, autoLaunch: $('auto-launch').checked }));
for (const id of ['open', 'show', 'close']) $(id).addEventListener('click', () => command(id));
$('send').addEventListener('click', () => command('handoff'));
if (/Mac/.test(navigator.platform)) $('shortcut').textContent = '⌘';
api.onDetails(render);
api.bootstrap().then(render);
