'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Session } = require('../../src/core/session.cjs');
const { claimCode } = require('../../src/core/pairing.cjs');
const { AudioRouter } = require('../../src/main/audio-router.cjs');

test('Audio manager persists split mode, follows saved layout, and shows the active source assignment', async () => {
  test.skip(process.platform !== 'win32', 'Windows Audio manager with a paired Mac.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'compusync-stereo-e2e-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ cursorSettings: { linked: false }, clipboardSync: false }));
  const env = { ...process.env, COMPUSYNC_PROFILE: profile, COMPUSYNC_PORT: '0', COMPUSYNC_BIND_HOST: '127.0.0.1' };
  delete env.ELECTRON_RUN_AS_NODE;
  let app, peer, router;
  try {
    app = await electron.launch({ args: [path.resolve('.')], env });
    await expect.poll(() => app.windows().some((page) => page.url().endsWith('settings.html'))).toBe(true);
    const page = app.windows().find((candidate) => candidate.url().endsWith('settings.html'));
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    const mode = page.getByRole('combobox', { name: 'Playback mode', exact: true });
    await expect(mode).toHaveValue('stereo');
    const info = await page.evaluate(() => window.compusync.bootstrap());
    expect(info.audio.stereoSplitAvailable).toBe(true);
    await mode.selectOption('split-stereo');
    await expect(page.locator('#audio-channels')).toContainText('Connect both laptops');
    await expect(page.locator('#audio-start')).toBeDisabled();
    expect(JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).audioPlaybackMode).toBe('split-stereo');

    const paired = await claimCode({ host: '127.0.0.1', port: info.port }, info.invitation.code);
    peer = new Session({ id: 'stereo-test-mac', name: 'Stereo Mac', role: 'join', secret: paired.secret,
      host: '127.0.0.1', port: info.port, discovery: false,
      layout: { revision: 1, platform: 'darwin', edge: 'right', activeDisplayId: 'main',
        displays: [{ id: 'main', primary: true, scaleFactor: 1,
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 0, width: 1920, height: 1040 } }] } });
    const engine = new EventEmitter();
    engine.available = true; engine.canSend = true; engine.supportsStereoSplit = true;
    engine.stop = () => {}; engine.setPlaybackChannel = () => {}; engine.send = async () => {};
    engine.volume = () => ({ level: 35, muted: false, label: 'MacBook speakers' });
    router = new AudioRouter({ session: peer, engine, platform: 'darwin' });
    router.start(); await peer.start();
    await expect.poll(() => peer.phase).toBe('connected');
    peer.action({ type: 'layout', layout: peer.config.layout });
    await expect(page.locator('#audio-channels')).toContainText('Mac: left channel');
    await expect(page.locator('#audio-channels')).toContainText('Windows: right channel');
    // Keyboard layout editing runs through the actual settings IPC and save.
    await page.locator('#layout-mac').focus();
    await page.locator('#layout-mac').press('ArrowRight');
    await expect(page.locator('#audio-channels')).toContainText('Mac: right channel');
    await expect(page.locator('#audio-channels')).toContainText('Windows: left channel');

    await mode.selectOption('stereo');
    // The receiver must display the source's negotiated mode even when its
    // own saved preference is full stereo. Capture is mocked on the Mac.
    router.layoutChanged({ macPosition: 'right' });
    router.setPlaybackMode('split-stereo');
    await expect.poll(() => router.state().canStart).toBe(true);
    router.startRoute();
    await expect(mode).toHaveValue('split-stereo');
    await expect(mode).toBeDisabled();
    await expect(page.locator('#audio-mode')).toHaveText('Split stereo');
    await expect(page.locator('#audio-channels')).toContainText('Mac: right channel');
    await page.locator('[aria-labelledby="audio-heading"]').screenshot({ path: 'test-results/audio-stereo-controls.png' });
    router.layoutChanged({ macPosition: 'left' });
    await expect(page.locator('#audio-channels')).toContainText('Mac: left channel');
    await expect(page.locator('#audio-channels')).toContainText('Windows: right channel');
    router.stopRoute();
    await expect(mode).toBeEnabled();
    await expect(mode).toHaveValue('stereo');
    await mode.selectOption('split-stereo');
    await app.close(); app = null;
    app = await electron.launch({ args: [path.resolve('.')], env });
    await expect.poll(() => app.windows().some((candidate) => candidate.url().endsWith('settings.html'))).toBe(true);
    const reopened = app.windows().find((candidate) => candidate.url().endsWith('settings.html'));
    await expect(reopened.getByRole('combobox', { name: 'Playback mode', exact: true })).toHaveValue('split-stereo');
    expect(errors).toEqual([]);
  } finally {
    router?.stop(); await peer?.stop(); await app?.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
