import { expect, test } from '@playwright/test';

import {
  hasRenderedRoom,
  inspectCanvas,
  inspectTownCanvas,
} from './canvas-inspection';

test('touch user can command the cat and operate the memory drawer', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('Ready', {
    timeout: 15_000,
  });
  await expect.poll(() => inspectCanvas(page).then(hasRenderedRoom)).toBe(true);

  const turn = page.waitForResponse((response) =>
    response.url().endsWith('/turns'),
  );
  await page.getByLabel('Tell the cat what to do').fill('go to the window');
  await page.getByRole('button', { name: 'Send command' }).tap();
  expect((await turn).status()).toBe(200);
  await expect(page.getByRole('status')).toContainText('Ready', {
    timeout: 15_000,
  });

  await page.getByRole('button', { name: 'Open memories' }).tap();
  await expect(page.getByRole('dialog')).toContainText(
    'The player asked me to visit the window.',
  );
  await page.getByRole('button', { name: 'Close memories' }).tap();
  await expect(
    page.getByRole('button', { name: 'Open memories' }),
  ).toBeFocused();
});

test('touch user can release and follow a town resident without obscuring the viewport', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('Ready', {
    timeout: 15_000,
  });
  await page.getByRole('button', { name: '放桌宠去小镇' }).tap();
  await expect(page.getByLabel('跟随桌宠')).toBeVisible();
  await page.getByLabel('跟随桌宠').selectOption('resident-mikan');
  await expect(page.getByLabel('跟随桌宠')).toHaveValue('resident-mikan');
  const canvas = await inspectTownCanvas(page);
  expect(canvas.opaqueRatio).toBeGreaterThan(0.95);
  expect(canvas.variedRatio).toBeGreaterThan(0.45);
  const layout = await page.evaluate(() => {
    const surface = document.querySelector('.game-surface canvas')!;
    const controls = [
      ...document.querySelectorAll<HTMLElement>('.icon-button'),
    ];
    const rect = surface.getBoundingClientRect();
    return {
      canvas: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      },
      viewport: { width: innerWidth, height: innerHeight },
      imageRendering: getComputedStyle(surface).imageRendering,
      controls: controls.map((control) => ({
        width: control.offsetWidth,
        height: control.offsetHeight,
      })),
    };
  });
  expect(layout.canvas.left).toBeGreaterThanOrEqual(0);
  expect(layout.canvas.top).toBeGreaterThanOrEqual(0);
  expect(layout.canvas.right).toBeLessThanOrEqual(layout.viewport.width);
  expect(layout.canvas.bottom).toBeLessThanOrEqual(layout.viewport.height);
  expect(['pixelated', 'crisp-edges']).toContain(layout.imageRendering);
  for (const control of layout.controls) {
    expect(control.width).toBeGreaterThanOrEqual(44);
    expect(control.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({
    path: testInfo.outputPath('mobile-town.png'),
    fullPage: true,
  });
});
