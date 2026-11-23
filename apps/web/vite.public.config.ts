import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';
import {normalizeBase} from '../../packages/core/paths';
import {marketPacks} from '../../packages/core/packs';
import {publicShopBuild,publicOrderTemplate} from './public-shop-build';

// Keep customer code independent of owner-only imports and chunk boundaries.
const base=`${normalizeBase(process.env.BASE_PATH)}app/`;
// Ephemeral progress, adapter methods. Persisted fields and HTML copy keys stay literal.
const privateKeys=/^(revision|lastAttempt|updatedAt|openedAt|copiedAt|failedAt|sentAt|sentChannel|prepare|choose|current|durable)$/;
export const publicShopConfig=(route:'s'|'o'='s')=>defineConfig({
  base,publicDir:false,
  define:{__PUBLIC_ORDERS__:route==='o',__PUBLIC_PAYMENTS__:JSON.stringify(Object.fromEntries(Object.entries(marketPacks).map(([market,pack])=>[market,[...new Set(['Cash',...pack['pay/wallets']])]])))},
  plugins:[...(route==='o'?[publicOrderTemplate()]:[]),publicShopBuild(base,route)],
  build:{minify:'terser',terserOptions:{compress:{passes:3},mangle:{properties:{regex:privateKeys,keep_quoted:true}}},outDir:'../../site/app',emptyOutDir:false,assetsDir:route+'/assets',modulePreload:{polyfill:false},rollupOptions:{input:{shop:fileURLToPath(new URL('./'+route+'/index.html',import.meta.url))}}},
});
export default publicShopConfig();
