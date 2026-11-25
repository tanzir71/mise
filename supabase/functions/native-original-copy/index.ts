import {
  originalCopyHandler,
  originalCopyStore,
} from '../_shared/original-copy-handler.ts';
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (r: Request) => Promise<Response>): void;
};
let handler: (r: Request) => Promise<Response>;
try {
  const origins = new Set(
    (Deno.env.get('MISE_ALLOWED_ORIGINS') || '').split(',').filter(Boolean),
  );
  if (!origins.size || [...origins].some((o) => new URL(o).origin !== o))
    throw Error('Configure origins.');
  handler = originalCopyHandler(
    origins,
    originalCopyStore(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('MISE_PUBLISHABLE_API_KEY') || '',
    ),
  );
} catch {
  handler = async () =>
    new Response(
      JSON.stringify({
        error:
          'Original copy storage is unavailable. Keep your complete local backup.',
      }),
      {
        status: 503,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
      },
    );
}
Deno.serve(handler);
