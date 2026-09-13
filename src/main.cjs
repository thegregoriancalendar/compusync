'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, clipboard, dialog, screen, safeStorage, shell, systemPreferences, globalShortcut, powerMonitor, session: electronSession } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { Session } = require('./core/session.cjs');
const { newSecret, parseInvitation } = require('./core/wire.cjs');
const { pairWithCode } = require('./core/pairing.cjs');
const { EDGES } = require('./core/state.cjs');
const { cursorSettingsFromSaved, validateCursorSettings } = require('./core/cursor-preferences.cjs');
const { SharedInputRuntime } = require('./main/runtime.cjs');
const { WindowHandoffRuntime } = require('./main/window-runtime.cjs');
const { SeamOverlay } = require('./main/seam-overlay.cjs');
const { ChromeAdapterRuntime } = require('./main/adapters/chrome/runtime.cjs');
const { createUpdateService } = require('./main/updates.cjs');
const { createNativeAdapter } = require('../native/index.cjs');
const { autoUpdater } = require('electron-updater');

if (process.env.COMPUSYNC_PROFILE) {
  const profile = path.resolve(process.env.COMPUSYNC_PROFILE);
  fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
}
app.setName('CompuSync');
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();

let settings, tray, sync, inputRuntime, windowRuntime, seamOverlay, nativeInput, updateService, config;
let quitting = false;
let changingSession = false;
let backgroundLaunch = false;
let pendingActivation = false;
let layoutRevision = 0;
let layoutTimer;
let lastInputRuntimeError = null;
const notices = new Map();
const rendererPath = (file) => path.join(__dirname, 'renderer', file);
const configPath = () => path.join(app.getPath('userData'), 'settings.json');

const applicationLogger = {
  info(event, details) {
    // Chrome producers report only the active hostname and tab count. Drag
    // records are separately allow-listed at the runtime boundary.
    const safe = String(event).startsWith('chrome.') ? {
      id: typeof details?.id === 'string' ? details.id.slice(0, 160) : null,
      host: typeof details?.host === 'string' ? details.host.slice(0, 253) : '',
      tabCount: Number.isSafeInteger(details?.tabCount) ? details.tabCount : 0,
    } : details;
    console.info(JSON.stringify({ scope: 'window-handoff', event, ...safe }));
  },
  warn(event, details) { this.info(event, details); },
};

function readConfig() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch { saved = {}; }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
  if (saved.encryptedSecret) {
    try {
      saved.secret = safeStorage.decryptString(Buffer.from(saved.encryptedSecret, 'base64'));
    } catch (error) {
      // A keychain/key-store reset can make only the secret unreadable. Keep
      // identity and preferences instead of silently resetting the profile.
      console.warn('CompuSync could not decrypt the saved pairing secret:', error?.message || error);
      delete saved.secret;
    }
  }
  return {
    id: saved.id || randomUUID(), name: saved.name || os.hostname(),
    role: saved.role === 'join' ? 'join' : 'host', host: saved.host || '',
    port: Number(process.env.COMPUSYNC_PORT ?? saved.port ?? 43187),
    secret: saved.secret || newSecret(), edge: saved.edge || 'right',
    autoLaunch: Boolean(saved.autoLaunch), firstRun: !saved.id,
    cursorSettings: cursorSettingsFromSaved(saved.cursorSettings),
    dismissedNotices: Array.isArray(saved.dismissedNotices)
      ? saved.dismissedNotices.filter((id) => typeof id === 'string' && id.length <= 100).slice(0, 100) : [],
    bindHost: process.env.COMPUSYNC_BIND_HOST || undefined,
  };
}

function saveConfig() {
  const saved = { ...config, firstRun: false };
  delete saved.bindHost;
  if (safeStorage.isEncryptionAvailable()) {
    saved.encryptedSecret = safeStorage.encryptString(config.secret).toString('base64');
    delete saved.secret;
  }
  const destination = configPath();
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(saved, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('CompuSync could not remove a temporary settings file:', error?.message || error);
    }
  }
}

