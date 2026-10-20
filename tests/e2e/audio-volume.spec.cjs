'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Session } = require('../../src/core/session.cjs');
const { claimCode } = require('../../src/core/pairing.cjs');
const { AudioRouter } = require('../../src/main/audio-router.cjs');
const { loadBinding } = require('../../native/index.cjs');

test('Audio Manager reads system volume and controls both laptops through accessible sliders', async () => {
  test.skip(process.platform !== 'win32', 'Native Windows volume verification.');
  const binding = loadBinding().binding;
  expect(typeof binding?.NativeAudio?.prototype.volume).toBe('function');
  const native = new binding.NativeAudio();
  const original = native.volume('');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'compusync-volume-e2e-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ cursorSettings: { linked: false }, clipboardSync: false }));
  const env = { ...process.env, COMPUSYNC_PROFILE: profile, COMPUSYNC_PORT: '0', COMPUSYNC_BIND_HOST: '127.0.0.1' };
  delete env.ELECTRON_RUN_AS_NODE;
  let app, peer, router, changedLocal = false;
  try {
    app = await electron.launch({ args: [path.resolve('.')], env });
    await expect.poll(() => app.windows().some((page) => page.url().endsWith('settings.html')), { timeout: 15_000 }).toBe(true);
    const page = app.windows().find((candidate) => candidate.url().endsWith('settings.html'));
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const windows = page.getByRole('slider', { name: 'Windows volume' });
    const mac = page.locator('#audio-volume-mac');
    await expect(windows).toBeEnabled();
    await expect(windows).toHaveValue(String(original.level));
    await expect(mac).toBeDisabled();
    await expect(page.locator('#audio-volume-windows-status')).toContainText(original.label);
    if (!original.muted && original.level > 0) {
      changedLocal = true;
      await windows.focus();
      await windows.press('ArrowLeft');
      await expect.poll(() => native.volume('').level).toBe(original.level - 1);
      // An OS-side change must also update the slider, without user interaction.
      native.setVolume('', original.level);
      await expect(windows).toHaveValue(String(original.level));
    }

    const info = await page.evaluate(() => window.compusync.bootstrap());
    const paired = await claimCode({ host: '127.0.0.1', port: info.port }, info.invitation.code, { platform: 'darwin' });
    peer = new Session({ platform: 'darwin', id: 'volume-test-mac', name: 'Test Mac', role: 'join', secret: paired.secret,
      host: '127.0.0.1', port: info.port, discovery: false });
    const engine = new EventEmitter();
    engine.available = true; engine.canSend = false;
    let volume = { level: 37, muted: false, label: 'MacBook speakers' };
    let failure;
    engine.volume = () => volume;
    engine.setVolume = (_id, level) => {
      if (failure) throw new Error(failure);
      return volume = { ...volume, level, muted: level === 0 };
    };
    engine.stop = () => {};
    router = new AudioRouter({ session: peer, engine, platform: 'darwin' });
    router.start(); await peer.start();
    await expect(mac).toBeEnabled();
    await expect(mac).toHaveValue('37');
    await mac.focus(); await mac.press('Home');
    await expect.poll(() => volume.level).toBe(0);
    await expect(page.locator('#audio-volume-mac-value')).toHaveText('Muted · 0%');
    await mac.press('End');
    await expect.poll(() => volume.level).toBe(100);
    await expect(page.locator('#audio-volume-mac-value')).toHaveText('100%');

    // Refreshing details while dragging must preserve the pending thumb/value.
    await page.evaluate(() => {
      const slider = document.getElementById('audio-volume-mac');
      for (const level of [65, 50, 24]) {
        slider.value = String(level);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await expect(page.locator('#audio-volume-mac-value')).toHaveText('24%');
    await expect.poll(() => volume.level).toBe(24);
    await expect(mac).toHaveValue('24');
    await page.locator('[aria-labelledby="audio-heading"]').screenshot({ path: 'test-results/audio-volume-controls.png' });

    failure = 'The Mac speakers are disconnected.';
    await mac.press('ArrowRight');
    await expect(page.locator('#audio-error')).toContainText(failure);
    await expect(mac).toHaveValue('24');
    await peer.stop();
    await expect(mac).toBeDisabled();
    await expect(page.locator('#audio-volume-mac-value')).toHaveText('Unavailable');
    await expect(windows).toBeEnabled();
    expect(errors).toEqual([]);
  } finally {
    router?.stop();
    await peer?.stop();
    if (changedLocal) native.setVolume('', original.level);
    await app?.close();
    native.stop();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
