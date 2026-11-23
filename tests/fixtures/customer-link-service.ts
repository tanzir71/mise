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
  decodeCommandRecord,
  type CloudRecord,
} from '../../packages/core/cloud-records';
import { publicShopUrl } from '../../packages/core/public-shop-codec';
import { newInboxId } from '../../packages/core/inbox';
import { normalizeBase } from '../../packages/core/paths';
import { createPublicCapabilityHandler } from '../../supabase/functions/_shared/public-capability-handler';
import {createPublicOrderHandler} from '../../supabase/functions/_shared/public-order-handler';
import {createOrderCheckoutHandler} from '../../supabase/functions/_shared/order-checkout-handler';
import {confirmationIntentJson} from '../../packages/core/order-confirmation-protocol';
import {publicOrderHash,publicOrderIntentJson} from '../../packages/core/public-order-submission';
import {decodeShopPayload} from '../../packages/core/public-shop-decode';
import {publicOrderingUrl} from '../../packages/core/public-order-link';
import {parseEstimateAction,parseEstimateOutcome} from '../../packages/core/order-estimates';
import {customerViewerUrl} from '../../packages/core/customer-link-url';
import type { Order, SetupSnapshot } from '../../packages/core/models';
import {settleOrderCommand} from '../../packages/core/order-payments';
import {createStaffLinkHandler} from '../../supabase/functions/_shared/staff-link-handler';
import {emptyStaffProfile} from '../../packages/core/staff';
import {parseStaffOwnerAction,parseStaffOwnerContext,parseStaffOwnerOutcome} from '../../packages/core/staff-protocol';
import {parseStaffLinkAction,parseStaffLinkContext,staffViewerUrl} from '../../packages/core/staff-links';
import {deviceSecretHash} from '../../packages/core/device-access';
/** Synthetic phone accounts with actual Core commands, HTTP, Auth SDK clients,
 * SQL roles, scope checks and one-time capabilities. No provider/hosted account. */
