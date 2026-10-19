'use strict';

const api = window.compusync;
const $ = (id) => document.getElementById(id);
let details;
let selectedTab = false;
let copyTimer;
let layoutDraft = { macPosition: 'left', displayOffset: 0 };
let layoutBaseRects = null;
let layoutRects = null;
let layoutDrag = null;
let layoutViewportDrag = null;
let layoutView = { zoom: 1, panX: 0, panY: 0 };
const volumeEdits = new Map();

const localCursorDefaults = {
  macPosition: 'left',
  displayOffset: 0,
  acceleration: { base: 1, threshold: 0.5, slope: 0.015 },
  edgeResistanceVU: 0,
  linked: true,
};

function diagramGroups(next) {
  const layouts = Object.values(next.state?.layouts || {});
  return window.CompuSyncScreenLayout.monitorGroups({
    mac: layouts.find((candidate) => candidate.platform === 'darwin'),
    windows: layouts.find((candidate) => candidate.platform === 'win32'),
  }, { mac: 1.55, windows: 1.7 });
}

function renderMonitorGroup(element, platform, group, computerName) {
  element.replaceChildren();
  const platformName = platform === 'mac' ? 'Mac' : 'Windows';
  const count = group.monitors.length;
  element.setAttribute('aria-label', `${platformName} computer with ${count} display${count === 1 ? '' : 's'}. Drag to arrange.`);
  for (const [index, monitor] of group.monitors.entries()) {
    const display = document.createElement('span');
    display.className = `layout-monitor${monitor.primary ? ' primary' : ''}`;
    display.style.left = `${monitor.x}px`;
    display.style.top = `${monitor.y}px`;
    display.style.width = `${monitor.w}px`;
    display.style.height = `${monitor.h}px`;
    display.title = `${platformName} display ${index + 1}${monitor.primary ? ' (primary)' : ''}`;
    const label = document.createElement('strong');
    label.textContent = count === 1 ? platformName : String(index + 1);
    display.append(label);
    if (platform === 'mac' && Math.abs(monitor.y) < .5) {
      const blocked = document.createElement('span');
      blocked.className = 'blocked-edge';
      blocked.setAttribute('aria-hidden', 'true');
      display.append(blocked);
    }
    element.append(display);
  }
  const label = document.createElement('span');
  label.className = 'layout-group-label';
  label.textContent = `${platformName}${computerName ? ` · ${computerName}` : ''} · ${count} display${count === 1 ? '' : 's'}`;
  element.append(label);
}

function renderScreenLayout(next = details) {
  if (!next || !window.CompuSyncScreenLayout || $('connection-page').hidden) return;
  const editor = $('screen-layout-editor');
  const groups = diagramGroups(next);
  layoutBaseRects = window.CompuSyncScreenLayout.arrangeDiagram(
    editor.clientWidth, editor.clientHeight, layoutDraft.macPosition, layoutDraft.displayOffset, groups,
  );
  layoutRects = Object.fromEntries(Object.entries(layoutBaseRects).map(([platform, rect]) => [
    platform,
    window.CompuSyncScreenLayout.viewportRect(rect, editor.clientWidth, editor.clientHeight, layoutView),
  ]));
  const gridSize = 18 * layoutView.zoom;
  const gridOrigin = window.CompuSyncScreenLayout.diagramToViewport(
    { x: 0, y: 0 }, editor.clientWidth, editor.clientHeight, layoutView,
  );
  editor.style.backgroundSize = `${gridSize}px ${gridSize}px`;
  editor.style.backgroundPosition = `${gridOrigin.x}px ${gridOrigin.y}px`;
  $('layout-zoom-level').textContent = `${Math.round(layoutView.zoom * 100)}%`;
  const peer = next.status?.peers?.[0];
  for (const [platform, id] of [['mac', 'layout-mac'], ['windows', 'layout-windows']]) {
    const rect = layoutRects[platform];
    const baseRect = layoutBaseRects[platform];
    const element = $(id);
    element.classList.toggle('label-above', layoutDraft.macPosition === 'top'
      ? platform === 'mac' : platform === 'windows');
    Object.assign(element.style, {
      left: `${rect.x}px`, top: `${rect.y}px`, width: `${baseRect.w}px`, height: `${baseRect.h}px`,
      transform: `scale(${layoutView.zoom})`, transformOrigin: 'top left',
    });
    const nativePlatform = platform === 'mac' ? 'darwin' : 'win32';
    const computerName = next.platform === nativePlatform ? next.name : peer?.name || '';
    renderMonitorGroup(element, platform, groups[platform], computerName);
  }
  $('layout-description').textContent = window.CompuSyncScreenLayout.arrangementText(layoutDraft.macPosition);
}

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

