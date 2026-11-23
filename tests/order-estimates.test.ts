import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {createPublicOrderDatabase} from './public-order-fixture';
import {deviceId} from './device-pairing-fixture';
import {newInboxId} from '../packages/core/inbox';
import {parseEstimateAction,parseEstimateContext,parseEstimateOutcome,parseOrderEstimate,estimateDelay,type EstimateAction,type EstimateChange} from '../packages/core/order-estimates';
import {projectCustomerLink,parseCustomerLinkRequest} from '../packages/core/customer-links';
let f:Awaited<ReturnType<typeof createPublicOrderDatabase>>,orderId:string;
beforeAll(async()=>{f=await createPublicOrderDatabase();},30000);
beforeEach(async()=>{await f.seed();await f.publish();const request=await f.intent();await f.finish(request,await f.prepare(request));orderId=request.source.orderId;});
afterAll(async()=>{await f?.db.close();});
const scope=()=>({businessId:deviceId(1),outletId:deviceId(11),actorId:deviceId(101),actorRole:'owner' as const,orderId});
async function context(){return parseEstimateContext(await f.asRole(1,'authenticated','select public.read_order_estimate($1) data',[orderId]),scope());}
async function action(change:EstimateChange){const c=await context();return parseEstimateAction({v:1,id:newInboxId(),orderId,orderRevision:c.orderRevision,revision:c.estimate?.revision??0,change});}
const set=(offset=0):EstimateChange=>({kind:'set',start:Date.now()+60000+offset,end:Date.now()+300000+offset,note:'The shop is preparing your order.',undoOf:null});
async function call(a:EstimateAction,operation='submit',actor=1){return parseEstimateOutcome(await f.asRole(actor,'authenticated','select public.change_order_estimate($1,$2,$3,$4,$5,$6) data',[a.orderId,a.id,a.orderRevision,a.revision,JSON.stringify(a.change),operation]),a);}
it('records a real owner estimate and exposes only that order’s approved public timing fields',async()=>{
 const before=(await f.db.query('select row_to_json(o) data from public.orders o where id=$1',[orderId])).rows[0];expect((await context()).estimate).toBeNull();
 const a=await action(set()),result=await call(a);expect(result.state).toBe('applied');expect((await context()).estimate).toEqual(result.estimate);expect(result.estimate?.firstEnd).toBe(a.change.end);
 const r=await f.asRole<Record<string,unknown>>(null,'service_role',"select public.read_public_capability($1,'order',0,50,3000,60) data",['T'.repeat(43)]);
 const projected=projectCustomerLink(r.data,parseCustomerLinkRequest({kind:'order',token:'T'.repeat(43)}));expect(projected.kind).toBe('order');if(projected.kind!=='order')throw Error();expect(projected.order.estimate).toEqual(result.estimate);expect(JSON.stringify(projected)).not.toContain(a.id);expect(JSON.stringify(projected)).not.toContain(deviceId(101));
 expect((await f.db.query('select row_to_json(o) data from public.orders o where id=$1',[orderId])).rows[0]).toEqual(before);
 expect((await f.db.query<{sales:number;entries:number}>('select (select count(*) from public.sales) sales,(select count(*) from public.credit_entries) entries')).rows[0]).toEqual({sales:0,entries:0});
});
it('replays the exact original receipt and rejects mutated or reused action identities',async()=>{
 const a=await action(set()),result=await call(a);expect(await call(a)).toEqual(result);expect(await call(a,'inspect')).toEqual(result);expect(await call(a,'close')).toEqual(result);
 await expect(call({...a,change:{...a.change,note:'Different'}})).rejects.toMatchObject({code:'23505'});
 expect((await f.db.query<{n:number}>('select count(*) n from private.order_estimate_actions')).rows[0].n).toBe(1);
});
it('retains the first promise when the range moves later, is withdrawn and is restored',async()=>{
 const first=await call(await action(set())),later=await action(set(600000));await call(later);expect((await context()).estimate?.firstEnd).toBe(first.estimate?.end);
 const clear=await action({kind:'clear',start:null,end:null,note:'Please contact the shop.',undoOf:null});await call(clear);expect((await context()).estimate).toMatchObject({start:null,end:null,firstEnd:first.estimate?.end});
 const undo=await action({kind:'undo',start:null,end:null,note:'',undoOf:clear.id}),restored=await call(undo);expect(restored.estimate).toMatchObject({start:later.change.start,end:later.change.end,firstEnd:first.estimate?.end});
});
it('journals a closure before a delayed submission and never mistakes an applied action for cancellation',async()=>{
 const a=await action(set());expect((await call(a,'inspect')).state).toBe('pending');const closed=await call(a,'close');expect(closed.state).toBe('closed');expect(await call(a)).toEqual(closed);expect((await context()).estimate).toBeNull();
 const applied=await action(set());const receipt=await call(applied);expect(await call(applied,'close')).toEqual(receipt);
});
it('requires current order and estimate revisions and refuses finished orders',async()=>{
 const a=await action(set()),competing=await action(set(600000));await call(a);await expect(call(competing)).rejects.toMatchObject({code:'PT409'});expect((await call(competing,'close')).state).toBe('closed');
 const next=await action(set());await f.db.query('update public.orders set revision=revision+1 where id=$1',[orderId]);await expect(call(next)).rejects.toMatchObject({code:'PT409'});
 const done=await action(set());await f.db.query("update public.orders set status='done' where id=$1",[orderId]);await expect(call(done)).rejects.toMatchObject({code:'PT409'});expect((await call(done,'close')).state).toBe('closed');
});
it('only the latest recorded estimate can be undone, and original receipts survive later updates',async()=>{
 const a=await action(set()),first=await call(a),b=await action(set(600000));await call(b);
 await expect(call(await action({kind:'undo',start:null,end:null,note:'',undoOf:a.id}))).rejects.toMatchObject({code:'PT409'});expect(await call(a,'inspect')).toEqual(first);
 await call(await action({kind:'undo',start:null,end:null,note:'',undoOf:b.id}));expect((await context()).estimate?.end).toBe(a.change.end);
});
it('requires the actual phone owner or assigned manager and keeps raw rows private',async()=>{
 const a=await action(set());for(const actor of [3,4,5]){await expect(f.asRole(actor,'authenticated','select public.read_order_estimate($1) data',[orderId])).rejects.toMatchObject({code:'42501'});await expect(call(a,'submit',actor)).rejects.toMatchObject({code:'42501'});}
 const manager=await f.asRole<Record<string,unknown>>(2,'authenticated','select public.read_order_estimate($1) data',[orderId]);expect(manager.actorId).toBe(deviceId(102));await call(a,'submit',2);await expect(call(a,'inspect',1)).rejects.toMatchObject({code:'42501'});
 for(const role of ['anon','authenticated','service_role'] as const)for(const table of ['order_estimates','order_estimate_actions'])await expect(f.asRole(role==='authenticated'?1:null,role,`select count(*) data from private.${table}`)).rejects.toMatchObject({code:'42501'});
 for(const role of ['anon','service_role'] as const)await expect(f.asRole(null,role,'select public.read_order_estimate($1) data',[orderId])).rejects.toMatchObject({code:'42501'});
});
it('rejects malformed and expired windows while permitting exact checks and closure of an expired original',async()=>{
 const a=await action(set());a.change.start=Date.now()-120000;a.change.end=Date.now()-60000;await expect(call(a)).rejects.toMatchObject({code:'PT409'});expect((await call(a,'inspect')).state).toBe('pending');expect((await call(a,'close')).state).toBe('closed');
 expect(()=>parseEstimateAction({...a,change:{...a.change,privateNote:'secret'}})).toThrow();expect(()=>parseEstimateAction({...a,change:{...a.change,start:1,end:86400002}})).toThrow();
});
it('derives an honest delay at the checked instant and suppresses it for finished or unknown estimates',()=>{
 const estimate=parseOrderEstimate({revision:2,start:600000,end:900000,firstEnd:300000,note:'Updated estimate',updatedAt:250000});
 expect(estimateDelay(estimate,'out',660000)).toBe(6);expect(estimateDelay(estimate,'out',300001)).toBe(1);expect(estimateDelay(estimate,'out',300000)).toBeNull();expect(estimateDelay(estimate,'done',660000)).toBeNull();expect(estimateDelay(null,'out',660000)).toBeNull();expect(estimateDelay(estimate,'out',NaN)).toBeNull();
 expect(()=>parseOrderEstimate({...estimate,start:null})).toThrow();expect(()=>parseOrderEstimate({...estimate,actorId:'private'})).toThrow();
 const earlier={...estimate,start:60000,end:120000,firstEnd:300000};expect(estimateDelay(earlier,'out',180000)).toBe(1);expect(estimateDelay(earlier,'out',120000)).toBeNull();
});
