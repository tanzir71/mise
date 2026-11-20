import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {stockBatchHeader} from '../packages/core/stock-commands';
import {purchaseBodyHeader} from '../packages/core/purchase-commands';
import {orderBodyHeader} from '../packages/core/order-commands';
import {savedCurrencyHeader} from '../packages/core/order-currency';
import {handoffBodyHeader} from '../packages/core/handoff-commands';
import {inboxBodyHeader} from '../packages/core/inbox-commands';
import {linkBodyHeader} from '../packages/core/link-commands';
import {commandReviewHeader} from '../packages/core/command-resolution';
import {createOrderReviewHandler,createOrderReviewStore} from '../supabase/functions/_shared/order-review';
import { resolve, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  createCommandStore,
  createCommandsHandler,
} from '../supabase/functions/_shared/commands-handler';
import {
  createSyncReadHandler,
  createSyncReadStore,
} from '../supabase/functions/_shared/sync-read-handler';
import {
  createInboxImageHandler,
  ImageAccessDenied,
} from '../supabase/functions/_shared/inbox-image-handler';
import {
  prepareCloudMigration,
  encodeCommandRecord,
} from '../packages/core/cloud-records';
import { createBackup } from '../packages/core/backup';
import { newInboxId, inboxImageBytes } from '../packages/core/inbox';
import { syncImagesFixture } from './sync-images-fixture';
import { promoteOwnerUpload } from './owner-upload-sql-fixture';
import { cloudUploadFixture } from './cloud-upload-fixture';
import { createInitialUploadHandler } from '../supabase/functions/_shared/upload-handler';
import { createInitialUploadStore } from '../supabase/functions/_shared/upload-store';

/** Local test verifier and object storage are synthetic. HTTP, scoped SQL roles,
 * command tickets/receipts, cursors and database transactions are real.
 */