function showPage(page) {
  for (const name of ['connection', 'latency-monitor']) {
    const selected = name === page;
    $(`${name}-tab`).setAttribute('aria-selected', String(selected));
    $(`${name}-tab`).tabIndex = selected ? 0 : -1;
    $(`${name}-page`).hidden = !selected;
  }
  if (page === 'connection') renderScreenLayout();
}

function render(next) {
  details = next;
  const { status } = next;
  const connected = status.phase === 'connected';
  const cursorReady = connected && next.cursorLinkReady === true;
  const cursorPending = next.cursorLinkPending === true;
  const cursor = next.cursorSettings || localCursorDefaults;
  if (!layoutDrag) layoutDraft = { macPosition: cursor.macPosition, displayOffset: cursor.displayOffset };
  $('pairing-card').hidden = connected;
  $('status-dot').className = `dot ${status.phase}`;
  $('status').textContent = connected ? `Connected to ${status.peers[0]?.name || 'your other laptop'}` : {
    starting: 'Getting ready', hosting: 'Ready to pair', connecting: 'Connecting…', reconnecting: 'Waiting for your other laptop', error: 'Connection needs attention',
  }[status.phase] || 'Not connected';
  $('status-description').textContent = status.message || (connected ? 'Cursor and Chrome handoff are ready between your laptops.' : status.role === 'host' ? `${next.name} · Share the invitation below.` : 'Keep CompuSync open on the other laptop.');
  $('hosting').hidden = status.role !== 'host' || status.phase === 'error';
  $('create-host').hidden = !$('hosting').hidden;
  const code = next.invitation?.code || '';
  $('invitation').value = code;
  $('copy').disabled = !code;
  $('new-code').disabled = connected;
  $('code-status').textContent = connected
    ? 'Connected. This pairing is saved for next time.'
    : status.phase === 'reconnecting'
      ? 'Pairing saved. Waiting for the other laptop to reconnect.'
      : code ? '' : 'Code expired or used. Choose New code to pair again.';
  $('host-addresses').textContent = next.addresses.map((host) => `${host}:${next.port}`).join(' · ');
  $('discovery-error').textContent = next.invitation?.discoveryError || '';
  $('auto-launch').checked = next.autoLaunch;
  $('clipboard-sync').checked = next.clipboardSync !== false;
  renderAudio(next);
  renderMouseLatency(next);
  $('auto-launch').disabled = !next.packaged;
  $('launch-note').hidden = next.packaged;
  const update = next.update || {
    phase: 'disabled', currentVersion: '', canCheck: false, canRestart: false,
    message: 'Automatic updates are available in the installed Windows and macOS apps.',
  };
  $('update-status').textContent = update.message;
  $('update-check').disabled = !update.canCheck;
  $('update-install').hidden = !update.canRestart;
  $('app-version').textContent = update.currentVersion ? `Current version ${update.currentVersion}` : '';
  renderScreenLayout(next);
  setValueUnlessEditing('acceleration-base', cursor.acceleration.base);
  setValueUnlessEditing('acceleration-threshold', cursor.acceleration.threshold);
  setValueUnlessEditing('acceleration-slope', cursor.acceleration.slope);
  setValueUnlessEditing('edge-resistance', cursor.edgeResistanceVU);
  $('cursor-mode-status').textContent = cursor.linked ? 'Linked' : 'Unlinked';
  $('cursor-mode-status').className = `mode-badge${cursor.linked ? '' : ' unlinked'}`;
  $('cursor-mode').textContent = cursor.linked ? 'Unlink cursors' : cursorPending ? 'Linking…' : 'Link cursors';
  $('cursor-mode').disabled = !cursorReady || cursorPending;
  $('cursor-mode-description').textContent = !connected
    ? 'The saved pairing must reconnect before cursor linking is available.'
    : !cursorReady
      ? 'Cursor linking is unavailable. Review the notice above.'
      : cursorPending
        ? 'Waiting for the other laptop to enter shared-cursor mode.'
      : cursor.linked
        ? 'One cursor can move and type across both laptops.'
        : 'Each laptop currently has its own independent cursor.';
  $('toggle-ownership').disabled = !connected || !cursor.linked;
  renderNotices(next.notices);
  if (!selectedTab) tab(status.role === 'join');
}

