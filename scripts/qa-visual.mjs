import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { compareImages } from './visual-diff.mjs';
import { writeVisualReport } from './visual-report.mjs';

const configPaths = process.argv[2] ? [process.argv[2]] : readdirSync('qa/configs').filter(file => file.endsWith('.json')).sort().map(file => `qa/configs/${file}`);
const configs = configPaths.map(path => JSON.parse(readFileSync(path, 'utf8')));
const targets = configs.flatMap(config => config.pages.map(page => {
  const shared = (page.actionSets || []).flatMap(name => {
    if (!Array.isArray(config.actionSets?.[name])) throw new Error(`Unknown visual action set: ${name}`);
    return config.actionSets[name];
  });
  return { ...page, actions:[...shared,...(page.actions || [])], widths: page.widths || config.widths, heights: page.heights || config.heights, sections: page.sections || config.sections };
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
    const page = await browser.newPage({ viewport: { width, height: target.heights?.[width] || 1000 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    await page.goto(new URL(target.path, origin).href);
    await page.evaluate(() => document.fonts.ready);
    for (const action of target.actions || []) {
      const locator = page.locator(action.selector);
      if (action.type === 'click') await locator.click();
      else if (action.type === 'fill') await locator.fill(action.value);
      else if (action.type === 'select') await locator.selectOption(action.value);
      else if (action.type === 'press') await locator.press(action.value);
      else if (action.type === 'wait') await locator.waitFor({ state: action.state || 'visible' });
      else throw new Error(`Unknown capture action: ${action.type}`);
    }
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
      rows.push({ id, page: target.id, section: section.id, width, url: new URL(target.path, origin).href, screen, reference, diff, referenceFile, note: section.note || target.note || '', captureStyle, pageMetrics, ...result.metrics });
      console.log(`${id}: ${result.metrics.percent}% difference (informational)`);
    }
    await page.close();
  }
  const report = { title: configs.length === 1 ? configs[0].title : 'Mise UI — Figma comparison', generatedAt: new Date().toISOString(), configs: configPaths, rows };
  writeFileSync(`${output}/results.json`, JSON.stringify(report, null, 2) + '\n');
  writeVisualReport(output, report);
  console.log(`Visual QA: ${rows.length} comparisons → ${output}/report.html`);
} finally { await browser?.close(); server?.kill(); }
