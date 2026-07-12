import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { hasRenderedRoom, inspectCanvas, type CanvasInspection } from './canvas-inspection';

const execFileAsync = promisify(execFile);

async function openReady(page: Page, url = '/') {
  await page.goto(url);
  await expect(page.getByRole('status')).toContainText('Ready', { timeout: 15_000 });
  await expect(page.locator('.game-surface canvas')).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('agent-cat-house.session-id'))).toBeTruthy();
}

async function submitAndWaitForTurn(page: Page, command: string, status = 200) {
  const request = page.waitForRequest((candidate) => candidate.url().endsWith('/turns'));
  const response = page.waitForResponse((candidate) => candidate.url().endsWith('/turns'));
  await page.getByLabel('Tell the cat what to do').fill(command);
  await page.getByRole('button', { name: 'Send command' }).click();
  await request;
  expect((await response).status()).toBe(status);
}

async function sessionId(page: Page): Promise<string> {
  const id = await page.evaluate(() => localStorage.getItem('agent-cat-house.session-id'));
  if (!id) throw new Error('Missing browser session ID');
  return id;
}

async function loadSession(request: APIRequestContext, id: string) {
  const response = await request.get(`http://127.0.0.1:8787/api/sessions/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

function expectFurnitureInCanvas(inspection: CanvasInspection) {
  for (const cluster of Object.values(inspection.furniture)) {
    expect(cluster.pixels).toBeGreaterThan(1_000);
    expect(cluster.minX).toBeGreaterThanOrEqual(0);
    expect(cluster.minY).toBeGreaterThanOrEqual(0);
    expect(cluster.maxX).toBeLessThan(inspection.width);
    expect(cluster.maxY).toBeLessThan(inspection.height);
  }
}

test('creates a durable session and renders a nonblank Phaser room', async ({ page }) => {
  await openReady(page);
  await page.getByLabel('Tell the cat what to do').focus();
  await expect(page.getByLabel('Tell the cat what to do')).toBeFocused();
  const sessionId = await page.evaluate(() => localStorage.getItem('agent-cat-house.session-id'));
  expect(sessionId).toBeTruthy();
  const rendered = await inspectCanvas(page);
  expect(hasRenderedRoom(rendered)).toBe(true);
  expectFurnitureInCanvas(rendered);
  expect(rendered.cat).not.toBeNull();

  await page.reload();
  await expect(page.getByRole('status')).toContainText('Ready');
  expect(await page.evaluate(() => localStorage.getItem('agent-cat-house.session-id'))).toBe(sessionId);
});

test('executes a window command with rendered movement and bubble, then persists conversation and memory', async ({ page }) => {
  await openReady(page);
  const before = await inspectCanvas(page);
  expect(before.cat).not.toBeNull();
  await submitAndWaitForTurn(page, 'go to the window');
  await expect(page.getByRole('status')).toContainText('Acting');
  const actingFrame = await inspectCanvas(page);
  expect(actingFrame.bubble).not.toBeNull();
  await expect.poll(() => inspectCanvas(page).then((visible) =>
    visible.bubble !== null
    && visible.bubble.pixels > 200
    && visible.bubble.textPixels > 10,
  )).toBe(true);
  await expect(page.getByRole('status')).toContainText('Ready', { timeout: 15_000 });
  const after = await inspectCanvas(page);
  expect(after.cat).not.toBeNull();
  expect(Math.abs(after.cat!.centroidX - before.cat!.centroidX)).toBeGreaterThan(40);
  expect(Math.abs(after.cat!.centroidY - before.cat!.centroidY)).toBeGreaterThan(40);

  await page.reload();
  await expect(page.getByRole('status')).toContainText('Ready');
  await page.getByRole('button', { name: 'Open conversation' }).click();
  await expect(page.getByRole('dialog')).toContainText('go to the window');
  await expect(page.getByRole('dialog')).toContainText('I will take a look by the window.');
  await page.getByRole('button', { name: 'Close conversation' }).click();
  await page.getByRole('button', { name: 'Open memories' }).click();
  await expect(page.getByRole('dialog')).toContainText('The player asked me to visit the window.');
  await page.getByRole('button', { name: 'Close memories' }).click();
  await expect(page.getByRole('button', { name: 'Open memories' })).toBeFocused();
});

test('opens the rendered arcade placeholder and restores the same persisted room', async ({ page, request }) => {
  await openReady(page);
  const room = await inspectCanvas(page);
  const id = await sessionId(page);
  await submitAndWaitForTurn(page, 'open the arcade');
  await expect.poll(async () => {
    const arcade = await inspectCanvas(page);
    return arcade.darkRatio > room.darkRatio + 0.15
      && arcade.goldPixels > 500
      && arcade.hash !== room.hash;
  }).toBe(true);
  await expect(page.getByRole('status')).toContainText('Ready', { timeout: 15_000 });
  const persistedBeforeReturn = await loadSession(request, id);
  await page.keyboard.press('Enter');
  await expect.poll(() => inspectCanvas(page).then(hasRenderedRoom)).toBe(true);
  const restored = await inspectCanvas(page);
  expectFurnitureInCanvas(restored);
  expect(restored.darkRatio).toBeLessThan(room.darkRatio + 0.08);
  const persistedAfterReturn = await loadSession(request, id);
  expect(persistedAfterReturn.session.id).toBe(id);
  expect(persistedAfterReturn.world).toEqual(persistedBeforeReturn.world);
});

test('prevents a concurrent submit and supports cancellation', async ({ page }) => {
  let releaseTurn!: () => void;
  const turnReleased = new Promise<void>((resolve) => { releaseTurn = resolve; });
  let abortTurn = false;
  const turnRequests: string[] = [];
  await page.route('**/turns', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    turnRequests.push(`${route.request().url()} ${route.request().postData() ?? ''}`);
    await turnReleased;
    if (abortTurn) {
      await route.abort('aborted');
    } else {
      await route.continue();
    }
  });
  await openReady(page);
  const input = page.getByLabel('Tell the cat what to do');
  await input.fill('go to the window');
  await page.getByRole('button', { name: 'Send command' }).click();
  await expect(page.getByRole('button', { name: 'Cancel current request' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send command' })).toHaveCount(0);
  await expect(input).toBeDisabled();
  await expect.poll(() => turnRequests.length).toBe(1);
  await page.getByRole('button', { name: 'Cancel current request' }).click();
  abortTurn = true;
  releaseTurn();
  await expect(page.getByRole('button', { name: 'Cancel current request' })).toHaveCount(0);
  await expect(input).toBeEnabled();
});

test('uses a server fallback when provider configuration is unavailable', async ({ page, request }) => {
  const health = await request.get('http://127.0.0.1:8788/health');
  expect(health.status()).toBe(503);
  expect((await health.json()).checks.config).toBe(false);
  await openReady(page, 'http://127.0.0.1:5174');
  await submitAndWaitForTurn(page, 'go to the window', 503);
  await expect(page.getByRole('status')).toContainText('Provider error');
  await expect.poll(() => inspectCanvas(page).then((fallback) =>
    fallback.bubble !== null
    && fallback.bubble.pixels > 200
    && fallback.bubble.textPixels > 10,
  )).toBe(true);
});

test('replaying an observed action result is idempotent', async ({ page, request }) => {
  let delivery: { url: string; body: string } | undefined;
  page.on('request', (outgoing) => {
    if (outgoing.url().endsWith('/action-results')) {
      delivery = { url: outgoing.url(), body: outgoing.postData() ?? '' };
    }
  });
  await openReady(page);
  await submitAndWaitForTurn(page, 'go to the window');
  await expect(page.getByRole('status')).toContainText('Ready', { timeout: 15_000 });
  await expect.poll(() => delivery).toBeTruthy();
  const id = await sessionId(page);
  const beforeReplay = await durableActionState(id);
  expect(beforeReplay.eventCount).toBe(1);
  const replay = await request.post(delivery!.url, {
    data: JSON.parse(delivery!.body),
    headers: { origin: 'http://127.0.0.1:5173' },
  });
  expect(replay.status()).toBe(202);
  expect(await replay.json()).toEqual({ accepted: 1 });
  const afterReplay = await durableActionState(id);
  expect(afterReplay).toEqual(beforeReplay);
});

async function durableActionState(id: string) {
  expect(id).toMatch(/^[A-Za-z0-9._:-]+$/);
  const databasePath = test.info().config.metadata.primaryDatabasePath;
  if (typeof databasePath !== 'string') throw new Error('Playwright primary database metadata is unavailable');
  const sql = [
    `SELECT COUNT(*) FROM events WHERE session_id = '${id}' AND type = 'actions.results.recorded';`,
    `SELECT quote(snapshot_json) || '|' || updated_at FROM world_states WHERE session_id = '${id}';`,
  ].join(' ');
  const { stdout } = await execFileAsync('/usr/bin/sqlite3', [databasePath, sql]);
  const [eventCount, worldIdentity] = stdout.trim().split('\n');
  return { eventCount: Number(eventCount), worldIdentity };
}

for (const viewport of [
  { name: 'desktop', width: 1_440, height: 900 },
  { name: 'compact desktop', width: 1_024, height: 768 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name} keeps the room and controls visible without overlap`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openReady(page);
    const rendered = await inspectCanvas(page);
    expect(hasRenderedRoom(rendered)).toBe(true);
    expectFurnitureInCanvas(rendered);
    expect(rendered.cat).not.toBeNull();
    const layout = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const canvas = rect('.game-surface canvas');
      const dock = rect('.command-dock');
      const tools = rect('.tool-strip');
      const buttons = [...document.querySelectorAll<HTMLButtonElement>('.tool-strip button, .command-dock button')]
        .map((button) => button.getBoundingClientRect());
      const textFits = [...document.querySelectorAll<HTMLElement>('.status-strip, .command-dock, button')]
        .every((element) => element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight);
      const imageRendering = getComputedStyle(document.querySelector('.game-surface canvas')!).imageRendering;
      return { canvas, dock, tools, buttons, textFits, imageRendering, width: innerWidth, height: innerHeight };
    });
    expect(layout.canvas.width).toBeGreaterThan(0);
    expect(layout.canvas.height).toBeGreaterThan(0);
    expect(layout.canvas.x).toBeGreaterThanOrEqual(0);
    expect(layout.canvas.right).toBeLessThanOrEqual(layout.width);
    expect(layout.dock.top).toBeGreaterThan(layout.tools.bottom);
    expect(layout.dock.bottom).toBeLessThanOrEqual(layout.height);
    expect(layout.textFits).toBe(true);
    expect(['pixelated', 'crisp-edges']).toContain(layout.imageRendering);
    for (const button of layout.buttons) {
      expect(button.width).toBeGreaterThanOrEqual(44);
      expect(button.height).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole('button', { name: 'Open memories' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const drawerLayout = await page.evaluate(() => {
      const drawer = document.querySelector('.edge-drawer')!.getBoundingClientRect();
      const dock = document.querySelector('.command-dock')!.getBoundingClientRect();
      const overlap = !(drawer.right <= dock.left || drawer.left >= dock.right || drawer.bottom <= dock.top || drawer.top >= dock.bottom);
      return {
        overlap,
        inert: document.querySelector('.app-content')?.hasAttribute('inert') ?? false,
        drawerZ: Number(getComputedStyle(document.querySelector('.edge-drawer')!).zIndex),
        overlayZ: Number(getComputedStyle(document.querySelector('.ui-overlay')!).zIndex),
      };
    });
    expect(drawerLayout.overlap && !(drawerLayout.inert && drawerLayout.drawerZ > drawerLayout.overlayZ)).toBe(false);
    await page.getByRole('button', { name: 'Close memories' }).click();

    await page.goto('http://127.0.0.1:5174');
    await expect(page.getByRole('status')).toContainText('Ready', { timeout: 15_000 });
    await submitAndWaitForTurn(page, 'go to the window', 503);
    const statusFits = await page.getByRole('status').evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      viewportWidth: innerWidth,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(statusFits.width).toBeLessThanOrEqual(statusFits.viewportWidth);
    expect(statusFits.scrollWidth).toBeLessThanOrEqual(statusFits.clientWidth);
    expect(statusFits.scrollHeight).toBeLessThanOrEqual(statusFits.clientHeight);
  });
}