function renderMouseLatency(next) {
  const latency = next.mouseLatency;
  const linked = next.status.phase === 'connected' && next.cursorSettings?.linked === true;
  const windows = next.platform === 'win32';
  const directions = {
    'mac-windows': windows ? latency?.incoming : latency?.outgoing,
    'windows-mac': windows ? latency?.outgoing : latency?.incoming,
  };
  const format = (value) => Number.isFinite(value) ? `~${value.toFixed(1)} ms` : '\u2014';
  for (const [direction, stats] of Object.entries(directions)) {
    const median = $(`latency-${direction}`);
    const p95 = $(`latency-${direction}-p95`);
    median.textContent = format(linked ? stats?.medianMs : null);
    p95.textContent = format(linked ? stats?.p95Ms : null);
    const title = linked && stats ? `${stats.samples} samples; clock uncertainty about \u00b1${stats.uncertaintyMs.toFixed(1)} ms.` : '';
    median.title = title;
    p95.title = title;
  }
  $('mouse-latency-status').textContent = !linked
    ? 'Connect both laptops and link cursors to measure.'
    : !latency || latency.calibrating
      ? 'Calibrating timing with the other laptop. Both laptops need the current build.'
      : 'Live while moving the other laptop\'s cursor. Readings clear after 10 seconds without samples.';
  $('mouse-latency-network').textContent = linked && Number.isFinite(latency?.networkRttMs)
    ? `Network round trip (best recent): ${latency.networkRttMs.toFixed(1)} ms.` : '';
}

