import { spawnSync, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hardenSite } from './harden.mjs';

execFileSync(process.execPath, ['scripts/check-marketing.mjs'], { stdio: 'inherit' });

for (const app of ['@mise/landing', '@mise/web']) {
  const result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--filter', app, 'build'], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
mkdirSync('site/downloads', { recursive: true });
if (existsSync('downloads')) cpSync('downloads', 'site/downloads', { recursive: true });
mkdirSync('site/docs', { recursive: true });
cpSync('docs/deploy-own-vercel.md', 'site/docs/deploy-own-vercel.md');
writeFileSync('site/.nojekyll', '');
cpSync('site/app/index.html', 'site/404.html');
hardenSite('site');
execFileSync(process.execPath, ['scripts/check-image-budgets.mjs'], { stdio: 'inherit' });
