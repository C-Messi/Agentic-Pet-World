import { expect, test, type Page } from '@playwright/test';

type E2EState = {
  sessionId?: string;
  statuses: string[];
  phases: string[];
  bubbles: Array<{ kind: string; text?: string }>;
  actions: Array<{ phase: string; actionId: string }>;
  snapshots: Array<{ cat: { position: { x: number; y: number }; currentTargetId?: string } }>;
  activeSceneKeys: string[];
};

async function openReady(page: Page, url = '/') {
  await page.goto(url);
  await expect(page.getByRole('status')).toContainText('Ready', { timeout: 15_000 });
  await expect(page.locator('.game-surface canvas')).toBeVisible();
  await expect.poll(() => state(page).then((value) => value.sessionId)).toBeTruthy();
}

async function state(page: Page): Promise<E2EState> {
  return page.evaluate(() => (window as unknown as { __CAT_HOUSE_E2E__: E2EState }).__CAT_HOUSE_E2E__);
}

async function canvasHasPixels(page: Page) {
  return page.locator('.game-surface canvas').evaluate((canvas: HTMLCanvasElement) => {
    const sample = document.createElement('canvas');
    sample.width = 64;
    sample.height = 43;
    const context = sample.getContext('2d', { willReadFrequently: true });
    if (!context) return false;
    context.drawImage(canvas, 0, 0, sample.width, sample.height);
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
    let opaque = 0;
    let varied = 0;
    const first = `${pixels[0]}:${pixels[1]}:${pixels[2]}`;
    for (let index = 0; index < pixels.length; index += 4) {
      if ((pixels[index + 3] ?? 0) > 0) opaque += 1;
      if (`${pixels[index]}:${pixels[index + 1]}:${pixels[index + 2]}` !== first) varied += 1;
    }
    return opaque > 1_000 && varied > 300;
  });
}

async function submitAndWaitForTurn(page: Page, command: string, status = 200) {
  const request = page.waitForRequest((candidate) => candidate.url().endsWith('/turns'));
  const response = page.waitForResponse((candidate) => candidate.url().endsWith('/turns'));
  await page.getByLabel('Tell the cat what to do').fill(command);
  await page.getByRole('button', { name: 'Send command' }).click();
  await expect.poll(() => state(page).then((value) => value.phases)).toContain('turn-received');
  await request;
  expect((await response).status()).toBe(status);
}

test('creates a durable session and renders a nonblank Phaser room', async ({ page }) => {
  await openReady(page);
  await page.getByLabel('Tell the cat what to do').focus();
  await expect(page.getByLabel('Tell the cat what to do')).toBeFocused();
  const sessionId = await page.evaluate(() => localStorage.getItem('agent-cat-house.session-id'));
  expect(sessionId).toBeTruthy();
  await expect.poll(() => canvasHasPixels(page)).toBe(true);

  await page.reload();
  await expect(page.getByRole('status')).toContainText('Ready');
  expect(await page.evaluate(() => localStorage.getItem('agent-cat-house.session-id'))).toBe(sessionId);
});