function renderAudio(next) {
  const audio = next.audio;
  const windows = next.platform === 'win32';
  const active = audio?.active === true;
  $('audio-mode').textContent = active ? 'Shared playback' : 'Separate';
  $('audio-mode').className = `mode-badge${active ? '' : ' unlinked'}`;
  $('audio-status').textContent = audio?.message || 'Audio stays on each laptop.';
  $('audio-status').classList.toggle('audio-error-text', audio?.phase === 'error');
  const timing = audio?.timing;
  $('audio-timing').hidden = !active || !timing?.clockReady;
  $('audio-timing').textContent = timing?.clockReady
    ? `Buffered delay: ${Math.round(timing.delayMs)} ms · Clock uncertainty estimate: ±${Number(timing.uncertaintyMs).toFixed(2)} ms · Recoveries: ${timing.resyncs}`
    : '';
  $('audio-start').hidden = false;
  $('audio-start').textContent = `Play ${windows ? 'Windows' : 'Mac'} audio on both laptops`;
  $('audio-start').disabled = !audio?.canStart;
  $('audio-stop').disabled = !active;
  $('audio-windows-output').hidden = false;
  $('audio-windows-source').hidden = !windows;
  $('audio-source').disabled = active || !audio?.available;
  const buses = audio?.routing?.buses || [];
  $('audio-setup').hidden = !windows || buses.length > 0;
  const sources = [{ id: '', label: 'Detect standard VB-CABLE' }, ...buses];
  if (audio?.sourceId && !buses.some((bus) => bus.id === audio.sourceId)) sources.push({ id: audio.sourceId, label: 'Saved capture bus (unavailable)' });
  const sourceSignature = JSON.stringify(sources);
  if ($('audio-source').dataset.sources !== sourceSignature) {
    $('audio-source').replaceChildren(...sources.map((bus) => new Option(bus.label, bus.id)));
    $('audio-source').dataset.sources = sourceSignature;
  }
  $('audio-source').value = audio?.sourceId || '';
  $('audio-output').disabled = active || !audio?.available;
  $('audio-refresh').disabled = active || !audio?.available;
  const select = $('audio-output');
  const outputs = (audio?.outputs || []).filter((output) => !buses.some((bus) => bus.id === output.id));
  const options = [{ id: '', label: `${windows ? 'Windows' : 'Mac'} default output` }, ...outputs];
  if (audio?.outputId && !outputs.some((output) => output.id === audio.outputId)) {
    options.push({ id: audio.outputId, label: 'Saved output (refresh to check availability)' });
  }
  const signature = JSON.stringify(options);
  if (select.dataset.outputs !== signature) {
    select.replaceChildren(...options.map((output) => new Option(output.label, output.id)));
    select.dataset.outputs = signature;
  }
  select.value = audio?.outputId || '';
  for (const [device, platform] of [['mac', 'darwin'], ['windows', 'win32']]) {
    const slider = $(`audio-volume-${device}`);
    const volume = audio?.volumes?.[device];
    const available = Number.isInteger(volume?.level) && !volume.error;
    slider.disabled = !available;
    const edit = volumeEdits.get(device);
    if (!available && edit) {
      clearTimeout(edit.timer);
      volumeEdits.delete(device);
    }
    if (!available || !edit) {
      slider.value = available ? volume.level : 0;
      const value = available ? `${volume.muted ? 'Muted · ' : ''}${volume.level}%` : 'Unavailable';
      $(`audio-volume-${device}-value`).textContent = value;
      slider.setAttribute('aria-valuetext', value);
    }
    $(`audio-volume-${device}-status`).textContent = volume?.error || (available
      ? `${volume.label}${next.platform === platform ? ' · This laptop' : ''}`
      : next.platform === platform ? 'Reading output volume…'
        : next.status.phase === 'connected' ? 'Volume controls are unavailable on the other laptop.'
          : `Connect ${device === 'mac' ? 'the Mac' : 'Windows'} to adjust its volume.`);
  }
  $('audio-help').textContent = !audio?.available
    ? 'Rebuild the native addon on both laptops to enable audio routing.'
    : windows
      ? active ? 'Windows output is temporarily routed through VB-CABLE. Stop sharing to restore your previous outputs.'
        : audio.routing?.reason || 'Choose physical speakers or headphones. Apps must use System default in shared mode; close other monitors of VB-CABLE. Start here to share Windows audio.'
      : !audio.canCapture
        ? 'Mac audio capture requires macOS 14.6 or later.'
        : !audio.peerReady && next.status.phase === 'connected'
          ? 'The other laptop has not announced audio support. Run the same current build on both laptops.'
          : `Use built-in or wired speakers for the first test. Allow System Audio Recording for ${next.packaged ? 'CompuSync' : 'Electron or the terminal used to launch it'} when prompted. The Mac’s local sound is delayed so both laptops can follow the same schedule.`;
}

async function audioCommand(name, data) {
  $('audio-error').hidden = true;
  try {
    const result = await api.command(name, data);
    if (!result.ok) throw new Error(result.error);
  } catch (error) {
    $('audio-error').textContent = error.message;
    $('audio-error').hidden = false;
  }
}

function previewVolume(device, level) {
  const value = `${level}%`;
  $(`audio-volume-${device}-value`).textContent = value;
  $(`audio-volume-${device}`).setAttribute('aria-valuetext', value);
}

