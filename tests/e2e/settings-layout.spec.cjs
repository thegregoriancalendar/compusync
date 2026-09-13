'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('screen editor snaps two laptops without permitting the Mac top seam', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'compusync-layout-e2e-'));
  const env = { ...process.env, COMPUSYNC_PROFILE: profile, COMPUSYNC_PORT: '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve('.')], env });
  try {
    await expect.poll(() => app.windows().some((page) => page.url().endsWith('settings.html'))).toBe(true);
    const page = app.windows().find((candidate) => candidate.url().endsWith('settings.html'));
    const mac = page.locator('#layout-mac');
    const windows = page.locator('#layout-windows');
    await mac.scrollIntoViewIfNeeded();
    await expect(page.locator('.blocked-edge')).toHaveCSS('background-color', 'rgb(210, 78, 78)');

    const macBox = await mac.boundingBox();
    const winBox = await windows.boundingBox();
    await page.mouse.move(macBox.x + macBox.width / 2, macBox.y + macBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(winBox.x + winBox.width + macBox.width, winBox.y + winBox.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator('#layout-description')).toContainText('Mac is right of Windows');

    const movedMac = await mac.boundingBox();
    const movedWin = await windows.boundingBox();
    await page.mouse.move(movedMac.x + movedMac.width / 2, movedMac.y + movedMac.height / 2);
    await page.mouse.down();
    await page.mouse.move(movedWin.x + movedWin.width / 2, movedWin.y - movedMac.height, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator('#layout-description')).toContainText('Mac is above Windows');
    await expect.poll(() => page.evaluate(() => window.compusync.bootstrap().then((value) => value.cursorSettings.macPosition)))
      .toBe('top');
  } finally {
    await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