function addresses() {
  return [...new Set(Object.values(os.networkInterfaces()).flat().filter((entry) => entry && entry.family === 'IPv4' && !entry.internal).map((entry) => entry.address))];
}

function selectedDisplay() {
  return screen.getPrimaryDisplay();
}

function localLayout() {
  const active = selectedDisplay();
  const primary = screen.getPrimaryDisplay();
  const displays = screen.getAllDisplays().slice(0, 8).map((display) => ({
    id: String(display.id),
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
    primary: display.id === primary.id,
  }));
  let desktop;
  try {
    const nativeSpace = nativeInput?.coordinateSpace?.();
    const scale = Number(primary.scaleFactor);
    if (nativeSpace && Number.isFinite(scale) && scale > 0) desktop = {
      widthVU: nativeSpace.width * nativeSpace.scale / scale,
      heightVU: nativeSpace.height * nativeSpace.scale / scale,
      scale,
    };
  } catch { /* Native-unavailable development builds keep the Electron layout. */ }
  return {
    revision: ++layoutRevision, edge: config.edge, activeDisplayId: String(active.id), displays,
    ...(desktop ? { desktop } : {}),
  };
}

function scheduleLayoutUpdate() {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => {
    if (!sync || sync.stopped) return;
    sync.action({ type: 'layout', layout: localLayout() });
  }, 100);
}

function handleDisplayChange() {
  try { nativeInput?.refreshCoordinateSpace?.(); }
  catch (error) { inputRuntime?.watchdog?.trigger?.('display-metrics-failed', error); }
  scheduleLayoutUpdate();
}

function details() {
  const ips = addresses();
  return {
    id: config.id, name: config.name, edge: config.edge, autoLaunch: config.autoLaunch,
    cursorSettings: {
      ...config.cursorSettings,
      linked: inputRuntime ? inputRuntime.cursor.linked : false,
    },
    cursorLinkReady: Boolean(inputRuntime?.native?.available
      && inputRuntime.peerConnected && inputRuntime.cursor.placements.length === 2),
    notices: [...notices.values()].filter((notice) => !config.dismissedNotices.includes(notice.id)),
    update: updateService?.status() || null,
    packaged: app.isPackaged,
    status: sync?.status() || { role: config.role, phase: 'starting', peers: [] },
    invitation: config.role === 'host' ? sync?.invitation() : null,
    addresses: ips.length ? ips : ['127.0.0.1'],
    host: config.host, port: sync?.port || config.port,
    state: sync?.state,
    clockOffsetMs: sync?.clockOffsetMs || 0,
  };
}

function addNotice(notice) {
  if (!notice?.id || typeof notice.message !== 'string') return;
  notices.set(notice.id, notice);
  refreshStatus();
}

function dismissNotice(id) {
  if (typeof id !== 'string' || !notices.has(id)) return false;
  if (!config.dismissedNotices.includes(id)) config.dismissedNotices.push(id);
  saveConfig();
  refreshStatus();
  return true;
}

function send(window, channel, value) {
  if (window && !window.isDestroyed() && !window.webContents.isLoading()) window.webContents.send(channel, value);
}

function refreshStatus() {
  send(settings, 'sync:details', details());
  updateMenu();
}

function webPreferences() {
  return { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true };
}

function secureWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

function cancelOwnedDrag() {
  const drag = sync?.state.drag;
  if (drag?.owner === config.id) sync.action({ type: 'drag-cancel', id: drag.id });
}

function applyState(state) {
  // The retired shared surface is no longer created. Settings still needs
  // placement changes so connection and cursor controls stay current.
  const placement = `${state.open}:${state.window.rect.x}:${state.window.rect.y}:${state.layouts[config.id]?.revision || 0}`;
  if (placement !== applyState.lastPlacement) {
    applyState.lastOpen = state.open;
    applyState.lastPlacement = placement;
    send(settings, 'sync:details', details());
    updateMenu();
  }
}

