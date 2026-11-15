import lighthouse from 'lighthouse';
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const origin = process.env.PREVIEW_URL || 'http://127.0.0.1:4321/';
const browser = await chromium.launch({ args: ['--remote-debugging-port=9222'] });
const reports = [];
mkdirSync('docs/quality', { recursive: true });
mkdirSync('test-results', { recursive: true });
try {
  for (const region of ['bd', 'intl']) {
    const result = await lighthouse(`${origin}${region}/`, { port: 9222, output: 'html', logLevel: 'error', onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'] });
    if (!result) throw new Error('Lighthouse returned no report');
    writeFileSync(`test-results/lighthouse-${region}.html`, result.report);
    const { lhr } = result;
    const scores = Object.fromEntries(Object.entries(lhr.categories).map(([key, value]) => [key, Math.round(value.score * 100)]));
    const report = { region, url: lhr.finalDisplayedUrl, scores, cls: lhr.audits['cumulative-layout-shift'].numericValue, lcp: lhr.audits['largest-contentful-paint'].numericValue, fcp: lhr.audits['first-contentful-paint'].numericValue };
    reports.push(report);
    console.log(JSON.stringify(report));
    console.log(JSON.stringify(Object.values(lhr.audits).filter(a => a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== 'informative').map(a => ({ id: a.id, title: a.title, value: a.displayValue }))));
  }
  writeFileSync('docs/quality/lighthouse.json', JSON.stringify({ measuredAt: new Date().toISOString(), profile: 'Lighthouse default mobile, cold navigation, local static production build', reports }, null, 2) + '\n');
} finally { await browser.close(); }
