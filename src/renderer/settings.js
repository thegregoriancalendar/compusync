'use strict';

const api = window.compusync;
const $ = (id) => document.getElementById(id);
let details;
let selectedTab = false;
let copyTimer;

const localCursorDefaults = {
  screenSide: /Mac/.test(navigator.platform) ? 'left' : 'right',
  verticalOffsetVU: 0,
  acceleration: { base: 1, threshold: 0.5, slope: 0.015 },
  edgeResistanceVU: 0,
  linked: true,
};

function setValueUnlessEditing(id, value) {
  const field = $(id);
  if (document.activeElement !== field) field.value = String(value);
}

function renderNotices(notices = []) {
  const container = $('notices');
  container.replaceChildren();
  for (const notice of notices) {
    if (!notice || typeof notice.id !== 'string') continue;
    const article = document.createElement('article');
    article.className = `notice ${notice.kind === 'permission' ? 'permission' : ''}`;
    const title = document.createElement('strong');
    title.textContent = notice.title || 'CompuSync needs attention';
    const message = document.createElement('p');
    message.textContent = notice.message || '';
    article.append(title, message);
    if (notice.actionLabel) {
      const action = document.createElement('button');
      action.className = 'notice-action';
      action.textContent = notice.actionLabel;
      action.addEventListener('click', () => command('notice-action', { id: notice.id, action: notice.action }));
      article.append(action);
    }
    if (notice.dismissible !== false) {
      const dismiss = document.createElement('button');
      dismiss.className = 'notice-dismiss';
      dismiss.setAttribute('aria-label', `Dismiss ${notice.title || 'notice'}`);
      dismiss.textContent = '×';
      dismiss.addEventListener('click', () => command('dismiss-notice', { id: notice.id }));
      article.append(dismiss);
    }
    container.append(article);
  }
  container.hidden = !container.childElementCount;
}

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
  const cursor = next.cursorSettings || localCursorDefaults;
  $('status-dot').className = `dot ${status.phase}`;
  $('status').textContent = connected ? `Connected to ${status.peers[0]?.name || 'your other laptop'}` : {
    starting: 'Getting ready', hosting: 'Ready to pair', connecting: 'Connecting…', reconnecting: 'Waiting for your other laptop', error: 'Connection needs attention',
  }[status.phase] || 'Not connected';
  $('status-description').textContent = status.message || (connected ? 'One logical window is shared across the display seam.' : status.role === 'host' ? `${next.name} · Share the invitation below.` : 'Keep CompuSync open on the other laptop.');
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
  $('place-here').disabled = !next.state?.layouts?.[next.id];
  $('screen-side').value = cursor.screenSide;
  setValueUnlessEditing('vertical-offset', cursor.verticalOffsetVU);
  setValueUnlessEditing('acceleration-base', cursor.acceleration.base);
  setValueUnlessEditing('acceleration-threshold', cursor.acceleration.threshold);
  setValueUnlessEditing('acceleration-slope', cursor.acceleration.slope);
  setValueUnlessEditing('edge-resistance', cursor.edgeResistanceVU);
  $('cursor-mode-status').textContent = cursor.linked ? 'Linked' : 'Unlinked';
  $('cursor-mode-status').className = `mode-badge${cursor.linked ? '' : ' unlinked'}`;
  $('cursor-mode').textContent = cursor.linked ? 'Unlink cursors' : 'Link cursors';
  $('cursor-mode-description').textContent = cursor.linked
    ? 'One cursor can move and type across both laptops.'
    : 'Each laptop currently has its own independent cursor.';
  $('toggle-ownership').disabled = !connected || !cursor.linked;
  renderNotices(next.notices);
  if (!selectedTab) tab(status.role === 'join');
}

function cursorSettingsFromForm() {
  return {
    screenSide: $('screen-side').value,
    verticalOffsetVU: Number($('vertical-offset').value),
    acceleration: {
      base: Number($('acceleration-base').value),
      threshold: Number($('acceleration-threshold').value),
      slope: Number($('acceleration-slope').value),
    },
    edgeResistanceVU: Number($('edge-resistance').value),
    linked: details?.cursorSettings?.linked !== false,
  };
}

function savePreferences() {
  return command('preferences', {
    edge: $('edge').value,
    autoLaunch: $('auto-launch').checked,
    cursorSettings: cursorSettingsFromForm(),
  });
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
for (const id of [
  'edge', 'auto-launch', 'screen-side', 'vertical-offset',
  'acceleration-base', 'acceleration-threshold', 'acceleration-slope', 'edge-resistance',
]) $(id).addEventListener('change', savePreferences);
$('cursor-mode').addEventListener('click', () => command(details?.cursorSettings?.linked === false ? 'cursor-link' : 'cursor-unlink'));
$('toggle-ownership').addEventListener('click', () => command('cursor-toggle-ownership'));
for (const id of ['open', 'place-here', 'close']) $(id).addEventListener('click', () => command(id));
if (/Mac/.test(navigator.platform)) for (const id of ['shortcut', 'unlink-shortcut', 'ownership-shortcut']) $(id).textContent = '⌘';
api.onDetails(render);
api.bootstrap().then(render);
