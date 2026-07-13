import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';

import { inspectCanvas, inspectTownCanvas } from './canvas-inspection';

const MAX_TOWN_SPRITE_FRAME_DIFF = 1_500;
const AUTONOMOUS_TOWN_TIMEOUT_MS = 35_000;

interface TownPosition {
  x: number;
  y: number;
}

interface TownResident {
  residentId: string;
  position: TownPosition;
}

interface TownProjection {
  version: number;
  lastEventSequence: number;
  residents: TownResident[];
}

interface TownSnapshot {
  projection: TownProjection;
  outings: Array<{ lastConfirmedAt: string }>;
}

interface TownEvent {
  id: string;
  sequence: number;
  type: string;
  participantIds: string[];
  payload: {
    residentId?: string;
    position?: TownPosition;
    standalone?: boolean;
  };
}

interface TownHistory {
  events: TownEvent[];
}

interface Metadata {
  primaryApiUrl: string;
  primaryDatabasePath: string;
  webUrl: string;
}

const metadata = () => test.info().config.metadata as unknown as Metadata;

async function openReady(page: Page) {
  await page.goto(metadata().webUrl);
  await expect(page.getByRole('status')).toContainText('Ready', {
    timeout: 15_000,
  });
  await expect(page.locator('.game-surface canvas')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem('agent-cat-house.session-id')),
    )
    .toBeTruthy();
}

async function sessionId(page: Page) {
  const value = await page.evaluate(() =>
    localStorage.getItem('agent-cat-house.session-id'),
  );
  if (!value) throw new Error('Missing browser session');
  return value;
}