export async function startCustomerLinkService(options:{ordering?:boolean;estimates?:boolean;checkout?:boolean;staffTeam?:boolean}={}) {
  const f = await createPairingDatabase(process.cwd()),
    origin = 'http://127.0.0.1:4321';
  let apiUrl = '',
    lose: string | null = null;
  const rpcs: Record<string, string[]> = {
    ...(options.staffTeam?{read_staff_context:['p_outlet_id','p_member_id'],read_staff_board:['p_outlet_id','p_after','p_page_size'],change_staff_action:['p_outlet_id','p_action_json','p_operation'],read_staff_links:['p_outlet_id','p_member_id','p_after'],change_staff_link:['p_outlet_id','p_action_json','p_operation']}:{}),
    ...((options.ordering||options.estimates||options.checkout)?{read_checkout_policy:['p_outlet_id','p_order_id'],change_checkout_policy:['p_outlet_id','p_action','p_operation']}:{}),
    ...(options.estimates?{read_order_estimate:['p_order_id'],change_order_estimate:['p_order_id','p_action_id','p_order_revision','p_estimate_revision','p_change','p_operation']}:{}),
    ...(options.ordering?{read_public_shop_page:['p_outlet_id','p_after_id','p_page_size'],publish_public_shop:['p_id','p_event_id','p_outlet_id','p_source_url','p_payload_json','p_secret_hash','p_table','p_expiry'],revoke_public_shop:['p_id','p_event_id','p_outlet_id']}:{}),
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
          businessType: options.checkout?'corner_shop':'restaurant',
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
        options.checkout?40000:96000,
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
    while (order.status !== (options.checkout?'delivering':'out')) {
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
        name: options.ordering?setup.outlet.name:setup.business.name,
        address: options.ordering?setup.outlet.address:'Road 27, Dhanmondi',
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
      'update private.public_read_budget set window_at=0,requests=0;update private.public_order_budget set window_at=0,requests=0;update private.staff_link_budget set window_at=0,requests=0;',
    );
    await f.db.transaction(async (tx) => {
      await tx.query(
        'update public.businesses set name=$2,business_type=$3 where id=$1',
        [setup.business.id, JSON.stringify(setup.business.name),setup.business.businessType],
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
  const publicOrder=createPublicOrderHandler({origins:new Set([origin]),store:{
    prepare:async(value,limits)=>f.asRole(null,'service_role','select public.prepare_public_order($1,$2,$3,$4,$5,$6) data',[value.shopToken,await publicOrderHash(value.trackingToken),publicOrderIntentJson(value.intent),value.action,limits.global,limits.shop]),
    finish:(value,preparation,rows)=>f.asRole(null,'service_role','select public.finish_public_order($1,$2,$3) data',[value.intent.id,preparation.ticketToken,JSON.stringify(rows)]),
  }});
  const checkout=createOrderCheckoutHandler({origins:new Set([origin]),store:{
    prepare:(value,limits)=>f.asRole(null,'service_role','select public.prepare_order_confirmation($1,$2,$3,$4,$5) data',[value.token,value.intent?confirmationIntentJson(value.intent):null,value.action,limits.global,limits.link]),
    finish:(value,preparation,rows)=>f.asRole(null,'service_role','select public.finish_order_confirmation($1,$2,$3) data',[value.id,preparation.ticketToken,JSON.stringify(rows)]),
  }});
  const staff=createStaffLinkHandler({origins:new Set([origin]),store:{visit:(value,limits)=>f.asRole(null,'service_role','select public.visit_staff_link($1,$2,$3,$4,$5,$6) data',[value.token,value.operation,value.intent===null?null:JSON.stringify(value.intent),value.after===null?null:JSON.stringify(value.after),limits.global,limits.link])}});
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
        if (size > (options.ordering||options.checkout?65536:8192)) throw Error();
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
      else if(options.ordering&&url.pathname==='/functions/v1/public/orders')response=await publicOrder(new Request(url,{method:req.method,headers,body:raw}));
      else if(options.staffTeam&&url.pathname==='/functions/v1/public/staff')response=await staff(new Request(url,{method:req.method,headers,body:raw}));
      else if(options.checkout&&['order-quote','order-confirmations','order-payment'].some(path=>url.pathname==='/functions/v1/public/'+path))response=await checkout(new Request(url,{method:req.method,headers,body:raw}));
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
                keys.map((k) => ['p_change','p_action'].includes(k)?JSON.stringify(body[k]):body[k]),
              ),
            );
          } catch (error) {
            const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
            const staffRpc=['read_staff_context','read_staff_board','change_staff_action','read_staff_links','change_staff_link'].includes(rpc);
            const status=(staffRpc||['read_order_estimate','change_order_estimate','read_checkout_policy','change_checkout_policy'].includes(rpc))?code==='42501'?403:code==='PT409'||code==='23505'||staffRpc&&code==='40001'?409:code.startsWith('22')?400:503:403;
            response = json({ error: status===403?'Access denied':'Review the original action' },status);
          }
      } else
        response = json({ error: 'No provider endpoint in this fixture' }, 404);
      const bytes = Buffer.from(await response.arrayBuffer()),
        out = new Headers(cors);
      for (const [k, v] of response.headers) out.set(k, v);
      out.set('Content-Length', String(bytes.length));
      const drop =
        lose !== null && url.pathname.endsWith('/' + lose) && response.ok && (lose!=='staff'||JSON.parse(raw).operation!=='read');
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
    viewerUrl(token:string,basePath:string,kind:'order'|'khata'='order'){return customerViewerUrl(origin,basePath,{kind,apiUrl,token});},
    async seedHistoricalEstimate(earlierCurrentWindow=false){
      if(!options.estimates)throw Error('Estimate fixture is not enabled');
      // A previously accepted promise, seeded as historical fixture data. The
      // real owner RPC deliberately refuses newly publishing a past window.
      const now=Date.now(),at=now-540000,id=newInboxId(),action=parseEstimateAction({v:1,id,orderId:order.id,orderRevision:order.revision,revision:0,change:{kind:'set',start:now+(earlierCurrentWindow?1500000:-480000),end:now+(earlierCurrentWindow?1800000:-360000),note:'The earlier shop estimate.',undoOf:null}}),
        estimate={revision:1,start:action.change.start,end:action.change.end,firstEnd:action.change.end,note:action.change.note,updatedAt:at},receipt=parseEstimateOutcome({v:1,action,state:'applied',at,estimate},action);
      const history=[{action,receipt,previous:null as typeof estimate|null}];
      if(earlierCurrentWindow){const nextAction=parseEstimateAction({v:1,id:newInboxId(),orderId:order.id,orderRevision:order.revision,revision:1,change:{kind:'set',start:now-480000,end:now-360000,note:'The shop brought the estimate forward.',undoOf:null}}),nextAt=now-420000,nextEstimate={...estimate,revision:2,start:nextAction.change.start,end:nextAction.change.end,note:nextAction.change.note,updatedAt:nextAt};history.push({action:nextAction,receipt:parseEstimateOutcome({v:1,action:nextAction,state:'applied',at:nextAt,estimate:nextEstimate},nextAction),previous:estimate});}
      if(history.some(row=>row.receipt.at!<order.updatedAt||row.receipt.estimate!.end!<=row.receipt.at!))throw Error('Historical estimates must follow the actual order and precede their deadlines');
      const latest=history.at(-1)!;
      await f.db.transaction(async tx=>{
        for(const row of history)await tx.query("insert into private.order_estimate_actions values($1,$2,$3,$4,$5,$6,'applied',$7,$8,$9)",[row.action.id,setup.business.id,setup.outlet.id,order.id,setup.owner.id,JSON.stringify(row.action),JSON.stringify(row.receipt),row.previous===null?null:JSON.stringify(row.previous),row.receipt.at]);
        const current=latest.receipt.estimate!;await tx.query('insert into private.order_estimates values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[order.id,setup.business.id,setup.outlet.id,current.revision,current.start,current.end,current.firstEnd,current.note,current.updatedAt,latest.action.id]);
      });return latest.receipt.estimate!;
    },
    async estimateCounts(){return(await f.db.query<{estimates:number;actions:number;closed:number}>("select (select count(*) from private.order_estimates) estimates,(select count(*) from private.order_estimate_actions) actions,(select count(*) from private.order_estimate_actions where state='closed') closed")).rows[0];},
    loseNext(
      rpc:
        | 'create_public_link'
        | 'close_public_link_attempt'
        | 'revoke_public_link' | 'publish_public_shop' | 'revoke_public_shop' | 'orders' | 'change_order_estimate' | 'change_checkout_policy' | 'order-confirmations' | 'change_staff_action' | 'change_staff_link' | 'staff',
    ) {
      lose = rpc;
    },
    async staffCounts(){return(await f.db.query<{checkIns:number;links:number;revoked:number;actions:number;closed:number}>("select (select count(*) from public.check_ins)::integer as \"checkIns\",(select count(*) from private.staff_links)::integer links,(select count(*) from private.staff_links where revoked_at is not null)::integer revoked,(select count(*) from private.staff_link_actions)::integer actions,(select count(*) from private.staff_link_actions where state='closed')::integer closed")).rows[0];},
    async staffScene(base:string){
      if(!options.staffTeam)throw Error('Staff fixture is not enabled');
      // Initial synthetic roster, then only actual authenticated staff commands.
      await f.db.query('update public.members set active=false where business_id=$1 and id<>$2',[setup.business.id,setup.owner.id]);
      const scope={businessId:setup.business.id,outletId:setup.outlet.id,actorId:setup.owner.id,actorRole:'owner' as const};
      const read=async(memberId:string)=>parseStaffOwnerContext(await f.asRole(1,'authenticated','select public.read_staff_context($1,$2) data',[scope.outletId,memberId]),scope,memberId);
      const change=async(action:ReturnType<typeof parseStaffOwnerAction>)=>parseStaffOwnerOutcome(await f.asRole(1,'authenticated','select public.change_staff_action($1,$2,$3) data',[scope.outletId,JSON.stringify(action),'submit']),action);
      for(const [n,name,nameLocal,role] of [[101,'Shop owner','দোকানের মালিক','owner'],[201,'Karim Uddin','করিম উদ্দিন','kitchen'],[202,'Nadia Akter','নাদিয়া আক্তার','staff'],[203,'Jamal Mia','জামাল মিয়া','rider'],[204,'Tuhin Ahmed','তুহিন আহমেদ','kitchen']] as const){
        const c=await read(deviceId(n)),draft={...emptyStaffProfile(),name,nameLocal,role,active:true,phone:'+1415555'+String(n).padStart(4,'0'),methods:['link'] as const,language:'bn' as const,shift:{days:[0,1,2,3,4,5,6],start:0,end:1439}};
        await change(parseStaffOwnerAction({...scope,v:1,id:newInboxId(),eventId:newInboxId(),memberId:c.memberId,kind:'save',expected:c.current,latest:null,draft,checkIn:null}));
        if(n!==202&&n!==204){const current=await read(c.memberId),eventId=newInboxId();await change(parseStaffOwnerAction({...scope,v:1,id:newInboxId(),eventId,memberId:c.memberId,kind:'check-in',expected:current.current,latest:current.latest,draft:null,checkIn:{v:1,id:newInboxId(),eventId,memberId:c.memberId,outletId:scope.outletId,type:'in',occurredAt:Date.now(),expectedLastId:current.latest?.id??null}}));}
      }
      const memberId=deviceId(202),context=parseStaffLinkContext(await f.asRole(1,'authenticated','select public.read_staff_links($1,$2,null) data',[scope.outletId,memberId]),scope,memberId),token='J'.repeat(43);
      const action=parseStaffLinkAction({...scope,v:1,id:newInboxId(),eventId:newInboxId(),memberId,linkId:newInboxId(),kind:'issue',expected:context.current,tokenHash:await deviceSecretHash(token),expiresAt:context.serverAt+30*86400000});
      await f.asRole(1,'authenticated','select public.change_staff_link($1,$2,$3) data',[scope.outletId,JSON.stringify(action),'submit']);
      const intent={v:1,id:newInboxId(),eventId:newInboxId(),memberId,outletId:scope.outletId,type:'in',occurredAt:Date.now(),expectedLastId:null};
      const receipt=await f.asRole<{state:string}>(null,'service_role','select public.visit_staff_link($1,$2,$3,null,1000,1000) data',[token,'submit',JSON.stringify(intent)]);if(receipt.state!=='applied')throw Error('Synthetic shift must be actually recorded');
      return {url:staffViewerUrl(origin,base,{v:1,apiUrl,token})};
    },
    async publishShop(table:string|null=null){
      if(!options.ordering)throw Error('Ordering fixture is not enabled');
      const shop=decodeShopPayload(new URL(setup.outlet.shopLink!).hash.slice(1)),token='S'.repeat(43);
      const metadata=await f.asRole<Record<string,unknown>>(1,'authenticated','select public.publish_public_shop($1,$2,$3,$4,$5,$6,$7,null) data',[newInboxId(),newInboxId(),setup.outlet.id,setup.outlet.shopLink,JSON.stringify(shop),await publicOrderHash(token),table]);
      return {url:publicOrderingUrl({v:1,sourceUrl:setup.outlet.shopLink!,apiUrl,shopToken:token,table}),metadata};
    },
    async orderCounts(){return(await f.db.query<{orders:number;submitted:number;publications:number;sales:number;entries:number}>("select (select count(*) from public.orders) orders,(select count(*) from public.events where command='order.create' and actor_type='system' and actor_id='public-order') submitted,(select count(*) from private.public_shops where created_at is not null) publications,(select count(*) from public.sales) sales,(select count(*) from public.credit_entries) entries")).rows[0];},
    async priceOrder(id:string,swap=true){
      if(!options.checkout)throw Error('Checkout fixture is not enabled');
      const before=decodeCommandRecord('orders',(await f.db.query<{data:Record<string,unknown>}>('select row_to_json(o) data from public.orders o where id=$1',[id])).rows[0].data) as unknown as Order;
      const change=saveOrderCommand({source:before.source,sourceText:before.sourceText,customerId:records.customer.id,name:before.customer.name,phone:before.customer.phone??'',type:before.type,address:before.address,table:before.table,lines:[{id:before.lines[0].id,name:'Miniket rice',unit:'kg',qty:2,unitPrice:10000,note:''},...(swap?[{name:'Soya milk',unit:'bottle',qty:1,unitPrice:5000,note:'Shop suggestion',substitution:{from:'Fresh milk',accepted:false}}]:[])],deliveryFee:0,discount:0,payment:{method:'cash'}},{setup,customer:records.customer,items:[],sequence:before.sequence},before,before.revision,Date.now());
      await f.db.transaction(async tx=>{await insert(tx,encodeCommandRecord('events',change.event,setup.business.id));const row=encodeCommandRecord('orders',change.order,setup.business.id),keys=Object.keys(row.values).filter(k=>k!=='id');await tx.query(`update public.orders set ${keys.map((k,i)=>k+'=$'+(i+2)).join(',')} where id=$1`,[id,...keys.map(k=>row.values[k])]);});
      order=change.order;records={...records,order,events:[...records.events,change.event]};return order;
    },
    async checkoutCounts(){return(await f.db.query<{actions:number;closed:number;settings:number;permissions:number}>("select (select count(*) from private.order_confirmation_actions) actions,(select count(*) from private.order_confirmation_actions where state='closed') closed,(select count(*) from private.outlet_checkout_settings) settings,(select count(*) from private.order_credit_permissions) permissions")).rows[0];},
    async recordCashPayment(){
      if(!options.checkout)throw Error('Checkout fixture is not enabled');
      const current=decodeCommandRecord('orders',(await f.db.query<{data:Record<string,unknown>}>('select row_to_json(o) data from public.orders o where id=$1',[order.id])).rows[0].data) as unknown as Order,change=settleOrderCommand(current,{method:'cash'},{setup},current.revision,Date.now());
      await f.db.transaction(async tx=>{for(const row of [...change.sales.map(v=>encodeCommandRecord('sales',v,setup.business.id)),...change.entries.map(v=>encodeCommandRecord('creditEntries',v,setup.business.id)),...change.events.map(v=>encodeCommandRecord('events',v,setup.business.id))])await insert(tx,row);const row=encodeCommandRecord('orders',change.order,setup.business.id),keys=Object.keys(row.values).filter(k=>k!=='id');await tx.query(`update public.orders set ${keys.map((k,i)=>k+'=$'+(i+2)).join(',')} where id=$1`,[order.id,...keys.map(k=>row.values[k])]);});order=change.order;return order;
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
      if(options.checkout){order=decodeCommandRecord('orders',(await f.db.query<{data:Record<string,unknown>}>('select row_to_json(o) data from public.orders o where id=$1',[order.id])).rows[0].data) as unknown as Order;}
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