function showSettings() {
  if (settings && !settings.isDestroyed()) { if (settings.isMinimized()) settings.restore(); settings.show(); settings.focus(); return; }
  settings = new BrowserWindow({ width: 580, height: 780, minWidth: 500, minHeight: 600, title: 'CompuSync · Connection', backgroundColor: '#f6f7f9', show: false, autoHideMenuBar: true, webPreferences: webPreferences() });
  const window = settings;
  window.once('ready-to-show', () => { if (!window.isDestroyed()) { window.show(); window.focus(); } });
  settings.setMenuBarVisibility(false);
  secureWindow(settings);
  settings.loadFile(rendererPath('settings.html'));
  settings.on('closed', () => { settings = null; });
}

function showMessageBox(options) {
  return settings && !settings.isDestroyed()
    ? dialog.showMessageBox(settings, options)
    : dialog.showMessageBox(options);
}

// A foreground launch is also the entry point to pairing, even with a saved
// profile or an app that was left running in the tray. Login launches stay quiet.
function activateApp() {
  if (!sync) { pendingActivation = true; return; }
  pendingActivation = false;
  showSettings();
}

function menuTemplate() {
  const cursorReady = Boolean(inputRuntime?.native?.available
    && inputRuntime.peerConnected && inputRuntime.cursor.placements.length === 2);
  return [
    { label: sync?.phase === 'connected' ? `Connected to ${sync.status().peers[0]?.name || 'laptop'}` : 'CompuSync · Waiting for connection', enabled: false },
    { type: 'separator' },
    {
      label: inputRuntime?.cursor.linked ? 'Unlink cursors' : 'Link cursors',
      enabled: cursorReady,
      click: () => inputRuntime?.setLinked(!inputRuntime.cursor.linked, 'menu'),
    },
    { label: 'Move cursor to other laptop', enabled: Boolean(cursorReady && inputRuntime?.cursor.linked), click: () => inputRuntime?.cursor.toggleOwnership() },
    { type: 'separator' },
    { label: 'Connection & settings…', accelerator: 'CmdOrCtrl+,', click: showSettings },
    { type: 'separator' },
    { label: 'Quit on this laptop', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
  ];
}

function updateMenu() {
  if (!sync) return;
  tray?.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
  tray?.setToolTip(sync.phase === 'connected' ? 'CompuSync · Connected' : 'CompuSync · Waiting for connection');
  if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'CompuSync', submenu: menuTemplate() },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
  ]));
}

function createTray() {
  // A code-native bitmap keeps the app independent of external image assets.
  const pixels = Buffer.alloc(20 * 20 * 4);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
    const border = x >= 2 && x <= 17 && y >= 3 && y <= 16 && (x <= 3 || x >= 16 || y <= 4 || y >= 15);
    const split = x === 9 && y >= 5 && y <= 14;
    if (border || split) { const i = (y * 20 + x) * 4; pixels[i] = 180; pixels[i + 1] = 130; pixels[i + 2] = 80; pixels[i + 3] = 255; }
  }
  const icon = nativeImage.createFromBitmap(pixels, { width: 20, height: 20, scaleFactor: 1 });
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.on('double-click', activateApp);
  if (process.platform !== 'darwin') tray.on('click', activateApp);
  updateMenu();
}

