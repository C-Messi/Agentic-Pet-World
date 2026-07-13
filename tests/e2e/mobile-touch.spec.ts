import { expect, test, type Page } from '@playwright/test';

import {
  hasRenderedRoom,
  inspectCanvas,
  inspectTownCanvas,
} from './canvas-inspection';

const MAX_TOWN_SPRITE_FRAME_DIFF = 500;
const MIN_RESIDENT_PRIMARY_PIXELS = 300;
const RESIDENT_PRIMARY_RGB = {
  'player-cat': { red: 0xe9, green: 0x95, blue: 0x3d },
  'resident-mikan': { red: 0xf2, green: 0x9a, blue: 0x38 },
  'resident-huihui': { red: 0x89, green: 0x93, blue: 0x9e },
  'resident-lanlan': { red: 0x5e, green: 0x91, blue: 0xc9 },
  'resident-doubao': { red: 0xe8, green: 0xc9, blue: 0x8f },
} as const;

type ResidentId = keyof typeof RESIDENT_PRIMARY_RGB;

async function inspectResidentPrimaryPixels(
  page: Page,
): Promise<Record<ResidentId, number>> {
  return page
    .locator('.game-surface canvas')
    .evaluate(async (canvas: HTMLCanvasElement, residentColors) => {
      const image = new Image();
      image.src = canvas.toDataURL('image/png');
      await image.decode();
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Resident pixel inspection is unavailable');
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      const counts = Object.fromEntries(
        Object.keys(residentColors).map((residentId) => [residentId, 0]),
      ) as Record<string, number>;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const red = pixels[offset] ?? 0;
        const green = pixels[offset + 1] ?? 0;
        const blue = pixels[offset + 2] ?? 0;
        for (const [residentId, color] of Object.entries(residentColors)) {
          if (red === color.red && green === color.green && blue === color.blue)
            counts[residentId] = (counts[residentId] ?? 0) + 1;
        }
      }
      return counts;
    }, RESIDENT_PRIMARY_RGB) as Promise<Record<ResidentId, number>>;
}

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
  testInfo.snapshotSuffix = '';
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('Ready', {
    timeout: 15_000,
  });
  await expect.poll(() => inspectCanvas(page).then(hasRenderedRoom)).toBe(true);
  const room = await inspectTownCanvas(page);
  const releaseResponse = page.waitForResponse((response) =>
    response.url().endsWith('/town/release'),
  );
  await page.getByRole('button', { name: '放桌宠去小镇' }).tap();
  expect((await releaseResponse).status()).toBe(200);
  await expect(page.getByLabel('跟随桌宠')).toBeVisible();
  await page.getByLabel('跟随桌宠').selectOption('resident-mikan');
  await expect(page.getByLabel('跟随桌宠')).toHaveValue('resident-mikan');
  await expect
    .poll(() => inspectTownCanvas(page).then((result) => result.hash))
    .not.toBe(room.hash);
  await expect
    .poll(async () => {
      const rendered = await inspectTownCanvas(page);
      return (
        rendered.opaqueRatio > 0.95 &&
        rendered.variedRatio > 0.55 &&
        rendered.distinctColorBuckets > 28 &&
        rendered.variedBounds !== null
      );
    })
    .toBe(true);
  const residentPrimaryPixels = await inspectResidentPrimaryPixels(page);
  expect(Object.keys(residentPrimaryPixels)).toEqual([
    'player-cat',
    'resident-mikan',
    'resident-huihui',
    'resident-lanlan',
    'resident-doubao',
  ]);
  for (const [residentId, primaryPixels] of Object.entries(
    residentPrimaryPixels,
  )) {
    expect(primaryPixels, residentId).toBeGreaterThan(
      MIN_RESIDENT_PRIMARY_PIXELS,
    );
  }
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
    const interactiveControls = [
      ...topButtons.map((button, index) => ({
        label: `top:${button.getAttribute('aria-label') ?? index}`,
        rect: button.getBoundingClientRect(),
      })),
      { label: 'top:follow-control', rect: followControlRect },
      ...townToolButtons.map((button, index) => ({
        label: `town-tool:${button.getAttribute('aria-label') ?? index}`,
        rect: button.getBoundingClientRect(),
      })),
    ];
    const overlappingControlPairs: string[] = [];
    for (let first = 0; first < interactiveControls.length; first += 1) {
      for (
        let second = first + 1;
        second < interactiveControls.length;
        second += 1
      ) {
        const firstControl = interactiveControls[first]!;
        const secondControl = interactiveControls[second]!;
        if (overlaps(firstControl.rect, secondControl.rect)) {
          overlappingControlPairs.push(
            `${firstControl.label} <> ${secondControl.label}`,
          );
        }
      }
    }
    const safeContentOverlappingControls = interactiveControls
      .filter(({ rect: controlRect }) => overlaps(safeContent, controlRect))
      .map(({ label }) => label);
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
      interactiveControlLabels: interactiveControls.map(({ label }) => label),
      overlappingControlPairs,
      safeContentOverlappingControls,
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
  expect(layout.interactiveControlLabels).toEqual([
    'top:让桌宠回家',
    'top:Open conversation',
    'top:Open memories',
    'top:Open settings',
    'top:Mute sound',
    'top:follow-control',
    'town-tool:小镇动态',
    'town-tool:居民关系',
    'town-tool:旅行见闻',
    'town-tool:个性展摊',
  ]);
  expect(layout.overlappingControlPairs).toEqual([]);
  expect(layout.safeContentOverlappingControls).toEqual([]);
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