test('executes a window command, shows speech then thought, persists conversation and memory', async ({ page }) => {
  await openReady(page);
  const before = (await state(page)).snapshots.at(-1)?.cat.position;
  await submitAndWaitForTurn(page, 'go to the window');

  await expect.poll(() => state(page).then((value) => value.statuses)).toContain('thinking');
  await expect.poll(() => state(page).then((value) => value.statuses)).toContain('acting');
  await expect(page.getByRole('status')).toContainText('Ready', { timeout: 15_000 });
  const after = await state(page);
  expect(after.snapshots.at(-1)?.cat.currentTargetId).toBe('window');
  expect(after.snapshots.at(-1)?.cat.position).not.toEqual(before);
  expect(after.bubbles.filter((bubble) => bubble.text).map((bubble) => bubble.kind)).toEqual(
    expect.arrayContaining(['speech', 'thought']),
  );
  expect(after.actions.some(({ phase }) => phase === 'completed')).toBe(true);

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

test('opens the registered arcade placeholder and returns without replacing session or world', async ({ page }) => {
  await openReady(page);
  const before = await state(page);
  await submitAndWaitForTurn(page, 'open the arcade');
  await expect.poll(() => state(page).then((value) => value.activeSceneKeys)).toContain('arcade-coming-soon');
  await page.keyboard.press('Enter');
  await expect.poll(() => state(page).then((value) => value.activeSceneKeys)).toContain('WorldScene');
  const after = await state(page);
  expect(after.sessionId).toBe(before.sessionId);
  expect(after.snapshots.at(-1)?.cat.currentTargetId).toBe('arcade');
});

test('prevents a concurrent submit and supports cancellation', async ({ page }) => {
  let releaseTurn!: () => void;
  const turnReleased = new Promise<void>((resolve) => { releaseTurn = resolve; });
  const turnRequests: string[] = [];
  await page.route('**/turns', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    turnRequests.push(`${route.request().url()} ${route.request().postData() ?? ''}`);
    await turnReleased;
    await route.continue();
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
  await expect.poll(() => state(page).then((value) => value.statuses)).toContain('cancelled');
  releaseTurn();
});

test('uses a server fallback when provider configuration is unavailable', async ({ page, request }) => {
  const health = await request.get('http://127.0.0.1:8788/health');
  expect(health.status()).toBe(503);
  expect((await health.json()).checks.config).toBe(false);
  await openReady(page, 'http://127.0.0.1:5174');
  await submitAndWaitForTurn(page, 'go to the window', 503);
  await expect(page.getByRole('status')).toContainText('Provider error');
  await expect.poll(() => state(page).then((value) => value.bubbles.some(
    (bubble) => bubble.text === 'I lost the thread for a moment, but I am still here with you.',
  ))).toBe(true);
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
  await expect(page.getByRole('status')).toContainText('Ready');
  await expect.poll(() => delivery).toBeTruthy();
  const replay = await request.post(delivery!.url, {
    data: JSON.parse(delivery!.body),
    headers: { origin: 'http://127.0.0.1:5173' },
  });
  expect(replay.status()).toBe(202);
  expect(await replay.json()).toEqual({ accepted: 1 });
});

for (const viewport of [
  { name: 'desktop', width: 1_440, height: 900 },
  { name: 'compact desktop', width: 1_024, height: 768 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name} keeps the room and controls visible without overlap`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openReady(page);
    await expect.poll(() => canvasHasPixels(page)).toBe(true);
    const layout = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const canvas = rect('.game-surface canvas');
      const dock = rect('.command-dock');
      const tools = rect('.tool-strip');
      const buttons = [...document.querySelectorAll<HTMLButtonElement>('.tool-strip button, .command-dock button')]
        .map((button) => button.getBoundingClientRect());
      const textFits = [...document.querySelectorAll<HTMLElement>('.status-strip, .command-dock, button')]
        .every((element) => element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight);
      return { canvas, dock, tools, buttons, textFits, width: innerWidth, height: innerHeight };
    });
    expect(layout.canvas.width).toBeGreaterThan(0);
    expect(layout.canvas.height).toBeGreaterThan(0);
    expect(layout.canvas.x).toBeGreaterThanOrEqual(0);
    expect(layout.canvas.right).toBeLessThanOrEqual(layout.width);
    expect(layout.dock.top).toBeGreaterThan(layout.tools.bottom);
    expect(layout.dock.bottom).toBeLessThanOrEqual(layout.height);
    expect(layout.textFits).toBe(true);
    for (const button of layout.buttons) {
      expect(button.width).toBeGreaterThanOrEqual(44);
      expect(button.height).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole('button', { name: 'Open memories' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Close memories' }).click();
  });
}