function ensureInputRuntime() {
  if (inputRuntime || !sync || sync.phase !== 'connected' || sync.members.length !== 2) return inputRuntime;
  const peer = sync.members.find((member) => member.id !== config.id);
  if (!peer) return null;
  const hostId = config.role === 'host' ? config.id : peer.id;
  let startingInputRuntime = null;
  try {
    startingInputRuntime = new SharedInputRuntime({
      session: sync,
      native: nativeInput,
      machineId: config.id,
      hostId,
      peerId: peer.id,
      settings: config.cursorSettings,
      layouts: sync.state.layouts,
      globalShortcut,
      powerMonitor,
      logger: applicationLogger,
      onLayoutNeeded: scheduleLayoutUpdate,
      onNotice: addNotice,
      onModeChange: (linked, reason) => {
        config.cursorSettings.linked = linked;
        if (linked) {
          notices.delete('cursor-recovered');
          notices.delete('input-runtime-error');
          lastInputRuntimeError = null;
        } else if (reason && reason !== 'user') {
          addNotice({
            id: 'cursor-recovered', kind: 'warning', title: 'Cursors unlinked for safety',
            message: `Compusync restored local input after ${reason}. Link again when both laptops are ready.`,
            dismissible: true,
          });
        }
        saveConfig();
        refreshStatus();
      },
    });
    inputRuntime = startingInputRuntime;
    inputRuntime.start();
    const chrome = new ChromeAdapterRuntime({
      native: nativeInput,
      machineId: config.id,
      getPlacement: () => inputRuntime?.cursor.placementFor(config.id),
      store: {
        get: (key) => config[key],
        set: async (key, value) => { config[key] = value; saveConfig(); },
      },
      requestAutomation: async () => {
        const result = await showMessageBox({
          type: 'info', buttons: ['Continue', 'Cancel'], defaultId: 0, cancelId: 1,
          title: 'Allow Chrome Automation',
          message: 'Compusync needs macOS Automation access for this Chrome handoff.',
          detail: 'macOS will ask you to allow Compusync to read and recreate this window’s tabs.',
        });
        return result.response === 0;
      },
      requestRelaunch: async (offer) => {
        if (!offer) return false;
        const result = await showMessageBox({
          type: 'question', buttons: [offer.confirmLabel || 'Restart Chrome', offer.cancelLabel || 'Not now'],
          defaultId: 0, cancelId: 1, title: offer.title,
          message: offer.message, detail: offer.detail || '',
        });
        return result.response === 0;
      },
      onNotice: addNotice,
      logger: applicationLogger,
    });
    windowRuntime = new WindowHandoffRuntime({
      input: inputRuntime,
      native: nativeInput,
      chrome,
      onNotice: addNotice,
      setBusy: () => {},
      setSeam: (state) => seamOverlay?.update(state, config.id),
      showHint: (message) => seamOverlay?.showHint(message),
      logger: applicationLogger,
    });
    windowRuntime.start();
    lastInputRuntimeError = null;
    notices.delete('input-runtime-error');
  } catch (error) {
    void windowRuntime?.stop('runtime-startup-failed');
    windowRuntime = null;
    try { startingInputRuntime?.stop('runtime-startup-failed'); } catch { /* Continue fail-closed recovery below. */ }
    nativeInput?.emergencyRecover?.('runtime startup failed');
    inputRuntime = null;
    config.cursorSettings.linked = false;
    lastInputRuntimeError = error?.message || 'The native input layer could not start.';
    addNotice({
      id: 'input-runtime-error', kind: 'warning', title: 'Cursor linking needs attention',
      message: lastInputRuntimeError, dismissible: false,
    });
  }
  return inputRuntime;
}

function stopInputRuntime(reason = 'session-stop') {
  const windows = windowRuntime;
  windowRuntime = null;
  void windows?.stop(reason);
  const runtime = inputRuntime;
  inputRuntime = null;
  runtime?.stop(reason);
}

