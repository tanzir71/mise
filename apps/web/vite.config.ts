import { defaultFlags } from '../../packages/core/flags';
import { defineConfig } from 'vite';
import { normalizeBase } from '../../packages/core/paths';
import { VitePWA } from 'vite-plugin-pwa';
import { appManifest } from './pwa-manifest';
import {fileURLToPath} from 'node:url';
import {marketPacks} from '../../packages/core/packs';
import {publicShopBuild} from './public-shop-build';

const base = `${normalizeBase(process.env.BASE_PATH)}app/`;
export default defineConfig(({command})=>({
  base,
  define:{__PUBLIC_PAYMENTS__:JSON.stringify(Object.fromEntries(Object.entries(marketPacks).map(([market,pack])=>[market,[...new Set(['Cash',...pack['pay/wallets']])]])))},
  plugins: [VitePWA({ manifest: appManifest(base,defaultFlags.shareTarget), injectRegister: false, registerType: 'prompt', includeAssets: ['mise-mark.svg','apple-touch-icon.png','manifest-share.webmanifest'], strategies:'injectManifest',srcDir:'src',filename:'sw.ts',injectManifest:{globIgnores:['s/**'],globPatterns:['**/*.{js,css,html,woff2,svg}'],rollupFormat:'iife'} }),...(command==='serve'?[publicShopBuild(base)]:[])],
  build: { outDir: '../../site/app', emptyOutDir: true,modulePreload:{polyfill:false},rollupOptions:{input:{app:fileURLToPath(new URL('./index.html',import.meta.url))}} },
}));
