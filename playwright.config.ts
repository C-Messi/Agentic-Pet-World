import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);
const runDirectory = mkdtempSync(join(tmpdir(), 'agent-cat-house-e2e-'));

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: 'html',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
  webServer: [
    {
      command:
        'pnpm --filter @cat-house/shared build && pnpm --filter @cat-house/server exec node --import tsx src/index.ts',
      url: 'http://127.0.0.1:8787/health',
      env: {
        ...inheritedEnv,
        PORT: '8787',
        DATABASE_URL: join(runDirectory, 'primary.sqlite'),
        USE_FAKE_LLM: 'true',
        WEB_ORIGIN: 'http://127.0.0.1:5173',
      },
      reuseExistingServer: false,
    },
    {
      command:
        'pnpm --filter @cat-house/shared build && pnpm --filter @cat-house/server exec node --import tsx src/index.ts',
      url: 'http://127.0.0.1:8788/live',
      env: {
        ...inheritedEnv,
        PORT: '8788',
        DATABASE_URL: join(runDirectory, 'degraded.sqlite'),
        USE_FAKE_LLM: 'false',
        LLM_BASE_URL: '',
        LLM_API_KEY: '',
        LLM_MODEL: '',
        WEB_ORIGIN: 'http://127.0.0.1:5174',
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
    {
      command: 'pnpm --filter @cat-house/web dev --host 127.0.0.1 --port 5174',
      url: 'http://127.0.0.1:5174',
      env: {
        ...inheritedEnv,
        VITE_API_URL: 'http://127.0.0.1:8788',
      },
      reuseExistingServer: false,
    },
  ],
});
