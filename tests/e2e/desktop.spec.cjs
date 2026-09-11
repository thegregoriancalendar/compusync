'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('one logical window crosses the seam, supports either drag bar, and keeps one shared desktop', async () => {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compusync-e2e-'));
  const apps = [];
  const errors = [];

  async function launch(name) {
    const env = { ...process.env, COMPUSYNC_PROFILE: path.join(profileRoot, name), COMPUSYNC_PORT: '0' };
    delete env.COMPUSYNC_BIND_HOST;
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await electron.launch({ args: [path.resolve('.')], env });
    apps.push(app);
    await expect.poll(() => app.windows().length).toBe(2);
    const windows = app.windows();
    const surface = windows.find((page) => page.url().endsWith('surface.html'));
    const settings = windows.find((page) => page.url().endsWith('settings.html'));
    for (const page of windows) page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
    await expect(settings.locator('#status')).toHaveText('Ready to pair');
    return { name, app, surface, settings };
  }

  const visible = (client) => client.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('surface.html')).isVisible());
  const nativeBounds = (client) => client.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('surface.html')).getBounds());
  const contentSize = (client) => client.surface.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const renderedCropWidth = (client) => client.surface.evaluate(() => document.getElementById('desktop').clientWidth);
  const getDetails = (client) => client.surface.evaluate(() => window.compusync.bootstrap());
  const getState = async (client) => (await getDetails(client)).state;
  const input = (client, action) => client.surface.evaluate((value) => window.compusync.input(value), action);
  const rectKey = (rect) => `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;

  async function beginDrag(client, label) {
    const current = await getState(client);
    const view = current.viewport;
    expect(view, `${client.name} needs a visible crop`).not.toBeNull();
    expect(view.y, `${client.name} needs a visible bar fragment`).toBeLessThan(36);
    const id = `e2e_${label}_${Date.now().toString(36)}`;
    const barBottom = Math.min(36, view.y + view.height);
    await input(client, {
      type: 'drag-start',
      id,
      offsetX: view.x + Math.min(100, Math.max(0, view.width - 1)),
      offsetY: view.y + Math.min(12, Math.max(0, barBottom - view.y - 1)),
    });
    await expect.poll(async () => (await getState(client)).drag?.id).toBe(id);
    return { id, seq: 0 };
  }

  async function moveDrag(client, transaction, dx, dy = 0) {
    const before = (await getState(client)).window.rect;
    let remainingX = dx;
    let remainingY = dy;
    while (remainingX || remainingY) {
      const stepX = Math.max(-500, Math.min(500, remainingX));
      const stepY = Math.max(-500, Math.min(500, remainingY));
      await input(client, { type: 'drag-move', id: transaction.id, seq: ++transaction.seq, dx: stepX, dy: stepY });
      remainingX -= stepX;
      remainingY -= stepY;
    }
    const expected = { ...before, x: before.x + dx, y: before.y + dy };
    await expect.poll(async () => rectKey((await getState(client)).window.rect)).toBe(rectKey(expected));
    return expected;
  }

  async function endDrag(client, transaction) {
    await input(client, { type: 'drag-end', id: transaction.id });
    await expect.poll(async () => (await getState(client)).drag).toBeNull();
  }

  async function assertHalfway(first, second) {
    await expect.poll(async () => Boolean((await getState(first)).viewport && (await getState(second)).viewport)).toBe(true);
    await expect.poll(() => visible(first)).toBe(true);
    await expect.poll(() => visible(second)).toBe(true);
    const firstState = await getState(first);
    const secondState = await getState(second);
    expect(secondState.window.rect).toEqual(firstState.window.rect);
    expect(firstState.viewport.x).toBe(0);
    expect(firstState.viewport.x + firstState.viewport.width).toBe(secondState.viewport.x);
    expect(secondState.viewport.x + secondState.viewport.width).toBe(firstState.window.rect.width);
    expect(firstState.viewport.width + secondState.viewport.width).toBe(firstState.window.rect.width);
    expect(firstState.viewport.height).toBe(firstState.window.rect.height);
    expect(secondState.viewport.height).toBe(secondState.window.rect.height);
    await expect.poll(() => renderedCropWidth(first)).toBe(firstState.viewport.width);
    await expect.poll(() => renderedCropWidth(second)).toBe(secondState.viewport.width);
    // Conversion to physical pixels at fractional Windows display scaling can
    // round the native/content window outward by one DIP. The explicitly sized
    // desktop above remains the exact crop used for rendering and input.
    expect(Math.abs((await contentSize(first)).width - firstState.viewport.width)).toBeLessThanOrEqual(1);
    expect(Math.abs((await contentSize(second)).width - secondState.viewport.width)).toBeLessThanOrEqual(1);
    expect(Math.abs((await contentSize(first)).height - firstState.viewport.height)).toBeLessThanOrEqual(1);
    expect(Math.abs((await contentSize(second)).height - secondState.viewport.height)).toBeLessThanOrEqual(1);
    expect(Math.abs((await nativeBounds(first)).width - firstState.viewport.width)).toBeLessThanOrEqual(2);
    expect(Math.abs((await nativeBounds(second)).width - secondState.viewport.width)).toBeLessThanOrEqual(2);
    return { firstState, secondState };
  }

  async function cursorProjection(client) {
    return client.surface.evaluate(async () => {
      const state = (await window.compusync.bootstrap()).state;
      const transform = new DOMMatrixReadOnly(getComputedStyle(document.getElementById('cursor')).transform);
      const contentOffsetY = Math.max(state.viewport.y, 36) - 36;
      return {
        localX: transform.m41,
        localY: transform.m42,
        worldX: transform.m41 + state.viewport.x,
        worldY: transform.m42 + contentOffsetY,
        expectedX: state.cursor.x * Math.max(1, state.window.rect.width - 24),
        expectedY: state.cursor.y * Math.max(1, state.window.rect.height - 36 - 30),
      };
    });
  }

  try {
    const first = await launch('first');
    const second = await launch('second');
    const invitation = await first.settings.locator('#invitation').inputValue();
    expect(invitation).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    await second.settings.locator('#join-tab').click();
    await second.settings.locator('#join-code').fill(invitation);
    await second.settings.locator('#join').click();
    await expect(first.settings.locator('#status')).toContainText('Connected to', { timeout: 15000 });
    await expect(second.settings.locator('#status')).toContainText('Connected to');

    const firstId = (await getDetails(first)).id;
    const secondId = (await getDetails(second)).id;
    await expect.poll(async () => (await getState(first)).topology.displays.length).toBe(2);
    await expect.poll(async () => (await getState(second)).layouts[secondId]?.activeDisplayId).toBeTruthy();
    await expect.poll(() => visible(first)).toBe(true);
    await expect.poll(() => visible(second)).toBe(false);
    const initial = await getState(first);
    expect(initial.version).toBe(2);
    expect(initial.viewport).toEqual({ x: 0, y: 0, width: initial.window.rect.width, height: initial.window.rect.height });
    expect((await getState(second)).viewport).toBeNull();
    await expect(first.surface.locator('#top-bar')).toBeVisible();
    await expect(first.surface.locator('#desktop')).toBeVisible();

    const peerDisplay = initial.topology.displays.find((display) => display.memberId === secondId);
    const hostDisplay = initial.topology.displays.find((display) => display.memberId === firstId);
    expect(initial.topology.edge).toBe('right');
    expect(peerDisplay.virtualWorkArea.x).toBe(hostDisplay.virtualWorkArea.x + hostDisplay.virtualWorkArea.width);
    const halfX = peerDisplay.virtualWorkArea.x - Math.floor(initial.window.rect.width / 2);

    // Stop exactly at the seam. Both native windows are only complementary
    // fragments of the same logical rectangle.
    let transaction = await beginDrag(first, 'host_half');
    await moveDrag(first, transaction, halfX - initial.window.rect.x);
    await endDrag(first, transaction);
    await assertHalfway(first, second);

    // The same normalized cursor must resolve to one full-world coordinate in
    // both crops, including when its graphic straddles the seam.
    await input(first, { type: 'enter', x: .5, y: .45 });
    await expect.poll(async () => (await getState(second)).cursor.active.includes(firstId)).toBe(true);
    await expect(first.surface.locator('#cursor')).toBeVisible();
    await expect(second.surface.locator('#cursor')).toBeVisible();
    const firstCursor = await cursorProjection(first);
    const secondCursor = await cursorProjection(second);
    expect(firstCursor.worldX).toBeCloseTo(firstCursor.expectedX, 5);
    expect(secondCursor.worldX).toBeCloseTo(secondCursor.expectedX, 5);
    expect(firstCursor.worldX).toBeCloseTo(secondCursor.worldX, 5);
    expect(firstCursor.worldY).toBeCloseTo(secondCursor.worldY, 5);
    await input(first, { type: 'move', dx: .03, dy: .02 });
    await expect.poll(async () => (await getState(second)).cursor.trail.length).toBeGreaterThan(0);
    await expect.poll(async () => JSON.stringify((await getState(second)).cursor.trail))
      .toBe(JSON.stringify((await getState(first)).cursor.trail));

    // Resume from the host's visible bar fragment and finish entirely on the
    // peer. The source renderer has to retain capture after its crop vanishes.
    const peerTargetX = peerDisplay.virtualWorkArea.x + Math.round((peerDisplay.virtualWorkArea.width - initial.window.rect.width) / 2);
    transaction = await beginDrag(first, 'host_finish');
    await moveDrag(first, transaction, peerTargetX - halfX);
    await endDrag(first, transaction);
    await expect.poll(() => visible(first)).toBe(false);
    await expect.poll(() => visible(second)).toBe(true);
    await expect.poll(async () => (await getState(first)).viewport).toBeNull();
    expect((await getState(second)).viewport).toEqual({ x: 0, y: 0, width: initial.window.rect.width, height: initial.window.rect.height });

    // Exercise the actual DOM drag bar and Pointer Lock gesture. A deterministic
    // reducer move proves Escape restores the transaction's exact origin even
    // when desktop automation cannot synthesize reliable locked raw movement.
    await second.surface.bringToFront();
    const handle = await second.surface.locator('#drag-handle').boundingBox();
    const escapeOrigin = (await getState(second)).window.rect;
    await second.surface.mouse.move(handle.x + Math.min(140, handle.width / 2), handle.y + 18);
    await second.surface.mouse.down();
    await expect.poll(() => second.surface.evaluate(() => document.pointerLockElement?.id)).toBe('drag-handle');
    await expect.poll(async () => (await getState(second)).drag?.owner).toBe(secondId);
    const liveDrag = (await getState(second)).drag;
    await input(second, { type: 'drag-move', id: liveDrag.id, seq: liveDrag.lastSeq + 1, dx: -64, dy: 0 });
    await expect.poll(async () => (await getState(second)).window.rect.x).toBe(escapeOrigin.x - 64);
    await second.surface.keyboard.press('Escape');
    await expect.poll(async () => (await getState(second)).drag).toBeNull();
    await expect.poll(async () => rectKey((await getState(second)).window.rect)).toBe(rectKey(escapeOrigin));
    await expect.poll(() => second.surface.evaluate(() => document.pointerLockElement)).toBeNull();
    await second.surface.mouse.up();

    // Pick up on the peer, reverse to the seam, release, then pick up the same
    // peer bar fragment again and complete the reverse crossing.
    transaction = await beginDrag(second, 'peer_half');
    await moveDrag(second, transaction, halfX - peerTargetX);
    await endDrag(second, transaction);
    await assertHalfway(first, second);
    const hostTargetX = hostDisplay.virtualWorkArea.x + Math.round((hostDisplay.virtualWorkArea.width - initial.window.rect.width) / 2);
    transaction = await beginDrag(second, 'peer_finish');
    await moveDrag(second, transaction, hostTargetX - halfX);
    await endDrag(second, transaction);
    await expect.poll(() => visible(first)).toBe(true);
    await expect.poll(() => visible(second)).toBe(false);
    expect((await getState(first)).viewport).toEqual({ x: 0, y: 0, width: initial.window.rect.width, height: initial.window.rect.height });

    // Interior capture remains independent from the bar's drag transaction.
    await first.surface.bringToFront();
    await first.surface.mouse.move(250, 200);
    await first.surface.mouse.move(320, 245, { steps: 5 });
    await first.surface.mouse.click(320, 245);
    await expect.poll(() => first.surface.evaluate(() => document.pointerLockElement?.id)).toBe('desktop');
    await first.surface.keyboard.press('Escape');
    await expect.poll(() => first.surface.evaluate(() => document.pointerLockElement)).toBeNull();
    await expect.poll(async () => (await getState(second)).cursor.trail.length).toBeGreaterThan(0);
    await expect.poll(async () => JSON.stringify((await getState(second)).cursor.trail))
      .toBe(JSON.stringify((await getState(first)).cursor.trail));

    // Closing is global. Reopening from the peer creates one peer-local surface,
    // and Bring here moves that same placement back without adding a copy.
    await first.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('surface.html')).close());
    await expect.poll(() => visible(first)).toBe(false);
    await expect.poll(() => visible(second)).toBe(false);
    await second.settings.bringToFront();
    await second.settings.locator('#open').click();
    await expect.poll(() => visible(first)).toBe(false);
    await expect.poll(() => visible(second)).toBe(true);
    expect((await getState(first)).viewport).toBeNull();
    await first.settings.bringToFront();
    await first.settings.locator('#place-here').click();
    await expect.poll(() => visible(first)).toBe(true);
    await expect.poll(() => visible(second)).toBe(false);
    expect((await getState(second)).viewport).toBeNull();

    await expect(first.surface.locator('#field')).toBeVisible();
    await expect(first.surface.locator('#open-settings')).toBeVisible();
    await expect(first.surface.locator('#close-window')).toBeVisible();
    expect(errors).toEqual([]);
    await first.settings.evaluate(() => window.scrollTo(0, 0));
    await first.settings.screenshot({ path: 'test-results/connection.png' });
    await first.surface.screenshot({ path: 'test-results/shared-grid.png' });
  } finally {
    await Promise.allSettled(apps.map((app) => app.close()));
    fs.rmSync(profileRoot, { recursive: true, force: true });
  }
});
