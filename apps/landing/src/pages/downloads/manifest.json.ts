import type { APIRoute } from 'astro';
import manifest from '../../../../../downloads/manifest.json';

export const GET: APIRoute = () => new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/json' } });
