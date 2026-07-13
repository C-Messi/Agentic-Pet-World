import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';

import { inspectCanvas, inspectTownCanvas } from './canvas-inspection';

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
  return response.json();
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
  expect(visibleTown.variedRatio).toBeGreaterThan(0.45);
  expect(visibleTown.distinctColorBuckets).toBeGreaterThan(20);
  await page.getByLabel('跟随桌宠').selectOption('resident-huihui');
  await expect(page.getByLabel('跟随桌宠')).toHaveValue('resident-huihui');
  await page.screenshot({
    path: testInfo.outputPath('town.png'),
    fullPage: true,
  });

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
