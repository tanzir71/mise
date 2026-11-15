import { defineConfig } from 'astro/config';
import { normalizeBase } from '../../packages/core/paths.ts';

export default defineConfig({
  output: 'static',
  base: normalizeBase(process.env.BASE_PATH),
  site: process.env.PUBLIC_SITE_URL || 'https://tanzir71.github.io',
  trailingSlash: 'always',
  outDir: '../../site',
});
