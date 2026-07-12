import type { FullConfig } from '@playwright/test';

import { removeE2ERunDirectory } from './temp-directory';

export default function globalTeardown(config: FullConfig): void {
  const directory = config.metadata.runDirectory;
  if (typeof directory !== 'string') {
    throw new Error('Playwright E2E run directory metadata is unavailable');
  }
  removeE2ERunDirectory(directory);
}
