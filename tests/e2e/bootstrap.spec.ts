import { expect, test } from '@playwright/test';

test('starts the fake server and web application', async ({ page, request }) => {
  const health = await request.get('http://127.0.0.1:8787/health');

  expect(health.ok()).toBe(true);
  await page.goto('/');
  await expect(page.locator('#app')).toBeAttached();
});
