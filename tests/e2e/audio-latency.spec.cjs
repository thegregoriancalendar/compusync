'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('audio latency shows either direction without linked cursors and clears stale timing', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'compusync-audio-latency-e2e-'));
  const env = { ...process.env, COMPUSYNC_PROFILE: profile, COMPUSYNC_PORT: '0', COMPUSYNC_BIND_HOST: '127.0.0.1' };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.')], env });
    await expect.poll(() => app.windows().some((page) => page.url().endsWith('settings.html'))).toBe(true);
    const page = app.windows().find((candidate) => candidate.url().endsWith('settings.html'));
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.getByRole('tab', { name: 'Latency Monitor' }).click();
    await expect(page.getByRole('heading', { name: 'Audio', exact: true })).toBeVisible();
    await expect(page.locator('#audio-latency-status')).toContainText('Connect both laptops');
    await expect(page.locator('#audio-latency-delay')).toHaveText('\u2014');
    await page.evaluate(async () => {
      const next = await window.compusync.bootstrap();
      window.audioLatencyDetails = {
        ...next, platform: 'win32', cursorSettings: { ...next.cursorSettings, linked: false },
        status: { ...next.status, phase: 'connected', peers: [{ name: 'Mac' }] },
        audio: { ...next.audio, active: true, role: 'sender', phase: 'streaming',
          timing: { clockReady: true, playing: true, delayMs: 175, rttMs: 4.2,
            uncertaintyMs: 2.1, phaseErrorMs: -0.25, latePackets: 3, resyncs: 2 } },
      };
      render(window.audioLatencyDetails);
    });
    await expect(page.locator('#audio-latency-status')).toContainText('Windows \u2192 Mac');
    await expect(page.locator('#audio-latency-delay')).toHaveText('~175.00 ms');
    await expect(page.locator('#audio-latency-rtt')).toHaveText('~4.20 ms');
    await expect(page.locator('#audio-latency-uncertainty')).toHaveText('\u00b12.10 ms');
    await expect(page.locator('#audio-latency-phase')).toHaveText('-0.25 ms');
    await expect(page.locator('#audio-latency-late')).toHaveText('3');
    await expect(page.locator('#audio-latency-resyncs')).toHaveText('2');
    await expect(page.locator('#latency-windows-mac')).toHaveText('\u2014');
    // Direction follows the source, including when viewing it on the receiver.
    await page.evaluate(() => render({ ...window.audioLatencyDetails, platform: 'darwin',
      audio: { ...window.audioLatencyDetails.audio, role: 'receiver', phase: 'receiving' } }));
    await expect(page.locator('#audio-latency-status')).toContainText('Windows \u2192 Mac');
    await page.evaluate(() => render({ ...window.audioLatencyDetails,
      audio: { ...window.audioLatencyDetails.audio, role: 'receiver', phase: 'receiving',
        timing: { ...window.audioLatencyDetails.audio.timing, delayMs: 200, phaseErrorMs: 0.5, latePackets: 0, resyncs: 0 } } }));
    await expect(page.locator('#audio-latency-status')).toContainText('Mac \u2192 Windows');
    await expect(page.locator('#audio-latency-delay')).toHaveText('~200.00 ms');
    await expect(page.locator('#audio-latency-phase')).toHaveText('+0.50 ms');
    await expect(page.locator('#audio-latency-late')).toHaveText('0');
    await page.screenshot({ path: 'test-results/audio-latency-monitor.png', fullPage: true });
    for (const condition of ['clock-lost', 'starting', 'stopped', 'disconnected', 'error']) {
      await page.evaluate((condition) => {
        const next = structuredClone(window.audioLatencyDetails);
        if (condition === 'clock-lost') next.audio.timing.clockReady = false;
        if (condition === 'starting') next.audio.timing.playing = false;
        if (condition === 'stopped') next.audio.active = false;
        if (condition === 'disconnected') next.status.phase = 'reconnecting';
        if (condition === 'error') { next.audio.phase = 'error'; next.audio.message = 'The audio output disconnected.'; }
        render(next);
      }, condition);
      for (const metric of ['delay', 'rtt', 'uncertainty', 'phase', 'late', 'resyncs']) {
        await expect(page.locator(`#audio-latency-${metric}`)).toHaveText('\u2014');
      }
    }
    await expect(page.locator('#audio-latency-status')).toHaveText('The audio output disconnected.');
    expect(errors).toEqual([]);
  } finally {
    if (app) await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
