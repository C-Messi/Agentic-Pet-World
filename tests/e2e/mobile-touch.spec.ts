import { expect, test } from '@playwright/test';

import {
  hasRenderedRoom,
  inspectCanvas,
  inspectTownCanvas,
  MAX_TOWN_SPRITE_FRAME_DIFF,
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
  expect(canvas.variedRatio).toBeGreaterThan(0.55);
  expect(canvas.distinctColorBuckets).toBeGreaterThan(28);
  expect(canvas.variedBounds).not.toBeNull();
  if (!canvas.variedBounds) throw new Error('Town content is not visible');
  const layout = await page.evaluate((contentBounds) => {
    const surface = document.querySelector('.game-surface canvas')!;
    const townControls = document.querySelector('.town-controls')!;
    const townToolStrip = document.querySelector('.town-tool-strip')!;
    const followControl = document.querySelector('.follow-control')!;
    const commandDock = document.querySelector('.command-dock')!;
    const controls = [
      ...document.querySelectorAll<HTMLElement>('.icon-button'),
    ];
    const topButtons = [
      ...document.querySelectorAll<HTMLElement>('.top-rail button'),
    ];
    const townToolButtons = [
      ...document.querySelectorAll<HTMLElement>('.town-tool-strip button'),
    ];
    const rect = surface.getBoundingClientRect();
    const townControlsRect = townControls.getBoundingClientRect();
    const townToolStripRect = townToolStrip.getBoundingClientRect();
    const followControlRect = followControl.getBoundingClientRect();
    const commandDockRect = commandDock.getBoundingClientRect();
    const overlaps = (first: DOMRect, second: DOMRect) =>
      first.left < second.right &&
      first.right > second.left &&
      first.top < second.bottom &&
      first.bottom > second.top;
    const withinViewport = (bounds: DOMRect) =>
      bounds.left >= 0 &&
      bounds.top >= 0 &&
      bounds.right <= innerWidth &&
      bounds.bottom <= innerHeight;
    const style = getComputedStyle(surface);
    const contentScale = Math.min(
      rect.width / surface.width,
      rect.height / surface.height,
    );
    const renderedWidth = surface.width * contentScale;
    const renderedHeight = surface.height * contentScale;
    const renderedLeft = rect.left + (rect.width - renderedWidth) / 2;
    const renderedTop = rect.top + (rect.height - renderedHeight) / 2;
    const safeContent = new DOMRect(
      renderedLeft + contentBounds.minX * contentScale,
      renderedTop + contentBounds.minY * contentScale,
      (contentBounds.maxX - contentBounds.minX + 1) * contentScale,
      (contentBounds.maxY - contentBounds.minY + 1) * contentScale,
    );
    return {
      canvas: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      },
      viewport: { width: innerWidth, height: innerHeight },
      imageRendering: style.imageRendering,
      objectFit: style.objectFit,
      objectPosition: style.objectPosition,
      safeContentOverlapsCommandDock: overlaps(safeContent, commandDockRect),
      townControlsOverlapCommandDock: overlaps(
        townControlsRect,
        commandDockRect,
      ),
      townToolStripOverlapCommandDock: overlaps(
        townToolStripRect,
        commandDockRect,
      ),
      topButtonOverlapsCommandDock: topButtons.some((button) =>
        overlaps(button.getBoundingClientRect(), commandDockRect),
      ),
      townToolButtonOverlapsCommandDock: townToolButtons.some((button) =>
        overlaps(button.getBoundingClientRect(), commandDockRect),
      ),
      followOverlapsTopButton: topButtons.some((button) =>
        overlaps(followControlRect, button.getBoundingClientRect()),
      ),
      townControlsOverlapTownToolStrip: overlaps(
        townControlsRect,
        townToolStripRect,
      ),
      controlsWithinViewport: [
        townControlsRect,
        townToolStripRect,
        followControlRect,
        ...topButtons.map((button) => button.getBoundingClientRect()),
        ...townToolButtons.map((button) => button.getBoundingClientRect()),
      ].every(withinViewport),
      controls: controls.map((control) => ({
        width: control.offsetWidth,
        height: control.offsetHeight,
      })),
    };
  }, canvas.variedBounds);
  expect(layout.canvas.left).toBeGreaterThanOrEqual(0);
  expect(layout.canvas.top).toBeGreaterThanOrEqual(0);
  expect(layout.canvas.right).toBeLessThanOrEqual(layout.viewport.width);
  expect(layout.canvas.bottom).toBeLessThanOrEqual(layout.viewport.height);
  expect(layout.objectFit).toBe('contain');
  expect(layout.objectPosition).toBe('50% 50%');
  expect(layout.safeContentOverlapsCommandDock).toBe(false);
  expect(layout.townControlsOverlapCommandDock).toBe(false);
  expect(layout.townToolStripOverlapCommandDock).toBe(false);
  expect(layout.topButtonOverlapsCommandDock).toBe(false);
  expect(layout.townToolButtonOverlapsCommandDock).toBe(false);
  expect(layout.followOverlapsTopButton).toBe(false);
  expect(layout.townControlsOverlapTownToolStrip).toBe(false);
  expect(layout.controlsWithinViewport).toBe(true);
  expect(['pixelated', 'crisp-edges']).toContain(layout.imageRendering);
  for (const control of layout.controls) {
    expect(control.width).toBeGreaterThanOrEqual(44);
    expect(control.height).toBeGreaterThanOrEqual(44);
  }
  await expect(page.locator('.game-surface canvas')).toHaveScreenshot(
    'layered-town-mobile.png',
    { maxDiffPixels: MAX_TOWN_SPRITE_FRAME_DIFF },
  );
  await page.screenshot({
    path: testInfo.outputPath('mobile-town.png'),
    fullPage: true,
  });
});
