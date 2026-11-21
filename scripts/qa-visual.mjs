import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { compareImages } from './visual-diff.mjs';
import { writeVisualReport } from './visual-report.mjs';
import LZString from 'lz-string';
import { installPhoneAuthFixture } from '../tests/fixtures/phone-auth-browser.mjs';
import { installUploadReviewFixture } from '../tests/fixtures/install-upload-review.mjs';
import { installOperatorsFixture } from '../tests/fixtures/install-operators.mjs';
import {captureDeviceAccess,closeDeviceAccessVisual} from '../tests/fixtures/device-access-visual.mjs';
import {captureKitchenScreen,closeKitchenScreenVisual} from '../tests/fixtures/install-kitchen-ui.mjs';
import {captureRecoveryReview,captureOwnerResumeReview,captureLocalInboxReview,capturePendingJoinShare,captureOrderActionReview,captureMoneyActionReview,capturePurchaseActionReview,captureStockActionReview,captureCustomerActionReview,captureClosingActionReview,captureMoneyCurrencyReview,capturePendingCurrencyRecovery,closeRecoveryVisual} from '../tests/fixtures/install-recovery-visual.mjs';

const configPaths = process.argv.length>2 ? process.argv.slice(2) : readdirSync('qa/configs').filter(file => file.endsWith('.json')).sort().map(file => `qa/configs/${file}`);
const configs = configPaths.map(path => JSON.parse(readFileSync(path, 'utf8')));
const targets = configs.flatMap(config => config.pages.map(page => {
  const shared = (page.actionSets || []).flatMap(name => {
    if (!Array.isArray(config.actionSets?.[name])) throw new Error(`Unknown visual action set: ${name}`);
    return config.actionSets[name];
  });
  const publicShop=typeof page.publicShop==='string'?config.publicShops?.[page.publicShop]:page.publicShop;
  if(page.publicShop&&!publicShop)throw new Error(`Unknown public shop fixture: ${page.publicShop}`);
  return { ...page, publicShop, actions:[...shared,...(page.actions || [])], widths: page.widths || config.widths, heights: page.heights || config.heights, sections: page.sections || config.sections };
}));
const assets = JSON.parse(readFileSync('handover/exports/landing-assets.json', 'utf8'));
const base = `/${(process.env.BASE_PATH || '/').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
const origin = process.env.PREVIEW_URL || `http://127.0.0.1:4321${base}`;
const output = resolve(configs.length === 1 ? configs[0].output || 'qa' : 'qa');
for (const directory of ['screens', 'references', 'diffs']) mkdirSync(`${output}/${directory}`, { recursive: true });
let server;
let browser;
const rows = [];
const captureIds = new Set();
try {
  let available = false;
  try { available = (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* Start the local production preview below. */ }
  if (!available && !process.env.PREVIEW_URL) {
    server = spawn(process.execPath, ['scripts/serve.mjs'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    server.stderr.on('data', chunk => { error += chunk; });
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(origin)).ok) { available = true; break; } } catch { /* Wait for the server to listen. */ }
      if (server.exitCode !== null) throw new Error(`Preview failed: ${error}`);
      await new Promise(done => setTimeout(done, 100));
    }
  }
  if (!available) throw new Error(`Production preview unavailable at ${origin}. Run pnpm build first.`);
  browser = await chromium.launch();
  for (const target of targets) for (const width of target.widths) {
    const context = await browser.newContext({ viewport: { width, height: target.heights?.[width] || 1000 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const page = await context.newPage();
    if (target.phoneAuthFixture) await installPhoneAuthFixture(page);
    let clockInstalled = false,reviewFixtureInstalled=false;
    if ((target.actions || []).some(action => action.type === 'advance-time')) { await page.clock.install(); clockInstalled = true; }
    const targetUrl = new URL(target.path, origin);
    if (target.publicShop) targetUrl.hash = Buffer.from(LZString.compressToUint8Array(JSON.stringify(target.publicShop))).toString('base64url');
    await page.goto(targetUrl.href);
    if(target.deviceAccessFixture)await captureDeviceAccess(page,target.deviceAccessFixture);
    if(target.kitchenScreenFixture)await captureKitchenScreen(page,target.kitchenScreenFixture);
    if(target.scopeRecoveryFixture)await captureRecoveryReview(page);
    if(target.ownerResumeFixture)await captureOwnerResumeReview(page);
    if(target.localInboxFixture)await captureLocalInboxReview(page,typeof target.localInboxFixture==='string'?target.localInboxFixture:'review');
    if(target.pendingJoinShareFixture)await capturePendingJoinShare(page,target.pendingJoinShareFixture);
    if(target.orderActionReviewFixture)await captureOrderActionReview(page,target.orderActionReviewFixture);
    if(target.moneyActionReviewFixture)await captureMoneyActionReview(page,target.moneyActionReviewFixture);
    if(target.purchaseActionReviewFixture)await capturePurchaseActionReview(page,target.purchaseActionReviewFixture);
    if(target.stockActionReviewFixture)await captureStockActionReview(page,target.stockActionReviewFixture);
    if(target.customerActionReviewFixture)await captureCustomerActionReview(page,target.customerActionReviewFixture);
    if(target.closingActionReviewFixture)await captureClosingActionReview(page,target.closingActionReviewFixture);
    if(target.moneyCurrencyReviewFixture)await captureMoneyCurrencyReview(page);
    if(target.pendingCurrencyRecoveryFixture)await capturePendingCurrencyRecovery(page);
    await page.evaluate(() => document.fonts.ready);
    for (const action of target.actions || []) {
      const locator = page.locator(action.selector || 'body');
      if (action.type === 'click') await locator.click();
      else if (action.type === 'fill') await locator.fill(action.value);
      else if (action.type === 'reload') await page.reload();
      else if (action.type === 'select') await locator.selectOption(action.value);
      else if (action.type === 'press') await locator.press(action.value);
      else if (action.type === 'wait') await locator.waitFor({ state: action.state || 'visible' });
      else if (action.type === 'advance-time') {
        if (!Number.isSafeInteger(action.milliseconds) || action.milliseconds < 0 || action.milliseconds > 604800000) throw new Error('Visual time advance must be between zero and seven days.');
        if (!clockInstalled) { await page.clock.install(); clockInstalled = true; }
        await page.clock.fastForward(action.milliseconds);
      }
      else if(action.type==='operators'){
        if(action.value!=='restore')throw new Error('Use an explicit local operator recovery fixture.');
        await installOperatorsFixture(page);await page.evaluate(()=>window.miseOperatorsTest.restoreFixture());await page.reload();
      }
      else if(action.type==='upload-review'){
        if(!['arm','accept','removeOriginal','blockQueue'].includes(action.value))throw new Error('Use an explicit local upload-review fixture action.');
        if(!reviewFixtureInstalled){await installUploadReviewFixture(page);reviewFixtureInstalled=true;}
        await page.evaluate(value=>window.miseUploadReviewTest[value](),action.value);
      }
      else throw new Error(`Unknown capture action: ${action.type}`);
    }
    await page.evaluate(() => document.fonts.ready);
    const pageMetrics = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, overflow: document.documentElement.scrollWidth > innerWidth }));
    if (pageMetrics.overflow) throw new Error(`${target.id} overflows at ${width}px.`);
    for (const section of target.sections) {
      if (section.widths && !section.widths.includes(width)) continue;
      const referenceFile = section.reference || assets[target.referenceGroup]?.sectionReferences[section.referenceKey];
      if (!referenceFile) throw new Error(`Missing reference mapping: ${target.id}/${section.id}`);
      const referencePath = resolve('handover/exports', referenceFile);
      readFileSync(referencePath); // Missing exports are a failure; pixel differences are informational.
      const element = page.locator(section.selector);
      for (const img of await element.locator('img').all()) {
        if (!await img.isVisible()) continue;
        await img.scrollIntoViewIfNeeded();
        await img.evaluate(image => image.decode());
      }
      for (const strip of await element.locator('.day-shots').all()) await strip.evaluate(row => { row.scrollLeft = 0; });
      for (const panel of await element.locator('.order-detail-content').all()) await panel.evaluate(panel => { panel.scrollTop = 0; });
      const id = `${target.id}-${section.id}-${width}`;
      if (!/^[a-z0-9-]+$/.test(id) || captureIds.has(id)) throw new Error(`Invalid or duplicate capture id: ${id}`);
      captureIds.add(id);
      const screen = `screens/${id}.png`;
      const captureStyle = section.captureStyle || target.captureStyle || '';
      await element.screenshot({ path: `${output}/${screen}`, animations: 'disabled', style: '.skip-link{visibility:hidden}' + (section.selector !== '.site-header' && section.selector !== 'body' ? '.site-header{visibility:hidden}' : '') + captureStyle });
      const result = await compareImages(`${output}/${screen}`, referencePath, section.clip);
      const reference = `references/${id}.png`;
      const diff = `diffs/${id}.png`;
      writeFileSync(`${output}/${reference}`, result.reference);
      writeFileSync(`${output}/${diff}`, result.diff);
      rows.push({ id, page: target.id, section: section.id, width, url: targetUrl.href, screen, reference, diff, referenceFile, note: section.note || target.note || '', captureStyle, pageMetrics, ...result.metrics });
      console.log(`${id}: ${result.metrics.percent}% difference (informational)`);
    }
    await context.close();
  }
  const report = { title: configs.length === 1 ? configs[0].title : 'Mise UI — Figma comparison', generatedAt: new Date().toISOString(), configs: configPaths, rows };
  writeFileSync(`${output}/results.json`, JSON.stringify(report, null, 2) + '\n');
  writeVisualReport(output, report);
  console.log(`Visual QA: ${rows.length} comparisons → ${output}/report.html`);
  if(configPaths.some(path=>path.endsWith('/m20.json')))await import('./proof-public-fonts.mjs');
} finally {
  try { await browser?.close(); }
  finally { try { await closeRecoveryVisual(); } finally { try { await closeDeviceAccessVisual(); } finally { try { await closeKitchenScreenVisual(); } finally { server?.kill(); } } } }
}
