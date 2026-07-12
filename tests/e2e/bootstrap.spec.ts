import { expect, test } from '@playwright/test';

test('starts the fake server and web application', async ({ page, request }) => {
  const primaryApiUrl = test.info().config.metadata.primaryApiUrl;
  if (typeof primaryApiUrl !== 'string') throw new Error('Primary API URL metadata is unavailable');
  const health = await request.get(`${primaryApiUrl}/health`);

  expect(health.ok()).toBe(true);
  await page.goto('/');
  await expect(page.locator('#app')).toBeAttached();
});
