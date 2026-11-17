import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export function hardenSite(directory) {
  const allowedOrigins = [process.env.PUBLIC_GEO_URL, process.env.PUBLIC_ANALYTICS_ENABLED === 'true' ? process.env.PUBLIC_ANALYTICS_SCRIPT : ''].filter(Boolean).map(value => new URL(value).origin);
  function visit(folder) {
    for (const file of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, file.name);
      if (file.isDirectory()) visit(path);
      else if (file.name.endsWith('.html')) {
        let html = readFileSync(path, 'utf8');
        const hashes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].filter(m => m[1]).map(m => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
        const policy = `default-src 'self'; script-src 'self' ${hashes.join(' ')} ${allowedOrigins.join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data:${path.replace(/\\/g,'/').endsWith('/app/index.html')||path.replace(/\\/g,'/').endsWith('/404.html')?' blob:':''}; font-src 'self'; connect-src 'self' ${allowedOrigins.join(' ')}; object-src 'none'; base-uri 'self'; form-action 'self'`;
        html = html.replace(/<head>/i, `<head><meta http-equiv="Content-Security-Policy" content="${policy}">`);
        writeFileSync(path, html);
      }
    }
  }
  visit(directory);
}
