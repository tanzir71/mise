import {readFileSync, readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {afterAll, beforeAll, expect, it} from 'vitest';
import {createBackup} from '../packages/core/backup';
import {emptyBackupTables} from '../packages/core/backup-tables';
import {decodeCommandRecord, encodeCommandRecord, prepareCloudMigration} from '../packages/core/cloud-records';
import {newKitchenId, prepareKitchenAction, type KitchenAction, type KitchenReceipt} from '../packages/core/kitchen';
import {changeOrderStatusCommand, nextOrderStatuses, saveOrderCommand, undoOrderStatusCommand} from '../packages/core/orders';
import {ORDER_SOURCE_MAX_TEXT} from '../packages/core/order-limits';
import {orderPricing} from '../packages/core/order-lines';
import type {AuditEvent,Order} from '../packages/core/models';
import type {BusinessType} from '../packages/core/packs';
import {createStaffPin} from '../supabase/functions/_shared/staff-pin';
import {createKitchenActionsHandler, createKitchenActionsStore, replayKitchenPreparation, type KitchenStep} from '../supabase/functions/_shared/kitchen-actions-handler';
import {createKitchenTicketsHandler,createKitchenTicketsStore} from '../supabase/functions/_shared/kitchen-tickets-handler';
import {parseKitchenPage,parseKitchenChanges} from '../packages/core/kitchen-tickets';
import {kitchenContentHash} from '../packages/core/kitchen';
import type {SharedDevice,StaffDeviceSession} from '../packages/core/device-access';
import {orderFixture, ORDER_AT} from './order-fixture';
import {createKitchenRecoveryHandler,createKitchenRecoveryStore} from '../supabase/functions/_shared/kitchen-recovery-handler';
import {parseKitchenTapRecovery,type RetainedKitchenTap} from '../packages/core/kitchen-recovery';

type Sql = Pick<PGlite, 'query' | 'exec'>;
type Device = SharedDevice & {token: string};
type Session = StaffDeviceSession;
interface Shop {businessId: string; outletId: string; memberId: string; order: Order; device: Device; session: Session; counter: Device; counterSession: Session}
const origin = 'https://shop.test', literal = 'বাংলা\0' + String.fromCharCode(0xd800), shops: Shop[] = [];
let db: PGlite, requestNumber = 0, lastRpcError = '';

async function role<T>(sql: Sql, selected: 'anon' | 'authenticated' | 'service_role', uid: string | null, query: string, args: unknown[] = []) {
  await sql.exec('set local role ' + selected);
  await sql.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({role: selected, ...(uid ? {sub: uid} : {}), user_metadata: {role: 'owner'}})]);
  return (await sql.query<T>(query, args)).rows;
}
async function rollback(work: (sql: Sql) => Promise<void>) {
  const sentinel = new Error('rollback fixture');
  try {await db.transaction(async sql => {await work(sql); throw sentinel;});} catch (error) {if (error !== sentinel) throw error;}
}
async function current(sql: Sql, shop: Shop) {
  const row = (await sql.query<Record<string, unknown>>('select * from public.orders where id=$1', [shop.order.id])).rows[0];
  return decodeCommandRecord('orders', row) as unknown as Order;
}
async function undoLastStatus(sql:Sql,shop:Shop){
 const order=await current(sql,shop),raw=(await sql.query<Record<string,unknown>>('select * from public.events where id=$1',[order.statusEventId])).rows[0];
 const event=decodeCommandRecord('events',raw) as unknown as AuditEvent,seed=orderFixture(order.businessType).context.setup;
 const setup={business:{...seed.business,id:shop.businessId},outlet:{...seed.outlet,id:shop.outletId,businessId:shop.businessId},owner:{...seed.owner,id:order.createdBy,businessId:shop.businessId,outletIds:[shop.outletId]}};
 const result=undoOrderStatusCommand(order,event,setup,order.revision),record=encodeCommandRecord('orders',result.order,shop.businessId),audit=encodeCommandRecord('events',result.event,shop.businessId);
 const keys=Object.keys(audit.values);await sql.query(`insert into public.events(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(audit.values));
 const changes=Object.entries(record.values).filter(([key])=>key!=='id');await sql.query(`update public.orders set ${changes.map(([key],i)=>key+'=$'+(i+1)).join(',')} where id=$${changes.length+1}`,[...changes.map(([,value])=>value),order.id]);
 return result.order;
}
/** Exercise the production HTTP/RPC adapter with real PostgreSQL named
 * arguments. An incorrect RPC field cannot pass a positional fake callback. */
function rpc(sql: Sql, hooks: {afterPrepare?: () => Promise<void>; afterFinish?: () => Promise<void>;afterRead?:()=>Promise<void>} = {}): typeof fetch {
  return async (url, options) => {
    const route = new URL(String(url)).pathname.split('/').at(-1);
    if (!['prepare_kitchen_action', 'finish_kitchen_action','read_kitchen_page','read_kitchen_changes','read_kitchen_acknowledgements','recover_kitchen_tap'].includes(route ?? '')) throw Error('Unexpected RPC');
    expect(options).toMatchObject({method: 'POST', redirect: 'error', headers: {apikey: 'sb_secret_test_only'}});
    const body = JSON.parse(String(options?.body)) as Record<string, unknown>, keys = Object.keys(body), savepoint = 'request_' + ++requestNumber;
    if (keys.some(key => !/^p_[a-z_]+$/.test(key))) throw Error('Invalid RPC field');
    await sql.exec('savepoint ' + savepoint);
    let value: unknown;
    try {
      value = (await role<{data: unknown}>(sql, 'service_role', null,
        `select public.${route}(${keys.map((key, index) => key + ' => $' + (index + 1)).join(',')}) as data`,
        Object.values(body).map(v => v !== null && typeof v === 'object' ? JSON.stringify(v) : v)))[0].data;
      await sql.exec('reset role; release savepoint ' + savepoint);
    } catch (error) {
      await sql.exec('rollback to savepoint ' + savepoint + '; release savepoint ' + savepoint);
      const code = (error as {code?: string}).code;
      lastRpcError = String(code) + ': ' + String((error as Error).message).slice(0, 350) + '; ' +
        String((error as {where?: string}).where ?? '').split('\n').filter(line => /function/.test(line)).join('; ').slice(0, 500);
      return new Response('privileged SQL detail never reaches the screen', {status: code === 'PT409' ? 409 : code === 'PT429' ? 429 : code === '22023' ? 400 : 500});
    }
    if (route === 'prepare_kitchen_action') await hooks.afterPrepare?.();
    else if(route==='finish_kitchen_action')await hooks.afterFinish?.();
    else if(route==='read_kitchen_page'||route==='read_kitchen_changes')await hooks.afterRead?.();
    return new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json'}});
  };
}
function gateway(sql: Sql, hooks: Parameters<typeof rpc>[1] = {}) {
  return createKitchenActionsHandler({origins: new Set([origin]), store: createKitchenActionsStore('https://api.test', 'sb_secret_test_only', rpc(sql, hooks))});
}
function ticketGateway(sql:Sql,hooks:Parameters<typeof rpc>[1]={}){
 return createKitchenTicketsHandler({origins:new Set([origin]),store:createKitchenTicketsStore('https://api.test','sb_secret_test_only',rpc(sql,hooks))});
}
function recoveryGateway(sql:Sql){return createKitchenRecoveryHandler({origins:new Set([origin]),store:createKitchenRecoveryStore('https://api.test','sb_secret_test_only',rpc(sql))});}
function recoveryRequest(shop:Shop,original:RetainedKitchenTap,closeId:string|null=null,patch:Record<string,unknown>={}){
 return new Request('https://api.test/functions/v1/kitchen-recovery',{method:'POST',headers:{origin,authorization:'Bearer '+shop.device.token,'Content-Type':'application/json'},
  body:JSON.stringify({action:closeId?'close':'lookup',sessionToken:shop.session.token,original,...(closeId?{resolution:{id:closeId,sessionId:shop.session.id,memberId:shop.memberId,occurredAt:Date.now()}}:{}),...patch})});
}
async function nextKitchenStaff(sql:Sql,shop:Shop){
 const memberId=newKitchenId(),pin=await createStaffPin('0042',{businessId:shop.businessId,memberId},new Uint8Array(32).fill(23));
 await sql.query('insert into public.members(id,business_id,name,role,permissions,created_at,updated_at) values($1,$2,\'"Next shift"\',\'staff\',$3,1,1)',[memberId,shop.businessId,JSON.stringify({'orders.read':true,'orders.acknowledge':true,'orders.ready':true})]);
 await sql.query('insert into public.member_outlets values($1,$2,$3)',[shop.businessId,memberId,shop.outletId]);
 const uid=`00000000-0000-4000-8000-${String(shops.indexOf(shop)+1).padStart(12,'0')}`;
 await role(sql,'authenticated',uid,'select public.set_staff_pin($1,$2,$3,$4,$5,$6)',[shop.outletId,memberId,newKitchenId(),pin.salt,pin.verifier,pin.pepperVersion]);
 const attempt=(await role<{data:{attemptId:string}}>(sql,'service_role',null,'select public.begin_staff_pin($1,$2,$3) data',[newKitchenId(),shop.device.token,memberId]))[0].data;
 const session=(await role<{data:Session}>(sql,'service_role',null,'select public.finish_staff_pin($1,$2,$3,$4,$5) data',[shop.device.token,attempt.attemptId,pin.verifier,newKitchenId(),newKitchenId()]))[0].data;
 await sql.exec('reset role');return {...shop,memberId,session};
}
async function statusForScreen(sql:Sql,shop:Shop,status:Order['status']){
 const order=await current(sql,shop),seed=orderFixture(order.businessType).context.setup;
 const setup={business:{...seed.business,id:shop.businessId},outlet:{...seed.outlet,id:shop.outletId,businessId:shop.businessId},owner:{...seed.owner,id:order.createdBy,businessId:shop.businessId,outletIds:[shop.outletId]}};
 const result=changeOrderStatusCommand(order,status,setup,order.revision,Math.max(Date.now(),order.updatedAt,order.statusChangedAt));
 const record=encodeCommandRecord('orders',result.order,shop.businessId),audit=encodeCommandRecord('events',result.event,shop.businessId),keys=Object.keys(audit.values);
 await sql.query(`insert into public.events(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(audit.values));
 const changes=Object.entries(record.values).filter(([key])=>key!=='id');await sql.query(`update public.orders set ${changes.map(([key],i)=>key+'=$'+(i+1)).join(',')} where id=$${changes.length+1}`,[...changes.map(([,value])=>value),order.id]);
 return result.order;
}
const cancelForScreen=(sql:Sql,shop:Shop)=>statusForScreen(sql,shop,'cancelled');
function ticketRequest(shop:Shop,input:Record<string,unknown>={action:'page'}){
 return new Request('https://api.test/functions/v1/kitchen-tickets',{method:'POST',headers:{origin,authorization:'Bearer '+shop.device.token,'Content-Type':'application/json'},body:JSON.stringify({sessionToken:shop.session.token,...input})});
}
function request(shop: Shop, action: KitchenAction, counter = false) {
  return new Request('https://api.test/functions/v1/kitchen-actions', {method: 'POST', headers: {
    origin, authorization: 'Bearer ' + (counter ? shop.counter : shop.device).token, 'Content-Type': 'application/json'},
    body: JSON.stringify({sessionToken: (counter ? shop.counterSession : shop.session).token, action})});
}
async function gotIt(sql: Sql, shop: Shop, counter = false) {
  const action = await prepareKitchenAction(await current(sql, shop), 'kitchen.acknowledge');
  const response = await gateway(sql)(request(shop, action, counter));
  expect(response.status, lastRpcError + '; ' + await response.clone().text()).toBe(200);
  return {action, receipt: await response.json() as KitchenReceipt};
}

beforeAll(async () => {
  db = await PGlite.create();
  for (const name of ['supabase-auth.sql', 'supabase-storage.sql']) await db.exec(readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8'));
  const directory = new URL('../supabase/migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(name, directory), 'utf8'));
  for (const [index, pack] of (['restaurant','online_shop','food_stall','corner_shop'] as BusinessType[]).entries()) {
    const f = orderFixture(pack), setup = f.context.setup, tables = emptyBackupTables();
    const created = saveOrderCommand({...f.input, type: 'delivery', address: literal, table: '', sourceText: 'PRIVATE CHAT ' + literal,
      name: 'PRIVATE CUSTOMER ' + literal, lines: [{name: literal, unit: 'cup', qty: 1.125, unitPrice: 1200, note: literal}]}, f.context, null, 0, ORDER_AT);
    let order = created.order;
    tables.events.push(created.event);
    const target = pack === 'corner_shop' ? 'accepted' : pack === 'food_stall' ? 'ordered' : 'confirmed';
    while (order.status !== target) {
      const change = changeOrderStatusCommand(order, nextOrderStatuses(order)[0], setup, order.revision, ORDER_AT + 1000);
      order = change.order; tables.events.push(change.event);
    }
    tables.businesses.push(setup.business); tables.outlets.push(setup.outlet); tables.members.push(setup.owner); tables.orders.push(order);
    const uid = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    const plan = await prepareCloudMigration(createBackup(tables), uid);
    await db.query('insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,now())', [uid, '1415555010' + index]);
    await db.transaction(async sql => {
      for (const record of plan.records) {
        const keys = Object.keys(record.values);
        await sql.query(`insert into public.${record.table}(${keys.join(',')}) values(${keys.map((_, i) => '$' + (i + 1)).join(',')})`, Object.values(record.values));
      }
    });
    const memberId = newKitchenId(), memberPermissions = {'orders.read': true, 'orders.acknowledge': true, 'orders.ready': true};
    await db.query('insert into public.members(id,business_id,name,role,permissions,created_at,updated_at) values($1,$2,$3,$4,$5,1,1)',
      [memberId, setup.business.id, '"Staff"', 'staff', JSON.stringify(memberPermissions)]);
    await db.query('insert into public.member_outlets values($1,$2,$3)', [setup.business.id, memberId, setup.outlet.id]);
    const pin = await createStaffPin('0042', {businessId: setup.business.id, memberId}, new Uint8Array(32).fill(23));
    await db.transaction(sql => role(sql, 'authenticated', uid, 'select public.set_staff_pin($1,$2,$3,$4,$5,$6)',
      [setup.outlet.id, memberId, newKitchenId(), pin.salt, pin.verifier, pin.pepperVersion]));
    const devices: Device[] = [], sessions: Session[] = [];
    for (const mode of ['kitchen', 'counter']) {
      const device = (await db.transaction(sql => role<{data: Device}>(sql, 'authenticated', uid,
        'select public.enrol_device($1,$2,$3,$4,$5) as data', [newKitchenId(), newKitchenId(), setup.outlet.id, 'Test screen', mode])))[0].data;
      const attempt = (await db.transaction(sql => role<{data: {attemptId: string}}>(sql, 'service_role', null,
        'select public.begin_staff_pin($1,$2,$3) as data', [newKitchenId(), device.token, memberId])))[0].data;
      const session = (await db.transaction(sql => role<{data: Session}>(sql, 'service_role', null,
        'select public.finish_staff_pin($1,$2,$3,$4,$5) as data', [device.token, attempt.attemptId, pin.verifier, newKitchenId(), newKitchenId()])))[0].data;
      devices.push(device); sessions.push(session);
    }
    shops.push({businessId: setup.business.id, outletId: setup.outlet.id, order, memberId, device: devices[0], session: sessions[0], counter: devices[1], counterSession: sessions[1]});
  }
}, 30000);
afterAll(async () => {await db?.close();});

it.each([0,1,2,3])('pack %s keeps the cancellation until actual Understood, removes only current work and preserves the original feed and money',async index=>rollback(async sql=>{
 const shop=shops[index],cancelled=await cancelForScreen(sql,shop),handler=ticketGateway(sql);
 const page=await parseKitchenPage(await(await handler(ticketRequest(shop))).json(),shop);
 expect(page.tickets.map(ticket=>ticket.id)).toContain(cancelled.id);expect(page.tickets[0].status).toBe('cancelled');
 const seen=await gotIt(sql,shop);expect(seen.receipt).toMatchObject({status:'cancelled',sourceRevision:cancelled.revision,revision:cancelled.revision,transitionEventIds:[]});
 expect(await current(sql,shop)).toEqual(cancelled);
 expect(await(await gateway(sql)(request(shop,seen.action))).json()).toEqual(seen.receipt);
 const refreshed=await parseKitchenPage(await(await handler(ticketRequest(shop))).json(),shop);expect(refreshed.tickets).toEqual([]);
 const changes=await parseKitchenChanges(await(await handler(ticketRequest(shop,{action:'changes',afterSeq:page.watermark}))).json(),shop,page.watermark);
 expect(changes.tickets[0].status).toBe('cancelled');expect(changes.tickets[0].acknowledgement?.id).toBe(seen.receipt.id);expect(changes.removed).toEqual([]);
 await sql.exec('reset role');expect((await sql.query<{n:number}>('select count(*)::int n from private.kitchen_cancellation_work where order_id=$1',[cancelled.id])).rows[0].n).toBe(0);
}));

it('an accepted earlier Understood remains history and cannot dismiss a later undo-and-recancel notice',async()=>rollback(async sql=>{
 const shop=shops[0];const original=await cancelForScreen(sql,shop),unaccepted=await prepareKitchenAction(original,'kitchen.acknowledge'),earlier=await gotIt(sql,shop);
 await undoLastStatus(sql,shop);const later=await cancelForScreen(sql,shop);
 const page=await parseKitchenPage(await(await ticketGateway(sql)(ticketRequest(shop))).json(),shop);
 expect(page.tickets[0].revision).toBe(later.revision);expect(page.tickets[0].acknowledgement).toBeNull();
 expect(await(await gateway(sql)(request(shop,earlier.action))).json()).toEqual(earlier.receipt);expect(await current(sql,shop)).toEqual(later);
 expect((await gateway(sql)(request(shop,unaccepted))).status).toBe(409);expect(await current(sql,shop)).toEqual(later);
 const fresh=await gotIt(sql,shop);expect(fresh.receipt.id).not.toBe(earlier.receipt.id);expect(await current(sql,shop)).toEqual(later);
}));

it.each([0,1,2,3])('pack %s retains handed-off history and real receipts, blocks fresh taps, and returns through the original feed after owner undo',async index=>rollback(async sql=>{
 const shop=shops[index],original=await current(sql,shop),unaccepted=await prepareKitchenAction(original,'kitchen.acknowledge'),accepted=await gotIt(sql,shop),handler=ticketGateway(sql);
 const page=await parseKitchenPage(await(await handler(ticketRequest(shop))).json(),shop),target=(['out','booked','collected','delivering'] as const)[index];
 let handed=await current(sql,shop);while(handed.status!==target){const next=nextOrderStatuses(handed)[0];if(!next)throw Error('Real handoff is unreachable');handed=await statusForScreen(sql,shop,next);}
 expect(handed.payment).toEqual(original.payment);expect(handed.total).toBe(original.total);
 expect((await parseKitchenPage(await(await handler(ticketRequest(shop))).json(),shop)).tickets.map(ticket=>ticket.id)).not.toContain(original.id);
 const feed=await parseKitchenChanges(await(await handler(ticketRequest(shop,{action:'changes',afterSeq:page.watermark}))).json(),shop,page.watermark);
 expect(feed.tickets.some(ticket=>ticket.id===original.id&&ticket.status===target)).toBe(true);expect(feed.removed).toEqual([]);
 expect(await(await gateway(sql)(request(shop,accepted.action))).json()).toEqual(accepted.receipt);
 expect((await gateway(sql)(request(shop,unaccepted))).status).toBe(409);
 expect((await gateway(sql)(request(shop,await prepareKitchenAction(handed,'kitchen.acknowledge')))).status).toBe(409);expect(await current(sql,shop)).toEqual(handed);
 await undoLastStatus(sql,shop);const returned=await current(sql,shop);
 const reopened=await parseKitchenPage(await(await handler(ticketRequest(shop))).json(),shop);expect(reopened.tickets.some(ticket=>ticket.id===original.id&&ticket.revision===returned.revision)).toBe(true);
 expect(returned.payment).toEqual(original.payment);expect(returned.total).toBe(original.total);
}));

it.each(['anon','authenticated','service_role'] as const)('%s cannot read or modify the private cancellation projection or invoke its trigger helpers',async selected=>rollback(async sql=>{
 const shop=shops[0];await cancelForScreen(sql,shop);
 for(const query of ['select * from private.kitchen_cancellation_work','delete from private.kitchen_cancellation_work',
  'select private.note_kitchen_cancellation_order()','select private.note_kitchen_cancellation_receipt()',
  "select private.kitchen_ack_active(null,null,null,'{}')","select private.kitchen_preparation_status('confirmed')"]){
  await sql.exec('savepoint private_denial');
  await expect(role(sql,selected,null,query)).rejects.toMatchObject({code:'42501'});
  await sql.exec('rollback to savepoint private_denial; release savepoint private_denial');
 }
 expect((await sql.query<{n:number}>('select count(*)::int n from private.kitchen_cancellation_work where order_id=$1',[shop.order.id])).rows[0].n).toBe(1);
}));

it('a cancellation acknowledged between bounded pages does not hide the next active order, and a reopened order returns through the original feed',async()=>rollback(async sql=>{
 const shop=shops[0],seed=orderFixture('restaurant'),setup={business:{...seed.context.setup.business,id:shop.businessId},outlet:{...seed.context.setup.outlet,id:shop.outletId,businessId:shop.businessId},owner:{...seed.context.setup.owner,id:shop.order.createdBy,businessId:shop.businessId,outletIds:[shop.outletId]}};
 const made=saveOrderCommand(seed.input,{...seed.context,setup,sequence:2042},null,0,shop.order.createdAt+1);
 for(const record of [encodeCommandRecord('events',made.event,shop.businessId),encodeCommandRecord('orders',made.order,shop.businessId)]){const keys=Object.keys(record.values);await sql.query(`insert into public.${record.table}(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(record.values));}
 await cancelForScreen(sql,shop);const handler=ticketGateway(sql),first=await parseKitchenPage(await(await handler(ticketRequest(shop,{action:'page',limit:1}))).json(),shop,null,1);
 expect(first.tickets.map(ticket=>ticket.id)).toEqual([shop.order.id]);expect(first.next).not.toBeNull();await gotIt(sql,shop);
 const next=await parseKitchenPage(await(await handler(ticketRequest(shop,{action:'page',after:first.next,limit:1}))).json(),shop,first.next,1);expect(next.tickets.map(ticket=>ticket.id)).toEqual([made.order.id]);expect(next.next).toBeNull();
 await undoLastStatus(sql,shop);const changed=await parseKitchenChanges(await(await handler(ticketRequest(shop,{action:'changes',afterSeq:first.watermark}))).json(),shop,first.watermark);expect(changed.tickets.some(ticket=>ticket.id===shop.order.id&&ticket.status!=='cancelled')).toBe(true);
}));

it('retains the real cancellation acknowledgement across non-preparation revisions, including a previously saved source',async()=>rollback(async sql=>{
 const shop=shops[0],cancelled=await cancelForScreen(sql,shop),original=await prepareKitchenAction(cancelled,'kitchen.acknowledge');
 await sql.query('update public.orders set revision=revision+1,updated_at=updated_at+1 where id=$1',[cancelled.id]);
 const before=await current(sql,shop),response=await gateway(sql)(request(shop,original));expect(response.status,lastRpcError).toBe(200);
 const actual=await response.json() as KitchenReceipt;expect(actual.sourceRevision).toBe(cancelled.revision);expect(actual.revision).toBe(before.revision);expect(await current(sql,shop)).toEqual(before);
 await sql.query('update public.orders set revision=revision+1,updated_at=updated_at+1 where id=$1',[cancelled.id]);
 const page=await parseKitchenPage(await(await ticketGateway(sql)(ticketRequest(shop))).json(),shop);expect(page.tickets).toEqual([]);
 const hint=await sql.query<{data:unknown}>('select public.read_kitchen_acknowledgements($1,$2,$3) data',[shop.device.token,shop.session.token,JSON.stringify([{orderId:before.id,contentHash:original.contentHash,revision:before.revision+1}])]);
 expect((hint.rows[0].data as {entries:{receipt:KitchenReceipt}[]}).entries[0].receipt).toEqual(actual);
 await sql.exec('reset role');expect((await sql.query<{n:number}>('select count(*)::int n from private.kitchen_cancellation_work where order_id=$1',[cancelled.id])).rows[0].n).toBe(0);
}));

it.each([0,1,2,3])('commits Got it then Ready over real scoped HTTP/SQL for pack %s without changing money', async index => rollback(async sql => {
  const shop = shops[index], original = await current(sql, shop), {receipt} = await gotIt(sql, shop);
  const beforeReady = await current(sql, shop), tap = await prepareKitchenAction(beforeReady, 'kitchen.ready', receipt.id);
  const response = await gateway(sql)(request(shop, tap));
  expect(response.status, await response.clone().text()).toBe(200);
  const accepted = await response.json() as KitchenReceipt, saved = await current(sql, shop);
  expect(saved.status).toBe(['ready','packed','ready_called','ready'][index]);
  for (const field of ['lines','payment','sourceText','address','customer','subtotal','deliveryFee','discount','total','createdBy','handledBy','createdAt'] as const) expect(saved[field]).toEqual(original[field]);
  expect(accepted).toMatchObject({id: tap.id, memberId: shop.memberId, deviceId: shop.device.id, sessionId: shop.session.id, status: saved.status, revision: saved.revision});
  const event = (await sql.query<{after_data: Order}>('select after_data from public.events where id=$1', [saved.eventId])).rows[0];
  expect(event.after_data).toEqual(saved);
  const body = JSON.stringify(accepted);
  for (const privateText of [literal, 'PRIVATE CUSTOMER', 'PRIVATE CHAT', shop.device.token, shop.session.token]) expect(body).not.toContain(privateText);
  expect(response.headers.get('cache-control')).toBe('no-store');
}));

it('allows explicitly granted counter preparation without giving it to every counter user', async () => rollback(async sql => {
  const shop = shops[0];
  await sql.query('update public.members set permissions=$1 where id=$2', [JSON.stringify({'orders.read': true, 'counter.sell': true}), shop.memberId]);
  const tap = await prepareKitchenAction(shop.order, 'kitchen.acknowledge');
  expect((await gateway(sql)(request(shop, tap, true))).status).toBe(401);
  await sql.query('update public.members set permissions=$1 where id=$2', [JSON.stringify({'orders.read': true, 'orders.acknowledge': true, 'orders.ready': true}), shop.memberId]);
  const {receipt} = await gotIt(sql, shop, true), ready = await prepareKitchenAction(await current(sql, shop), 'kitchen.ready', receipt.id);
  expect((await gateway(sql)(request(shop, ready, true))).status).toBe(200);
}));

it.each([0,1,2,3])('delivers pack %s Ready from its original displayed pre-ACK source after that exact Got it commits',async index=>rollback(async sql=>{
 const shop=shops[index],original=await current(sql,shop),{receipt:ack}=await gotIt(sql,shop);
 expect((await current(sql,shop)).revision).toBeGreaterThanOrEqual(original.revision);
 const action=await prepareKitchenAction(original,'kitchen.ready',ack.id),response=await gateway(sql)(request(shop,action));
 expect(response.status,lastRpcError+'; '+await response.clone().text()).toBe(200);
 const result=await response.json() as KitchenReceipt,saved=await current(sql,shop);
 expect(result).toMatchObject({id:action.id,sourceRevision:original.revision,parentAckId:ack.id,status:['ready','packed','ready_called','ready'][index],contentHash:action.contentHash});
 for(const field of ['lines','payment','customer','sourceText','subtotal','deliveryFee','discount','total'] as const)expect(saved[field]).toEqual(original[field]);
}));

it.each(['unpriced','unaccepted-swap','all-unavailable'] as const)('records Got it for %s without bypassing commercial readiness', async kind => rollback(async sql => {
  const shop = shops[0], before = await current(sql, shop), lines = structuredClone(before.lines);
  if (kind === 'unpriced') {lines[0].unitPrice = null; lines[0].lineTotal = null;}
  else if (kind === 'unaccepted-swap') lines[0].substitution = {from: 'Original ' + literal, accepted: false};
  else lines[0].unavailable = true;
  const priced = orderPricing(lines, before.deliveryFee, before.discount);
  await sql.query('update public.orders set lines=$1,subtotal=$2,total=$3,revision=revision+1 where id=$4', [JSON.stringify(lines), priced.subtotal, priced.total, before.id]);
  const {receipt} = await gotIt(sql, shop), seen = await current(sql, shop);
  expect(seen.status).toBe('confirmed'); expect(receipt.transitionEventIds).toEqual([]); expect(seen.total).toBeNull();
  const ready = await prepareKitchenAction(seen, 'kitchen.ready', receipt.id);
  expect((await gateway(sql)(request(shop, ready))).status).toBe(409);
  expect(await current(sql, shop)).toEqual(seen);
}));

it('preserves scheduled ticket times in the actual status before/after images', async () => rollback(async sql => {
  const shop = shops[0], scheduledFor = Date.now() + 3600000;
  await sql.query('update public.orders set scheduled_for=$1 where id=$2', [scheduledFor, shop.order.id]);
  await gotIt(sql, shop);
  const saved = await current(sql, shop), event = (await sql.query<{before_data: Order; after_data: Order}>('select before_data,after_data from public.events where id=$1', [saved.eventId])).rows[0];
  expect(event.before_data.scheduledFor).toBe(scheduledFor); expect(event.after_data).toEqual(saved);
}));

it('returns the original committed outcome after a lost HTTP reply with no duplicate transition or audit', async () => rollback(async sql => {
  const shop = shops[0], tap = await prepareKitchenAction(shop.order, 'kitchen.acknowledge');
  const response = await gateway(sql, {afterFinish: async () => {throw Error('lost after commit');}})(request(shop, tap));
  expect(response.status).toBe(503);
  const saved = await current(sql, shop), retry = await gateway(sql)(request(shop, tap));
  expect(retry.status).toBe(200);
  expect(await current(sql, shop)).toEqual(saved);
  expect((await sql.query<{n: number}>('select count(*)::int as n from private.kitchen_action_receipts where id=$1', [tap.id])).rows[0].n).toBe(1);
  expect((await sql.query<{n: number}>('select count(*)::int as n from public.events where id=any($1)', [[tap.id, ...tap.transitionEventIds]])).rows[0].n).toBe(2);
  for (const patch of [{contentHash: '0'.repeat(64)}, {occurredAt: tap.occurredAt + 1}, {transitionEventIds: [newKitchenId(), newKitchenId(), newKitchenId()]}]) {
    expect((await gateway(sql)(request(shop, {...tap, ...patch} as KitchenAction))).status).toBe(409);
  }
}));

it.each(['device','session','member','assignment','pin','permission'] as const)('rechecks %s revocation between preparation and completion', async kind => rollback(async sql => {
  const shop = shops[0], before = await current(sql, shop), tap = await prepareKitchenAction(before, 'kitchen.acknowledge');
  const handler = gateway(sql, {afterPrepare: async () => {
    if (kind === 'device') await sql.query('update private.devices set revoked_at=created_at where id=$1', [shop.device.id]);
    else if (kind === 'session') await sql.query('update private.device_sessions set revoked_at=created_at where id=$1', [shop.session.id]);
    else if (kind === 'member') await sql.query('update public.members set active=false where id=$1', [shop.memberId]);
    else if (kind === 'assignment') await sql.query('delete from public.member_outlets where member_id=$1', [shop.memberId]);
    else if (kind === 'pin') await sql.query('delete from private.staff_pins where member_id=$1', [shop.memberId]);
    else await sql.query('update public.members set permissions=$1 where id=$2', [JSON.stringify({'orders.read': true}), shop.memberId]);
  }});
  expect((await handler(request(shop, tap))).status).toBe(401);
  expect(await current(sql, shop)).toEqual(before);
  expect((await sql.query<{n: number}>('select count(*)::int as n from private.kitchen_action_receipts')).rows[0].n).toBe(0);
}));

it('rejects a changed SQL snapshot, then safely replays the original visible intent over current private fields', async () => rollback(async sql => {
  const shop = shops[0], tap = await prepareKitchenAction(shop.order, 'kitchen.acknowledge');
  const first = await gateway(sql, {afterPrepare: async () => {
    await sql.query('update public.orders set customer_name=$1,revision=revision+1 where id=$2', [JSON.stringify('Current private name ' + literal), shop.order.id]);
  }})(request(shop, tap));
  expect(first.status).toBe(409);
  expect((await current(sql, shop)).status).toBe('confirmed');
  expect((await gateway(sql)(request(shop, tap))).status).toBe(200);
  expect((await current(sql, shop)).customer.name).toBe('Current private name ' + literal);
}));

it('rejects a stale visible ticket and never substitutes a newer line for the queued Ready', async () => rollback(async sql => {
  const shop = shops[0], {receipt} = await gotIt(sql, shop), before = await current(sql, shop);
  const tap = await prepareKitchenAction(before, 'kitchen.ready', receipt.id), changed = structuredClone(before.lines);
  changed[0].name = 'Changed food';
  await sql.query('update public.orders set lines=$1,revision=revision+1 where id=$2', [JSON.stringify(changed), shop.order.id]);
  expect((await gateway(sql)(request(shop, tap))).status).toBe(409);
  expect((await current(sql, shop)).status).toBe('kitchen_seen');
}));

it('a queued Ready cannot reverse a newer explicit owner undo',async()=>rollback(async sql=>{
 const shop=shops[3],{receipt}=await gotIt(sql,shop),seen=await current(sql,shop);
 const queued=await prepareKitchenAction(seen,'kitchen.ready',receipt.id),later=await prepareKitchenAction(seen,'kitchen.ready',receipt.id);
 expect((await gateway(sql)(request(shop,later))).status).toBe(200);
 const undone=await undoLastStatus(sql,shop);
 expect((await gateway(sql)(request(shop,queued))).status).toBe(409);
 expect(await current(sql,shop)).toEqual(undone);
 expect((await sql.query<{n:number}>('select count(*)::int n from private.kitchen_action_receipts where id=$1',[queued.id])).rows[0].n).toBe(0);
 expect((await gateway(sql)(request(shop,later))).status).toBe(200);expect(await current(sql,shop)).toEqual(undone);
 const page=await (await ticketGateway(sql)(ticketRequest(shop))).json();expect(page.tickets[0].acknowledgement.id).toBe(receipt.id);
 const fresh=await prepareKitchenAction(undone,'kitchen.ready',receipt.id);expect((await gateway(sql)(request(shop,fresh))).status).toBe(200);
}));

it.each([0,2,3])('undoing Got it keeps its historical proof but requires a new acknowledgement for pack %s',async index=>rollback(async sql=>{
 const shop=shops[index],before=await current(sql,shop),queued=await prepareKitchenAction(before,'kitchen.acknowledge'),accepted=await gotIt(sql,shop);
 const undone=await undoLastStatus(sql,shop),page=await (await ticketGateway(sql)(ticketRequest(shop))).json();
 expect(page.tickets[0].acknowledgement).toBeNull();
 expect((await gateway(sql)(request(shop,queued))).status).toBe(409);
 const invalidReady=await prepareKitchenAction(undone,'kitchen.ready',accepted.receipt.id);expect((await gateway(sql)(request(shop,invalidReady))).status).toBe(409);
 const historical=await gateway(sql)(request(shop,accepted.action));expect(historical.status).toBe(200);expect(await historical.json()).toEqual(accepted.receipt);
 expect(await current(sql,shop)).toEqual(undone);
 const fresh=await gotIt(sql,shop);expect(fresh.receipt.id).not.toBe(accepted.receipt.id);
 const currentPage=await (await ticketGateway(sql)(ticketRequest(shop))).json();expect(currentPage.tickets[0].acknowledgement.id).toBe(fresh.receipt.id);
 expect((await current(sql,shop)).payment).toEqual(before.payment);expect((await current(sql,shop)).total).toBe(before.total);
}));
it('an undo between preparation and completion blocks both the held Ready and its exact retry',async()=>rollback(async sql=>{
 const shop=shops[3],{receipt}=await gotIt(sql,shop),before=await current(sql,shop),queued=await prepareKitchenAction(before,'kitchen.ready',receipt.id);
 const handler=gateway(sql,{afterPrepare:async()=>{
  const competing=await prepareKitchenAction(before,'kitchen.ready',receipt.id);expect((await gateway(sql)(request(shop,competing))).status).toBe(200);await undoLastStatus(sql,shop);
 }});
 expect((await handler(request(shop,queued))).status).toBe(409);const undone=await current(sql,shop);
 expect((await gateway(sql)(request(shop,queued))).status).toBe(409);expect(await current(sql,shop)).toEqual(undone);
 expect((await sql.query<{n:number}>('select count(*)::int n from private.kitchen_action_receipts where id=$1',[queued.id])).rows[0].n).toBe(0);
}));

it('denies other device/session pairs, outlet selection and direct anonymous/authenticated SQL', async () => rollback(async sql => {
  const shop = shops[0], tap = await prepareKitchenAction(shop.order, 'kitchen.acknowledge');
  expect((await gateway(sql)(request(shops[1], tap))).status).toBe(401);
  const wrong = request({...shop, session: shop.counterSession}, tap);
  expect((await gateway(sql)(wrong)).status).toBe(401);
  for (const selected of ['anon', 'authenticated'] as const) {
    await sql.exec('savepoint denied');
    await expect(role(sql, selected, null, 'select public.prepare_kitchen_action($1,$2,$3,$4)', [shop.device.token, shop.session.token, newKitchenId(), JSON.stringify(tap)]))
      .rejects.toMatchObject({code: '42501'});
    await sql.exec('rollback to savepoint denied; release savepoint denied');
  }
}));

it('never rebinds a completed original action to another valid screen session', async () => rollback(async sql => {
  const shop = shops[0], {action} = await gotIt(sql, shop);
  const response = await gateway(sql)(request(shop, action, true));
  expect(response.status).toBe(409);
  expect((await sql.query<{n: number}>('select count(*)::int as n from private.kitchen_action_receipts where id=$1', [action.id])).rows[0].n).toBe(1);
}));

it('rejects incomplete, reused or caller-authorized action plans at the SQL boundary itself', async () => rollback(async sql => {
  const tap = await prepareKitchenAction(shops[0].order, 'kitchen.acknowledge');
  for (const action of [{...tap, memberId: shops[0].memberId}, {...tap, type: null}, {...tap, revision: 1.5}, {...tap, parentAckId: newKitchenId()},
    {...tap, transitionEventIds: [tap.id, ...tap.transitionEventIds.slice(1)]}, {...tap, transitionEventIds: []}]) {
    expect((await sql.query<{valid: boolean}>('select private.kitchen_action_valid($1) as valid', [JSON.stringify(action)])).rows[0].valid).toBe(false);
  }
}));

it.each(['steps','receipt','expired'] as const)('SQL rejects altered %s and rolls back any attempted status/audit writes', async kind => rollback(async sql => {
  const shop = shops[0], tap = await prepareKitchenAction(shop.order, 'kitchen.acknowledge'), ticketId = newKitchenId(), send = rpc(sql);
  const store = createKitchenActionsStore('https://api.test', 'sb_secret_test_only', send), prepared = await store.prepare(shop.device.token, shop.session.token, ticketId, tap);
  const write = await replayKitchenPreparation(prepared, tap, ticketId), before = await current(sql, shop);
  if (kind === 'expired') await sql.query('update private.kitchen_action_tickets set created_at=0,expires_at=60000 where id=$1', [ticketId]);
  await expect(store.finish(shop.device.token, shop.session.token, ticketId, write.token,
    kind === 'steps' ? [{id: tap.transitionEventIds[0], status: 'delivered'} as KitchenStep] : write.steps,
    kind === 'receipt' ? {...write.receipt, memberId: newKitchenId()} : write.receipt)).rejects.toMatchObject({status: 409});
  expect(await current(sql, shop)).toEqual(before);
  expect((await sql.query<{n: number}>('select count(*)::int as n from public.events where id=$1', [tap.id])).rows[0].n).toBe(0);
}));

it('preserves the full existing source limit, including escaped NUL, through internal context and original audits', async () => rollback(async sql => {
  const shop = shops[0], text = '\0'.repeat(ORDER_SOURCE_MAX_TEXT);
  await sql.query('update public.orders set source_text=$1 where id=$2', [JSON.stringify(text), shop.order.id]);
  const {receipt} = await gotIt(sql, shop), saved = await current(sql, shop);
  expect(saved.sourceText).toBe(text);
  expect(JSON.stringify(receipt).length).toBeLessThan(1500);
  const event = (await sql.query<{before_data: Order; after_data: Order}>('select before_data,after_data from public.events where id=$1', [saved.eventId])).rows[0];
  expect(event.before_data.sourceText).toBe(text); expect(event.after_data.sourceText).toBe(text);
}), 30000);

it.each([0,1,2,3])('reads private-field-free, hash-verified preparation tickets through actual named SQL/HTTP for pack %s',async index=>rollback(async sql=>{
 const shop=shops[index],response=await ticketGateway(sql)(ticketRequest(shop));
 expect(response.status,lastRpcError+'; '+await response.clone().text()).toBe(200);
 const body=await response.json(),page=await parseKitchenPage(body,shop);
 expect(page.tickets).toHaveLength(1);expect(page.tickets[0].contentHash).toBe(await kitchenContentHash(await current(sql,shop)));
 expect(page.tickets[0].lines[0].name).toBe(literal);expect(page.tickets[0].acknowledgement).toBeNull();
 const text=JSON.stringify(body);for(const value of ['PRIVATE CHAT','PRIVATE CUSTOMER',shop.device.token,shop.session.token])expect(text).not.toContain(value);
 for(const key of ['unitPrice','lineTotal','subtotal','total','payment','customer','customerName','customerPhone','address','sourceText'])expect(text).not.toContain('"'+key+'":');
 expect(response.headers.get('cache-control')).toBe('no-store');
}));
it('delivers actual acknowledgement parents and retains a frozen change window while newer changes arrive',async()=>rollback(async sql=>{
 const shop=shops[0],handler=ticketGateway(sql),initial=await parseKitchenPage(await (await handler(ticketRequest(shop))).json(),shop);
 const {receipt}=await gotIt(sql,shop);
 const firstBody=await (await handler(ticketRequest(shop,{action:'changes',afterSeq:initial.watermark,limit:1}))).json();
 const first=await parseKitchenChanges(firstBody,shop,initial.watermark,null,1);
 expect(first.nextSeq).toBeGreaterThan(initial.watermark);expect(first.nextSeq).toBeLessThan(first.watermark);
 expect(first.tickets[0].acknowledgement).toEqual(receipt);
 await sql.query('update public.orders set customer_name=$1,revision=revision+1 where id=$2',[JSON.stringify('Current private contact'),shop.order.id]);
 const second=await parseKitchenChanges(await (await handler(ticketRequest(shop,{action:'changes',afterSeq:first.nextSeq,untilSeq:first.watermark,limit:1}))).json(),shop,first.nextSeq,first.watermark,1);
 expect(second.nextSeq).toBe(first.watermark);
 const later=await parseKitchenChanges(await (await handler(ticketRequest(shop,{action:'changes',afterSeq:second.nextSeq}))).json(),shop,second.nextSeq);
 expect(later.watermark).toBeGreaterThan(second.watermark);expect(later.tickets[0].contentHash).toBe(first.tickets[0].contentHash);
 expect(later.tickets[0].acknowledgement?.id).toBe(receipt.id);
}));
it('a changed preparation line loses its old acknowledgement without exposing a customer or payment',async()=>rollback(async sql=>{
 const shop=shops[0];await gotIt(sql,shop);const before=await current(sql,shop),lines=structuredClone(before.lines);lines[0].note='New instruction '+literal;
 await sql.query('update public.orders set lines=$1,revision=revision+1 where id=$2',[JSON.stringify(lines),shop.order.id]);
 const page=await parseKitchenPage(await (await ticketGateway(sql)(ticketRequest(shop))).json(),shop);
 expect(page.tickets[0].acknowledgement).toBeNull();expect(page.tickets[0].lines[0].note).toBe(lines[0].note);
 expect(page.tickets[0].contentHash).not.toBe(await kitchenContentHash(before));
}));
it('does not return a partial ticket page after live access is revoked before acknowledgement lookup',async()=>rollback(async sql=>{
 const shop=shops[0],handler=ticketGateway(sql,{afterRead:async()=>{await sql.query('update public.members set active=false where id=$1',[shop.memberId]);}});
 const response=await handler(ticketRequest(shop));expect(response.status).toBe(401);expect(await response.text()).not.toContain(shop.order.id);
}));
it('another outlet cannot widen a device cursor and deletion leaves an explicit scoped tombstone',async()=>rollback(async sql=>{
 const shop=shops[0],handler=ticketGateway(sql),first=await parseKitchenPage(await (await handler(ticketRequest(shop))).json(),shop);
 await sql.query('update public.orders set revision=revision+1 where id=$1',[shops[1].order.id]);
 const quiet=await parseKitchenChanges(await (await handler(ticketRequest(shop,{action:'changes',afterSeq:first.watermark}))).json(),shop,first.watermark);
 expect(quiet.tickets).toEqual([]);expect(quiet.nextSeq).toBe(first.watermark);
 await sql.query('delete from public.orders where id=$1',[shop.order.id]);
 const removed=await parseKitchenChanges(await (await handler(ticketRequest(shop,{action:'changes',afterSeq:first.watermark}))).json(),shop,first.watermark);
 expect(removed.tickets).toEqual([]);expect(removed.removed).toEqual([shop.order.id]);
}));
it('holds a transaction fence for each changed outlet before its feed numbers can escape in commit order',async()=>rollback(async sql=>{
 // This single-backend WASM runtime reports null PIDs in pg_locks. Match the
 // actual 64-bit scoped lock tag; multi-connection blocking is checked on PG.
 const held=async(shop:Shop)=>(await sql.query<{n:number}>("select count(*)::int n from pg_locks where locktype='advisory' and granted and objsubid=1 and classid::bigint=((hashtextextended($1,0)>>32)&4294967295) and objid::bigint=(hashtextextended($1,0)&4294967295)",['mise:kitchen-feed:'+shop.businessId+':'+shop.outletId])).rows[0].n;
 expect(await held(shops[0])).toBe(0);expect(await held(shops[1])).toBe(0);
 await sql.query('update public.orders set updated_at=updated_at+1 where id=$1',[shops[0].order.id]);expect(await held(shops[0])).toBe(1);expect(await held(shops[1])).toBe(0);
 await gotIt(sql,shops[0]);expect(await held(shops[0])).toBe(1);
 await sql.query('update public.orders set updated_at=updated_at+1 where id=$1',[shops[1].order.id]);expect(await held(shops[1])).toBe(1);
}));

it('recovers a real lost original receipt with a different valid PIN session and preserves the original actor',async()=>rollback(async sql=>{
 const shop=shops[0],done=await gotIt(sql,shop),next=await nextKitchenStaff(sql,shop);
 await sql.query('update private.device_sessions set revoked_at=created_at where id=$1',[shop.session.id]);
 const original={action:done.action,sessionId:shop.session.id,memberId:shop.memberId};
 const response=await recoveryGateway(sql)(recoveryRequest(next,original));expect(response.status,lastRpcError).toBe(200);
 const recovered=parseKitchenTapRecovery(await response.json(),original,{device:next.device,session:next.session});
 expect(recovered.outcome).toBe('accepted');expect(recovered.receipt).toEqual(done.receipt);expect(recovered.receipt!.memberId).toBe(shop.memberId);
 expect(recovered.access.memberId).toBe(next.memberId);expect(recovered.closure).toBeNull();
}));
it('lookup alone preserves a missing original action without retiring or acknowledging it',async()=>rollback(async sql=>{
 const shop=shops[0],action=await prepareKitchenAction(await current(sql,shop),'kitchen.acknowledge'),next=await nextKitchenStaff(sql,shop),before=await current(sql,shop);
 const original={action,sessionId:shop.session.id,memberId:shop.memberId},response=await recoveryGateway(sql)(recoveryRequest(next,original));
 expect(response.status,lastRpcError).toBe(200);expect(parseKitchenTapRecovery(await response.json(),original).outcome).toBe('pending');
 expect((await sql.query<{n:number}>('select count(*)::int n from private.kitchen_tap_closures')).rows[0].n).toBe(0);expect(await current(sql,shop)).toEqual(before);
}));
it('an explicit close removes every prepared plan and prevents both late finalization and a fresh original retry',async()=>rollback(async sql=>{
 const shop=shops[0],action=await prepareKitchenAction(await current(sql,shop),'kitchen.acknowledge'),before=await current(sql,shop);
 const ticketId=newKitchenId(),prepared=(await role<{data:unknown}>(sql,'service_role',null,'select public.prepare_kitchen_action($1,$2,$3,$4) data',[shop.device.token,shop.session.token,ticketId,JSON.stringify(action)]))[0].data;
 const write=await replayKitchenPreparation(prepared,action,ticketId);await sql.exec('reset role');
 const next=await nextKitchenStaff(sql,shop),original={action,sessionId:shop.session.id,memberId:shop.memberId},id=newKitchenId();
 const response=await recoveryGateway(sql)(recoveryRequest(next,original,id));expect(response.status,lastRpcError).toBe(200);
 const closed=parseKitchenTapRecovery(await response.json(),original);expect(closed.outcome).toBe('closed');expect(closed.closure).toMatchObject({id,originalMemberId:shop.memberId,memberId:next.memberId,action});
 expect((await sql.query<{n:number}>('select count(*)::int n from private.kitchen_action_tickets where action->>\'id\'=$1',[action.id])).rows[0].n).toBe(0);
 const late=await rpc(sql)('https://api.test/rest/v1/rpc/finish_kitchen_action',{method:'POST',redirect:'error',headers:{apikey:'sb_secret_test_only'},body:JSON.stringify({p_device_token:shop.device.token,p_session_token:shop.session.token,p_ticket_id:ticketId,p_token:write.token,p_steps:write.steps,p_receipt:write.receipt})});
 expect(late.status).toBe(409);expect((await gateway(sql)(request(shop,action))).status).toBe(409);
 expect(await current(sql,shop)).toEqual(before);expect((await sql.query<{n:number}>('select count(*)::int n from private.kitchen_action_receipts')).rows[0].n).toBe(0);
 expect((await sql.query<{n:number}>("select count(*)::int n from public.events where command='kitchen.tap-close'")).rows[0].n).toBe(1);
}));
it('closing after a real acceptance returns that receipt and creates no closure or extra order event',async()=>rollback(async sql=>{
 const shop=shops[0],done=await gotIt(sql,shop),next=await nextKitchenStaff(sql,shop),before=await current(sql,shop),original={action:done.action,sessionId:shop.session.id,memberId:shop.memberId};
 const response=await recoveryGateway(sql)(recoveryRequest(next,original,newKitchenId()));expect(response.status,lastRpcError).toBe(200);
 expect(parseKitchenTapRecovery(await response.json(),original).receipt).toEqual(done.receipt);expect(await current(sql,shop)).toEqual(before);
 expect((await sql.query<{n:number}>('select count(*)::int n from private.kitchen_tap_closures')).rows[0].n).toBe(0);
}));
it('a lost close reply returns the original closure and reviewer without duplicate audits',async()=>rollback(async sql=>{
 const shop=shops[0],action=await prepareKitchenAction(await current(sql,shop),'kitchen.acknowledge'),next=await nextKitchenStaff(sql,shop),original={action,sessionId:shop.session.id,memberId:shop.memberId};
 const body=await (await recoveryGateway(sql)(recoveryRequest(next,original,newKitchenId()))).json();
 const recovered=await (await recoveryGateway(sql)(recoveryRequest(shop,original))).json();expect(recovered.closure).toEqual(body.closure);
 expect((await sql.query<{n:number}>("select count(*)::int n from public.events where command='kitchen.tap-close'")).rows[0].n).toBe(1);
}));
it('a different physical device or a changed original cannot recover or close another screen’s tap',async()=>rollback(async sql=>{
 const shop=shops[0],done=await gotIt(sql,shop),original={action:done.action,sessionId:shop.session.id,memberId:shop.memberId};
 const other={...shop,device:shop.counter,session:shop.counterSession};
 expect((await recoveryGateway(sql)(recoveryRequest(other,original))).status).toBe(409);
 expect((await recoveryGateway(sql)(recoveryRequest(shop,{...original,action:{...done.action,occurredAt:done.action.occurredAt+1}}))).status).toBe(409);
}));
it('a prepared plan on another device cannot be poisoned by a claimed offline intent on this one',async()=>rollback(async sql=>{
 const shop=shops[0],action=await prepareKitchenAction(await current(sql,shop),'kitchen.acknowledge'),id=newKitchenId();
 await role(sql,'service_role',null,'select public.prepare_kitchen_action($1,$2,$3,$4)',[shop.counter.token,shop.counterSession.token,id,JSON.stringify(action)]);await sql.exec('reset role');
 const response=await recoveryGateway(sql)(recoveryRequest(shop,{action,sessionId:shop.session.id,memberId:shop.memberId},newKitchenId()));
 expect(response.status).toBe(409);expect((await sql.query<{n:number}>('select count(*)::int n from private.kitchen_action_tickets where id=$1',[id])).rows[0].n).toBe(1);
 expect((await sql.query<{n:number}>('select count(*)::int n from private.kitchen_tap_closures')).rows[0].n).toBe(0);
}));
it('read permission can look up an original but closing requires current action permission and the original review actor',async()=>rollback(async sql=>{
 const shop=shops[0],action=await prepareKitchenAction(await current(sql,shop),'kitchen.acknowledge'),next=await nextKitchenStaff(sql,shop),original={action,sessionId:shop.session.id,memberId:shop.memberId};
 const id=newKitchenId(),wrong={id,sessionId:shop.session.id,memberId:shop.memberId,occurredAt:Date.now()};
 expect((await recoveryGateway(sql)(recoveryRequest(next,original,id,{resolution:wrong}))).status).toBe(409);
 await sql.query("update public.members set permissions=permissions||'{\"orders.acknowledge\":false}' where id=$1",[next.memberId]);
 expect((await recoveryGateway(sql)(recoveryRequest(next,original))).status).toBe(200);
 expect((await recoveryGateway(sql)(recoveryRequest(next,original,id))).status).toBe(401);
}));
