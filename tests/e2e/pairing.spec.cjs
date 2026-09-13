'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('short code pairs two laptops through automatic discovery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compusync-code-e2e-'));
  const apps = [];
  const errors = [];
  async function launch(name) {
    const env = { ...process.env, COMPUSYNC_PROFILE: path.join(root, name), COMPUSYNC_PORT: '0' };
    delete env.COMPUSYNC_BIND_HOST;
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await electron.launch({ args: [path.resolve('.')], env });
    apps.push(app);
    app.on('window', (page) => page.on('pageerror', (error) => errors.push(error.message)));
    await expect.poll(() => {
      const urls = app.windows().map((page) => page.url());
      return ['settings.html', 'handoff-overlay.html']
        .every((file) => urls.some((url) => url.endsWith(file)));
    }, { timeout: 15_000 }).toBe(true);
    expect(app.windows().some((page) => page.url().endsWith('surface.html'))).toBe(false);
    const settings = app.windows().find((page) => page.url().endsWith('settings.html'));
    await expect(settings.locator('#status')).toHaveText('Ready to pair');
    return { app, settings };
  }
  try {
    const host = await launch('host');
    const peer = await launch('peer');
    await expect(host.settings.locator('#cursor-mode')).toBeDisabled();
    await expect(peer.settings.locator('#cursor-mode')).toBeDisabled();
    const original = await host.settings.locator('#invitation').inputValue();
    await host.settings.locator('#new-code').click();
    await expect(host.settings.locator('#invitation')).not.toHaveValue(original);
    const code = await host.settings.locator('#invitation').inputValue();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    await host.settings.locator('#copy').click();
    expect(await host.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(code);
    await host.settings.screenshot({ path: 'test-results/short-invitation.png' });
    await peer.settings.locator('#join-tab').click();
    await peer.settings.locator('#join-code').fill('ABC');
    await peer.settings.locator('#join').click();
    await expect(peer.settings.locator('#error')).toContainText('8-character');
    await expect(peer.settings.locator('#status')).toHaveText('Ready to pair');
    await peer.settings.locator('#join-code').fill('');
    await peer.settings.locator('#join-code').pressSequentially(code.toLowerCase().replace('-', ''));
    await expect(peer.settings.locator('#join-code')).toHaveValue(code);
    await peer.settings.locator('#join-code').press('Enter');
    await expect(peer.settings.locator('#status')).toContainText('Connected to', { timeout: 15000 });
    await expect(host.settings.locator('#status')).toContainText('Connected to');
    await expect(host.settings.locator('#cursor-mode')).toBeEnabled();
    await expect(peer.settings.locator('#cursor-mode')).toBeEnabled();
    await expect(host.settings.locator('#code-status')).toContainText('Connected. This pairing is saved');
    await expect(peer.settings.locator('#code-status')).toContainText('Connected. This pairing is saved');
    await expect(host.settings.locator('#notices')).not.toContainText('Cursor linking needs attention');
    await expect(peer.settings.locator('#notices')).not.toContainText('Cursor linking needs attention');
    await expect(host.settings.locator('#invitation')).toHaveValue('');
    await expect(host.settings.locator('#copy')).toBeDisabled();
    expect(errors).toEqual([]);
  } finally {
    await Promise.allSettled(apps.map((app) => app.close()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
