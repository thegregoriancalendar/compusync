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

function invitation() {
  $('invitation').value = details.invitations.find((item) => item.host === $('address').value)?.code || '';
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
  const chosenAddress = $('address').value;
  $('address').replaceChildren(...next.invitations.map((item) => new Option(item.host === '127.0.0.1' ? '127.0.0.1 · No network found' : item.host, item.host)));
  if (next.invitations.some((item) => item.host === chosenAddress)) $('address').value = chosenAddress;
  invitation();
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
$('address').addEventListener('change', invitation);
$('copy').addEventListener('click', async () => {
  if (await command('copy', { host: $('address').value })) {
    $('copy-status').textContent = 'Copied';
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { $('copy-status').textContent = ''; }, 2000);
  }
});
$('join').addEventListener('click', async () => {
  $('join').disabled = true;
  await command('join', { invitation: $('join-code').value });
  $('join').disabled = false;
});
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
