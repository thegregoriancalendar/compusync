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
    if (process.platform === 'win32') {
      await expect(peer.settings.locator('#error')).toContainText('Windows-to-Windows is not supported yet');
      await expect(host.settings.locator('#invitation')).toHaveValue(code);
      await expect(peer.settings.locator('#cursor-mode')).toBeDisabled();
      return;
    }
    await expect(peer.settings.locator('#status')).toContainText('Connected to', { timeout: 15000 });
    await expect(host.settings.locator('#status')).toContainText('Connected to');
    const info = await peer.settings.evaluate(() => window.compusync.bootstrap());
    expect(info.members.map((member) => member.platform)).toEqual(['darwin', 'darwin']);
    await expect(host.settings.locator('#layout-windows')).toHaveAttribute('aria-label', /Mac 2/);
    await expect(peer.settings.locator('#layout-mac')).toHaveAttribute('aria-label', /Mac 1/);
    await expect(host.settings.locator('.blocked-edge')).toHaveCount(2);
    for (const laptop of [host, peer]) {
      await expect(laptop.settings.locator('#audio-volume-mac-label')).toHaveText('Mac 1 volume');
      await expect(laptop.settings.locator('#audio-volume-windows-label')).toHaveText('Mac 2 volume');
      await expect(laptop.settings.locator('#audio-volume-mac')).toHaveAttribute('data-device-id', info.members[0].id);
      await expect(laptop.settings.locator('#audio-volume-windows')).toHaveAttribute('data-device-id', info.members[1].id);
    }
    await peer.settings.locator('#layout-windows').focus();
    await peer.settings.locator('#layout-windows').press('ArrowLeft');
    await expect(host.settings.locator('#layout-description')).toContainText('Mac 1 is right of Mac 2');
    await expect(peer.settings.locator('#layout-description')).toContainText('Mac 1 is right of Mac 2');
    await peer.settings.locator('#layout-windows').press('ArrowDown');
    await expect(peer.settings.locator('#layout-description')).toContainText('Mac 1 is right of Mac 2');
    await peer.settings.locator('#layout-windows').press('ArrowRight');
    await expect(host.settings.locator('#layout-description')).toContainText('Mac 1 is left of Mac 2');
    await host.settings.screenshot({ path: 'test-results/mac-to-mac-settings.png', fullPage: true });
    await expect(host.settings.locator('#cursor-mode')).toBeEnabled();
    await expect(peer.settings.locator('#cursor-mode')).toBeEnabled();
    await expect(host.settings.locator('#pairing-card')).toBeHidden();
    await expect(peer.settings.locator('#pairing-card')).toBeHidden();
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
