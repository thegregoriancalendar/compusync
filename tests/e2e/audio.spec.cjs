'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('Windows audio manager exposes routing setup and refuses capture before pairing', async () => {
  test.skip(process.platform !== 'win32', 'The first audio receiver runs on Windows.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'compusync-audio-e2e-'));
  const env = { ...process.env, COMPUSYNC_PROFILE: profile, COMPUSYNC_PORT: '0', COMPUSYNC_BIND_HOST: '127.0.0.1' };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.')], env });
    await expect.poll(() => app.windows().some((page) => page.url().endsWith('settings.html')), { timeout: 15_000 }).toBe(true);
    const page = app.windows().find((candidate) => candidate.url().endsWith('settings.html'));
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.locator('#audio-mode')).toHaveText('Separate');
    await expect(page.locator('#audio-start')).toBeVisible();
    await expect(page.locator('#audio-start')).toBeDisabled();
    await expect(page.locator('#audio-windows-source')).toBeVisible();
    await expect(page.locator('#audio-stop')).toBeDisabled();
    await expect(page.locator('#audio-refresh')).toBeEnabled();
    await page.locator('#audio-refresh').click();
    await expect(page.locator('#audio-error')).toBeHidden();
    const audio = await page.evaluate(async () => (await window.compusync.bootstrap()).audio);
    expect(audio.available).toBe(true);
    expect(audio.canStart).toBe(false);
    expect(await page.locator('#audio-output option').count()).toBe(audio.outputs.filter((output) => !audio.routing.buses.some((bus) => bus.id === output.id)).length + 1);
    expect(await page.evaluate(() => window.compusync.command('audio-start'))).toMatchObject({ ok: false });
    expect(await page.evaluate(() => window.compusync.command('audio-output', { id: 'missing-device' }))).toMatchObject({ ok: false });
    await expect(page.locator('#audio-warning')).toBeHidden();
    const warning = 'screenpipe-app.exe has an audio session. This may be a recorder.';
    await page.evaluate((warning) => {
      renderAudio({ ...details, audio: { ...details.audio, active: true, phase: 'streaming', warning } });
    }, warning);
    await expect(page.locator('#audio-warning')).toHaveText(warning);
    await expect(page.locator('#audio-stop')).toBeEnabled();
    await page.evaluate(() => renderAudio(details));
    await expect(page.locator('#audio-warning')).toBeHidden();
    await page.screenshot({ path: 'test-results/audio-manager-windows.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    if (app) await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
