#!/usr/bin/env node
// Downloads every Figma frame, landing section and icon listed in handover/exports/manifest.json.
// Usage (Node 18+, no dependencies):
//   FIGMA_TOKEN=<personal access token> node handover/scripts/export-figma.mjs
// Optional: --only=phone,desktop,landing,boards,icons   --force (re-download existing files)
// Get a token: Figma → Settings → Security → Personal access tokens. A read-only "File content" scope is enough.
// The token is only sent to api.figma.com and is never written to disk.

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');                       // handover/
const manifest = JSON.parse(await readFile(join(root, 'exports/manifest.json'), 'utf8'));
const token = process.env.FIGMA_TOKEN;
if (!token) { console.error('Set FIGMA_TOKEN (Figma personal access token).'); process.exit(1); }

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const only = args.only ? args.only.split(',') : null;
const force = 'force' in args;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const exists = p => access(p).then(() => true, () => false);

async function api(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { headers: { 'X-Figma-Token': token } });
    if (res.status === 429 || res.status >= 500) { await sleep(2000 * (i + 1)); continue; }
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  }
  throw new Error('Figma API kept failing: ' + url);
}

async function download(url, out, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url);
    if (res.ok) { await mkdir(dirname(out), { recursive: true }); await writeFile(out, Buffer.from(await res.arrayBuffer())); return; }
    await sleep(1500 * (i + 1));
  }
  throw new Error('Download failed: ' + out);
}

const index = [];
let done = 0, skipped = 0, failed = 0;
for (const job of manifest.jobs) {
  let items = job.items.filter(it => !only || only.includes(it.out.split('/')[0]));
  if (!force) {
    const keep = [];
    for (const it of items) (await exists(join(root, 'exports', it.out))) ? (skipped++, index.push(it)) : keep.push(it);
    items = keep;
  }
  // Figma renders up to ~32 megapixels per image; batch ids to keep requests small.
  for (let i = 0; i < items.length; i += 10) {
    const batch = items.slice(i, i + 10);
    const ids = batch.map(b => b.id).join(',');
    const q = new URLSearchParams({ ids, format: job.format, scale: String(job.scale) });
    if (job.format === 'svg') { q.set('svg_outline_text', 'false'); q.set('svg_include_id', 'false'); }
    let data;
    try { data = await api(`https://api.figma.com/v1/images/${manifest.fileKey}?${q}`); }
    catch (e) { console.error('Batch failed, retrying one by one:', e.message); data = { images: {} };
      for (const b of batch) { try { Object.assign(data.images, (await api(`https://api.figma.com/v1/images/${manifest.fileKey}?ids=${b.id}&format=${job.format}&scale=${job.format === 'svg' ? 1 : Math.min(job.scale, 1)}`)).images); } catch (e2) { console.error('  ', b.out, e2.message); } } }
    for (const b of batch) {
      const url = data.images?.[b.id];
      if (!url) { failed++; console.error('No render for', b.id, b.out); continue; }
      try { await download(url, join(root, 'exports', b.out)); done++; index.push(b); process.stdout.write(`✓ ${b.out}\n`); }
      catch (e) { failed++; console.error(e.message); }
    }
  }
}

const lines = ['# Exported files', '', `From ${manifest.figmaUrl} · ${new Date().toISOString()}`, '', '| File | Figma node |', '|---|---|',
  ...index.sort((a, b) => a.out.localeCompare(b.out)).map(it => `| \`${it.out}\` | [${it.id}](${manifest.figmaUrl}?node-id=${it.id.replace(':', '-')}) |`)];
await writeFile(join(root, 'exports/INDEX.md'), lines.join('\n') + '\n');
console.log(`\nDone: ${done} downloaded, ${skipped} already present, ${failed} failed. See handover/exports/INDEX.md`);
process.exit(failed ? 2 : 0);
