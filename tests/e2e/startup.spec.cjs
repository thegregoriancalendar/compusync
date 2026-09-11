'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function environment(profile) {
  const env = { ...process.env, COMPUSYNC_PROFILE: profile, COMPUSYNC_PORT: '0', COMPUSYNC_BIND_HOST: '127.0.0.1' };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

async function setupWindow(app) {
  await expect.poll(() => app.windows().some((page) => page.url().endsWith('settings.html'))).toBe(true);
  const page = app.windows().find((window) => window.url().endsWith('settings.html'));
  await expect(page.locator('#invitation')).toHaveValue(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('settings.html'))?.isVisible())).toBe(true);
  return page;
}

test('pairing reappears with a saved profile and when reopening an app left in the tray', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'compusync-startup-'));
  let app;
  try {
    const env = environment(profile);
    app = await electron.launch({ args: [path.resolve('.')], env });
    await setupWindow(app);
    await app.close();
    app = null;
    expect(JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).firstRun).toBe(false);

    app = await electron.launch({ args: [path.resolve('.')], env });
    await setupWindow(app);
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.close();
    });
    await expect.poll(() => app.windows().length).toBe(1);

    // Launch the actual second process, exercising Electron's single-instance
    // forwarding rather than synthesizing the application event.
    await new Promise((resolve, reject) => {
      const child = spawn(require('electron'), [path.resolve('.')], { env, stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => { child.kill(); reject(new Error('Second launch did not exit.')); }, 8000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Second launch exited with ${code}.`)); });
    });
    await setupWindow(app);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('surface.html')).isVisible())).toBe(true);
  } finally {
    if (app) await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('background launch stays hidden until the user activates it', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'compusync-background-'));
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.'), '--background'], env: environment(profile) });
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(async () => (await window.compusync.bootstrap()).status.phase)).toBe('hosting');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible()))).toBe(false);
    expect(app.windows().length).toBe(1);
    await app.evaluate(({ app: application }) => application.emit('activate'));
    await setupWindow(app);
  } finally {
    if (app) await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
