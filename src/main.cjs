'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, clipboard, screen, safeStorage, session: electronSession } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { Session } = require('./core/session.cjs');
const { newSecret, parseInvitation } = require('./core/wire.cjs');
const { pairWithCode } = require('./core/pairing.cjs');
const { edgeCrossing, arrivalBounds } = require('./core/geometry.cjs');
const { EDGES } = require('./core/state.cjs');

if (process.env.COMPUSYNC_PROFILE) {
  const profile = path.resolve(process.env.COMPUSYNC_PROFILE);
  fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
}
app.setName('CompuSync');
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();

let surface, settings, tray, sync, config;
let quitting = false;
let changingSession = false;
let applyingBounds = false;
let handoffAt = 0;
let lastHandoff = null;
let backgroundLaunch = false;
let pendingActivation = false;
let resizeTimer;
const rendererPath = (file) => path.join(__dirname, 'renderer', file);
const configPath = () => path.join(app.getPath('userData'), 'settings.json');

function readConfig() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (saved.encryptedSecret) saved.secret = safeStorage.decryptString(Buffer.from(saved.encryptedSecret, 'base64'));
  } catch { saved = {}; }
  return {
    id: saved.id || randomUUID(), name: saved.name || os.hostname(),
    role: saved.role === 'join' ? 'join' : 'host', host: saved.host || '',
    port: Number(process.env.COMPUSYNC_PORT ?? saved.port ?? 43187),
    secret: saved.secret || newSecret(), edge: saved.edge || 'right',
    autoLaunch: Boolean(saved.autoLaunch), firstRun: !saved.id,
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
  fs.writeFileSync(configPath(), JSON.stringify(saved, null, 2), { mode: 0o600 });
}

function addresses() {
  return [...new Set(Object.values(os.networkInterfaces()).flat().filter((entry) => entry && entry.family === 'IPv4' && !entry.internal).map((entry) => entry.address))];
}

function details() {
  const ips = addresses();
  return {
    id: config.id, name: config.name, edge: config.edge, autoLaunch: config.autoLaunch,
    packaged: app.isPackaged,
    status: sync?.status() || { role: config.role, phase: 'starting', peers: [] },
    invitation: config.role === 'host' ? sync?.invitation() : null,
    addresses: ips.length ? ips : ['127.0.0.1'],
    host: config.host, port: sync?.port || config.port,
    state: sync?.state,
    clockOffsetMs: sync?.clockOffsetMs || 0,
  };
}

function send(window, channel, value) {
  if (window && !window.isDestroyed() && !window.webContents.isLoading()) window.webContents.send(channel, value);
}

function refreshStatus() {
  send(settings, 'sync:details', details());
  send(surface, 'sync:connection', sync.status());
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

function createSurface() {
  surface = new BrowserWindow({
    width: 900, height: 600, minWidth: 360, minHeight: 240,
    title: 'CompuSync', backgroundColor: '#ffffff', show: false,
    autoHideMenuBar: true, webPreferences: webPreferences(),
  });
  surface.setMenuBarVisibility(false);
  secureWindow(surface);
  surface.loadFile(rendererPath('surface.html'));
  surface.once('ready-to-show', () => {
    if (sync) applyState(sync.state);
    // The grid can finish loading after setup; keep pairing in front.
    if (settings && !settings.isDestroyed() && settings.isVisible()) settings.focus();
  });
  surface.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    if (!sync.action({ type: 'close' })) { surface.hide(); showSettings(); }
  });
  surface.on('hide', releasePointer);
  surface.on('blur', releasePointer);
  surface.on('will-move', (_event, bounds) => {
    if (applyingBounds || Date.now() - handoffAt < 1200 || sync.phase !== 'connected') return;
    const pointer = screen.getCursorScreenPoint();
    const display = screen.getDisplayMatching(surface.getBounds());
    const crossing = edgeCrossing(bounds, pointer, display.bounds, config.edge);
    if (crossing) transfer(crossing);
  });
  surface.on('resize', () => {
    if (applyingBounds) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const [width, height] = surface.getSize();
      if (width !== sync.state.size.width || height !== sync.state.size.height) sync.action({ type: 'resize', width, height });
    }, 100);
  });
  surface.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
    const key = input.key.toLowerCase();
    if (key === ',') { event.preventDefault(); showSettings(); }
    if (key === 'w') { event.preventDefault(); closeShared(); }
    if (key === 'enter' && input.shift) { event.preventDefault(); transfer({ edge: config.edge, ratio: 0.5 }); }
    if (key === 'o' && input.shift) { event.preventDefault(); openShared(); }
  });
}

function releasePointer() {
  send(surface, 'sync:release', null);
  if (sync?.state.cursor.active.includes(config.id)) sync.action({ type: 'leave' });
}

