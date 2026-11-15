import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const failures = [];
for (const region of ['bd', 'intl']) {
  const html = readFileSync(`site/${region}/index.html`, 'utf8');
  const pictures = [...html.matchAll(/<picture\b[\s\S]*?<\/picture>/g)].map(match => match[0]).filter(picture => picture.includes('data-shot='));
  if (pictures.length !== 23) failures.push(`${region}: expected 23 Figma pictures, found ${pictures.length}`);
  let aboveFold = 0;
  for (const picture of pictures) {
    const slot = picture.match(/data-shot="([^"]+)"/)?.[1] || 'unknown';
    const sources = [...picture.matchAll(/<source\b[^>]*>/g)].map(match => match[0]);
    for (const format of ['avif', 'webp']) if (!sources.some(source => source.includes(`type="image/${format}"`))) failures.push(`${slot}: missing ${format}`);
    const avif = sources.find(source => source.includes('type="image/avif"'));
    const variants = avif?.match(/srcset="([^"]+)"/)?.[1].split(',').map(value => value.trim().split(/\s+/)) || [];
    if (variants.length !== 2) { failures.push(`${slot}: expected 1× and 2× AVIF variants`); continue; }
    const largest = variants.sort((a,b) => parseInt(b[1]) - parseInt(a[1]))[0][0];
    const path = new URL(largest, 'https://mise.test').pathname;
    const asset = path.slice(path.indexOf('/_astro/') + 1);
    const bytes = statSync(resolve('site', asset)).size;
    if (slot.endsWith('/hero.visual') && bytes > 90 * 1024) failures.push(`${slot}: ${bytes} bytes exceeds 90KB`);
    if (slot.includes('/detail.') && bytes > 140 * 1024) failures.push(`${slot}: ${bytes} bytes exceeds 140KB`);
    if (picture.includes('loading="eager"')) aboveFold += bytes;
    if (!picture.match(/<img\b[^>]*\.png/)) failures.push(`${slot}: missing PNG fallback`);
  }
  if (aboveFold > 150 * 1024) failures.push(`${region}: above-fold images exceed 150KB`);
  const inlineSvg = (html.match(/<svg\b/g) || []).length;
  if (inlineSvg > 120) failures.push(`${region}: ${inlineSvg} inline SVGs exceeds 120`);
  console.log(`${region}: ${pictures.length} Figma pictures, ${inlineSvg} inline icons, ${Math.round(aboveFold / 1024)}KB eager AVIF (2×).`);
}
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
