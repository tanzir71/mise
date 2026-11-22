import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateVAPIDKeys } from 'web-push';
import {
  createPairingDatabase,
  deviceId,
  deviceUid,
} from '../device-pairing-fixture';
import { orderFixture } from '../order-fixture';
import {
  saveOrderCommand,
  changeOrderStatusCommand,
  nextOrderStatuses,
} from '../../packages/core/orders';
import { encodeCommandRecord } from '../../packages/core/cloud-records';
import {
  newKitchenId,
  kitchenContentHash,
  prepareKitchenAction,
} from '../../packages/core/kitchen';
import {
  createDeskNotificationsHandler,
  createDeskNotificationsStore,
} from '../../supabase/functions/_shared/desk-notifications-handler';
import { createKitchenAlarmsStore } from '../../supabase/functions/_shared/kitchen-alarms-handler';
import {
  createKitchenActionsHandler,
  createKitchenActionsStore,
} from '../../supabase/functions/_shared/kitchen-actions-handler';
import { deriveStaffPin } from '../../supabase/functions/_shared/staff-pin';
import type {
  SharedDevice,
  StaffDeviceSession,
} from '../../packages/core/device-access';
import type { Order, SetupSnapshot } from '../../packages/core/models';

/** Isolated synthetic phone authentication and real PostgreSQL/production
 * handlers. Never connects to Supabase, an SMS provider or a push provider. */
