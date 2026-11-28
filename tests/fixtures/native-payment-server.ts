import {createSyncReadHandler,createSyncReadStore} from '../../supabase/functions/_shared/sync-read-handler';
import {createInitialUploadHandler} from '../../supabase/functions/_shared/upload-handler';
import {createInitialUploadStore} from '../../supabase/functions/_shared/upload-store';
import {createInboxImageHandler} from '../../supabase/functions/_shared/inbox-image-handler';
import {createInboxImageStore} from '../../supabase/functions/_shared/inbox-image-store';
// Controlled HTTP/Auth boundary over real PostgreSQL roles and production handlers.
// Never imported by a browser bundle or deployed to an installation.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { prepareCloudMigration } from '../../packages/core/cloud-records';
import type { MiseBackup } from '../../packages/core/backup-tables';
import { copySdkSubject } from './original-copy-sdk';
import {
  createNativePaymentHandler,
  createNativePaymentStore,
} from '../../supabase/functions/_shared/native-payment-handler';
import {
  originalCopyHandler,
  originalCopyStore,
} from '../../supabase/functions/_shared/original-copy-handler';
import {
  createCommandsHandler,
  createCommandStore,
} from '../../supabase/functions/_shared/commands-handler';
export async function nativePaymentTestServer(
  apiUrl: string,
  publishableKey: string,
  origin: string,
  migrationCeiling?: string,
) {
  const sql = await PGlite.create(),
    serviceKey = 'sb_secret_test_only';
  for (const file of ['supabase-auth.sql', 'supabase-storage.sql'])
    await sql.exec(readFileSync('tests/fixtures/' + file, 'utf8'));
  await sql.exec(
    'create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id) on delete cascade,not_after timestamptz)',
  );
  for (const file of readdirSync('supabase/migrations')
    .filter((n) => n.endsWith('.sql') && (!migrationCeiling || n <= migrationCeiling))
    .sort())
    await sql.exec(readFileSync('supabase/migrations/' + file, 'utf8'));
  // The installation provisions its own private bucket. Mirror that configured
  // Storage boundary here; migrations deliberately do not create service-owned buckets.
  await sql.query("insert into storage.buckets(id,name,public) values('mise-inbox','mise-inbox',false)");
  for (const n of [1, 2]) {
    await sql.query(
      'insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,now())',
      [copySdkSubject(n), '880171234548' + n],
    );
    await sql.query('insert into auth.sessions(id,user_id) values($1,$2)', [
      copySdkSubject(n + 100),
      copySdkSubject(n),
    ]);
  }
  function claims(jwt: string | null) {
    if (!jwt || jwt.split('.')[2] !== 'synthetic-copy-test-signature')
      throw Error('Unknown controlled token');
    return JSON.parse(
      Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'),
    ) as { sub: string; session_id: string };
  }
  let lastError='';
  const rpc: typeof fetch = async (url, init = {}) => {
    const name = new URL(String(url)).pathname.split('/').at(-1)!;
    if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw Error('Unknown controlled RPC');
    const h = new Headers(init.headers),
      service = h.get('apikey') === serviceKey;
    if (!service && h.get('apikey') !== publishableKey)
      throw Error('Unknown controlled key');
    const values = JSON.parse(init.body as string) as Record<string, unknown>,
      keys = Object.keys(values);
    if (keys.some((k) => !/^p_[a-z_0-9]+$/.test(k)))
      throw Error('Unknown controlled parameter');
    try {
      const rows = await sql.transaction(async (tx) => {
        await tx.exec(
          'set local role ' + (service ? 'service_role' : 'authenticated'),
        );
        await tx.query("select set_config('request.jwt.claims',$1,true)", [
          JSON.stringify(
            service
              ? { role: 'service_role' }
              : {
                  ...claims(
                    h.get('Authorization')?.replace(/^Bearer /, '') ?? null,
                  ),
                  role: 'authenticated',
                  user_metadata: { role: 'owner' },
                },
          ),
        ]);
        return (
          await tx.query<{ value: unknown }>(
            `select public.${name}(${keys.map((k, i) => k + ' => $' + (i + 1)).join(',')}) value`,
            keys.map((k) =>
              values[k] !== null && typeof values[k] === 'object'
                ? JSON.stringify(values[k])
                : values[k],
            ),
          )
        ).rows;
      });
      return new Response(JSON.stringify(rows[0].value), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      const e = error as { code: string; message: string; where?: string };
      lastError=e.code+' '+e.message+' '+(e.where??'').slice(0,1200);
      return new Response(
        JSON.stringify({ code: e.code, message: e.message }),
        {
          status:
            e.code === '42501'
              ? 403
              : ['PT409', '23505'].includes(e.code)
                ? 409
                : e.code === '22023'
                  ? 400
                  : 500,
        },
      );
    }
  };
  // Synthetic Storage HTTP boundary; image bytes and SQL metadata are retained
  // exactly. Upload, image admission, scoped reads and financial handlers below
  // are the production implementations with their actual PostgreSQL roles.
  const objects = new Map<string,Uint8Array>();
  const backend:typeof fetch = async(url,init={}) => {
    const path=new URL(String(url)).pathname;
    if(path.startsWith('/rest/v1/rpc/'))return rpc(url,init);
    const match=path.match(/^\/storage\/v1\/object\/(?:authenticated\/)?mise-inbox\/(.+)$/),headers=new Headers(init.headers);
    if(!match||headers.get('apikey')!==serviceKey)return new Response('{}',{status:403});
    const name=match[1];
    if(init.method==='POST'){
      if(objects.has(name))return new Response('{}',{status:409});
      const bytes=new Uint8Array(await new Response(init.body).arrayBuffer()),metadata=JSON.parse(atob(headers.get('x-metadata')!));
      await sql.query("insert into storage.objects(bucket_id,name,metadata,user_metadata) values('mise-inbox',$1,$2,$3)",[name,JSON.stringify({size:bytes.length,mimetype:headers.get('Content-Type')}),JSON.stringify(metadata)]);
      objects.set(name,bytes);return new Response('{}');
    }
    const bytes=objects.get(name);return bytes?new Response(new Uint8Array(bytes),{headers:{'Content-Length':String(bytes.length)}}):new Response('{}',{status:404});
  };
  const uploadStore=createInitialUploadStore(apiUrl,publishableKey,serviceKey,backend);
  const upload=createInitialUploadHandler({origins:new Set([origin]),store:{...uploadStore,
    putImage:async(...args)=>{try{return await uploadStore.putImage(...args);}catch(error){lastError='putImage '+String(error);throw error;}},
    getImage:async(...args)=>{try{return await uploadStore.getImage(...args);}catch(error){lastError+='; getImage '+String(error);throw error;}},
  }}),
    image=createInboxImageHandler({origins:new Set([origin]),store:createInboxImageStore(apiUrl,publishableKey,serviceKey,backend)});
  const syncRead = createSyncReadHandler({origins:new Set([origin]),cursorKey:'c'.repeat(64),store:createSyncReadStore(apiUrl,publishableKey,rpc)});
  const originals = originalCopyHandler(
      new Set([origin]),
      originalCopyStore(apiUrl, publishableKey, rpc),
    ),
    nativeStore = createNativePaymentStore(apiUrl, publishableKey, serviceKey, rpc),
    native = createNativePaymentHandler({
      origins: new Set([origin]),
      store: {admit:(...args)=>nativeStore.admit(...args),apply:async(...args)=>{lastError='';try{return await nativeStore.apply(...args);}catch(error){lastError+=' '+String(error);throw error;}}},
    }),
    legacy = createCommandsHandler({
      origins: new Set([origin]),
      store: createCommandStore(apiUrl, publishableKey, rpc, { serviceKey }),
    });
  return {
    sql,
    lastError:()=>lastError,
    async seed(source: MiseBackup, authUser=copySdkSubject(1)) {
      const plan = await prepareCloudMigration(source, authUser);
      await sql.transaction(async (tx) => {
        for (const row of plan.records) {
          const keys = Object.keys(row.values);
          if (![row.table, ...keys].every((k) => /^[a-z_][a-z_0-9]*$/.test(k)))
            throw Error('Unknown controlled column');
          await tx.query(
            `insert into public.${row.table}(${keys.join(',')}) values(${keys.map((_, i) => '$' + (i + 1)).join(',')})`,
            keys.map((k) => row.values[k]),
          );
        }
      });
    },
    async handle(request: Request) {
      const path = new URL(request.url).pathname;
      if (path === '/auth/v1/user') {
        try {
          const c = claims(
              request.headers.get('Authorization')?.replace(/^Bearer /, '') ??
                null,
            ),
            row = (
              await sql.query<{
                phone: string;
                phone_confirmed_at: Date | null;
                is_anonymous: boolean;
              }>(
                'select phone,phone_confirmed_at,is_anonymous from auth.users where id=$1 and deleted_at is null',
                [c.sub],
              )
            ).rows[0];
          if (!row) return new Response('{}', { status: 401 });
          return new Response(
            JSON.stringify({
              id: c.sub,
              aud: 'authenticated',
              role: 'authenticated',
              phone: row.phone,
              phone_confirmed_at: row.phone_confirmed_at,
              created_at: '2026-01-01T00:00:00.000Z',
              app_metadata: { provider: 'phone' },
              user_metadata: { role: 'owner' },
              is_anonymous: row.is_anonymous,
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        } catch {
          return new Response('{}', { status: 401 });
        }
      }
      if(['/rest/v1/rpc/operator_context','/rest/v1/rpc/operator_contexts'].includes(path))return rpc(request.url,{method:request.method,headers:request.headers,body:await request.text()});
      if (path === '/functions/v1/sync-read') return syncRead(request);
      if (path === '/functions/v1/migration-upload') return upload(request);
      if (path === '/functions/v1/inbox-image') return image(request);
      if (path === '/functions/v1/native-original-copy')
        return originals(request);
      if (path === '/functions/v1/native-payment') return native(request);
      if (path === '/functions/v1/commands') return legacy(request);
      return new Response('{}', { status: 404 });
    },
    close: () => sql.close(),
  };
}
