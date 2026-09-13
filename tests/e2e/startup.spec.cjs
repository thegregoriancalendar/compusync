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
  await expect.poll(() => app.windows().some((page) => page.url().endsWith('settings.html')), { timeout: 15_000 }).toBe(true);
  const page = app.windows().find((window) => window.url().endsWith('settings.html'));
  await expect(page.locator('#invitation')).toHaveValue(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  await expect(page.locator('#update-status')).toContainText('installed Windows and macOS apps');
  await expect(page.locator('#update-check')).toBeDisabled();
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
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.webContents.getURL().endsWith('surface.html')))).toBe(false);
    await app.close();
    app = null;
    expect(JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).firstRun).toBe(false);

    app = await electron.launch({ args: [path.resolve('.')], env });
    await setupWindow(app);
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.close();
    });
    // Only the hidden, click-through handoff treatment remains. The retired
    // shared surface is not created, even as a hidden window.
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
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.webContents.getURL().endsWith('surface.html')))).toBe(false);
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
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      const overlay = windows.find((window) => window.webContents.getURL().endsWith('handoff-overlay.html'));
      return overlay ? {
        count: windows.length,
        visible: overlay.isVisible(),
        focusable: overlay.isFocusable(),
        retiredSurface: windows.some((window) => window.webContents.getURL().endsWith('surface.html')),
      } : null;
    })).toEqual({ count: 1, visible: false, focusable: false, retiredSurface: false });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible()))).toBe(false);
    await app.evaluate(({ app: application }) => application.emit('activate'));
    await setupWindow(app);
  } finally {
    if (app) await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('an unreadable saved secret preserves the rest of the profile', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'compusync-secret-recovery-'));
  const settingsPath = path.join(profile, 'settings.json');
  const id = '18b84eb8-0c6e-47da-94d8-90db93fcedaa';
  let app;
  try {
    fs.writeFileSync(settingsPath, JSON.stringify({
      id,
      name: 'Preserved laptop',
      role: 'host',
      port: 43187,
      autoLaunch: true,
      encryptedSecret: 'AA==',
    }));
    app = await electron.launch({ args: [path.resolve('.')], env: environment(profile) });
    await setupWindow(app);
    await app.close();
    app = null;

    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(saved.id).toBe(id);
    expect(saved.name).toBe('Preserved laptop');
    expect(saved.autoLaunch).toBe(true);
    expect(fs.readdirSync(profile).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  } finally {
    if (app) await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
