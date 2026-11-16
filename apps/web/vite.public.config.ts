import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';
import {normalizeBase} from '../../packages/core/paths';
import {marketPacks} from '../../packages/core/packs';
import {publicShopBuild} from './public-shop-build';

// Keep customer code independent of owner-only imports and chunk boundaries.
const base=`${normalizeBase(process.env.BASE_PATH)}app/`;
export default defineConfig({
  base,publicDir:false,
  define:{__PUBLIC_PAYMENTS__:JSON.stringify(Object.fromEntries(Object.entries(marketPacks).map(([market,pack])=>[market,[...new Set(['Cash',...pack['pay/wallets']])]])))},
  plugins:[publicShopBuild(base)],
  build:{outDir:'../../site/app',emptyOutDir:false,assetsDir:'s/assets',modulePreload:{polyfill:false},rollupOptions:{input:{shop:fileURLToPath(new URL('./s/index.html',import.meta.url))}}},
});
