import { cpSync } from 'node:fs';

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  noExternal: ['@cat-house/shared'],
  onSuccess: async () => {
    cpSync('content', 'dist/content', { recursive: true });
  },
});
