import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync, rmSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version || '')) throw new Error('Pass a semantic version, such as 0.5.0.');
const root = resolve('downloads');
const folder = resolve(root, version);
if (!folder.startsWith(root + sep)) throw new Error('Version path escaped downloads.');
if (!existsSync(folder)) { console.log('No device builds exist for this version; manifest unchanged.'); process.exit(0); }
const manifestFile = resolve(root, 'manifest.json');
const previous = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : { items: [] };
const items = new Map(previous.items.map(item => [item.id, item]));
const checksums = [];
for (const [id, name, suffix] of [['extension', 'Chrome extension', 'zip'], ['order-phone', 'Android order phone', 'apk']]) {
  const filename = `mise-${id}-${version}.${suffix}`;
  const path = resolve(folder, filename);
  if (!existsSync(path)) continue;
  const bytes = readFileSync(path);
  if (bytes.length > 50 * 1024 * 1024 || bytes.length < 1) throw new Error(`${filename} must be between 1 byte and 50 MB.`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const latest = `latest/mise-${id}.${suffix}`;
  mkdirSync(resolve(root, 'latest'), { recursive: true });
  cpSync(path, resolve(root, latest));
  items.set(id, { id, name, version, file: `${version}/${filename}`, latest, bytes: bytes.length, sha256, minApp: version, ...(id === 'order-phone' ? { minAndroid: '8.0' } : {}) });
  checksums.push(`${sha256}  ${filename}`);
}
if (!checksums.length) { console.log('No known device artifacts found; manifest unchanged.'); process.exit(0); }
writeFileSync(resolve(folder, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
writeFileSync(manifestFile, JSON.stringify({ updatedAt: new Date().toISOString(), items: [...items.values()] }, null, 2) + '\n');
const versions = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name)).map(entry => entry.name).sort((a,b) => {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  return right[0]-left[0] || right[1]-left[1] || right[2]-left[2];
});
const referenced = new Set([...items.values()].map(item => item.version));
for (const old of versions.slice(5)) {
  if (referenced.has(old)) continue;
  const target = realpathSync(resolve(root, old));
  if (!target.startsWith(realpathSync(root) + sep)) throw new Error('Refusing to remove a version outside downloads.');
  rmSync(target, { recursive: true });
}
console.log(`Published ${checksums.length} device build(s) for ${version}.`);