function applyState(state) {
  if (!surface || surface.isDestroyed()) return;
  const visible = state.open && state.views.includes(config.id);
  const incoming = state.handoff && state.handoff.serial !== lastHandoff;
  if (incoming) lastHandoff = state.handoff.serial;
  applyingBounds = true;
  const display = screen.getDisplayMatching(surface.getBounds());
  if (incoming && state.handoff.to === config.id && visible) {
    handoffAt = Date.now();
    surface.setBounds(arrivalBounds(state.size, display.workArea, state.handoff));
    surface.show();
    surface.focus();
  } else if (visible) {
    const width = Math.min(state.size.width, display.workArea.width);
    const height = Math.min(state.size.height, display.workArea.height);
    const current = surface.getBounds();
    if (current.width !== width || current.height !== height) surface.setSize(width, height);
    if (!surface.isVisible()) {
      surface.setBounds(arrivalBounds({ width, height }, display.workArea, { edge: 'center', ratio: 0.5 }));
      surface.show();
    }
  } else if (surface.isVisible()) surface.hide();
  applyingBounds = false;
  send(surface, 'sync:state', { ...state, clockOffsetMs: sync.clockOffsetMs });
  // Settings does not need high-frequency cursor updates.
  if (state.open !== applyState.lastOpen || state.views.join() !== applyState.lastViews) {
    applyState.lastOpen = state.open;
    applyState.lastViews = state.views.join();
    send(settings, 'sync:details', details());
    updateMenu();
  }
}

function transfer(crossing) {
  if (sync.phase !== 'connected') return false;
  handoffAt = Date.now();
  releasePointer();
  return sync.action({ type: 'handoff', ...crossing });
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

function openShared() {
  if (!sync.action({ type: 'open' })) showSettings();
  else if (surface.isVisible()) { surface.restore(); surface.focus(); }
}

function showLocal() {
  if (!sync.action({ type: 'show' })) showSettings();
  else if (surface.isVisible()) { surface.restore(); surface.focus(); }
}

// A foreground launch is also the entry point to pairing, even with a saved
// profile or an app that was left running in the tray. Login launches stay quiet.
function activateApp() {
  if (!sync) { pendingActivation = true; return; }
  pendingActivation = false;
  showLocal();
  if (sync.phase !== 'connected') showSettings();
}

function closeShared() {
  if (!sync.action({ type: 'close' })) { surface.hide(); showSettings(); }
}

function menuTemplate() {
  return [
    { label: sync?.phase === 'connected' ? `Connected to ${sync.status().peers[0]?.name || 'laptop'}` : 'CompuSync · Waiting for connection', enabled: false },
    { type: 'separator' },
    { label: 'Open on both laptops', accelerator: 'CmdOrCtrl+Shift+O', click: openShared },
    { label: 'Show on this laptop', click: showLocal },
    { label: 'Send to other laptop', accelerator: 'CmdOrCtrl+Shift+Enter', enabled: sync?.phase === 'connected' && sync?.state.open, click: () => transfer({ edge: config.edge, ratio: 0.5 }) },
    { label: 'Close on both laptops', accelerator: 'CmdOrCtrl+W', click: closeShared },
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

async function startSession() {
  if (sync) await sync.stop();
  lastHandoff = null;
  sync = new Session({ ...config, startClosed: backgroundLaunch });
  let openWhenConnected = config.role === 'join' && !backgroundLaunch;
  sync.on('state', applyState);
  sync.on('status', () => {
    refreshStatus();
    if (openWhenConnected && sync.phase === 'connected') {
      openWhenConnected = false;
      sync.action({ type: 'show' });
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
  const trusted = (event) => [surface, settings].some((window) => window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame);
  ipcMain.handle('sync:bootstrap', (event) => { if (!trusted(event)) throw new Error('Unknown window.'); return details(); });
  ipcMain.on('sync:input', (event, action) => {
    if (!trusted(event) || event.sender !== surface.webContents || !['enter', 'leave', 'move', 'button'].includes(action?.type)) return;
    sync.action(action);
  });
  ipcMain.handle('sync:command', async (event, command, data) => {
    if (!trusted(event)) return { ok: false, error: 'Unknown window.' };
    try {
      if (command === 'settings') showSettings();
      else if (command === 'open') openShared();
      else if (command === 'show') showLocal();
      else if (command === 'close') closeShared();
      else if (command === 'handoff') transfer({ edge: config.edge, ratio: 0.5 });
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
        if (!EDGES.includes(data?.edge)) throw new Error('Choose a valid screen edge.');
        config.edge = data.edge;
        config.autoLaunch = Boolean(data.autoLaunch);
        if (app.isPackaged) app.setLoginItemSettings({
          openAtLogin: config.autoLaunch, args: ['--background'],
          ...(process.platform === 'win32' ? { path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath } : {}),
        });
        saveConfig();
        refreshStatus();
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
  clearTimeout(resizeTimer);
  sync?.stop().finally(() => app.quit());
  if (!sync) app.quit();
});

if (hasLock) app.whenReady().then(async () => {
  config = readConfig();
  backgroundLaunch = app.commandLine.hasSwitch('background') || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
  const permissions = (_contents, permission) => permission === 'pointerLock';
  electronSession.defaultSession.setPermissionCheckHandler(permissions);
  electronSession.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(permissions(contents, permission)));
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  setupIpc();
  createSurface();
  createTray();
  await startSession();
  if (!backgroundLaunch || pendingActivation) activateApp();
  else if (sync.phase === 'error') showSettings();
}).catch((error) => { console.error(error); app.quit(); });