async function sendVolume(device) {
  const edit = volumeEdits.get(device);
  if (!edit || edit.sending) return;
  clearTimeout(edit.timer);
  edit.sending = true;
  const level = edit.level;
  await audioCommand('audio-volume', { platform: device === 'mac' ? 'darwin' : 'win32', level });
  if (volumeEdits.get(device) !== edit) return;
  edit.sending = false;
  if (edit.level !== level) { void sendVolume(device); return; }
  volumeEdits.delete(device);
  if (details) renderAudio(details);
}

function cursorSettingsFromForm() {
  return {
    macPosition: layoutDraft.macPosition,
    displayOffset: layoutDraft.displayOffset,
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
    autoLaunch: $('auto-launch').checked,
    clipboardSync: $('clipboard-sync').checked,
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

for (const name of ['connection', 'latency-monitor']) {
  const button = $(`${name}-tab`);
  button.addEventListener('click', () => showPage(name));
  button.addEventListener('keydown', (event) => {
    let page;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      page = name === 'connection' ? 'latency-monitor' : 'connection';
    } else if (event.key === 'Home') page = 'connection';
    else if (event.key === 'End') page = 'latency-monitor';
    else return;
    event.preventDefault();
    showPage(page);
    $(`${page}-tab`).focus();
  });
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
  'auto-launch', 'clipboard-sync',
  'acceleration-base', 'acceleration-threshold', 'acceleration-slope', 'edge-resistance',
]) $(id).addEventListener('change', savePreferences);

for (const [id, platform] of [['layout-mac', 'mac'], ['layout-windows', 'windows']]) {
  const screen = $(id);
  screen.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !layoutBaseRects) return;
    const editor = $('screen-layout-editor');
    const editorBounds = editor.getBoundingClientRect();
    const point = window.CompuSyncScreenLayout.viewportToDiagram({
      x: event.clientX - editorBounds.left - editor.clientLeft,
      y: event.clientY - editorBounds.top - editor.clientTop,
    }, editor.clientWidth, editor.clientHeight, layoutView);
    const rect = layoutBaseRects[platform];
    layoutDrag = {
      platform,
      pointerId: event.pointerId,
      offsetX: point.x - rect.x - rect.w / 2,
      offsetY: point.y - rect.y - rect.h / 2,
    };
    screen.classList.add('dragging');
    screen.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  screen.addEventListener('pointermove', (event) => {
    if (!layoutDrag || layoutDrag.platform !== platform || layoutDrag.pointerId !== event.pointerId) return;
    const editor = $('screen-layout-editor');
    const bounds = editor.getBoundingClientRect();
    const point = window.CompuSyncScreenLayout.viewportToDiagram({
      x: event.clientX - bounds.left - editor.clientLeft,
      y: event.clientY - bounds.top - editor.clientTop,
    }, editor.clientWidth, editor.clientHeight, layoutView);
    const snapped = window.CompuSyncScreenLayout.snapDragged(platform, {
      x: point.x - layoutDrag.offsetX,
      y: point.y - layoutDrag.offsetY,
    }, layoutBaseRects);
    if (!snapped) return;
    layoutDraft = snapped;
    renderScreenLayout();
  });
  const finishDrag = (event) => {
    if (!layoutDrag || layoutDrag.platform !== platform || layoutDrag.pointerId !== event.pointerId) return;
    screen.classList.remove('dragging');
    layoutDrag = null;
    void savePreferences();
  };
  screen.addEventListener('pointerup', finishDrag);
  screen.addEventListener('pointercancel', finishDrag);
  screen.addEventListener('keydown', (event) => {
    const positions = platform === 'mac'
      ? { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'top' }
      : { ArrowLeft: 'right', ArrowRight: 'left', ArrowDown: 'top' };
    if (!positions[event.key]) return;
    layoutDraft = { macPosition: positions[event.key], displayOffset: 0 };
    renderScreenLayout();
    void savePreferences();
    event.preventDefault();
  });
}

