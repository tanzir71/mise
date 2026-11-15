import { defineConfig } from 'astro/config';
import { normalizeBase } from '../../packages/core/paths.ts';

export default defineConfig({
  output: 'static',
  base: normalizeBase(process.env.BASE_PATH),
  site: process.env.PUBLIC_SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL}` : 'https://tanzir71.github.io'),
  trailingSlash: 'always',
  outDir: '../../site',
});
