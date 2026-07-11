import { defineConfig, devices } from '@playwright/test';

const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: 'html',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command:
        'pnpm --filter @cat-house/shared build && pnpm --filter @cat-house/server dev',
      url: 'http://127.0.0.1:8787/health',
      env: {
        ...inheritedEnv,
        PORT: '8787',
        USE_FAKE_LLM: 'true',
        WEB_ORIGIN: 'http://127.0.0.1:5173',
      },
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @cat-house/web dev --host 127.0.0.1',
      url: 'http://127.0.0.1:5173',
      env: {
        ...inheritedEnv,
        VITE_API_URL: 'http://127.0.0.1:8787',
      },
      reuseExistingServer: false,
    },
  ],
});
