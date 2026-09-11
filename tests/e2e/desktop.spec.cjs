'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('two desktop apps pair, share a cursor, transfer, close, and reopen', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compusync-e2e-'));
  const apps = [];
  const errors = [];
  async function launch(name) {
    const env = { ...process.env, COMPUSYNC_PROFILE: path.join(root, name), COMPUSYNC_PORT: '0' };
    delete env.COMPUSYNC_BIND_HOST;
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await electron.launch({ args: [path.resolve('.')], env });
    apps.push(app);
    await expect.poll(() => app.windows().length).toBe(2);
    const windows = app.windows();
    const surface = windows.find((page) => page.url().endsWith('surface.html'));
    const settings = windows.find((page) => page.url().endsWith('settings.html'));
    for (const page of windows) page.on('pageerror', (error) => errors.push(error.message));
    await expect(settings.locator('#status')).toHaveText('Ready to pair');
    return { app, surface, settings };
  }
  const visible = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('surface.html')).isVisible());
  const getState = (surface) => surface.evaluate(async () => (await window.compusync.bootstrap()).state);
  try {
    const first = await launch('first');
    const second = await launch('second');
    const invitation = await first.settings.locator('#invitation').inputValue();
    expect(invitation).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    await second.settings.locator('#join-tab').click();
    await second.settings.locator('#join-code').fill('ABC');
    await second.settings.locator('#join').click();
    await expect(second.settings.locator('#error')).toContainText('8-character');
    await expect(second.settings.locator('#status')).toHaveText('Ready to pair');
    await second.settings.locator('#join-code').fill('');
    await second.settings.locator('#join-code').pressSequentially(invitation.toLowerCase().replace('-', ''));
    await expect(second.settings.locator('#join-code')).toHaveValue(invitation);
    await second.settings.locator('#join').click();
    await expect(first.settings.locator('#status')).toContainText('Connected to', { timeout: 15000 });
    await expect(second.settings.locator('#status')).toContainText('Connected to');

    await first.surface.bringToFront();
    await first.surface.mouse.move(250, 200);
    await first.surface.mouse.move(290, 230);
    await expect.poll(async () => (await getState(first.surface)).cursor.active.length).toBeGreaterThan(0);
    await expect.poll(async () => (await getState(second.surface)).cursor.x).toBe((await getState(first.surface)).cursor.x);
    await expect(second.surface.locator('#cursor')).toBeVisible();
    const before = (await getState(first.surface)).cursor.x;
    await second.surface.bringToFront();
    await second.surface.mouse.move(180, 200);
    await second.surface.mouse.move(230, 200);
    await expect.poll(async () => (await getState(second.surface)).cursor.x).not.toBe(before);
    await expect.poll(async () => (await getState(first.surface)).cursor.x).toBe((await getState(second.surface)).cursor.x);

    // A real mouse click requests pointer lock. Escape must restore the OS cursor.
    await second.surface.mouse.click(230, 200);
    await expect.poll(() => second.surface.evaluate(() => !!document.pointerLockElement)).toBe(true);
    await second.surface.keyboard.press('Escape');
    await expect.poll(() => second.surface.evaluate(() => !!document.pointerLockElement)).toBe(false);

    await first.settings.bringToFront();
    await first.settings.locator('#send').click();
    await expect.poll(() => visible(first.app)).toBe(false);
    await expect.poll(() => visible(second.app)).toBe(true);
    await expect.poll(async () => (await getState(second.surface)).handoff?.edge).toBe('right');
    await first.settings.locator('#show').click();
    await expect.poll(() => visible(first.app)).toBe(true);

    if (process.platform === 'win32') {
      // Exercise a real native title-bar drag: setBounds does not emit the
      // will-move event, and DOM mouse automation cannot grab OS window chrome.
      const points = await first.app.evaluate(({ BrowserWindow, screen }) => {
        const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('surface.html'));
        window.setAlwaysOnTop(true); window.show(); window.focus();
        window.dragEvents = [];
        window.on('will-move', (_event, nextBounds) => window.dragEvents.push({ bounds: nextBounds, point: screen.getCursorScreenPoint(), at: Date.now() }));
        const bounds = window.getBounds();
        const display = screen.getDisplayMatching(bounds);
        return {
          start: screen.dipToScreenPoint({ x: bounds.x + Math.round(bounds.width / 2), y: bounds.y + 14 }),
          end: screen.dipToScreenPoint({ x: display.bounds.x + display.bounds.width - 1, y: bounds.y + 14 }),
        };
      });
      await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'drag-window.ps1'), '-StartX', String(points.start.x), '-StartY', String(points.start.y), '-EndX', String(points.end.x), '-EndY', String(points.end.y)], { windowsHide: true });
      await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('surface.html')).setAlwaysOnTop(false));
      if (await visible(first.app)) console.log('Native drag diagnostics', points, await first.app.evaluate(({ BrowserWindow, screen }) => {
        const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('surface.html'));
        return { bounds: window.getBounds(), events: window.dragEvents, display: screen.getDisplayMatching(window.getBounds()).bounds };
      }));
      await expect.poll(() => visible(first.app)).toBe(false);
      await expect.poll(() => visible(second.app)).toBe(true);
      await first.settings.bringToFront();
      await first.settings.locator('#show').click();
      await expect.poll(() => visible(first.app)).toBe(true);
    }

    // Native window close goes through the same synchronized close path.
    await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('surface.html')).close());
    await expect.poll(() => visible(first.app)).toBe(false);
    await expect.poll(() => visible(second.app)).toBe(false);
    await first.settings.bringToFront();
    await first.settings.locator('#open').click();
    await expect.poll(() => visible(first.app)).toBe(true);
    await expect.poll(() => visible(second.app)).toBe(true);
    await second.settings.bringToFront();
    await second.settings.locator('#close').click();
    await expect.poll(() => visible(first.app)).toBe(false);
    await second.settings.locator('#open').click();
    await expect.poll(() => visible(first.app)).toBe(true);

    // The interactive surface contains no text, controls, or setup UI.
    expect((await first.surface.locator('body').innerText()).trim()).toBe('');
    await expect(first.surface.locator('#field')).toBeVisible();
    // Both views receive the same particle seeds/history, including points that
    // may have been coalesced between network snapshots.
    await first.surface.bringToFront();
    await first.surface.mouse.move(300, 250);
    await first.surface.mouse.move(500, 320, { steps: 15 });
    await expect.poll(async () => (await getState(second.surface)).cursor.trail.length).toBeGreaterThan(0);
    await expect.poll(async () => JSON.stringify((await getState(second.surface)).cursor.trail)).toBe(JSON.stringify((await getState(first.surface)).cursor.trail));
    expect(errors).toEqual([]);
    await first.settings.evaluate(() => window.scrollTo(0, 0));
    await first.settings.screenshot({ path: 'test-results/connection.png' });
    await first.surface.screenshot({ path: 'test-results/shared-grid.png' });
  } finally {
    await Promise.allSettled(apps.map((app) => app.close()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