async function startSession() {
  stopInputRuntime('session-restart');
  if (sync) await sync.stop();
  const layout = localLayout();
  sync = new Session({ ...config, layout, startClosed: backgroundLaunch });
  sync.on('state', (state) => {
    applyState(state);
    // SharedInputRuntime consumes the same state event after this listener and
    // may gain its second screen placement. Refresh once all synchronous state
    // listeners have run so Link cursors reflects the live layout immediately.
    queueMicrotask(refreshStatus);
  });
  sync.on('status', () => {
    refreshStatus();
    if (sync.phase === 'connected') {
      if (!sync.state.layouts[config.id]) sync.action({ type: 'layout', layout: localLayout() });
      ensureInputRuntime();
    }
  });
  try {
    await sync.start();
    if (config.role === 'host' && config.port === 0) config.port = sync.port;
    saveConfig();
  } catch (error) {
    sync.setStatus('error', error.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Choose another port in settings.` : error.message);
    showSettings();
  }
  refreshStatus();
}

function setupIpc() {
  const trusted = (event) => settings && !settings.isDestroyed()
    && event.sender === settings.webContents && event.senderFrame === settings.webContents.mainFrame;
  ipcMain.handle('sync:bootstrap', (event) => { if (!trusted(event)) throw new Error('Unknown window.'); return details(); });
  ipcMain.handle('sync:command', async (event, command, data) => {
    if (!trusted(event)) return { ok: false, error: 'Unknown window.' };
    try {
      if (command === 'settings') showSettings();
      else if (event.sender !== settings?.webContents) throw new Error('Open settings to change this.');
      else if (command === 'copy') {
        const code = details().invitation?.code;
        if (!code) throw new Error('Generate a new code first.');
        clipboard.writeText(code);
      } else if (command === 'new-code') {
        if (config.role !== 'host') throw new Error('Start sharing from here first.');
        sync.refreshCode();
      } else if (command === 'join' || command === 'host') {
        if (changingSession) throw new Error('A connection change is already in progress.');
        changingSession = true;
        try {
          const invitation = data?.invitation;
          const next = command === 'join' ? {
            ...(typeof invitation === 'string' && invitation.trim().startsWith('CS1.')
              ? parseInvitation(invitation)
              : await pairWithCode(invitation, { excludeId: config.id, address: data?.address?.trim(), port: Number(data?.port || 43187) })),
            role: 'join',
          } : { role: 'host', host: '', port: Number(data?.port || 43187), secret: newSecret() };
          if (!Number.isInteger(next.port) || next.port < 1 || next.port > 65535) throw new Error('Port must be between 1 and 65535.');
          Object.assign(config, next);
          await startSession();
        } finally { changingSession = false; }
      } else if (command === 'preferences') {
        if (data?.edge !== undefined) {
          if (!EDGES.includes(data.edge)) throw new Error('Choose a valid screen edge.');
          config.edge = data.edge;
        }
        config.autoLaunch = Boolean(data.autoLaunch);
        config.cursorSettings = validateCursorSettings(data?.cursorSettings);
        inputRuntime?.updateSettings(config.cursorSettings);
        if (app.isPackaged) app.setLoginItemSettings({
          openAtLogin: config.autoLaunch, args: ['--background'],
          ...(process.platform === 'win32' ? { path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath } : {}),
        });
        saveConfig();
        sync.action({ type: 'layout', layout: localLayout() });
        refreshStatus();
      } else if (command === 'cursor-link') {
        if (sync?.phase !== 'connected') throw new Error('The saved pairing is not connected yet. Keep Compusync open on both laptops.');
        const runtime = ensureInputRuntime();
        if (!runtime) throw new Error(lastInputRuntimeError || 'Cursor linking could not start. Review the notice above and try again.');
        if (!runtime.setLinked(true, 'user')) throw new Error('Native input support and a shared layout are required before linking.');
        config.cursorSettings.linked = true;
        saveConfig();
        refreshStatus();
      } else if (command === 'cursor-unlink') {
        config.cursorSettings.linked = false;
        inputRuntime?.setLinked(false, 'user');
        saveConfig();
        refreshStatus();
      } else if (command === 'cursor-toggle-ownership') {
        if (!inputRuntime?.cursor.toggleOwnership()) throw new Error('Link both cursors before changing ownership.');
      } else if (command === 'update-check') {
        if (!await updateService?.check()) throw new Error('Could not check for updates right now.');
      } else if (command === 'update-install') {
        if (!updateService?.install()) throw new Error('No downloaded update is ready to install.');
      } else if (command === 'dismiss-notice') {
        if (!dismissNotice(data?.id)) throw new Error('Unknown notice.');
      } else if (command === 'notice-action') {
        const notice = notices.get(data?.id);
        if (!notice || notice.action !== data?.action) throw new Error('Unknown notice action.');
        const settingsPane = {
          'open-accessibility': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
          'open-input-monitoring': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
          'open-automation': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
        }[notice.action];
        if (!settingsPane) throw new Error('This notice has no action.');
        await shell.openExternal(settingsPane);
      } else throw new Error('Unknown command.');
      return { ok: true };
    } catch (error) { return { ok: false, error: error.message }; }
  });
}

app.on('second-instance', (_event, argv) => { if (!argv.includes('--background')) activateApp(); });
app.on('activate', () => { if (sync) activateApp(); });
app.on('window-all-closed', () => {});
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  updateService?.stop();
  clearTimeout(layoutTimer);
  cancelOwnedDrag();
  stopInputRuntime('process-exit');
  seamOverlay?.destroy();
  seamOverlay = null;
  Promise.resolve(sync?.stop()).finally(() => app.quit());
  if (!sync) app.quit();
});

if (hasLock) app.whenReady().then(async () => {
  config = readConfig();
  nativeInput = createNativeAdapter();
  if (!nativeInput.available) notices.set('native-unavailable', {
    id: 'native-unavailable', kind: 'warning', title: 'Native input support unavailable',
    message: 'This development build can pair, but cursor linking requires the platform native addon.',
    dismissible: false,
  });
  if (process.platform === 'darwin') {
    const accessibility = systemPreferences.isTrustedAccessibilityClient(config.firstRun);
    if (!accessibility) notices.set('accessibility-permission', {
      id: 'accessibility-permission', kind: 'permission', title: 'Allow Accessibility',
      message: 'Compusync needs Accessibility access to detect and position Chrome windows and share input.',
      actionLabel: 'Open Accessibility Settings', action: 'open-accessibility', dismissible: false,
    });
    if (config.firstRun) notices.set('input-monitoring-permission', {
      id: 'input-monitoring-permission', kind: 'permission', title: 'Allow Input Monitoring',
      message: 'Compusync needs Input Monitoring access so either mouse and keyboard can drive the shared cursor.',
      actionLabel: 'Open Input Monitoring Settings', action: 'open-input-monitoring', dismissible: false,
    });
  }
  backgroundLaunch = app.commandLine.hasSwitch('background') || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
  const permissions = (_contents, permission) => permission === 'pointerLock';
  electronSession.defaultSession.setPermissionCheckHandler(permissions);
  electronSession.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(permissions(contents, permission)));
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  setupIpc();
  // The v1 shared surface is retired. Do not create its BrowserWindow, even
  // hidden, because state updates could otherwise make it visible later.
  seamOverlay = new SeamOverlay({
    BrowserWindow, screen,
    preloadPath: path.join(__dirname, 'preload.cjs'),
    rendererPath: rendererPath('handoff-overlay.html'),
    secureWindow,
  });
  seamOverlay.create();
  createTray();
  screen.on('display-added', handleDisplayChange);
  screen.on('display-removed', handleDisplayChange);
  screen.on('display-metrics-changed', handleDisplayChange);
  await startSession();
  updateService = createUpdateService({ app, updater: autoUpdater, addNotice, onStatus: refreshStatus });
  updateService.start();
  if (!backgroundLaunch || pendingActivation) activateApp();
  else if (sync.phase === 'error') showSettings();
}).catch((error) => { console.error(error); app.quit(); });