async function town(request: APIRequestContext, id: string) {
  const response = await request.get(
    `${metadata().primaryApiUrl}/api/sessions/${id}/town`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as TownSnapshot;
}

async function townHistory(request: APIRequestContext, id: string) {
  const response = await request.get(
    `${metadata().primaryApiUrl}/api/sessions/${id}/town/history`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as TownHistory;
}

async function inspectTownBubbleCenter(page: Page) {
  return page
    .locator('.game-surface canvas')
    .evaluate(async (canvas: HTMLCanvasElement) => {
      const image = new Image();
      image.src = canvas.toDataURL('image/png');
      await image.decode();
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Town bubble inspection is unavailable');
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
      const mask = new Uint8Array(copy.width * copy.height);
      for (let index = 0, offset = 0; index < mask.length; index += 1) {
        const red = pixels[offset] ?? 0;
        const green = pixels[offset + 1] ?? 0;
        const blue = pixels[offset + 2] ?? 0;
        offset += 4;
        if (red >= 248 && green >= 240 && blue >= 210 && blue <= 230) {
          mask[index] = 1;
        }
      }

      const visited = new Uint8Array(mask.length);
      const centers: Array<{ center: number; pixels: number }> = [];
      for (let start = 0; start < mask.length; start += 1) {
        if (mask[start] !== 1 || visited[start] === 1) continue;
        const queue = [start];
        visited[start] = 1;
        let cursor = 0;
        let count = 0;
        let minX = copy.width;
        let minY = copy.height;
        let maxX = -1;
        let maxY = -1;
        while (cursor < queue.length) {
          const index = queue[cursor++]!;
          const x = index % copy.width;
          const y = Math.floor(index / copy.width);
          count += 1;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
          for (const next of [
            index - 1,
            index + 1,
            index - copy.width,
            index + copy.width,
          ]) {
            if (
              next < 0 ||
              next >= mask.length ||
              visited[next] === 1 ||
              mask[next] !== 1
            ) {
              continue;
            }
            if (Math.abs((next % copy.width) - x) > 1) continue;
            visited[next] = 1;
            queue.push(next);
          }
        }
        const width = maxX - minX + 1;
        const height = maxY - minY + 1;
        if (
          count >= 150 &&
          width >= 24 &&
          width <= 220 &&
          height >= 10 &&
          height <= 40 &&
          count / (width * height) >= 0.45
        ) {
          centers.push({ center: (minX + maxX) / 2, pixels: count });
        }
      }
      centers.sort((left, right) => right.pixels - left.pixels);
      return centers[0]?.center ?? null;
    });
}

async function observeTownBubbleSequence(page: Page) {
  const bubbleCenters: number[] = [];
  await expect
    .poll(
      async () => {
        const center = await inspectTownBubbleCenter(page);
        if (center === null) return bubbleCenters;
        if (
          bubbleCenters.every(
            (previousCenter) => Math.abs(center - previousCenter) > 8,
          )
        ) {
          bubbleCenters.push(center);
        }
        return bubbleCenters;
      },
      { timeout: AUTONOMOUS_TOWN_TIMEOUT_MS },
    )
    .toHaveLength(2);
}

async function advance(request: APIRequestContext, id: string, body: object) {
  const response = await request.post(
    `${metadata().primaryApiUrl}/api/sessions/${id}/town/advance`,
    { data: body },
  );
  if (!response.ok()) {
    throw new Error(
      `Town advance failed (${response.status()}): ${await response.text()}`,
    );
  }
  return response.json();
}

test('pet town vertical slice persists activities, recovery, and a sourced first-person story', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  testInfo.snapshotSuffix = '';
  const pageErrors: string[] = [];
  page.on('pageerror', (error) =>
    pageErrors.push(error.stack ?? error.message),
  );
  await page.setViewportSize({ width: 1_440, height: 900 });
  await openReady(page);
  const room = await inspectCanvas(page);
  const id = await sessionId(page);

  const releaseResponse = page.waitForResponse((response) =>
    response.url().endsWith('/town/release'),
  );
  await page.getByRole('button', { name: '放桌宠去小镇' }).click();
  expect((await releaseResponse).status()).toBe(200);
  const beforeAutonomy = await town(request, id);
  const initialPositions = new Map(
    beforeAutonomy.projection.residents.map(({ residentId, position }) => [
      residentId,
      position,
    ]),
  );
  const bubbleSequence = observeTownBubbleSequence(page);
  void bubbleSequence.catch(() => undefined);
  await page.waitForTimeout(500);
  expect(pageErrors).toEqual([]);
  await expect(page.getByRole('button', { name: '让桌宠回家' })).toBeVisible();
  await expect(page.getByLabel('跟随桌宠')).toHaveCount(1);
  await expect(page.getByLabel('跟随桌宠').locator('option')).toHaveCount(5);
  await expect
    .poll(() => inspectTownCanvas(page).then((result) => result.hash))
    .not.toBe(room.hash);
  const visibleTown = await inspectTownCanvas(page);
  expect(visibleTown.opaqueRatio).toBeGreaterThan(0.95);
  expect(visibleTown.variedRatio).toBeGreaterThan(0.55);
  expect(visibleTown.distinctColorBuckets).toBeGreaterThan(28);
  await expect(page.locator('.game-surface canvas')).toHaveScreenshot(
    'layered-town-desktop.png',
    { maxDiffPixels: MAX_TOWN_SPRITE_FRAME_DIFF },
  );
  await page.getByLabel('跟随桌宠').selectOption('resident-huihui');
  await expect(page.getByLabel('跟随桌宠')).toHaveValue('resident-huihui');
  await page.screenshot({
    path: testInfo.outputPath('town.png'),
    fullPage: true,
  });

  const movedResidentIds = new Set<string>();
  const autonomousState = async () => {
    const [current, history] = await Promise.all([
      town(request, id),
      townHistory(request, id),
    ]);
    const autonomousEvents = history.events.filter(
      ({ sequence }) => sequence > beforeAutonomy.projection.lastEventSequence,
    );
    for (const event of autonomousEvents) {
      if (event.type === 'resident.moved' && event.payload.residentId) {
        movedResidentIds.add(event.payload.residentId);
      }
    }
    for (const resident of current.projection.residents) {
      const initial = initialPositions.get(resident.residentId);
      if (
        initial !== undefined &&
        (resident.position.x !== initial.x || resident.position.y !== initial.y)
      ) {
        movedResidentIds.add(resident.residentId);
      }
    }
    return { autonomousEvents, current };
  };
  await expect
    .poll(
      async () => {
        const { autonomousEvents, current } = await autonomousState();
        return {
          projectionAdvanced:
            current.projection.version > beforeAutonomy.projection.version,
          hasConversation:
            autonomousEvents.filter(({ type }) => type === 'resident.spoke')
              .length >= 2,
          hasStandalonePlay: autonomousEvents.some(
            ({ participantIds, payload, type }) =>
              type === 'residents.played' &&
              participantIds.length === 2 &&
              payload.standalone === true,
          ),
        };
      },
      { timeout: AUTONOMOUS_TOWN_TIMEOUT_MS },
    )
    .toEqual({
      projectionAdvanced: true,
      hasConversation: true,
      hasStandalonePlay: true,
    });
  await expect
    .poll(
      async () => {
        await autonomousState();
        return beforeAutonomy.projection.residents
          .map(({ residentId }) => residentId)
          .filter((residentId) => !movedResidentIds.has(residentId));
      },
      { timeout: 75_000 },
    )
    .toEqual([]);

  const autonomousHistory = await townHistory(request, id);
  const autonomousEvents = autonomousHistory.events.filter(
    ({ sequence }) => sequence > beforeAutonomy.projection.lastEventSequence,
  );
  const standalonePlay = autonomousEvents.find(
    ({ participantIds, payload, type }) =>
      type === 'residents.played' &&
      participantIds.length === 2 &&
      payload.standalone === true,
  );
  expect(standalonePlay).toBeDefined();
  const encounterSpeech = autonomousEvents.filter(
    ({ participantIds, type }) =>
      type === 'resident.spoke' &&
      participantIds.length === 2 &&
      participantIds.every((residentId) =>
        standalonePlay!.participantIds.includes(residentId),
      ),
  );
  expect(encounterSpeech.length).toBeGreaterThanOrEqual(2);
  expect(
    encounterSpeech.slice(0, 2).map(({ payload }) => payload.residentId),
  ).toEqual(standalonePlay!.participantIds);
  await bubbleSequence;

  const beforeReloadHistory = await townHistory(request, id);
  await page.reload();
  await expect(page.getByRole('status')).toContainText('Ready', {
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: '让桌宠回家' })).toBeVisible();
  const afterReloadHistory = await townHistory(request, id);
  expect(
    new Set(afterReloadHistory.events.map(({ id: eventId }) => eventId)).size,
  ).toBe(afterReloadHistory.events.length);
  expect(
    new Set(afterReloadHistory.events.map(({ sequence }) => sequence)).size,
  ).toBe(afterReloadHistory.events.length);
  for (const event of beforeReloadHistory.events) {
    expect(
      afterReloadHistory.events.filter(
        ({ id: eventId, sequence }) =>
          eventId === event.id && sequence === event.sequence,
      ),
    ).toHaveLength(1);
  }

  const item = {
    id: 'public-music',
    sessionId: id,
    kind: 'interest',
    title: '夜晚歌单',
    content: '主人和我都喜欢轻柔的合成器音乐。',
    presetIconId: 'music',
    isPublic: true,
  };
  const saved = await request.put(
    `${metadata().primaryApiUrl}/api/sessions/${id}/town/showcase/${item.id}`,
    { data: { item } },
  );
  expect(saved.ok()).toBe(true);

  let snapshot = await town(request, id);
  const fortune = await advance(request, id, {
    baseVersion: snapshot.projection.version,
    intents: [
      {
        type: 'start-activity',
        actorId: 'resident-huihui',
        activityId: 'fortune-draw',
        invitedResidentIds: ['resident-mikan'],
      },
    ],
  });
  expect(fortune.events.map((event: { type: string }) => event.type)).toEqual(
    expect.arrayContaining([
      'fortune.started',
      'fortune.revealed',
      'fortune.interpreted',
    ]),
  );

  const build = await advance(request, id, {
    baseVersion: fortune.projection.version,
    intents: [
      {
        type: 'build',
        actorId: 'resident-lanlan',
        recipeId: 'street-lamp',
        plotId: 'plaza-north',
      },
    ],
  });
  expect(build.events.map((event: { type: string }) => event.type)).toEqual(
    expect.arrayContaining(['build.started', 'build.completed']),
  );
  expect(
    build.projection.modifications.filter(
      (entry: { recipeId: string }) => entry.recipeId === 'street-lamp',
    ),
  ).toHaveLength(1);

  const showcase = await request.get(
    `${metadata().primaryApiUrl}/api/sessions/${id}/town/showcase`,
  );
  expect((await showcase.json()).items).toEqual([item]);
  const stall = await advance(request, id, {
    baseVersion: build.projection.version,
    intents: [
      {
        type: 'open-stall',
        actorId: 'player-cat',
        stallId: 'stall-player-cat',
        showcaseItemIds: [item.id],
      },
    ],
  });
  expect(stall.events.map((event: { type: string }) => event.type)).toEqual([
    'stall.opened',
    'stall.visited',
    'stall.closed',
  ]);
  expect(
    stall.events.find(
      (event: { type: string }) => event.type === 'stall.visited',
    )?.participantIds,
  ).toHaveLength(2);
  await page.reload();
  await expect(page.getByRole('status')).toContainText('Ready', {
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: '让桌宠回家' })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('modified-town.png'),
    fullPage: true,
  });

  snapshot = await town(request, id);
  const outing = snapshot.outings[0];
  const recoveryWindowId = 'e2e-fixed-recovery';
  const recoveryBody = {
    residentId: 'player-cat',
    lastConfirmedAt: outing.lastConfirmedAt,
    recoveryWindowId,
  };
  const recoveredResponse = await request.post(
    `${metadata().primaryApiUrl}/api/sessions/${id}/town/recover`,
    { data: recoveryBody },
  );
  expect(recoveredResponse.ok()).toBe(true);
  const recovered = await recoveredResponse.json();
  expect(recovered.events.length).toBeGreaterThanOrEqual(0);
  expect(recovered.events.length).toBeLessThanOrEqual(5);
  expect(
    recovered.events.filter(
      (event: { type: string }) => event.type === 'build.completed',
    ).length,
  ).toBeLessThanOrEqual(1);
  const replay = await request.post(
    `${metadata().primaryApiUrl}/api/sessions/${id}/town/recover`,
    { data: recoveryBody },
  );
  expect(await replay.json()).toEqual(recovered);
  expect(
    recovered.projection.modifications.filter(
      (entry: { recipeId: string }) => entry.recipeId === 'street-lamp',
    ),
  ).toHaveLength(1);

  const recall = await request.post(
    `${metadata().primaryApiUrl}/api/sessions/${id}/town/recall`,
    { data: { residentId: 'player-cat' } },
  );
  expect(recall.ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole('status')).toContainText('Ready', {
    timeout: 15_000,
  });
  await expect(
    page.getByRole('button', { name: '放桌宠去小镇' }),
  ).toBeVisible();
  const cardsResponse = await request.get(
    `${metadata().primaryApiUrl}/api/sessions/${id}/town/experience-cards`,
  );
  const historyResponse = await request.get(
    `${metadata().primaryApiUrl}/api/sessions/${id}/town/history`,
  );
  const cards = (await cardsResponse.json()).experienceCards as Array<{
    body: string;
    sourceEventIds: string[];
  }>;
  const history = (await historyResponse.json()).events as Array<{
    id: string;
  }>;
  const historyIds = new Set(history.map(({ id: eventId }) => eventId));
  for (const card of cards) {
    expect(card.body).toMatch(/^I\b/);
    expect(
      card.sourceEventIds.every((eventId) => historyIds.has(eventId)),
    ).toBe(true);
  }
  if (cards.length > 0) {
    await page.getByRole('button', { name: '旅行见闻' }).click();
    await expect(page.getByRole('dialog')).toContainText(cards.at(-1)!.body);
  }
  await page.screenshot({
    path: testInfo.outputPath('return-card.png'),
    fullPage: true,
  });
});
