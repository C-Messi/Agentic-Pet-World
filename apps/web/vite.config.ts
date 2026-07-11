import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  envDir: fileURLToPath(new URL('../../', import.meta.url)),
  envPrefix: 'VITE_',
  plugins: [react()],
});
