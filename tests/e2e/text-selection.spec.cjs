'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function selectedText(page) {
  return page.evaluate(() => window.getSelection().toString());
}

test('released text selections survive periodic settings and message updates', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'compusync-selection-e2e-'));
  const env = { ...process.env, COMPUSYNC_PROFILE: profile, COMPUSYNC_PORT: '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.resolve('.')], env });
  try {
    await expect.poll(() => app.windows().some((page) => page.url().endsWith('settings.html'))).toBe(true);
    const page = app.windows().find((candidate) => candidate.url().endsWith('settings.html'));
    // Protocol mouse input still works; clicks elsewhere on the developer's desktop
    // must not land in this temporary app and invalidate its selection assertions.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().forEach((window) => window.setIgnoreMouseEvents(true));
    });
    await expect(page.locator('#status-description')).not.toHaveText('');
    await page.locator('#status-description').dblclick();
    const selected = await selectedText(page);
    expect(selected.length).toBeGreaterThan(0);
    // Reproduce the 1–2 second delay through the real preload IPC subscription.
    await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('settings.html'));
      const next = await window.webContents.executeJavaScript('window.compusync.bootstrap()');
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        window.webContents.send('sync:details', { ...next, mouseLatency: { calibrating: true, networkRttMs: i } });
      }
    });
    expect(await selectedText(page)).toBe(selected);

    // The remaining scenarios use controlled notices/connected state. Keep real
    // background discovery/audio details from overwriting those fixtures.
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('settings.html'));
      const send = window.webContents.send.bind(window.webContents);
      window.webContents.send = (channel, ...args) => {
        if (channel !== 'sync:details') send(channel, ...args);
      };
    });
    await page.evaluate(async () => {
      window.selectionDetails = {
        ...await window.compusync.bootstrap(),
        notices: [{ id: 'test', title: 'Permission needed', message: 'Allow access on the other laptop.' }],
      };
      render(window.selectionDetails);
    });
    await page.locator('#notices p').dblclick({ position: { x: 30, y: 10 } });
    const noticeSelection = await selectedText(page);
    expect(noticeSelection.length).toBeGreaterThan(0);
    await page.evaluate(() => render({ ...window.selectionDetails,
      notices: [...window.selectionDetails.notices, { id: 'second', message: 'Another notice.' }] }));
    expect(await selectedText(page)).toBe(noticeSelection);

    // Values that really change should wait until the user finishes selecting/copying them.
    await page.getByRole('tab', { name: 'Latency Monitor' }).click();
    await page.evaluate(() => {
      window.selectionDetails = {
        ...window.selectionDetails, id: 'windows', platform: 'win32',
        members: [{ id: 'mac', name: 'Mac', platform: 'darwin' }, { id: 'windows', name: 'Windows', platform: 'win32' }],
        status: { phase: 'connected', peers: [{ name: 'Mac' }] },
        cursorSettings: { ...window.selectionDetails.cursorSettings, linked: true },
        mouseLatency: { calibrating: false, incoming: { medianMs: 12.3, p95Ms: 20, uncertaintyMs: 1, samples: 10 } },
      };
      render(window.selectionDetails);
    });
    await page.locator('#latency-mac-windows').dblclick();
    const latencySelection = await selectedText(page);
    expect(latencySelection.length).toBeGreaterThan(0);
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('settings.html'));
      window.webContents.send('sync:mouse-latency', { calibrating: false,
        incoming: { medianMs: 18.4, p95Ms: 25, uncertaintyMs: 1, samples: 15 } });
    });
    await expect(page.locator('#latency-mac-windows-p95')).toHaveText('~25.0 ms');
    expect(await selectedText(page)).toBe(latencySelection);
    await expect(page.locator('#latency-mac-windows')).toHaveText('~12.3 ms');
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await expect(page.locator('#latency-mac-windows')).toHaveText('~18.4 ms');

    // Exercise the Messages renderer in the real browser with controlled history.
    await page.goto(pathToFileURL(path.resolve('src/renderer/messages.html')).href);
    await page.evaluate(() => {
      window.selectionConversation = { id: 'chat', name: 'Ada', participants: [], service: 'iMessage' };
      state = { available: true, conversations: [window.selectionConversation] };
      selectedId = 'chat';
      history = [{ id: 'one', fromMe: false, sender: 'Ada', text: 'Keep this selected.', sentAt: null }];
      renderState();
      renderMessages();
    });
    await page.locator('.bubble').dblclick();
    const messageSelection = await selectedText(page);
    expect(messageSelection.length).toBeGreaterThan(0);
    await page.evaluate(() => {
      renderMessages();
      history = [...history, { id: 'two', fromMe: true, text: 'A new reply.', sentAt: null, status: 'sent' }];
      renderMessages();
      renderState();
    });
    expect(await selectedText(page)).toBe(messageSelection);
    await expect(page.locator('.bubble')).toHaveCount(2);
  } finally {
    await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
