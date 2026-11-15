import { defineConfig } from 'vite';
import { normalizeBase } from '../../packages/core/paths';

export default defineConfig({
  base: `${normalizeBase(process.env.BASE_PATH)}app/`,
  build: { outDir: '../../site/app', emptyOutDir: true },
});