export async function startConvergenceServer(
  options: {
    originalOwner?: boolean;
    emptyCloud?: boolean;
    records?: number;
  } = {},
) {
  const db = await PGlite.create();
  for (const f of ['supabase-auth.sql', 'supabase-storage.sql'])
    await db.exec(readFileSync(resolve('tests/fixtures', f), 'utf8'));
  const dir = resolve('supabase/migrations');
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort())
    await db.exec(readFileSync(join(dir, f), 'utf8'));
  // This is the test-owned Storage SQL stub, never a managed Supabase bucket.
  const uid = (n: number) =>
    '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
  for (const n of [1, 2])
    await db.query(
      'insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,now())',
      [uid(n), '1415555010' + n],
    );
  const original =
    options.originalOwner && !options.emptyCloud
      ? await promoteOwnerUpload(db)
      : null;
  if (!original)
    await db.exec(
      "insert into storage.buckets(id,name,public) values('mise-inbox','mise-inbox',false)",
    );
  const localBackup = options.emptyCloud
    ? cloudUploadFixture(options.records)
    : null;
  const f = localBackup
      ? {
          backup: localBackup,
          imageBytes: inboxImageBytes(
            localBackup.tables.inboxItems.flatMap((i) => i.images)[0],
          ),
        }
      : original
        ? {
            backup: structuredClone(original.original),
            imageBytes: inboxImageBytes(
              original.original.tables.inboxItems.flatMap((i) => i.images)[0],
            ),
          }
        : await syncImagesFixture(),
    t = f.backup.tables,
    owner = t.members[0],
    outlet = t.outlets[0],
    managerId = newInboxId(),
    branchId = newInboxId();
  if (!original && !options.emptyCloud) owner.outletIds = [];
  await db.transaction(async (sql) => {
    if (options.emptyCloud) return;
    if (!original)
      for (const r of (await prepareCloudMigration(createBackup(t), uid(1)))
        .records) {
        const keys = Object.keys(r.values);
        await sql.query(
          `insert into public.${r.table}(${keys.join(',')}) values(${keys.map((_, i) => '$' + (i + 1)).join(',')})`,
          Object.values(r.values),
        );
      }
    const branch = encodeCommandRecord(
        'outlets',
        { ...outlet, id: branchId, name: 'Implicit owner branch' },
        owner.businessId,
      ),
      keys = Object.keys(branch.values);
    await sql.query(
      `insert into public.outlets(${keys.join(',')}) values(${keys.map((_, i) => '$' + (i + 1)).join(',')})`,
      Object.values(branch.values),
    );
    await sql.query(
      "insert into public.members(id,business_id,auth_user_id,name,phone,role,created_at,updated_at) values($1,$2,$3,'\"Manager\"','+14155550102','manager',1,1)",
      [managerId, owner.businessId, uid(2)],
    );
    await sql.query('insert into public.member_outlets values($1,$2,$3)', [
      owner.businessId,
      managerId,
      outlet.id,
    ]);
  });
  const allowed = new Set([
    'admit_sync_read',
    'prepare_sync_read',
    'read_sync_page',
    'read_sync_coverage',
    'read_sync_upload_coverage',
    'operator_context',
    'operator_contexts',
    'prepare_money_write',
    'finish_money_write',
    'prepare_stock_write',
    'finish_stock_write',
    'admit_stock_batch',
    'inbox_image_context',
    'complete_inbox_image',
    'prepare_customer_intent',
    'finish_customer_write',
    'prepare_catalogue_intent',
    'finish_catalogue_intent',
    'apply_catalogue_intent',
    'prepare_purchase_write',
    'finish_purchase_write',
    'admit_order_write',
    'prepare_order_write',
    'finish_order_write',
    'inspect_order_outcome',
    'prepare_order_review',
    'read_order_review',
    'finish_order_review',
    'prepare_closing_write',
    'finish_closing_write',
    'prepare_settings_write',
    'finish_settings_write',
    'prepare_profile_write',
    'finish_profile_write',
    'admit_shop_link_write',
    'prepare_shop_link_write',
    'finish_shop_link_write',
    'admit_handoff_write',
    'prepare_handoff_write',
    'finish_handoff_write',
    'admit_inbox_write',
    'prepare_inbox_write',
    'finish_inbox_write',
    'prepare_supplier_message_write',
    'finish_supplier_message_write',
    'initial_upload_identity',
    'begin_initial_upload',
    'initial_upload_info',
    'put_initial_upload_chunk',
    'read_initial_upload_chunk',
    'prepare_initial_upload',
    'finish_initial_upload',
    'release_initial_upload',
    'cancel_initial_upload',
    'admit_purchase_record',
]);
  const tokens = [1, 2].map((n) =>
    [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
        'base64url',
      ),
      Buffer.from(
        JSON.stringify({
          sub: uid(n),
          role: 'authenticated',
          exp: Math.floor(Date.now() / 1000) + 3600,
          iat: Math.floor(Date.now() / 1000),
        }),
      ).toString('base64url'),
      'synthetic-test-signature',
    ].join('.'),
  );
  const identity = (jwt: string) => {
    const index = tokens.indexOf(jwt);
    if (index < 0) throw Error('Synthetic account unavailable');
    return index + 1;
  };
  async function rpc(
    name: string,
    args: Record<string, unknown>,
    jwt: string | null,
    service = false,
  ) {
    if (
      !allowed.has(name) ||
      Object.keys(args).some((k) => !/^p_[a-z_]+$/.test(k))
    )
      throw Error('RPC is outside the fixture allowlist');
    return db.transaction(async (sql) => {
      await sql.exec(
        'set local role ' + (service ? 'service_role' : 'authenticated'),
      );
      await sql.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify(
          service
            ? { role: 'service_role' }
            : {
                role: 'authenticated',
                sub: uid(identity(jwt!)),
                user_metadata: { role: 'owner' },
              },
        ),
      ]);
      const entries = Object.entries(args);
      return (
        await sql.query<{ data: unknown }>(
          `select public.${name}(${entries.map(([key], i) => key + '=>$' + (i + 1)).join(',')}) data`,
          entries.map(([, v]) =>
            v !== null && typeof v === 'object' ? JSON.stringify(v) : v,
          ),
        )
      ).rows[0].data;
    });
  }
  const diagnostics: { name: string; code: string; message: string }[] = [];
  const objects = new Map<string, Uint8Array>();
  const bridge: typeof fetch = async (url, init) => {
    const name = new URL(String(url)).pathname.split('/').at(-1)!,
      headers = new Headers(init?.headers),
      service = headers.get('apikey') === 'sb_secret_test_only';
    try {
      const path = new URL(String(url)).pathname;
      if (path.startsWith('/storage/v1/object/')) {
        if (!service) return new Response('{}', { status: 403 });
        const key = path.replace(
          /^\/storage\/v1\/object\/(?:authenticated\/)?mise-inbox\//,
          '',
        );
        if (init?.method === 'POST') {
          if (objects.has(key)) return new Response('{}', { status: 409 });
          const bytes = new Uint8Array(
            await new Response(init.body).arrayBuffer(),
          );
          await db.query(
            'insert into storage.objects(bucket_id,name,metadata,user_metadata) values($1,$2,$3,$4)',
            [
              'mise-inbox',
              key,
              JSON.stringify({
                size: bytes.byteLength,
                mimetype: headers.get('content-type'),
              }),
              atob(headers.get('x-metadata')!),
            ],
          );
          objects.set(key, bytes);
          return new Response('{}');
        }
        const bytes = objects.get(key);
        return bytes
          ? new Response(new Uint8Array(bytes).buffer, {
              headers: { 'Content-Length': String(bytes.byteLength) },
            })
          : new Response('{}', { status: 404 });
      }
      const args = JSON.parse(init?.body as string),
        result = await rpc(
          name,
          args,
          headers.get('Authorization')?.slice(7) ?? null,
          service,
        );
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      const e = error as { code?: string; detail?: string; message?: string };
      diagnostics.push({
        name,
        code: e.code ?? 'PT500',
        message: e.message ?? 'Fixture RPC failed',
      });
      return new Response(
        JSON.stringify({ code: e.code ?? 'PT500', details: e.detail ?? null }),
        {
          status:
            e.code === '42501'
              ? 403
              : e.code === 'PT409' || e.code === '23505'
                ? 409
                : e.code === '22023'
                  ? 400
                  : 503,
        },
      );
    }
  };
  const origins = new Set(['http://127.0.0.1:4321']),
    read = createSyncReadHandler({
      origins,
      store: createSyncReadStore(
        'https://database.test',
        'sb_publishable_test_only',
        bridge,
      ),
      cursorKey: 'cd'.repeat(32),
    }),
    commands = createCommandsHandler({
      origins,
      store: createCommandStore(
        'https://database.test',
        'sb_publishable_test_only',
        bridge,
        { serviceKey: 'sb_secret_test_only' },
      ),
    }),
    reviews=createOrderReviewHandler({origins,store:createOrderReviewStore('https://database.test','sb_publishable_test_only','sb_secret_test_only',bridge)}),
    upload = createInitialUploadHandler({
      origins,
      store: createInitialUploadStore(
        'https://database.test',
        'sb_publishable_test_only',
        'sb_secret_test_only',
        bridge,
      ),
    }),
    images = createInboxImageHandler({
      origins,
      store: {
        context: async (jwt, id) => {
          try {
            return await rpc('inbox_image_context', { p_image_id: id }, jwt);
          } catch {
            throw new ImageAccessDenied();
          }
        },
        get: async (meta) => {
          const bytes = objects.get(meta.path);
          if (bytes) return new Uint8Array(bytes);
          if (options.emptyCloud) throw Error('Missing original object');
          return new Uint8Array(f.imageBytes);
        },
        put: async (meta,bytes) => {
          if(objects.has(meta.path))return false;
          objects.set(meta.path,new Uint8Array(bytes));
          await db.query('insert into storage.objects(bucket_id,name,metadata,user_metadata) values($1,$2,$3,$4)', ['mise-inbox',meta.path,JSON.stringify({size:bytes.length,mimetype:meta.type}),JSON.stringify({sha256:meta.sha256})]);
          return true;
        },
        complete: async (jwt,id,eventId) => rpc('complete_inbox_image',{p_image_id:id,p_event_id:eventId},jwt),
      },
    });
  let apiUrl = '',
    loseCommand = false,
    loseResolution = false,
    losePage = false,
    loseImage = false,
    loseUploadFinish = false,
    revokeAfterProof = false,
    holdCommand = false,
    releaseCommand: (() => void) | null = null;
  const calls = {
    commands: 0,
    pages: 0,
    images: 0,
    imagePuts: 0,
    uploadProofs: 0,
    heldCommands: 0,
    authUsers: 0,
    uploads: 0,
    uploadFinishes: 0,
    otp: 0,
    verifications: 0,
    logouts: 0,
  };
  async function authUser(n: number) {
    const user = (
      await db.query<{ phone: string; phone_confirmed_at: string | null }>(
        'select phone,phone_confirmed_at from auth.users where id=$1',
        [uid(n)],
      )
    ).rows[0];
    return {
      id: uid(n),
      aud: 'authenticated',
      role: 'authenticated',
      phone: user.phone,
      phone_confirmed_at: user.phone_confirmed_at,
      created_at: '2026-11-01T00:00:00Z',
      is_anonymous: false,
      app_metadata: { provider: 'phone' },
      user_metadata: { role: 'owner' },
    };
  }
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks),
        headers = new Headers();
      for (const [key, value] of Object.entries(req.headers))
        if (value !== undefined)
          headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const cors = {
        'Access-Control-Allow-Origin': 'http://127.0.0.1:4321',
        'Access-Control-Allow-Methods': 'POST,GET,PUT,OPTIONS',
        'Access-Control-Allow-Headers':
          ['authorization','apikey','content-type','x-mise-sync-outlet','x-client-info','x-supabase-api-version',stockBatchHeader,purchaseBodyHeader,orderBodyHeader,savedCurrencyHeader,handoffBodyHeader,inboxBodyHeader,linkBodyHeader,commandReviewHeader].join(','),
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors).end();
        return;
      }
      const request = new Request(apiUrl + req.url, {
          method: req.method,
          headers,
          ...(req.method === 'GET' ? {} : { body }),
        }),
        path = new URL(request.url).pathname;
      let response: Response;
      const truncate = async (response: Response) => {
        const bytes = Buffer.from(await response.arrayBuffer()),
          h = new Headers(cors);
        for (const [key, value] of response.headers) h.set(key, value);
        h.set('Content-Length', String(bytes.length));
        h.set('Connection', 'close');
        res.writeHead(response.status, Object.fromEntries(h));
        res.end(bytes.subarray(0, 2));
      };
      if (path === '/functions/v1/migration-upload') {
        calls.uploads++;
        const action = JSON.parse(body.toString()).action;
        if (action === 'finish') calls.uploadFinishes++;
        response = await upload(request);
        if (action === 'finish' && loseUploadFinish && response.ok) {
          loseUploadFinish = false;
          await truncate(response);
          return;
        }
      } else if (path === '/functions/v1/commands') {
        calls.commands++;
        response = await (new URL(request.url).searchParams.has('review')?reviews:commands)(request);
        if (holdCommand && response.ok) {
          holdCommand = false;
          await new Promise<void>((resolve) => {
            releaseCommand = resolve;
            calls.heldCommands++;
          });
          releaseCommand = null;
        }
        if ((loseCommand||loseResolution&&new URL(request.url).searchParams.get('review')==='resolve') && response.ok) {
          loseCommand = false;
          loseResolution = false;
          await truncate(response);
          return;
        }
      } else if (path === '/functions/v1/sync-read') {
        const type = JSON.parse(body.toString()).type,
          isPage = type === 'page';
        if (isPage) calls.pages++;
        if (type === 'upload-coverage') calls.uploadProofs++;
        response = await read(request);
        if (type === 'upload-coverage' && response.ok && revokeAfterProof) {
          revokeAfterProof = false;
          await db.query('update public.members set active=false where id=$1', [
            owner.id,
          ]);
        }
        if (isPage && losePage && response.ok) {
          losePage = false;
          await truncate(response);
          return;
        }
      } else if (path === '/functions/v1/inbox-image') {
        calls.images++;
        if(request.method==='PUT')calls.imagePuts++;
        response = await images(request);
        if(request.method==='PUT'&&loseImage&&response.ok){loseImage=false;await truncate(response);return;}
      } else if (path === '/auth/v1/settings') {
        // Test-owned OTP gateway only. No hosted provider is activated.
        response = Response.json({
          external: { phone: true },
          phone_autoconfirm: false,
        });
      } else if (path === '/auth/v1/otp') {
        calls.otp++;
        const phone = JSON.parse(body.toString()).phone;
        response = ['+14155550101', '+14155550102'].includes(phone)
          ? Response.json({})
          : Response.json(
              { message: 'Unknown fixture phone' },
              { status: 400 },
            );
      } else if (path === '/auth/v1/verify' || path === '/auth/v1/token') {
        const input = JSON.parse(body.toString());
        const n = path.endsWith('/verify')
          ? ['+14155550101', '+14155550102'].indexOf(input.phone) + 1
          : ['synthetic-refresh-1', 'synthetic-refresh-2'].indexOf(
              input.refresh_token,
            ) + 1;
        if (
          !n ||
          (path.endsWith('/verify') &&
            (input.token !== '123456' || input.type !== 'sms'))
        ) {
          response = Response.json(
            { message: 'Unverified fixture phone' },
            { status: 400 },
          );
        } else {
          if (path.endsWith('/verify')) calls.verifications++;
          response = Response.json({
            access_token: tokens[n - 1],
            refresh_token: 'synthetic-refresh-' + n,
            token_type: 'bearer',
            expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user: await authUser(n),
          });
        }
      } else if (path === '/auth/v1/logout') {
        calls.logouts++;
        response = new Response(null, { status: 204 });
      } else if (path === '/auth/v1/user') {
        calls.authUsers++;
        const n = identity(headers.get('Authorization')?.slice(7) ?? ''),
          user = await authUser(n);
        response = new Response(
          JSON.stringify({
            ...user,
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      } else if (path.startsWith('/rest/v1/rpc/operator_')) {
        response = await bridge(new URL(path, 'https://database.test'), {
          method: 'POST',
          headers,
          body,
        });
      } else response = new Response('{}', { status: 404 });
      const responseHeaders = new Headers(cors);
      for (const [key, value] of response.headers)
        responseHeaders.set(key, value);
      res.writeHead(response.status, Object.fromEntries(responseHeaders));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(503).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  apiUrl = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const ownerSeed = original
    ? {
        backup: original.original,
        manifest: original.plan.manifest,
        chunks: await Promise.all(
          original.plan.chunks.map(async (blob) =>
            Buffer.from(await blob.arrayBuffer()).toString('base64'),
          ),
        ),
        receipt: original.receipt,
      }
    : undefined;
  const config = (n: 1 | 2, branch = false) => ({
    apiUrl,
    publishableKey: 'sb_publishable_test_only',
    userId: uid(n),
    jwt: tokens[n - 1],
    businessId: owner.businessId,
    outletId: branch ? branchId : outlet.id,
    actorId: n === 1 ? owner.id : managerId,
    stockId: t.stockItems[0].id,
    ...(n === 1 && !branch && ownerSeed ? { original: ownerSeed } : {}),
    ...(n === 1 && localBackup ? { localBackup } : {}),
  });
  return {
    config,
    calls,
    diagnostics,
    loseNextUploadFinish() {
      loseUploadFinish = true;
    },
    async promotedUploads() {
      return (
        await db.query<{ n: number }>(
          'select count(*)::int n from private.initial_uploads where receipt is not null',
        )
      ).rows[0].n;
    },
    holdNextCommandReply() {
      holdCommand = true;
    },
    releaseCommandReply() {
      releaseCommand?.();
    },
    loseNextCommand() {
      loseCommand = true;
    },
    loseNextResolution() {loseResolution=true;},
    loseNextPage() {
      losePage = true;
    },
    loseNextImageReply() {loseImage=true;},
    revokeOwnerAfterProof() {
      revokeAfterProof = true;
    },
    async revokeManager() {
      await db.query('delete from public.member_outlets where member_id=$1', [
        managerId,
      ]);
    },
    async changeEpoch() {
      await db.exec('update private.sync_epoch set id=gen_random_uuid()');
    },
    async promoteManager() {
      await db.query("update public.members set role='owner' where id=$1", [managerId]);
    },
    async financialCount(ids: string[]) {
      return (
        await db.query<{ n: number }>(
          'select count(*)::int n from public.sales where id in (select value::public.ulid from jsonb_array_elements_text($1::jsonb))',
          [JSON.stringify(ids)],
        )
      ).rows[0].n;
    },
    async close() {
      releaseCommand?.();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    },
  };
}
