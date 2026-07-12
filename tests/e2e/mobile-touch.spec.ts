import { expect, test } from '@playwright/test';

import { hasRenderedRoom, inspectCanvas } from './canvas-inspection';

test('touch user can command the cat and operate the memory drawer', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('Ready', { timeout: 15_000 });
  await expect.poll(() => inspectCanvas(page).then(hasRenderedRoom)).toBe(true);

  const turn = page.waitForResponse((response) => response.url().endsWith('/turns'));
  await page.getByLabel('Tell the cat what to do').fill('go to the window');
  await page.getByRole('button', { name: 'Send command' }).tap();
  expect((await turn).status()).toBe(200);
  await expect(page.getByRole('status')).toContainText('Ready', { timeout: 15_000 });

  await page.getByRole('button', { name: 'Open memories' }).tap();
  await expect(page.getByRole('dialog')).toContainText('The player asked me to visit the window.');
  await page.getByRole('button', { name: 'Close memories' }).tap();
  await expect(page.getByRole('button', { name: 'Open memories' })).toBeFocused();
});
