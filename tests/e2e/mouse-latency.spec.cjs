'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('Latency Monitor has its own page, displays directional timings and clears unlinked readings', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'compusync-latency-e2e-'));
  const env = { ...process.env, COMPUSYNC_PROFILE: profile, COMPUSYNC_PORT: '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve('.')], env });
  try {
    await expect.poll(() => app.windows().some((page) => page.url().endsWith('settings.html'))).toBe(true);
    const page = app.windows().find((candidate) => candidate.url().endsWith('settings.html'));
    const connectionTab = page.getByRole('tab', { name: 'Connection', exact: true });
    const latencyTab = page.getByRole('tab', { name: 'Latency Monitor' });
    await expect(connectionTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#connection-page')).toBeVisible();
    await expect(page.locator('#latency-monitor-page')).toBeHidden();
    await latencyTab.click();
    await expect(latencyTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#connection-page')).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Latency Monitor' })).toBeVisible();
    await expect(page.locator('#mouse-latency-status')).toContainText('Connect both laptops');
    await page.evaluate(async () => {
      const next = await window.compusync.bootstrap();
      window.latencyTestDetails = {
        ...next, platform: 'win32', cursorSettings: { ...next.cursorSettings, linked: true },
        status: { ...next.status, phase: 'connected', peers: [{ name: 'Mac' }] },
        mouseLatency: { calibrating: false, networkRttMs: 4.2,
          incoming: { medianMs: 12.3, p95Ms: 35.6, uncertaintyMs: 2.1, samples: 40 },
          outgoing: { medianMs: 18.7, p95Ms: 65.4, uncertaintyMs: 2.1, samples: 40 } },
      };
      render(window.latencyTestDetails);
    });
    await expect(page.locator('#latency-mac-windows')).toHaveText('~12.3 ms');
    await expect(page.locator('#latency-windows-mac')).toHaveText('~18.7 ms');
    await expect(page.locator('#latency-windows-mac-p95')).toHaveText('~65.4 ms');
    await expect(page.locator('#mouse-latency-network')).toContainText('4.2 ms');
    await expect(page.locator('#latency-mac-windows')).toHaveAttribute('title', /40 samples; clock uncertainty about/);
    await page.evaluate(() => render({ ...window.latencyTestDetails, platform: 'darwin' }));
    await expect(page.locator('#latency-mac-windows')).toHaveText('~18.7 ms');
    await expect(page.locator('#latency-windows-mac')).toHaveText('~12.3 ms');
    await page.evaluate(() => render({ ...window.latencyTestDetails,
      cursorSettings: { ...window.latencyTestDetails.cursorSettings, linked: false } }));
    await expect(page.locator('#latency-mac-windows')).toHaveText('\u2014');
    await expect(page.locator('#latency-windows-mac-p95')).toHaveText('\u2014');
    await expect(page.locator('#mouse-latency-network')).toHaveText('');
    await latencyTab.press('ArrowLeft');
    await expect(connectionTab).toBeFocused();
    await expect(connectionTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#connection-page')).toBeVisible();
    await expect(page.locator('#latency-monitor-page')).toBeHidden();
    await page.locator('#layout-mac').scrollIntoViewIfNeeded();
    const mac = await page.locator('#layout-mac').boundingBox();
    expect(mac.width).toBeGreaterThan(0);
    expect(mac.height).toBeGreaterThan(0);
  } finally {
    await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
