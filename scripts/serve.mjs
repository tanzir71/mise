import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = resolve('site');
const base = `/${(process.env.BASE_PATH || '/').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8' };
createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (!pathname.startsWith(base)) { res.writeHead(404).end('Not found'); return; }
    let file = resolve(root, pathname.slice(base.length));
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    try { if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html'); }
    catch { if (pathname.startsWith(`${base}app/`) && !extname(pathname)) file = resolve(root, 'app/index.html'); }
    let body = await readFile(file);
    const headers = { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': /[.-][\w-]{8,}\.(css|js|woff2?)$/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache' };
    if (/\.(html|js|css|json|svg|xml|txt)$/.test(file) && body.length > 1024 && req.headers['accept-encoding']?.includes('gzip')) {
      body = gzipSync(body); headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding';
    }
    res.writeHead(200, headers).end(body);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(4321, '127.0.0.1', () => console.log(`Mise preview: http://127.0.0.1:4321${base}`));
