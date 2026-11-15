import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const forbidden = /\b(?:product-preview|phone-preview|preview-shell|preview-main|phone-status|browser-bar|preview-sidebar|preview-ticket|calculator-keys|dual-phones|hero-desktop|hero-phone|floating-chip|detail-callout)\b/;
const failures = [];
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (/\.(astro|css|tsx?|html)$/.test(path)) {
      const lines = readFileSync(path, 'utf8').split('\n');
      lines.forEach((line, index) => { if (forbidden.test(line)) failures.push(`${path}:${index + 1}: ${line.match(forbidden)[0]}`); });
    }
  }
}
for (const folder of process.argv.slice(2).length ? process.argv.slice(2) : ['apps/landing/src', 'packages/ui']) visit(folder);
if (failures.length) { console.error('Hand-drawn marketing UI is forbidden:\n' + failures.join('\n')); process.exit(1); }
console.log('Marketing guard passed: no hand-drawn screens or devices.');
