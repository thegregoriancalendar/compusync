'use strict';

const DEFAULT_INITIAL_DELAY_MS = 30_000;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

function createUpdateService({
  app,
  updater,
  addNotice = () => {},
  onStatus = () => {},
  logger = console,
  initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let stopped = false;
  let started = false;
  let timer = null;
  let checking = null;
  const listeners = [];
  const enabled = Boolean(app?.isPackaged && ['darwin', 'win32'].includes(process.platform)
    && process.env.COMPUSYNC_DISABLE_AUTO_UPDATE !== '1' && updater);
  let state = {
    phase: enabled ? 'idle' : 'disabled',
    currentVersion: app?.getVersion?.() || '0.0.0',
    availableVersion: null,
    percent: null,
    canCheck: enabled,
    canRestart: false,
    message: enabled
      ? 'CompuSync checks for updates automatically.'
      : 'Automatic updates are available in the installed Windows and macOS apps.',
  };

  const publish = (changes) => {
    state = { ...state, ...changes };
    onStatus({ ...state });
  };

  const listen = (event, handler) => {
    updater.on(event, handler);
    listeners.push([event, handler]);
  };

  const schedule = (delay) => {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(check, delay);
    timer?.unref?.();
  };

  const check = async () => {
    if (stopped || !enabled) return false;
    if (checking) return checking;
    if (timer) clearTimer(timer);
    timer = null;
    publish({ phase: 'checking', canCheck: false, percent: null, message: 'Checking for updates…' });
    checking = Promise.resolve(updater.checkForUpdates())
      .then(() => true)
      .catch((error) => {
        logger.warn?.('CompuSync update check failed:', error?.message || error);
        publish({
          phase: 'error', canCheck: true,
          message: 'Could not check for updates. CompuSync will try again later.',
        });
        return false;
      })
      .finally(() => {
        checking = null;
        schedule(intervalMs);
      });
    return checking;
  };

  const start = () => {
    if (!enabled || started) return false;
    started = true;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    listen('checking-for-update', () => publish({
      phase: 'checking', canCheck: false, percent: null, message: 'Checking for updates…',
    }));
    listen('update-available', (info) => {
      publish({
        phase: 'available', availableVersion: info?.version || null, percent: 0,
        canCheck: false, message: 'Downloading an update in the background…',
      });
      addNotice({
        id: 'update-available', kind: 'info', title: 'CompuSync update downloading',
        message: `Version ${info?.version || 'new'} is downloading in the background.`, dismissible: true,
      });
    });
    listen('download-progress', (progress) => {
      const value = Number(progress?.percent);
      const percent = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
      publish({
        phase: 'downloading', percent, canCheck: false,
        message: percent === null ? 'Downloading an update…' : `Downloading update… ${percent}%`,
      });
    });
    listen('update-not-available', () => publish({
      phase: 'up-to-date', availableVersion: null, percent: null, canCheck: true,
      message: 'CompuSync is up to date.',
    }));
    listen('update-downloaded', (info) => {
      publish({
        phase: 'downloaded', availableVersion: info?.version || null, percent: 100,
        canCheck: true, canRestart: true, message: 'Update ready. Restart CompuSync to install it.',
      });
      addNotice({
        id: 'update-downloaded', kind: 'info', title: 'CompuSync update ready',
        message: `Version ${info?.version || 'new'} will install automatically when you quit and reopen CompuSync.`, dismissible: true,
      });
    });
    listen('error', (error) => {
      logger.warn?.('CompuSync updater error:', error?.message || error);
      if (stopped) return;
      publish({
        phase: 'error', percent: null, canCheck: true,
        message: 'Could not update right now. CompuSync will try again later.',
      });
    });
    schedule(initialDelayMs);
    return true;
  };

  const stop = () => {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
    // electron-updater installs from its app `quit` listener. Keep our error
    // sink until process exit so a failed installer launch cannot become an
    // unhandled EventEmitter `error`; all state-producing listeners come off.
    for (const [event, handler] of listeners.splice(0)) {
      if (event !== 'error') updater.removeListener(event, handler);
    }
  };

  const install = () => {
    if (!enabled || !state.canRestart) return false;
    updater.quitAndInstall(false, true);
    return true;
  };

  return { start, stop, check, install, status: () => ({ ...state }) };
}

module.exports = { createUpdateService, DEFAULT_INITIAL_DELAY_MS, DEFAULT_INTERVAL_MS };
