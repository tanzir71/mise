import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';

for (const app of ['@mise/landing', '@mise/web']) {
  const result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--filter', app, 'build'], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
mkdirSync('site/downloads', { recursive: true });
if (existsSync('downloads')) cpSync('downloads', 'site/downloads', { recursive: true });
writeFileSync('site/.nojekyll', '');
cpSync('site/app/index.html', 'site/404.html');
