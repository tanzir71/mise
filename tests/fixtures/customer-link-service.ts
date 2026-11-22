import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  createPairingDatabase,
  deviceId,
  deviceUid,
} from '../device-pairing-fixture';
import { setupCommand } from '../../packages/core/setup';
import {
  saveOrderCommand,
  changeOrderStatusCommand,
  nextOrderStatuses,
} from '../../packages/core/orders';
import { saveCustomerCommand } from '../../packages/core/customers';
import {
  defaultCreditTerms,
  saveCreditTermsCommand,
  openingBalanceCommand,
} from '../../packages/core/khata';
import {
  encodeCommandRecord,
  type CloudRecord,
} from '../../packages/core/cloud-records';
import { publicShopUrl } from '../../packages/core/public-shop-codec';
import { newInboxId } from '../../packages/core/inbox';
import { normalizeBase } from '../../packages/core/paths';
import { createPublicCapabilityHandler } from '../../supabase/functions/_shared/public-capability-handler';
import type { Order, SetupSnapshot } from '../../packages/core/models';
/** Synthetic phone accounts with actual Core commands, HTTP, Auth SDK clients,
 * SQL roles, scope checks and one-time capabilities. No provider/hosted account. */
export async function startCustomerLinkService() {
  const f = await createPairingDatabase(process.cwd()),
    origin = 'http://127.0.0.1:4321';
  let apiUrl = '',
    lose: string | null = null;
  const rpcs: Record<string, string[]> = {
    read_customer_link_page: [
      'p_kind',
      'p_resource_id',
      'p_after_id',
      'p_page_size',
    ],
    create_public_link: [
      'p_id',
      'p_event_id',
      'p_kind',
      'p_resource_id',
      'p_expires_at',
    ],
    read_public_link_attempt: [
      'p_id',
      'p_create_event_id',
      'p_kind',
      'p_resource_id',
    ],
    close_public_link_attempt: [
      'p_id',
      'p_create_event_id',
      'p_event_id',
      'p_kind',
      'p_resource_id',
    ],
    revoke_public_link: ['p_id', 'p_event_id'],
  };
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
      'synthetic-customer-link-test-signature',
    ].join('.'),
  );
  const who = (value: string) => {
    const at = tokens.indexOf(value);
    if (at < 0) throw Error('Synthetic Auth denied');
    return at + 1;
  };
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
  let setup: SetupSnapshot, order: Order, records: ReturnType<typeof resources>;
  function resources() {
    const at = Date.now() - 600000,
      seed = setupCommand(
        {
          name: 'Shorshe Kitchen',
          outletName: 'Dhanmondi',
          businessType: 'restaurant',
          marketCode: 'BD',
          phone: '+14155550101',
        },
        null,
        at,
      ).snapshot;
    setup = {
      business: { ...seed.business, id: deviceId(1) },
      outlet: { ...seed.outlet, id: deviceId(11), businessId: deviceId(1) },
      owner: {
        ...seed.owner,
        id: deviceId(101),
        businessId: deviceId(1),
        outletIds: [deviceId(11)],
      },
    };
    const customer = saveCustomerCommand(
      {
        name: 'Sadia Islam',
        nickname: '',
        phone: '+14155550150',
        address: 'PRIVATE CUSTOMER ADDRESS',
        notes: 'PRIVATE CUSTOMER NOTE',
        tags: [],
      },
      setup,
      [],
      null,
      at,
    );
    const terms = saveCreditTermsCommand(
        { ...defaultCreditTerms, allowed: true, limit: 100000 },
        customer.customer,
        setup,
        null,
        at,
      ),
      opening = openingBalanceCommand(
        96000,
        at,
        {
          setup,
          customer: customer.customer,
          account: terms.account,
          entries: [],
        },
        at,
      );
    const created = saveOrderCommand(
      {
        source: 'phone',
        sourceText: 'PRIVATE CUSTOMER SOURCE',
        customerId: customer.customer.id,
        name: customer.customer.name,
        phone: customer.customer.phone ?? '',
        type: 'delivery',
        address: 'PRIVATE CUSTOMER ADDRESS',
        table: '',
        lines: [
          { name: 'Kacchi Biryani', unit: 'plate', qty: 2, unitPrice: 38000 },
          { name: 'Borhani', unit: 'bottle', qty: 1, unitPrice: 9000 },
        ],
        deliveryFee: 6000,
        discount: 0,
        payment: { method: 'cash' },
      },
      { setup, customer: customer.customer, items: [], sequence: 2041 },
      null,
      0,
      at,
    );
    order = created.order;
    const events = [customer.event, terms.event, opening.event, created.event];
    while (order.status !== 'out') {
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
    const url = publicShopUrl(
      origin + normalizeBase(process.env.BASE_PATH) + 'app/',
      {
        v: 1,
        code: 'BD-TRACK01',
        edition: newInboxId(),
        publishedAt: at,
        name: setup.business.name,
        address: 'Road 27, Dhanmondi',
        hours: 'Open until 11 pm',
        phone: '+14155550199',
        deliveryNote: 'Contact the shop for delivery timing.',
        market: 'BD',
        currency: 'BDT',
        timezone: 'Asia/Dhaka',
        mode: 'list',
        items: [],
      },
    );
    setup.outlet = { ...setup.outlet, shopLink: url };
    const manager = {
      ...setup.owner,
      id: deviceId(102),
      role: 'manager' as const,
      name: 'Assigned manager',
      phone: '+14155550102',
    };
    return {
      setup,
      customer: customer.customer,
      account: terms.account,
      entries: [opening.entry],
      order,
      events,
      members: [setup.owner, manager],
    };
  }
  async function insert(tx: Pick<typeof f.db, 'query'>, record: CloudRecord) {
    const keys = Object.keys(record.values);
    await tx.query(
      `insert into public.${record.table}(${keys.join(',')}) values(${keys.map((_, i) => '$' + (i + 1)).join(',')})`,
      Object.values(record.values),
    );
  }
  async function reset() {
    await f.seed();
    records = resources();
    lose = null;
    await f.db.exec(
      'update private.public_read_budget set window_at=0,requests=0;',
    );
    await f.db.transaction(async (tx) => {
      await tx.query(
        "update public.businesses set name=$2,business_type='restaurant' where id=$1",
        [setup.business.id, JSON.stringify(setup.business.name)],
      );
      await tx.query(
        'update public.outlets set name=$2,shop_link=$3 where id=$1',
        [
          setup.outlet.id,
          JSON.stringify(setup.outlet.name),
          setup.outlet.shopLink,
        ],
      );
      for (const record of [
        encodeCommandRecord('customers', records.customer, setup.business.id),
        encodeCommandRecord(
          'creditAccounts',
          records.account,
          setup.business.id,
        ),
        ...records.entries.map((v) =>
          encodeCommandRecord('creditEntries', v, setup.business.id),
        ),
        encodeCommandRecord('orders', order, setup.business.id),
        ...records.events.map((v) =>
          encodeCommandRecord('events', v, setup.business.id),
        ),
      ]) {
        await insert(tx, record);
        if (record.table === 'customers')
          await tx.query(
            'insert into public.customer_outlets values($1,$2,$3)',
            [setup.business.id, setup.outlet.id, records.customer.id],
          );
      }
    });
    calls.splice(0);
  }
  const calls: { path: string; auth: boolean; apikey: boolean }[] = [];
  const publicRead = createPublicCapabilityHandler({
    origins: new Set([origin]),
    store: {
      read: (value, limits) =>
        f.asRole(
          null,
          'service_role',
          'select public.read_public_capability($1,$2,$3,$4,$5,$6) data',
          [
            value.token,
            value.kind,
            value.afterSequence,
            value.pageSize,
            limits.global,
            limits.link,
          ],
        ),
    },
  });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  const server = createServer(async (req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers':
        'authorization,apikey,content-type,x-client-info,x-supabase-api-version',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Cache-Control': 'no-store',
    };
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const part of req) {
        size += part.length;
        if (size > 8192) throw Error();
        chunks.push(Buffer.from(part));
      }
      const raw = Buffer.concat(chunks).toString('utf8'),
        url = new URL(req.url ?? '/', apiUrl),
        headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(',') : v);
      calls.push({
        path: url.pathname,
        auth: headers.has('Authorization'),
        apikey: headers.has('apikey'),
      });
      let response: Response;
      if (url.pathname === '/auth/v1/user') {
        try {
          response = json(
            user(who(headers.get('Authorization')?.slice(7) ?? '')),
          );
        } catch {
          response = json({ error: 'Synthetic sign-in denied' }, 401);
        }
      } else if (url.pathname === '/auth/v1/logout') response = json({});
      else if (url.pathname === '/functions/v1/public-read')
        response = await publicRead(
          new Request(url, { method: req.method, headers, body: raw }),
        );
      else if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const rpc = url.pathname.split('/').at(-1)!,
          keys = rpcs[rpc],
          body = JSON.parse(raw);
        if (
          !keys ||
          Object.keys(body).sort().join(',') !== [...keys].sort().join(',')
        )
          response = json({ error: 'Unknown RPC' }, 400);
        else
          try {
            response = json(
              await f.asRole(
                who(headers.get('Authorization')?.slice(7) ?? ''),
                'authenticated',
                `select public.${rpc}(${keys.map((k, i) => k + '=>' + ('$' + (i + 1))).join(',')}) data`,
                keys.map((k) => body[k]),
              ),
            );
          } catch {
            response = json({ error: 'Access denied' }, 403);
          }
      } else
        response = json({ error: 'No provider endpoint in this fixture' }, 404);
      const bytes = Buffer.from(await response.arrayBuffer()),
        out = new Headers(cors);
      for (const [k, v] of response.headers) out.set(k, v);
      out.set('Content-Length', String(bytes.length));
      const drop =
        lose !== null && url.pathname.endsWith('/' + lose) && response.ok;
      if (drop) {
        lose = null;
        out.set('Connection', 'close');
      }
      res.writeHead(response.status, Object.fromEntries(out));
      res.end(drop ? bytes.subarray(0, 2) : bytes);
    } catch {
      res.writeHead(503, cors).end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  apiUrl = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  try {
    await reset();
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await f.db.close();
    throw error;
  }
  return {
    reset,
    config(n: 1 | 2 = 1) {
      return {
        apiUrl,
        publishableKey: 'sb_publishable_test_only',
        jwt: tokens[n - 1],
        user: user(n),
        records: {
          ...records,
          setup: n === 1 ? setup : { ...setup, owner: records.members[1] },
        },
      };
    },
    calls,
    loseNext(
      rpc:
        | 'create_public_link'
        | 'close_public_link_attempt'
        | 'revoke_public_link',
    ) {
      lose = rpc;
    },
    async issue(kind: 'order' | 'khata' = 'order') {
      return f.asRole<{ id: string; token: string }>(
        1,
        'authenticated',
        'select public.create_public_link($1,$2,$3,$4,null) data',
        [
          newInboxId(),
          newInboxId(),
          kind,
          kind === 'order' ? order.id : records.account.id,
        ],
      );
    },
    async revoke(id: string) {
      return f.asRole(
        1,
        'authenticated',
        'select public.revoke_public_link($1,$2) data',
        [id, newInboxId()],
      );
    },
    async status(next: Order['status']) {
      const change = changeOrderStatusCommand(
        order,
        next,
        setup,
        order.revision,
        Date.now(),
      );
      await f.db.transaction(async (tx) => {
        await insert(
          tx,
          encodeCommandRecord('events', change.event, setup.business.id),
        );
        const row = encodeCommandRecord(
            'orders',
            change.order,
            setup.business.id,
          ),
          keys = Object.keys(row.values).filter((k) => k !== 'id');
        await tx.query(
          `update public.orders set ${keys.map((k, i) => k + '=$' + (i + 2)).join(',')} where id=$1`,
          [order.id, ...keys.map((k) => row.values[k])],
        );
      });
      order = change.order;
    },
    async counts() {
      return (
        await f.db.query<{
          value: {
            creates: number;
            closures: number;
            revokes: number;
            active: number;
          };
        }>(
          "select jsonb_build_object('creates',(select count(*) from public.events where command='public_link.create'),'closures',(select count(*) from public.events where command='public_link.close_attempt'),'revokes',(select count(*) from public.events where command='public_link.revoke'),'active',(select count(*) from private.public_links where revoked_at is null)) value",
        )
      ).rows[0].value;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await f.db.close();
    },
  };
}
export type CustomerLinkFixtureConfig = ReturnType<
  Awaited<ReturnType<typeof startCustomerLinkService>>['config']
>;
