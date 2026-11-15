import { defineConfig } from 'astro/config';
import { normalizeBase } from '../../packages/core/paths.ts';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  output: 'static',
  base: normalizeBase(process.env.BASE_PATH),
  site: process.env.PUBLIC_SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL}` : 'https://tanzir71.github.io'),
  trailingSlash: 'always',
  outDir: '../../site',
  vite: { resolve: { alias: { '@figma': fileURLToPath(new URL('../../handover/exports/', import.meta.url)) } } },
});
