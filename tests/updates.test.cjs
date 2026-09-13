'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdateService } = require('../src/main/updates.cjs');

test('packaged builds check, download, and install updates on quit', async () => {
  const updater = new EventEmitter();
  let checks = 0;
  let installs = 0;
  updater.checkForUpdates = async () => { checks += 1; };
  updater.quitAndInstall = (silent, forceRunAfter) => {
    assert.equal(silent, false);
    assert.equal(forceRunAfter, true);
    installs += 1;
  };
  const notices = [];
  const statuses = [];
  const scheduled = [];
  const service = createUpdateService({
    app: { isPackaged: true, getVersion: () => '0.3.0' }, updater,
    addNotice: (notice) => notices.push(notice),
    onStatus: (status) => statuses.push(status),
    setTimer: (callback, delay) => {
      scheduled.push({ callback, delay });
      return { unref() {} };
    },
    clearTimer: () => {},
  });

  assert.equal(service.start(), true);
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(scheduled.length, 1);
  await scheduled.shift().callback();
  assert.equal(checks, 1);
  assert.equal(scheduled.length, 1);

  updater.emit('update-available', { version: '0.4.0' });
  updater.emit('download-progress', { percent: 48.7 });
  updater.emit('update-downloaded', { version: '0.4.0' });
  assert.deepEqual(notices.map(({ id }) => id), ['update-available', 'update-downloaded']);
  assert.match(notices[1].message, /quit and reopen/i);
  assert.equal(statuses.at(-1).phase, 'downloaded');
  assert.equal(statuses.at(-1).availableVersion, '0.4.0');
  assert.equal(statuses.at(-1).canRestart, true);
  assert.equal(service.status().currentVersion, '0.3.0');
  assert.equal(service.install(), true);
  assert.equal(installs, 1);
  assert.equal(updater.listenerCount('update-downloaded'), 1);
  service.stop();
  assert.equal(updater.listenerCount('update-downloaded'), 0);
  assert.equal(updater.listenerCount('error'), 1);
});

test('development builds do not contact the update provider', async () => {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => assert.fail('must not check');
  const service = createUpdateService({ app: { isPackaged: false }, updater });
  assert.equal(service.start(), false);
  assert.equal(service.status().phase, 'disabled');
  assert.equal(await service.check(), false);
  assert.equal(service.install(), false);
});

test('update errors are recoverable and never expose provider details in the UI', async () => {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => { throw new Error('token=https://secret.example'); };
  const warnings = [];
  const service = createUpdateService({
    app: { isPackaged: true, getVersion: () => '1.2.3' }, updater,
    logger: { warn: (...args) => warnings.push(args) },
    setTimer: () => ({ unref() {} }), clearTimer: () => {},
  });
  service.start();

  assert.equal(await service.check(), false);
  assert.equal(service.status().phase, 'error');
  assert.doesNotMatch(service.status().message, /secret\.example/);
  assert.equal(service.status().canCheck, true);
  assert.equal(warnings.length, 1);
});
