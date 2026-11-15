#!/usr/bin/env node
// Downloads every Figma frame, landing asset, section reference and icon listed in handover/exports/manifest.json.
// The manifest mirrors the export settings in the Figma file, so this produces the same files as the owner
// exporting each page from Figma (Ctrl/Cmd+Shift+E). Use whichever route is available.
// Usage (Node 18+, no dependencies):
//   node handover/scripts/export-figma.mjs --check          # no token: list missing files, exit 1 if any are missing
//   FIGMA_TOKEN=<personal access token> node handover/scripts/export-figma.mjs
// Optional: --only=landing,screens,system,flows,portfolio   --force (re-download existing files)
// Get a token: Figma → Settings → Security → Personal access tokens. A read-only "File content" scope is enough.
// The token is only sent to api.figma.com and is never written to disk.

import { readFile, writeFile, mkdir, access, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');                       // handover/
const manifest = JSON.parse(await readFile(join(root, 'exports/manifest.json'), 'utf8'));
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const existsSync = p => stat(p).then(file => file.isFile() && file.size > 0, () => false);

if ('check' in args) {
  const want = manifest.jobs.flatMap(j => j.items).filter(it => !args.only || args.only.split(',').includes(it.out.split('/')[0]));
  const missing = [];
  for (const it of want) if (!(await existsSync(join(root, 'exports', it.out)))) missing.push(it.out);
  if (missing.length) {
    console.error(`Missing or empty ${missing.length} of ${want.length} exports:`); for (const m of missing) console.error('  ' + m);
    console.error('Ask the owner to export from Figma (see handover/exports/README.md), or run this script with FIGMA_TOKEN.');
    process.exit(1);
  }
  console.log(`All ${want.length} exports present.`); process.exit(0);
}

const token = process.env.FIGMA_TOKEN;
if (!token) { console.error('Set FIGMA_TOKEN (Figma personal access token), or use --check.'); process.exit(1); }
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
      for (const b of batch) { try { Object.assign(data.images, (await api(`https://api.figma.com/v1/images/${manifest.fileKey}?ids=${b.id}&format=${job.format}&scale=${job.scale}`)).images); } catch (e2) { console.error('  ', b.out, e2.message); } } }
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
await writeFile(join(root, 'exports/DOWNLOADED.md'), lines.join('\n') + '\n');
console.log(`\nDone: ${done} downloaded, ${skipped} already present, ${failed} failed. See handover/exports/DOWNLOADED.md`);
process.exit(failed ? 2 : 0);
