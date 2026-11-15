import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const assets = JSON.parse(readFileSync('handover/exports/landing-assets.json', 'utf8'));
const font = readFileSync('packages/ui/node_modules/@fontsource/geist/files/geist-latin-400-normal.woff2').toString('base64');
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const browser = await chromium.launch();
try {
  for (const region of ['bd', 'intl']) {
    const copy = JSON.parse(readFileSync(`handover/copy/landing.${region}.json`, 'utf8'));
    const phone = readFileSync(`handover/exports/${assets[region].hero.src}`).toString('base64');
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html lang="en"><head><style>
      @font-face{font-family:Geist;src:url(data:font/woff2;base64,${font})}*{box-sizing:border-box}body{margin:0;background:#ededec;color:#141414;font-family:Geist,sans-serif;width:1200px;height:630px;overflow:hidden;display:flex;align-items:center;padding:48px 64px;gap:48px}main{width:640px}h1{font-size:56px;line-height:62px;letter-spacing:-.01em;font-weight:400;white-space:pre-line;margin:0}p{font-size:18px;line-height:28px;color:#6a6a67;margin:24px 0 0;max-width:590px}img{height:566px;width:auto;object-fit:contain;flex-shrink:0}
      </style></head><body><main><h1>${escape(copy.hero.headline)}</h1><p>${escape(copy.hero.lead)}</p></main><img src="data:image/png;base64,${phone}" alt="${escape(assets[region].hero.alt)}"></body></html>`);
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(img => img.decode())); });
    await page.screenshot({ path: `apps/landing/public/og-${region}.png` });
    await page.close();
    console.log(`OG ${region}: 1200×630, complete exported hero phone`);
  }
} finally { await browser.close(); }
