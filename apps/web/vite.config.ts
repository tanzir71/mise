import { defineConfig } from 'vite';
import { normalizeBase } from '../../packages/core/paths';
import { VitePWA } from 'vite-plugin-pwa';

const base = `${normalizeBase(process.env.BASE_PATH)}app/`;
export default defineConfig({
  base,
  plugins: [VitePWA({ manifest: false, injectRegister: false, registerType: 'prompt', includeAssets: ['mise-mark.svg'], workbox: { clientsClaim: true, navigateFallback: `${base}index.html`, globPatterns: ['**/*.{js,css,html,woff2,svg}'] } })],
  build: { outDir: '../../site/app', emptyOutDir: true },
});
