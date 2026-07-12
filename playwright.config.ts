import { defineConfig, devices } from '@playwright/test';
import { randomInt } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { e2eDirectoryPrefix, removeE2ERunDirectory } from './tests/e2e/temp-directory';

const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);
const inheritedRunDirectory = process.env.E2E_RUN_DIRECTORY;
const runDirectory = inheritedRunDirectory ?? mkdtempSync(join(tmpdir(), e2eDirectoryPrefix));
if (inheritedRunDirectory === undefined) {
  process.env.E2E_RUN_DIRECTORY = runDirectory;
  process.once('exit', () => removeE2ERunDirectory(runDirectory));
}
const primaryDatabasePath = join(runDirectory, 'primary.sqlite');
const basePort = parseBasePort(process.env.E2E_BASE_PORT);
process.env.E2E_BASE_PORT = String(basePort);
const primaryApiUrl = `http://127.0.0.1:${basePort}`;
const degradedApiUrl = `http://127.0.0.1:${basePort + 1}`;
const webUrl = `http://127.0.0.1:${basePort + 2}`;
const degradedWebUrl = `http://127.0.0.1:${basePort + 3}`;
const browserChannel = process.env.E2E_BROWSER_CHANNEL;
if (browserChannel !== undefined && browserChannel !== 'chrome') {
  throw new Error('E2E_BROWSER_CHANNEL must be "chrome" when set');
}

export default defineConfig({
  testDir: './tests/e2e',
  metadata: { runDirectory, primaryDatabasePath, primaryApiUrl, degradedApiUrl, webUrl, degradedWebUrl },
  globalTeardown: './tests/e2e/global-teardown.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: 'html',
  use: {
    baseURL: webUrl,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: '**/mobile-touch.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        ...(browserChannel === 'chrome' ? { channel: 'chrome' as const } : {}),
      },
    },
    {
      name: 'mobile-touch',
      testMatch: '**/mobile-touch.spec.ts',
      use: {
        ...devices['Pixel 5'],
        ...(browserChannel === 'chrome' ? { channel: 'chrome' as const } : {}),
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @cat-house/server exec node --import tsx src/index.ts',
      url: `${primaryApiUrl}/health`,
      env: {
        ...inheritedEnv,
        PORT: String(basePort),
        DATABASE_URL: primaryDatabasePath,
        USE_FAKE_LLM: 'true',
        WEB_ORIGIN: webUrl,
      },
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @cat-house/server exec node --import tsx src/index.ts',
      url: `${degradedApiUrl}/live`,
      env: {
        ...inheritedEnv,
        PORT: String(basePort + 1),
        DATABASE_URL: join(runDirectory, 'degraded.sqlite'),
        USE_FAKE_LLM: 'false',
        LLM_BASE_URL: '',
        LLM_API_KEY: '',
        LLM_MODEL: '',
        WEB_ORIGIN: degradedWebUrl,
      },
      reuseExistingServer: false,
    },
    {
      command: `pnpm --filter @cat-house/web dev --host 127.0.0.1 --port ${basePort + 2}`,
      url: webUrl,
      env: {
        ...inheritedEnv,
        VITE_API_URL: primaryApiUrl,
        VITE_E2E: 'true',
      },
      reuseExistingServer: false,
    },
    {
      command: `pnpm --filter @cat-house/web dev --host 127.0.0.1 --port ${basePort + 3}`,
      url: degradedWebUrl,
      env: {
        ...inheritedEnv,
        VITE_API_URL: degradedApiUrl,
        VITE_E2E: 'true',
      },
      reuseExistingServer: false,
    },
  ],
});

function parseBasePort(value: string | undefined): number {
  if (value === undefined) return 20_000 + randomInt(0, 30_000);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_532) {
    throw new Error('E2E_BASE_PORT must be an integer from 1024 through 65532');
  }
  return port;
}
