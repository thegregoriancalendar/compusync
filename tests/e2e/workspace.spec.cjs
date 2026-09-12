'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('the host workspace and text editor stay authoritative when the shared surface moves', async () => {
  test.setTimeout(120_000);

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compusync-workspace-e2e-'));
  const profileRoot = path.join(fixtureRoot, 'profiles');
  const sourceRoot = path.join(fixtureRoot, 'sources');
  fs.mkdirSync(profileRoot, { recursive: true });
  fs.mkdirSync(sourceRoot, { recursive: true });

  const hostSource = path.join(sourceRoot, 'host-note.txt');
  const peerSource = path.join(sourceRoot, 'peer-note.txt');
  fs.writeFileSync(hostSource, 'Host fixture: caf\u00e9 \u03b1\u03b2\n', 'utf8');
  fs.writeFileSync(peerSource, 'Peer fixture: \u3053\u3093\u306b\u3061\u306f\n', 'utf8');

  const apps = [];
  const errors = [];
  const watchedPages = new WeakSet();

  function watchPage(page, owner) {
    if (watchedPages.has(page)) return;
    watchedPages.add(page);
    page.on('pageerror', (error) => errors.push(`${owner}: ${error.message}`));
  }

  async function launch(name) {
    const profile = path.join(profileRoot, name);
    const env = { ...process.env, COMPUSYNC_PROFILE: profile, COMPUSYNC_PORT: '0' };
    delete env.COMPUSYNC_BIND_HOST;
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await electron.launch({ args: [path.resolve('.')], env });
    apps.push(app);
    app.on('window', (page) => watchPage(page, name));
    await expect.poll(() => {
      const urls = app.windows().map((page) => page.url());
      return ['surface.html', 'settings.html', 'handoff-overlay.html']
        .every((file) => urls.some((url) => url.endsWith(file)));
    }, { timeout: 15_000 }).toBe(true);
    for (const page of app.windows()) watchPage(page, name);
    const surface = app.windows().find((page) => page.url().endsWith('surface.html'));
    const settings = app.windows().find((page) => page.url().endsWith('settings.html'));
    expect(surface).toBeTruthy();
    expect(settings).toBeTruthy();
    await expect(settings.locator('#status')).toHaveText('Ready to pair');
    await expect.poll(() => surface.evaluate(() => window.compusync.desktop.bootstrap().then((state) => state.version))).toBe(1);
    await surface.evaluate(() => {
      window.__e2eProgramFrames = [];
      window.compusync.desktop.onFrame((frame) => {
        window.__e2eProgramFrames.push({
          programId: frame.programId,
          serial: frame.serial,
          width: frame.width,
          height: frame.height,
          prefix: frame.data?.slice(0, 12),
        });
      });
    });
    return { name, profile, app, surface, settings };
  }

  async function desktopCall(client, method, ...args) {
    const result = await client.surface.evaluate(async ({ method, args }) => {
      return window.compusync.desktop[method](...args);
    }, { method, args });
    if (result?.ok === false) throw new Error(`${method}: ${result.error}`);
    return result?.value ?? result;
  }

  async function importLocalFile(client, nativePath, target = '') {
    // CDP-created File objects intentionally have no native Electron path, so
    // stub only the OS chooser result and exercise the real Import button/API.
    await client.app.evaluate(({ dialog }, filePaths) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
    }, [nativePath]);
    await client.surface.locator('#import-files').click();
    const name = path.basename(nativePath);
    await expect.poll(async () => {
      const listing = await desktopCall(client, 'list', target);
      return listing.some((entry) => entry.name === name);
    }).toBe(true);
    return (await desktopCall(client, 'list', target)).filter((entry) => entry.name === name);
  }

  const desktopState = (client) => client.surface.evaluate(() => window.compusync.desktop.bootstrap());
  const syncDetails = (client) => client.surface.evaluate(() => window.compusync.bootstrap());
  const syncInput = (client, action) => client.surface.evaluate((value) => window.compusync.input(value), action);
  const surfaceVisible = (client) => client.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('surface.html')).isVisible());

  async function moveSurfaceToPeer(host, peer) {
    const details = await syncDetails(host);
    const state = details.state;
    const peerId = (await syncDetails(peer)).id;
    const peerDisplay = state.topology.displays.find((display) => display.memberId === peerId);
    expect(peerDisplay).toBeTruthy();
    const targetX = peerDisplay.virtualWorkArea.x
      + Math.round((peerDisplay.virtualWorkArea.width - state.window.rect.width) / 2);
    const id = `workspace-e2e-${Date.now().toString(36)}`;
    await syncInput(host, { type: 'drag-start', id, offsetX: 100, offsetY: 12 });
    await expect.poll(async () => (await syncDetails(host)).state.drag?.id).toBe(id);
    let remaining = targetX - state.window.rect.x;
    let sequence = 0;
    while (remaining) {
      const dx = Math.max(-500, Math.min(500, remaining));
      await syncInput(host, { type: 'drag-move', id, seq: ++sequence, dx, dy: 0 });
      remaining -= dx;
    }
    await syncInput(host, { type: 'drag-end', id });
    await expect.poll(async () => (await syncDetails(host)).state.drag).toBeNull();
    await expect.poll(() => surfaceVisible(host)).toBe(false);
    await expect.poll(() => surfaceVisible(peer)).toBe(true);
    await expect.poll(async () => (await syncDetails(peer)).state.viewport?.x).toBe(0);
  }

  async function sendProgramInput(client, programId, input) {
    const response = await desktopCall(client, 'programInput', programId, input);
    expect(response.accepted).toBe(true);
  }

  async function replaceAndSave(client, programId, text, host) {
    const accelerator = process.platform === 'darwin' ? 'meta' : 'control';
    await sendProgramInput(client, programId, { type: 'keyDown', keyCode: 'a', modifiers: [accelerator] });
    await sendProgramInput(client, programId, { type: 'keyUp', keyCode: 'a', modifiers: [accelerator] });
    for (const character of text) {
      await sendProgramInput(client, programId, { type: 'keyDown', keyCode: character, modifiers: [] });
      await sendProgramInput(client, programId, { type: 'char', keyCode: character, modifiers: [] });
      await sendProgramInput(client, programId, { type: 'keyUp', keyCode: character, modifiers: [] });
    }
    const editor = host.app.windows().find((page) => page.url().endsWith('editor.html'));
    expect(editor).toBeTruthy();
    await expect.poll(() => editor.locator('#text').inputValue()).toBe(text);
    await sendProgramInput(client, programId, { type: 'keyDown', keyCode: 's', modifiers: [accelerator] });
    await sendProgramInput(client, programId, { type: 'keyUp', keyCode: 's', modifiers: [accelerator] });
    await expect.poll(() => editor.locator('#status').textContent()).toBe('Saved');
  }

  async function newestFrameSerial(client, programId) {
    return client.surface.evaluate((id) => Math.max(0, ...window.__e2eProgramFrames
      .filter((frame) => frame.programId === id)
      .map((frame) => frame.serial)), programId);
  }

  function readTextOrNull(filename) {
    try { return fs.readFileSync(filename, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  try {
    const host = await launch('host');
    const hostWorkspace = path.join(host.profile, 'workspace');

    const importedOnHost = await importLocalFile(host, hostSource);
    expect(importedOnHost).toHaveLength(1);
    expect(importedOnHost[0]).toMatchObject({ path: 'host-note.txt', type: 'file' });
    await expect(host.surface.locator('.file-entry[data-path="host-note.txt"]')).toBeVisible();
    expect(fs.readFileSync(path.join(hostWorkspace, 'host-note.txt'), 'utf8')).toBe('Host fixture: caf\u00e9 \u03b1\u03b2\n');

    await host.surface.locator('#new-folder').click();
    await expect(host.surface.locator('#name-dialog')).toBeVisible();
    await host.surface.locator('#entry-name').fill('Drafts');
    await host.surface.locator('#entry-name').press('Enter');
    await expect(host.surface.locator('.file-entry[data-path="Drafts"]')).toBeVisible();
    await host.surface.locator('.file-entry[data-path="Drafts"]').click();
    await host.surface.locator('#rename-entry').click();
    await host.surface.locator('#entry-name').fill('Renamed');
    await host.surface.locator('#entry-name').press('Enter');
    await expect(host.surface.locator('.file-entry[data-path="Renamed"]')).toBeVisible();
    expect(fs.statSync(path.join(hostWorkspace, 'Renamed')).isDirectory()).toBe(true);

    const program = await desktopCall(host, 'launchTextEditor', 'host-note.txt');
    expect(program).toMatchObject({ appId: 'text-editor', documentPath: 'host-note.txt' });
    await expect.poll(async () => (await desktopState(host)).programs.some((item) => item.id === program.id)).toBe(true);
    await expect(host.surface.locator('#program-window')).toBeVisible();
    await expect.poll(() => host.surface.locator('#program-frame').getAttribute('src')).toMatch(/^data:image\/jpeg;base64,\/9j/);
    await host.surface.locator('#program-frame').click({ position: { x: 260, y: 180 } });
    const localJpeg = await host.surface.locator('#program-frame').getAttribute('src');
    const localJpegBytes = Buffer.from(localJpeg.split(',')[1], 'base64');
    expect([...localJpegBytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const localFrameSize = await host.surface.locator('#program-frame')
      .evaluate((image) => ({ width: image.naturalWidth, height: image.naturalHeight }));
    expect(localFrameSize.width).toBeGreaterThan(0);
    expect(localFrameSize.height).toBeGreaterThan(0);

    await replaceAndSave(host, program.id, 'saved-on-host', host);
    await expect.poll(() => readTextOrNull(path.join(hostWorkspace, 'host-note.txt'))).toBe('saved-on-host');

    const peer = await launch('peer');
    const peerWorkspace = path.join(peer.profile, 'workspace');
    const invitation = await host.settings.locator('#invitation').inputValue();
    await peer.settings.locator('#join-tab').click();
    await peer.settings.locator('#join-code').fill(invitation);
    await peer.settings.locator('#join').click();
    await expect(host.settings.locator('#status')).toContainText('Connected to', { timeout: 15_000 });
    await expect(peer.settings.locator('#status')).toContainText('Connected to');
    await expect.poll(async () => (await syncDetails(host)).state.topology.displays.length).toBe(2);
    await expect.poll(async () => (await desktopState(peer)).programs.some((item) => item.id === program.id)).toBe(true);
    await expect.poll(async () => (await desktopCall(peer, 'list', '')).some((entry) => entry.path === 'host-note.txt')).toBe(true);

    expect(await surfaceVisible(host)).toBe(true);
    expect(await surfaceVisible(peer)).toBe(false);
    await moveSurfaceToPeer(host, peer);
    await expect(peer.surface.locator('#program-window')).toBeVisible();
    expect((await desktopState(peer)).programs.map((item) => item.id)).toContain(program.id);

    const importedFromPeer = await importLocalFile(peer, peerSource);
    expect(importedFromPeer).toHaveLength(1);
    expect(importedFromPeer[0]).toMatchObject({ path: 'peer-note.txt', type: 'file' });
    await expect.poll(() => readTextOrNull(path.join(hostWorkspace, 'peer-note.txt'))).toBe('Peer fixture: \u3053\u3093\u306b\u3061\u306f\n');
    expect(readTextOrNull(path.join(peerWorkspace, 'peer-note.txt'))).toBeNull();
    const peerPublicEntries = fs.readdirSync(peerWorkspace).filter((name) => name !== '.compusync');
    expect(peerPublicEntries).toEqual([]);

    const frameBeforePeerInput = await newestFrameSerial(peer, program.id);
    await peer.surface.locator('#program-frame').click({ position: { x: 300, y: 200 } });
    await replaceAndSave(peer, program.id, 'saved-on-peer', host);
    await expect.poll(() => newestFrameSerial(peer, program.id)).toBeGreaterThan(frameBeforePeerInput);
    await expect.poll(() => peer.surface.locator('#program-frame').getAttribute('src')).toMatch(/^data:image\/jpeg;base64,\/9j/);
    await expect.poll(() => readTextOrNull(path.join(hostWorkspace, 'host-note.txt'))).toBe('saved-on-peer');
    expect(readTextOrNull(path.join(peerWorkspace, 'host-note.txt'))).toBeNull();

    await peer.surface.locator('#close-program').click();
    await expect.poll(async () => (await desktopState(peer)).programs.length).toBe(0);
    await expect(peer.surface.locator('#program-window')).toBeHidden();

    await desktopCall(peer, 'delete', 'peer-note.txt');
    await desktopCall(peer, 'delete', 'Renamed');
    await desktopCall(peer, 'delete', 'host-note.txt');
    await expect.poll(async () => (await desktopCall(peer, 'list', '')).length).toBe(0);
    expect(readTextOrNull(path.join(hostWorkspace, 'peer-note.txt'))).toBeNull();
    expect(readTextOrNull(path.join(hostWorkspace, 'host-note.txt'))).toBeNull();
    expect(fs.existsSync(path.join(hostWorkspace, 'Renamed'))).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await Promise.allSettled(apps.map((app) => app.close()));
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
