import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  deviceId,
  deviceUid,
} from '../device-pairing-fixture';
import {createStaffDeviceFixture} from '../staff-device-fixture';
import { setupCommand } from '../../packages/core/setup';
import { newInboxId } from '../../packages/core/inbox';
import {
  createDeviceAccessHandler,
  type DeviceAccessStore,
} from '../../supabase/functions/_shared/device-access-handler';
import { createDevicePinHandler } from '../../supabase/functions/_shared/device-pin-handler';
import {
  createOwnerPinHandler,
  OwnerPinDenied,
} from '../../supabase/functions/_shared/owner-pin-handler';

/** Real HTTP/SQL/roles/crypto, with explicitly synthetic verified Auth users.
 * No hosted project, provider, actual owner credential or SMS is involved. */
export async function startDeviceUiService() {
  const f = await createStaffDeviceFixture(process.cwd());
  await f.seed();
  const origin = 'http://127.0.0.1:4321',
    origins = new Set([origin]);
  const tokens = [1, 2].map((n) =>
    [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
        'base64url',
      ),
      Buffer.from(
        JSON.stringify({
          sub: deviceUid(n),
          role: 'authenticated',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString('base64url'),
      'synthetic-test-signature',
    ].join('.'),
  );
  const who = (jwt: string) => {
    const at = tokens.indexOf(jwt);
    if (at < 0) throw new OwnerPinDenied(401);
    return at + 1;
  };
  const owner = async <T = unknown>(
    jwt: string,
    sql: string,
    args: unknown[] = [],
  ) => {
    try {
      return await f.asRole<T>(who(jwt), 'authenticated', sql, args);
    } catch (error) {
      if (error instanceof OwnerPinDenied) throw error;
      throw new OwnerPinDenied(403);
    }
  };
  const accessStore: DeviceAccessStore = {
    request: (id, code, parent, hash) =>
      f.asRole(
        null,
        'service_role',
        'select public.request_device_pairing($1,$2,$3,$4) data',
        [id, code, parent, hash],
      ),
    poll: (id, secret) =>
      f.asRole(
        null,
        'service_role',
        'select public.read_device_pairing($1,$2) data',
        [id, secret],
      ),
    directory: f.directoryRead,
    session: (secret, token) =>
      f.asRole(
        null,
        'service_role',
        'select public.read_device_session($1,$2) data',
        [secret, token],
      ),
    logout: (secret, token, id) =>
      f.asRole(
        null,
        'service_role',
        'select public.end_device_session($1,$2,$3) data',
        [secret, token, id],
      ),
    reset: (secret, id, attempt) =>
      f.asRole(
        null,
        'service_role',
        'select public.reset_device_signins($1,$2,$3) data',
        [secret, id, attempt],
      ),
  };
  const access = createDeviceAccessHandler({ store: accessStore, origins }),
    pin = createDevicePinHandler({
      store: {
        begin: (id, secret, member) =>
          f.asRole(
            null,
            'service_role',
            'select public.begin_staff_pin($1,$2,$3) data',
            [id, secret, member],
          ),
        finish: (secret, id, proof, session, event) =>
          f.asRole(
            null,
            'service_role',
            'select public.finish_staff_pin($1,$2,$3,$4,$5) data',
            [secret, id, proof, session, event],
          ),
      },
      peppers: new Map([['v1', f.pepper]]),
      origins,
    }),
    ownerPin = createOwnerPinHandler({
      pepper: f.pepper,
      origins,
      store: {
        context: (jwt, outlet, member, action) =>
          owner(jwt, 'select public.staff_pin_context($1,$2,$3) data', [
            outlet,
            member,
            action,
          ]),
        set: (jwt, outlet, member, event, c) =>
          owner(jwt, 'select public.set_staff_pin($1,$2,$3,$4,$5,$6) data', [
            outlet,
            member,
            event,
            c.salt,
            c.verifier,
            c.pepperVersion,
          ]),
        clear: (jwt, outlet, member, event) =>
          owner(jwt, 'select public.clear_staff_pin($1,$2,$3) data', [
            outlet,
            member,
            event,
          ]),
      },
    });
  const rpcs: Record<string, string[]> = {
    staff_pin_context: ['p_outlet_id','p_member_id','p_action'],
    read_device_admin: ['p_outlet_id', 'p_kind', 'p_after_id', 'p_limit'],
    start_device_pairing: [
      'p_id',
      'p_event_id',
      'p_outlet_id',
      'p_name',
      'p_mode',
    ],
    inspect_device_pairing: ['p_id'],
    approve_device_pairing: [
      'p_pairing_id',
      'p_request_id',
      'p_verification',
      'p_event_id',
    ],
    cancel_device_pairing: ['p_id', 'p_event_id'],
    revoke_device: ['p_id', 'p_event_id'],
  };
  let apiUrl = '',
    lose: string | null = null;
  const calls = { auth: 0, otp: 0, pin: 0, reset: 0, starts: 0 };
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  const user = (n: number) => ({
    id: deviceUid(n),
    aud: 'authenticated',
    role: 'authenticated',
    phone: '1415555010' + n,
    phone_confirmed_at: new Date(1000).toISOString(),
    confirmed_at: new Date(1000).toISOString(),
    created_at: new Date(1000).toISOString(),
    updated_at: new Date(1000).toISOString(),
    is_anonymous: false,
    app_metadata: { provider: 'phone', providers: ['phone'] },
    user_metadata: {},
    identities: [],
  });
  const server = createServer(async (req, res) => {
    try {
      const cors = {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers':
          'authorization,apikey,content-type,x-client-info,x-supabase-api-version',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Cache-Control': 'no-store',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const part of req) chunks.push(Buffer.from(part));
      const body = Buffer.concat(chunks).toString('utf8'),
        url = new URL(req.url || '/', apiUrl),
        headers = new Headers();
      for (const [key, value] of Object.entries(req.headers))
        if (value !== undefined)
          headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const request = new Request(url, {
          method: req.method,
          headers,
          ...(req.method === 'GET' ? {} : { body }),
        }),
        jwt = headers.get('Authorization')?.slice(7) || '';
      let response: Response;
      if (url.pathname === '/functions/v1/device-access') {
        const input = JSON.parse(body);
        if (input.action === 'reset') calls.reset++;
        response = await access(request);
      } else if (url.pathname === '/functions/v1/device-pin') {
        calls.pin++;
        response = await pin(request);
      } else if (url.pathname === '/functions/v1/staff-pin')
        response = await ownerPin(request);
      else if (url.pathname === '/auth/v1/user') {
        calls.auth++;
        try {
          response = json(user(who(jwt)));
        } catch {
          response = json({ error: 'Synthetic sign-in denied' }, 401);
        }
      } else if (url.pathname === '/auth/v1/logout') response = json({});
      else if (url.pathname === '/auth/v1/otp') {
        calls.otp++;
        response = json({ error: 'No SMS in this fixture' }, 400);
      } else if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const rpc = url.pathname.split('/').at(-1)!,
          keys = rpcs[rpc],
          input = JSON.parse(body);
        if (
          !keys ||
          Object.keys(input).sort().join(',') !== [...keys].sort().join(',')
        )
          response = json({ error: 'Unknown synthetic RPC' }, 400);
        else {
          if (rpc === 'start_device_pairing') calls.starts++;
          try {
            response = json(
              await owner(
                jwt,
                `select public.${rpc}(${keys.map((key, i) => key + '=>' + ('$' + (i + 1))).join(',')}) data`,
                keys.map((key) => input[key]),
              ),
            );
          } catch {
            response = json({ error: 'Outlet access denied' }, 403);
          }
        }
      } else response = json({ error: 'Unknown synthetic endpoint' }, 404);
      const bytes = Buffer.from(await response.arrayBuffer()),
        out = new Headers(cors);
      for (const [key, value] of response.headers) out.set(key, value);
      out.set('Content-Length', String(bytes.length));
      const drop =
        lose &&
        ((lose === 'start' && url.pathname.endsWith('/start_device_pairing')) ||
          (lose === 'pin' && url.pathname.endsWith('/device-pin')) ||
          (lose === 'reset' &&
            url.pathname.endsWith('/device-access') &&
            JSON.parse(body).action === 'reset')) &&
        response.ok;
      if (drop) {
        lose = null;
        out.set('Connection', 'close');
      }
      res.writeHead(response.status, Object.fromEntries(out));
      res.end(drop ? bytes.subarray(0, 2) : bytes);
    } catch {
      res
        .writeHead(503, {
          'Access-Control-Allow-Origin': origin,
          'Content-Type': 'application/json',
        })
        .end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  apiUrl = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const config = (n: 1 | 2 = 1) => {
    const { snapshot } = setupCommand(
      {
        name: 'Fixture shop',
        outletName: 'Outlet 11',
        marketCode: 'BD',
        businessType: 'corner_shop',
        phone: '+1415555010' + n,
      },
      null,
      1000,
    );
    return {
      apiUrl,
      publishableKey: 'sb_publishable_test_only',
      jwt: tokens[n - 1],
      user: user(n),
      setup: {
        business: { ...snapshot.business, id: deviceId(1) },
        outlet: {
          ...snapshot.outlet,
          id: deviceId(11),
          businessId: deviceId(1),
        },
        owner: {
          ...snapshot.owner,
          id: deviceId(n === 1 ? 101 : 102),
          businessId: deviceId(1),
          outletIds: [deviceId(11)],
          role: n === 1 ? ('owner' as const) : ('manager' as const),
        },
      },
    };
  };
  return {
    config,
    calls,
    configureRider: (enabled:boolean) => f.configure(deviceId(111),{name:'Rider preview',role:'rider',methods:enabled?['order_phone']:[]}),
    reset: async () => {
      lose = null;
      await f.seed();
    },
    newPairing: async () => (await f.start()).pairing,
    async revokeManager() {
      await f.db.query('delete from public.member_outlets where member_id=$1', [
        deviceId(102),
      ]);
    },
    async approvePending(id: string, verification: string, requestId?: string) {
      const deadline = Date.now() + 5000;
      let claim: { id: string; verification: string } | undefined;
      while (!claim && Date.now() < deadline) {
        const inspected = await f.asRole<{
          requests: { id: string; verification: string }[];
        }>(
          1,
          'authenticated',
          'select public.inspect_device_pairing($1) data',
          [id],
        );
        claim = inspected.requests.find(
          (row) =>
            row.verification === verification &&
            (!requestId || row.id === requestId),
        );
        if (!claim) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!claim) throw Error('Fixture comparison does not match');
      return f.asRole(
        1,
        'authenticated',
        'select public.approve_device_pairing($1,$2,$3,$4) data',
        [id, claim.id, verification, newInboxId()],
      );
    },
    loseNext: (kind: 'start' | 'pin' | 'reset') => {
      lose = kind;
    },
    async counts() {
      return (
        await f.db.query<{
          devices: number;
          sessions: number;
          pending: number;
          starts: number;
        }>(
          "select (select count(*)::int from private.devices) devices,(select count(*)::int from private.device_sessions where revoked_at is null) sessions,(select count(*)::int from private.device_pairings where closed_at is null) pending,(select count(*)::int from public.events where command='device.pairing_start') starts",
        )
      ).rows[0];
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await f.db.close();
    },
  };
}