const layoutEditor = $('screen-layout-editor');
layoutEditor.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target !== layoutEditor) return;
  layoutViewportDrag = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    panX: layoutView.panX,
    panY: layoutView.panY,
  };
  layoutEditor.classList.add('panning');
  layoutEditor.setPointerCapture(event.pointerId);
  event.preventDefault();
});
layoutEditor.addEventListener('pointermove', (event) => {
  if (!layoutViewportDrag || layoutViewportDrag.pointerId !== event.pointerId) return;
  layoutView = {
    ...layoutView,
    panX: layoutViewportDrag.panX + event.clientX - layoutViewportDrag.x,
    panY: layoutViewportDrag.panY + event.clientY - layoutViewportDrag.y,
  };
  renderScreenLayout();
});
const finishViewportDrag = (event) => {
  if (!layoutViewportDrag || layoutViewportDrag.pointerId !== event.pointerId) return;
  layoutViewportDrag = null;
  layoutEditor.classList.remove('panning');
};
layoutEditor.addEventListener('pointerup', finishViewportDrag);
layoutEditor.addEventListener('pointercancel', finishViewportDrag);
layoutEditor.addEventListener('wheel', (event) => {
  const bounds = layoutEditor.getBoundingClientRect();
  const factor = Math.exp(-event.deltaY * .0015);
  layoutView = window.CompuSyncScreenLayout.zoomViewAt(layoutView, layoutView.zoom * factor, {
    x: event.clientX - bounds.left - layoutEditor.clientLeft,
    y: event.clientY - bounds.top - layoutEditor.clientTop,
  }, layoutEditor.clientWidth, layoutEditor.clientHeight);
  renderScreenLayout();
  event.preventDefault();
}, { passive: false });

function zoomLayout(factor) {
  layoutView = window.CompuSyncScreenLayout.zoomViewAt(
    layoutView, layoutView.zoom * factor, null, layoutEditor.clientWidth, layoutEditor.clientHeight,
  );
  renderScreenLayout();
}
$('layout-zoom-out').addEventListener('click', () => zoomLayout(1 / 1.2));
$('layout-zoom-in').addEventListener('click', () => zoomLayout(1.2));
$('layout-zoom-fit').addEventListener('click', () => {
  layoutView = { zoom: 1, panX: 0, panY: 0 };
  renderScreenLayout();
});
window.addEventListener('resize', () => renderScreenLayout());
$('cursor-mode').addEventListener('click', () => command(details?.cursorSettings?.linked === false ? 'cursor-link' : 'cursor-unlink'));
$('toggle-ownership').addEventListener('click', () => command('cursor-toggle-ownership'));
$('update-check').addEventListener('click', () => command('update-check'));
$('update-install').addEventListener('click', () => command('update-install'));
$('audio-source').addEventListener('change', () => audioCommand('audio-source', { id: $('audio-source').value }));
$('audio-setup').addEventListener('click', () => audioCommand('audio-setup'));
$('audio-start').addEventListener('click', () => audioCommand('audio-start'));
$('audio-stop').addEventListener('click', () => audioCommand('audio-stop'));
$('audio-refresh').addEventListener('click', () => audioCommand('audio-outputs'));
$('audio-output').addEventListener('change', () => audioCommand('audio-output', { id: $('audio-output').value }));
for (const device of ['mac', 'windows']) {
  const slider = $(`audio-volume-${device}`);
  slider.addEventListener('input', () => {
    const edit = volumeEdits.get(device) || { sending: false };
    clearTimeout(edit.timer);
    edit.level = Number(slider.value);
    volumeEdits.set(device, edit);
    previewVolume(device, edit.level);
    edit.timer = setTimeout(() => void sendVolume(device), 80);
  });
  slider.addEventListener('change', () => void sendVolume(device));
}
if (/Mac/.test(navigator.platform)) for (const id of ['shortcut', 'unlink-shortcut', 'ownership-shortcut']) $(id).textContent = '⌘';
api.onDetails(render);
api.bootstrap().then(render);
