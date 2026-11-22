import { publicOrderRecords } from '../packages/core/public-order-projection';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createPublicOrderDatabase } from './public-order-fixture';
import { deviceId } from './device-pairing-fixture';
import { newInboxId } from '../packages/core/inbox';
import { publicOrderAttemptIdFromHash, publicOrderHash } from '../packages/core/public-order-submission';
let f:Awaited<ReturnType<typeof createPublicOrderDatabase>>;
beforeAll(async()=>{f=await createPublicOrderDatabase();},30000);
beforeEach(async()=>{await f.seed();});
afterAll(async()=>{await f?.db.close();});
it('publishes the actual reviewed M20 snapshot, and prepares an ordinary Core order without writing it',async()=>{
  const grant=await f.publish(),request=await f.intent(),prepared=await f.prepare(request),records=publicOrderRecords(prepared,request.source);
  expect(grant.result).toMatchObject({id:grant.id,createEventId:grant.eventId,revokedAt:null});
  expect(prepared).toMatchObject({state:'prepared',businessId:deviceId(1),outletId:deviceId(11),actorId:deviceId(101),attemptId:request.source.id});
  expect(records.map(r=>r.table)).toEqual(['orders','events']);
  expect((await f.db.query<{n:number}>('select count(*) n from public.orders')).rows[0].n).toBe(0);
});
it.each([2,3,4,5])('operator %s follows actual outlet/phone authority',async n=>{
  if(n===2){expect((await f.publish(n)).result.createdAt).not.toBeNull();return;}
  await expect(f.publish(n)).rejects.toMatchObject({code:'42501'});
});
it('retries the exact original publication and preserves actual revocation without a second audit',async()=>{
  const grant=await f.publish();expect(await f.asRole(1,'authenticated','select public.publish_public_shop($1,$2,$3,$4,$5,$6,$7,$8) data',grant.args)).toEqual(grant.result);
  const revoked=await f.asRole(1,'authenticated','select public.revoke_public_shop($1,$2,$3) data',[grant.id,newInboxId(),deviceId(11)]);
  expect(await f.asRole(1,'authenticated','select public.revoke_public_shop($1,$2,$3) data',[grant.id,newInboxId(),deviceId(11)])).toEqual(revoked);
  expect((await f.db.query<{n:number}>("select count(*) n from public.events where command like 'public_shop.%'")).rows[0].n).toBe(2);
});
it('closing an unknown publication fences its delayed original creation',async()=>{
  const id=newInboxId();await f.asRole(1,'authenticated','select public.revoke_public_shop($1,$2,$3) data',[id,newInboxId(),deviceId(11)]);
  await expect(f.publish(1,id)).rejects.toMatchObject({code:'55000'});
});
it('the SQL attempt reference exactly matches the customer-secret derivation at both extremes',async()=>{
  for(const hash of ['0'.repeat(64),'f'.repeat(64),await publicOrderHash('X'.repeat(43))])
    expect((await f.db.query<{id:string}>('select private.public_order_attempt_id(decode($1,\'hex\')) id',[hash])).rows[0].id).toBe(publicOrderAttemptIdFromHash(hash));
});
it('closure before submission survives a delayed original and cannot become a different request',async()=>{
  await f.publish();const request=await f.intent();expect(await f.prepare(request,'close')).toMatchObject({state:'closed',attemptId:request.source.id});
  expect(await f.prepare(request)).toMatchObject({state:'closed'});request.source.name='Another name';
  expect(await f.prepare(request)).toMatchObject({state:'changed'});
  expect((await f.db.query<{n:number}>('select count(*) n from public.orders')).rows[0].n).toBe(0);
});
it('a known request reference alone cannot be used with another secret to plant a closure',async()=>{
  await f.publish();const request=await f.intent();request.trackingToken='Z'.repeat(43);
  expect(await f.prepare(request,'close')).toMatchObject({state:'changed'});
  expect((await f.db.query<{n:number}>('select count(*) n from private.public_order_attempts')).rows[0].n).toBe(0);
});
it('a customer cannot change displayed prices while retaining the approved public shop capability',async()=>{
  await f.publish();const request=await f.intent();request.source.shop.items[0].price=1;
  expect(await f.prepare(request)).toMatchObject({state:'changed'});
});
it('new attempts are bounded per shop while the actual original retry and inspection remain available',async()=>{
  await f.publish();const a=await f.intent(),b=await f.intent('B'.repeat(43));
  expect(await f.prepare(a,'submit',1000,1)).toMatchObject({state:'prepared'});
  expect(await f.prepare(b,'submit',1000,1)).toMatchObject({state:'limited'});
  expect(await f.prepare(a,'inspect',1000,1)).toMatchObject({state:'pending'});
  expect(await f.prepare(a,'submit',1000,1)).toMatchObject({state:'prepared'});
});
it.each(['anon','authenticated'] as const)('%s cannot bypass the public HTTP service and its fixed admission budgets',async role=>{
  await expect(f.asRole(null,role,'select public.prepare_public_order($1,$2,$3,$4,1000,30) data',['S'.repeat(43),'0'.repeat(64),'{}','submit'])).rejects.toMatchObject({code:'42501'});
  for(const table of ['public_shops','public_order_attempts','public_order_budget'])
    await expect(f.asRole(1,role,`select count(*) data from private.${table}`)).rejects.toMatchObject({code:'42501'});
});
it('atomically creates one native order, both original audits and its purpose-bound tracker, with no sale or khata entry',async()=>{
  await f.publish();const request=await f.intent(),prepared=await f.prepare(request),result=await f.finish(request,prepared);
  expect(result).toMatchObject({state:'created',attemptId:request.source.id,receipt:{orderId:request.source.orderId,total:20000,number:'A-0001'},link:{id:request.source.linkId,revokedAt:null}});
  expect(await f.finish(request,prepared)).toEqual(result);
  expect(await f.prepare(request)).toEqual(result);expect(await f.prepare(request,'close')).toEqual(result);
  const counts=(await f.db.query<{orders:number;events:number;sales:number;entries:number;links:number}>(`select
   (select count(*)::int from public.orders) orders,(select count(*)::int from public.events where actor_type='system') events,
   (select count(*)::int from public.sales) sales,(select count(*)::int from public.credit_entries) entries,(select count(*)::int from private.public_links) links`)).rows[0];
  expect(counts).toEqual({orders:1,events:2,sales:0,entries:0,links:1});
  const read=await f.asRole<Record<string,unknown>>(null,'service_role','select public.read_public_capability($1,\'order\',0,50,3000,60) data',[request.trackingToken]);
  expect(read).toMatchObject({state:'ok',data:{order:{id:request.source.orderId}}});
});
it('closing a prepared request fences an already in-flight finalizer without inventing an order',async()=>{
  await f.publish();const request=await f.intent(),prepared=await f.prepare(request);await f.prepare(request,'close');
  expect(await f.finish(request,prepared)).toMatchObject({state:'conflict'});
  expect((await f.db.query<{n:number}>('select count(*) n from public.orders')).rows[0].n).toBe(0);
});
it('another accepted order advances the sequence without changing the original customer source or retry identity',async()=>{
  await f.publish();const request=await f.intent(),prepared=await f.prepare(request);
  const another=await f.intent('B'.repeat(43));expect(await f.finish(another,await f.prepare(another))).toMatchObject({state:'created',receipt:{number:'A-0001'}});
  expect(await f.finish(request,prepared)).toMatchObject({state:'conflict'});
  expect(await f.finish(request,await f.prepare(request))).toMatchObject({state:'created',attemptId:request.source.id,receipt:{number:'A-0002'}});
});
it('a complete long Unicode list and literal whitespace remain unpriced and intact through actual SQL creation',async()=>{
  await f.publish();const request=await f.intent();request.source.selections=[];request.source.text='\u00a0'+'🙂'.repeat(1998)+'x';request.source.lineIds=Array.from({length:8},()=>newInboxId());
  expect(await f.finish(request,await f.prepare(request))).toMatchObject({state:'created',receipt:{total:null}});
  const row=(await f.db.query<{source:string;total:number|null}>('select source_text#>>\'{}\' source,total from public.orders where id=$1',[request.source.orderId])).rows[0];
  expect(row.source).toContain(request.source.text);expect(row.total).toBeNull();
});
it.each(['payment','actor','tenant','price','event'])('forged %s fields cannot partially create an order or tracker',async kind=>{
  await f.publish();const request=await f.intent(),prepared=await f.prepare(request),records=publicOrderRecords(prepared,request.source);
  if(kind==='payment')records[0].values.payment=JSON.stringify({method:'cash',status:'paid'});
  if(kind==='actor')records[1].values.actor_type='member';
  if(kind==='tenant')records[0].values.business_id=deviceId(2);
  if(kind==='price'){records[0].values.total=1;records[0].values.subtotal=1;}
  if(kind==='event')records[1].values.after_data='{}';
  await expect(f.finish(request,prepared,records)).rejects.toMatchObject({code:'22023'});
  expect((await f.db.query<{n:number}>('select count(*) n from public.orders')).rows[0].n).toBe(0);
  expect((await f.db.query<{n:number}>('select count(*) n from private.public_links')).rows[0].n).toBe(0);
});
it('a failed tracker audit rolls back order, creation audit, capability and completion receipt together',async()=>{
  await f.publish();const request=await f.intent();request.source.linkEventId=(await f.db.query<{id:string}>("select id from public.events where command='public_shop.publish'")).rows[0].id;
  const prepared=await f.prepare(request);
  await expect(f.finish(request,prepared)).rejects.toMatchObject({code:'23505'});
  expect((await f.db.query<{n:number}>('select count(*) n from public.orders')).rows[0].n).toBe(0);
  expect((await f.db.query<{n:number}>('select count(*) n from private.public_links')).rows[0].n).toBe(0);
  expect(await f.prepare(request,'inspect')).toMatchObject({state:'pending',receipt:null});
});
it('revoking the publication blocks unfinished submissions but retains a real earlier order and its exact outcome',async()=>{
  const grant=await f.publish(),first=await f.intent(),second=await f.intent('B'.repeat(43));
  const actual=await f.finish(first,await f.prepare(first)),prepared=await f.prepare(second);
  await f.asRole(1,'authenticated','select public.revoke_public_shop($1,$2,$3) data',[grant.id,newInboxId(),deviceId(11)]);
  expect(await f.finish(second,prepared)).toMatchObject({state:'unavailable'});
  expect(await f.prepare(first)).toEqual(actual);
  expect((await f.db.query<{n:number}>('select count(*) n from public.orders')).rows[0].n).toBe(1);
});
it.each(['inactive','unassigned'] as const)('an %s publishing manager cannot admit a prepared order',async change=>{
  await f.publish(2);const request=await f.intent(),prepared=await f.prepare(request);
  if(change==='inactive')await f.db.query('update public.members set active=false where id=$1',[deviceId(102)]);
  else await f.db.query('delete from public.member_outlets where member_id=$1 and outlet_id=$2',[deviceId(102),deviceId(11)]);
  expect(await f.finish(request,prepared)).toMatchObject({state:'unavailable'});
  expect((await f.db.query<{n:number}>('select count(*) n from public.orders')).rows[0].n).toBe(0);
});
it('owner revocation of the issued tracker is reflected on replay and never mints a replacement',async()=>{
  await f.publish();const request=await f.intent(),created=await f.finish(request,await f.prepare(request));
  await f.asRole(1,'authenticated','select public.revoke_public_link($1,$2) data',[request.source.linkId,newInboxId()]);
  const replay=await f.prepare(request);expect(replay.receipt).toEqual(created.receipt);expect((replay.link as Record<string,unknown>).revokedAt).not.toBeNull();
  expect(await f.asRole(null,'service_role','select public.read_public_capability($1,\'order\',0,50,3000,60) data',[request.trackingToken])).toMatchObject({state:'missing'});
  expect((await f.db.query<{n:number}>('select count(*) n from private.public_links')).rows[0].n).toBe(1);
});
it('every new private table forces RLS and endpoint grants distinguish owners from the server',async()=>{
  const tables=(await f.db.query<{name:string;forced:boolean}>("select c.relname name,c.relrowsecurity and c.relforcerowsecurity forced from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname in('public_shops','public_order_attempts','public_order_budget')")).rows;
  expect(tables).toHaveLength(3);expect(tables.every(t=>t.forced)).toBe(true);
  const grants=(await f.db.query<{name:string;schema:string;role:string}>(`select p.proname name,n.nspname schema,r.role from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    cross join unnest(array['anon','authenticated','service_role']) r(role) where n.nspname in('public','private') and p.proname in('publish_public_shop','revoke_public_shop','prepare_public_order','finish_public_order') and has_function_privilege(r.role,p.oid,'EXECUTE')`)).rows;
  expect(grants).toHaveLength(8);expect(grants.every(g=>g.role===(['publish_public_shop','revoke_public_shop'].includes(g.name)?'authenticated':'service_role'))).toBe(true);
  for(const role of ['anon','authenticated'] as const)await expect(f.asRole(null,role,'select public.finish_public_order($1,$2,$3) data',[newInboxId(),'T'.repeat(43),'[]'])).rejects.toMatchObject({code:'42501'});
});
it('changed public shop settings stop new orders, while explicit closure still fences a later undo and delayed submit',async()=>{
  await f.publish();const request=await f.intent();
  await f.db.query('update public.outlets set shop_link=$1 where id=$2',[f.sourceUrl+'changed',deviceId(11)]);
  expect(await f.prepare(request)).toMatchObject({state:'changed'});
  expect(await f.prepare(request,'close')).toMatchObject({state:'closed'});
  await f.db.query('update public.outlets set shop_link=$1 where id=$2',[f.sourceUrl,deviceId(11)]);
  expect(await f.prepare(request)).toMatchObject({state:'closed'});
  expect((await f.db.query<{n:number}>('select count(*) n from public.orders')).rows[0].n).toBe(0);
});
it('delivery remains unpriced until the shop explicitly confirms its fee, including a genuinely free delivery',async()=>{
  await f.publish();const request=await f.intent();request.source.fulfilment='delivery';request.source.address='Road 12';request.source.lineIds.push(newInboxId());
  expect(await f.finish(request,await f.prepare(request))).toMatchObject({state:'created',receipt:{total:null}});
  const order=(await f.db.query<{total:number|null;lines:Record<string,unknown>[]}>('select total,lines from public.orders where id=$1',[request.source.orderId])).rows[0];
  expect(order.total).toBeNull();expect(order.lines.at(-1)).toMatchObject({name:'Delivery fee to confirm',unitPrice:null,lineTotal:null});
});