export async function startDeskUiService() {
  const f = await createPairingDatabase(process.cwd()),
    origin = 'http://127.0.0.1:4321',
    origins = new Set([origin]),
    applicationKey = generateVAPIDKeys().publicKey;
  let tail = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  const user = {
    id: deviceUid(1),
    aud: 'authenticated',
    role: 'authenticated',
    phone: '14155550101',
    phone_confirmed_at: '2026-11-15T00:00:00Z',
    confirmed_at: '2026-11-15T00:00:00Z',
    created_at: '2026-11-15T00:00:00Z',
    updated_at: '2026-11-15T00:00:00Z',
    is_anonymous: false,
    app_metadata: { provider: 'phone', providers: ['phone'] },
    user_metadata: {},
  };
  const expires = Math.floor(Date.now() / 1000) + 86400,
    encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url'),
    jwt =
      encode({ alg: 'HS256', typ: 'JWT' }) +
      '.' +
      encode({
        sub: user.id,
        exp: expires,
        aud: 'authenticated',
        role: 'authenticated',
      }) +
      '.synthetic_signature';
  const session = {
    access_token: jwt,
    refresh_token: 'fixture-only-refresh',
    expires_at: expires,
    expires_in: 86400,
    token_type: 'bearer',
    user,
  };
  const ownerNames = new Set([
    'desk_push_context',
    'register_desk_push',
    'read_desk_push',
    'revoke_desk_push',
    'read_kitchen_alarm_task_page',
    'set_kitchen_alarm_settings',
  ]);
  const serviceNames = new Set([
    'prepare_kitchen_alarms',
    'finish_kitchen_alarm',
    'prepare_kitchen_action',
    'finish_kitchen_action',
    'read_kitchen_acknowledgements',
  ]);
  const rpc: typeof fetch = async (url, init) => {
    const name = new URL(String(url)).pathname.split('/').at(-1)!,
      headers = new Headers(init?.headers),
      owner = ownerNames.has(name),
      system = serviceNames.has(name);
    if (
      (!owner && !system) ||
      (owner && headers.get('authorization') !== 'Bearer ' + jwt) ||
      (system && headers.get('apikey') !== 'sb_secret_test_only')
    )
      return new Response('{}', { status: 401 });
    const body = JSON.parse(String(init?.body)),
      keys = Object.keys(body);
    if (keys.some((key) => !/^p_[a-z0-9_]+$/.test(key)))
      throw Error('Invalid desk fixture argument');
    try {
      return Response.json(
        await serial(() =>
          f.asRole(
            owner ? 1 : null,
            owner ? 'authenticated' : 'service_role',
            `select public.${name}(${keys.map((key, index) => key + '=> $' + (index + 1)).join(',')}) data`,
            Object.values(body).map((value) =>
              value !== null && typeof value === 'object'
                ? JSON.stringify(value)
                : value,
            ),
          ),
        ),
      );
    } catch (problem) {
      const code = (problem as { code?: string }).code;
      if (!['PT409', '42501', 'PT403', 'PT429'].includes(code ?? ''))
        console.error(
          'Isolated desk SQL failed:',
          name,
          code,
          (problem as Error).message,
        );
      return new Response('{}', {
        status:
          code === 'PT409'
            ? 409
            : code === '42501' || code === 'PT403'
              ? 403
              : code === 'PT429'
                ? 429
                : 503,
      });
    }
  };
  const store = createDeskNotificationsStore(
    'https://rpc.test',
    'sb_publishable_test_only',
    rpc,
  );
  const handler = createDeskNotificationsHandler({
      origins,
      applicationKey,
      store,
    }),
    alarms = createKitchenAlarmsStore(
      'https://rpc.test',
      'sb_secret_test_only',
      rpc,
    ),
    kitchen = createKitchenActionsHandler({
      origins,
      store: createKitchenActionsStore(
        'https://rpc.test',
        'sb_secret_test_only',
        rpc,
      ),
    });
  let apiUrl = '',
    lose = false,
    registrations = 0,
    withdrawals = 0,
    settingsCalls = 0,
    hold: { entered: () => void; gate: Promise<void> } | null = null;
  const releases = new Set<() => void>();
  const server = createServer(async (req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'authorization,apikey,content-type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Cache-Control': 'no-store',
    };
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks),
        path = req.url?.split('?')[0],
        headers = new Headers();
      for (const [key, value] of Object.entries(req.headers))
        if (value !== undefined)
          headers.set(key, Array.isArray(value) ? value.join(',') : value);
      let response: Response;
      if (path === '/auth/v1/user')
        response =
          headers.get('authorization') === 'Bearer ' + jwt
            ? Response.json(user)
            : new Response('{}', { status: 401 });
      else if (path === '/auth/v1/settings')
        response = Response.json({
          external: { phone: true },
          disable_signup: false,
          autoconfirm: false,
          phone_autoconfirm: false,
        });
      else if (path === '/auth/v1/logout') response = Response.json({});
      else if (path === '/auth/v1/token') response = Response.json(session);
      else if (path === '/functions/v1/desk-notifications') {
        const input = JSON.parse(body.toString());
        if (input.action === 'register') registrations++;
        if (input.action === 'revoke') withdrawals++;
        response = await handler(
          new Request(apiUrl + path, { method: 'POST', headers, body }),
        );
        if (input.action === 'register' && response.ok && hold) {
          const held = hold;
          hold = null;
          held.entered();
          await held.gate;
        }
        if (input.action === 'register' && response.ok && lose) {
          lose = false;
          const bytes = Buffer.from(await response.arrayBuffer());
          res
            .writeHead(response.status, {
              ...cors,
              'Content-Type': 'application/json',
              'Content-Length': String(bytes.length),
              Connection: 'close',
            })
            .end(bytes.subarray(0, 2));
          return;
        }
      } else if (path?.startsWith('/rest/v1/rpc/')) {
        if (path.endsWith('/set_kitchen_alarm_settings')) settingsCalls++;
        response = await rpc('https://rpc.test' + path, {
          method: 'POST',
          headers,
          body,
        });
      } else response = new Response('{}', { status: 404 });
      const bytes = Buffer.from(await response.arrayBuffer());
      res
        .writeHead(response.status, {
          ...cors,
          'Content-Type': 'application/json',
          'Content-Length': String(bytes.length),
        })
        .end(bytes);
    } catch {
      if (res.headersSent) res.destroy();
      else
        res
          .writeHead(503, { ...cors, 'Content-Type': 'application/json' })
          .end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  apiUrl = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  let setup: SetupSnapshot,
    order: Order,
    device: SharedDevice & { token: string },
    staff: StaffDeviceSession;
  async function prepare() {
    for (const release of releases) release();
    hold = null;
    lose = false;
    registrations = 0;
    withdrawals = 0;
    settingsCalls = 0;
    await serial(() => f.seed());
    const original = orderFixture('corner_shop'),
      seed = original.context.setup;
    setup = {
      business: { ...seed.business, id: deviceId(1), name: 'Desk shop' },
      outlet: {
        ...seed.outlet,
        id: deviceId(11),
        businessId: deviceId(1),
        name: 'Outlet 11',
      },
      owner: {
        ...seed.owner,
        id: deviceId(101),
        businessId: deviceId(1),
        name: 'Member 101',
        outletIds: [deviceId(11)],
      },
    };
    const made = saveOrderCommand(
      {
        ...original.input,
        sourceText: 'PRIVATE SOURCE',
        name: 'PRIVATE CUSTOMER',
        address: 'PRIVATE ADDRESS',
      },
      { ...original.context, setup, sequence: 2041 },
      null,
      0,
      Date.now() - 180000,
    );
    order = made.order;
    const events = [made.event];
    while (order.status !== 'accepted') {
      const change = changeOrderStatusCommand(
        order,
        nextOrderStatuses(order)[0],
        setup,
        order.revision,
        order.updatedAt + 1,
      );
      order = change.order;
      events.push(change.event);
    }
    await serial(() =>
      f.db.transaction(async (sql) => {
        for (const record of [
          ...events.map((event) =>
            encodeCommandRecord('events', event, deviceId(1)),
          ),
          encodeCommandRecord('orders', order, deviceId(1)),
        ]) {
          const keys = Object.keys(record.values);
          await sql.query(
            `insert into public.${record.table}(${keys.join(',')}) values(${keys.map((_, index) => '$' + (index + 1)).join(',')})`,
            Object.values(record.values),
          );
        }
      }),
    );
    const prepared = (await alarms.prepare(25)) as {
        jobs: {
          businessId: string;
          outletId: string;
          orderId: string;
          version: number;
          stamp: string;
        }[];
      },
      job = prepared.jobs.find((value) => value.orderId === order.id);
    if (!job) throw Error('Missing genuine due kitchen job');
    const result = await alarms.finish({
      ...job,
      contentHash: await kitchenContentHash(order),
      taskId: newKitchenId(),
      eventId: newKitchenId(),
      resolveEventId: newKitchenId(),
    });
    if ((result as { raised?: boolean }).raised !== true)
      throw Error('Kitchen task was not raised');
    device = await serial(() =>
      f.asRole(
        1,
        'authenticated',
        'select public.enrol_device($1,$2,$3,$4,$5) data',
        [
          newKitchenId(),
          newKitchenId(),
          deviceId(11),
          'Kitchen fixture',
          'kitchen',
        ],
      ),
    );
    const attempt = await serial(() =>
      f.asRole<{ attemptId: string; salt: string }>(
        null,
        'service_role',
        'select public.begin_staff_pin($1,$2,$3) data',
        [newKitchenId(), device.token, deviceId(105)],
      ),
    );
    const proof = await deriveStaffPin(
      '0042',
      attempt.salt,
      { businessId: deviceId(1), memberId: deviceId(105) },
      f.pepper,
    );
    staff = await serial(() =>
      f.asRole(
        null,
        'service_role',
        'select public.finish_staff_pin($1,$2,$3,$4,$5) data',
        [
          device.token,
          attempt.attemptId,
          proof,
          newKitchenId(),
          newKitchenId(),
        ],
      ),
    );
    return {
      config: { apiUrl, publishableKey: 'sb_publishable_test_only' },
      session,
      setup,
      order,
      applicationKey,
    };
  }
  return {
    prepare,
    loseNextRegistrationReply() {
      lose = true;
    },
    holdRegistration() {
      let entered!: () => void, finish!: () => void;
      const started = new Promise<void>((resolve) => {
          entered = resolve;
        }),
        gate = new Promise<void>((resolve) => {
          finish = resolve;
        }),
        release = () => {
          finish();
          releases.delete(release);
        };
      releases.add(release);
      hold = { entered, gate };
      return { started, release };
    },
    async acknowledge() {
      const action = await prepareKitchenAction(order, 'kitchen.acknowledge'),
        response = await kitchen(
          new Request(apiUrl + '/functions/v1/kitchen-actions', {
            method: 'POST',
            headers: {
              origin,
              Authorization: 'Bearer ' + device.token,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ sessionToken: staff.token, action }),
          }),
        );
      if (!response.ok) throw Error('Real kitchen acknowledgement failed');
      return response.json();
    },
    async changeWarning(minutes: number) {
      const revision = await serial(
        async () =>
          (
            await f.db.query<{ revision: number }>(
              'select revision from public.kitchen_alarm_settings where outlet_id=$1',
              [deviceId(11)],
            )
          ).rows[0]?.revision ?? 0,
      );
      return serial(() =>
        f.asRole(
          1,
          'authenticated',
          'select public.set_kitchen_alarm_settings($1,$2,$3,$4,$5) data',
          [deviceId(11), revision, true, minutes, newKitchenId()],
        ),
      );
    },
    async inspect() {
      return serial(async () => ({
        registrations,
        withdrawals,
        settingsCalls,
        order: (
          await f.db.query<{ status: string; payment: string; total: number }>(
            'select status,payment,total from public.orders where id=$1',
            [order.id],
          )
        ).rows[0],
        openTasks: (
          await f.db.query<{ n: number }>(
            "select count(*)::int n from public.tasks where status='open'",
          )
        ).rows[0].n,
        activeSubscriptions: (
          await f.db.query<{ n: number }>(
            'select count(*)::int n from private.desk_push_subscriptions where revoked_at is null',
          )
        ).rows[0].n,
      }));
    },
    async close() {
      for (const release of releases) release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await tail;
      await f.db.close();
    },
  };
}
