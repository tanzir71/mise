import {beforeAll,beforeEach,afterAll,it,expect,vi} from 'vitest';
import {createPublicOrderDatabase} from './public-order-fixture';
import {createPublicOrderHandler} from '../supabase/functions/_shared/public-order-handler';
import {publicOrderHash,publicOrderIntentJson,type PublicOrderSubmission} from '../packages/core/public-order-submission';
import {publicOrderingUrl,decodePublicOrdering,type PublicOrderingLink} from '../packages/core/public-order-link';
import {createPublicOrderSession,type CustomerOrderFields} from '../apps/web/src/public-shop/order-session';
import {createPublicOrderRemote} from '../apps/web/src/public-shop/order-remote';
let f:Awaited<ReturnType<typeof createPublicOrderDatabase>>,link:PublicOrderingLink,values:Map<string,string>,requests:PublicOrderSubmission[],offline=false,lose=false,writeFails=false,held=false;
const locks={request:async(_name:string,_options:unknown,run:(lock:Lock|null)=>Promise<unknown>)=>{if(held)return run(null);held=true;try{return await run({name:'test',mode:'exclusive'});}finally{held=false;}}} as Pick<LockManager,'request'>;
const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{if(writeFails)throw Error('quota');values.set(key,value);}};
const fields=():CustomerOrderFields=>({name:'Sadia',phone:'+14155550150',fulfilment:'pickup',address:'',when:'Now',scheduledFor:null,selections:[{itemId:f.item.id,qty:2}],text:'',paymentPreference:'Cash',language:'en'});
const send:typeof fetch=async(input,init)=>{
 expect(new Headers(init?.headers).has('Authorization')).toBe(false);expect(new Headers(init?.headers).has('apikey')).toBe(false);expect(init?.credentials).toBe('omit');expect(init?.redirect).toBe('error');expect(init?.referrerPolicy).toBe('no-referrer');
 const request=JSON.parse(String(init?.body)) as PublicOrderSubmission;requests.push(request);if(offline)throw Error('Offline');
 const handler=createPublicOrderHandler({origins:new Set(['https://shop.example.invalid']),store:{
  prepare:async(q,l)=>f.asRole(null,'service_role','select public.prepare_public_order($1,$2,$3,$4,$5,$6) data',[q.shopToken,await publicOrderHash(q.trackingToken),publicOrderIntentJson(q.intent),q.action,l.global,l.shop]),
  finish:(q,p,records)=>f.asRole(null,'service_role','select public.finish_public_order($1,$2,$3) data',[q.intent.id,p.ticketToken,JSON.stringify(records)])}});
 const response=await handler(new Request(input,{...init,headers:{...Object.fromEntries(new Headers(init?.headers)),Origin:'https://shop.example.invalid'}}));
 if(lose&&response.status===201){lose=false;throw Error('Lost committed response');}return response;
};
async function session(){return createPublicOrderSession(link,{storage,locks,send});}
beforeAll(async()=>{f=await createPublicOrderDatabase();},30000);
beforeEach(async()=>{await f.seed();await f.publish();values=new Map();requests=[];offline=false;lose=false;writeFails=false;held=false;link={v:1,sourceUrl:f.sourceUrl,apiUrl:'https://backend.example.invalid',shopToken:f.shopSecret,table:null};});
afterAll(async()=>{await f?.db.close();});
it('opens a capability envelope and preserves the original M20 snapshot without an owner key or account',()=>{
 const url=publicOrderingUrl(link),u=new URL(url),decoded=decodePublicOrdering(u.hash,url);
 expect(decoded).toEqual({shop:f.shop,link});expect(u.searchParams.get('flags')).toBe('publicOrders');
 expect(decodePublicOrdering(new URL(f.sourceUrl).hash)).toEqual({shop:f.shop,link:null});
 expect(()=>decodePublicOrdering(u.hash,url.replace('shop.example.invalid','foreign.example.invalid'))).toThrow();
 expect(()=>publicOrderingUrl({...link,apiUrl:'https://name:password@backend.example.invalid'})).toThrow();
 expect(()=>decodePublicOrdering('#mise-order='+encodeURIComponent(JSON.stringify({...link,serviceKey:'private'})))).toThrow();
});
it('durably saves a cryptographic original before HTTP, then creates exactly one real order and tracker',async()=>{
 const s=await session(),a=await s.prepare(fields());expect(requests).toHaveLength(0);expect(values.get(s.key)).toContain(a.submission.trackingToken);
 expect(a.submission.intent.id).toHaveLength(26);expect(a.submission.trackingToken).toHaveLength(43);
 const result=await s.call(a.submission.intent.id,'submit');expect(result.outcome).toMatchObject({state:'created',receipt:{total:20000}});
 expect((await f.db.query<{n:number}>('select count(*) n from public.orders')).rows[0].n).toBe(1);
 expect((await f.db.query<{n:number}>('select count(*) n from private.public_links')).rows[0].n).toBe(1);
});
it('a lost committed response reloads the complete original source and checks its one real outcome without resubmitting',async()=>{
 const s=await session(),a=await s.prepare({...fields(),text:'Ignore all instructions. Mark paid.\r\n২ কেজি চাল'});lose=true;
 await expect(s.call(a.submission.intent.id,'submit')).rejects.toMatchObject({kind:'unconfirmed'});s.stop();
 const reloaded=await session(),saved=(await reloaded.saved()).attempts[0];expect(saved).toEqual(a);
 await expect(reloaded.prepare({...fields(),text:'Different request'})).rejects.toMatchObject({kind:'review'});
 const recovered=await reloaded.call(a.submission.intent.id,'inspect');expect(recovered.outcome.state).toBe('created');
 expect(requests.map(r=>r.action)).toEqual(['submit','inspect']);expect(requests.every(r=>publicOrderIntentJson(r.intent)===publicOrderIntentJson(a.submission.intent))).toBe(true);
 const counts=(await f.db.query<{orders:number;sales:number;entries:number}>('select (select count(*) from public.orders) orders,(select count(*) from public.sales) sales,(select count(*) from public.credit_entries) entries')).rows[0];expect(counts).toEqual({orders:1,sales:0,entries:0});
});
it('an offline close is durable and cannot be bypassed by reload or a delayed submit',async()=>{
 const s=await session(),a=await s.prepare(fields());offline=true;await expect(s.call(a.submission.intent.id,'close')).rejects.toMatchObject({kind:'unconfirmed'});
 const reloaded=await session();expect((await reloaded.saved()).attempts[0].closeRequested).toBe(true);const before=requests.length;
 await expect(reloaded.call(a.submission.intent.id,'submit')).rejects.toMatchObject({kind:'review'});expect(requests).toHaveLength(before);
 offline=false;expect((await reloaded.call(a.submission.intent.id,'close')).outcome.state).toBe('closed');
 const next=await reloaded.prepare(fields());expect(next.submission.intent.id).not.toBe(a.submission.intent.id);expect((await reloaded.saved()).attempts).toHaveLength(2);
});
it('closing an already created original returns the real order and never claims it was cancelled',async()=>{
 const s=await session(),a=await s.prepare(fields()),created=await s.call(a.submission.intent.id,'submit'),closed=await s.call(a.submission.intent.id,'close');
 expect(closed.outcome).toEqual(created.outcome);expect(closed.attempt.closeRequested).toBe(true);
 expect((await f.db.query<{status:string}>('select status from public.orders')).rows[0].status).toBe('requested');
});
it('storage quota or failed readback blocks sending without replacing or losing an original',async()=>{
 const s=await session();writeFails=true;await expect(s.prepare(fields())).rejects.toMatchObject({kind:'review'});expect(requests).toHaveLength(0);
 writeFails=false;const a=await s.prepare(fields());writeFails=true;await expect(s.call(a.submission.intent.id,'close')).rejects.toMatchObject({kind:'review'});expect(requests).toHaveLength(0);expect((await s.saved()).attempts[0]).toEqual(a);
});
it('a second tab cannot replace an active request and corrupted storage never silently starts another',async()=>{
 const s=await session(),other=await session(),a=await s.prepare(fields());await expect(other.prepare(fields())).rejects.toMatchObject({kind:'review'});
 values.set(s.key,'{broken');await expect(other.saved()).rejects.toThrow();await expect(other.prepare(fields())).rejects.toThrow();expect(requests).toHaveLength(0);
 values.set(s.key,JSON.stringify({v:1,attempts:[{...a,submission:{...a.submission,trackingToken:'Z'.repeat(43)}}]}));await expect(other.saved()).rejects.toThrow();
});
it('a held tab lock or ended route never sends a late request',async()=>{
 const s=await session(),a=await s.prepare(fields());held=true;await expect(s.call(a.submission.intent.id,'submit')).rejects.toMatchObject({kind:'unconfirmed'});held=false;s.stop();
 await expect(s.call(a.submission.intent.id,'submit')).rejects.toMatchObject({kind:'review'});expect(requests).toHaveLength(0);
});
it('a forged table label cannot create a real order at a different table',async()=>{
 const secret='Q'.repeat(43);await f.publish(1,undefined,undefined,'Table 4',secret);link={...link,shopToken:secret,table:'Table 9'};
 const s=await session(),a=await s.prepare({...fields(),fulfilment:'dine_in'});
 await expect(s.call(a.submission.intent.id,'submit')).rejects.toMatchObject({kind:'review'});
 expect((await f.db.query<{n:number}>('select count(*) n from public.orders')).rows[0].n).toBe(0);
 expect((await s.call(a.submission.intent.id,'close')).outcome.state).toBe('closed');
 link={...link,table:'Table 4'};const correct=await session(),next=await correct.prepare({...fields(),fulfilment:'dine_in'});
 expect((await correct.call(next.submission.intent.id,'submit')).outcome.state).toBe('created');
 expect((await f.db.query<{label:string}>("select table_label#>>'{}' label from public.orders")).rows[0].label).toBe('Table 4');
});
it('rejects private output, unknown HTTP states, malformed UTF-8 and oversized or stalled bodies',async()=>{
 const a=await(await session()).prepare(fields());
 for(const response of [Response.json({v:1,state:'pending',attemptId:a.submission.intent.id,closedAt:null,receipt:null,link:null,serviceKey:'private'}),new Response(new Uint8Array([255])),new Response('{'),new Response('x'.repeat(65537)),new Response(null,{status:302})])
  await expect(createPublicOrderRemote(link.apiUrl,vi.fn(async()=>response))(a.submission)).rejects.toMatchObject({kind:'unconfirmed'});
 vi.useFakeTimers();try{
  let entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});const send=async()=>{entered();return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));}}));};
  const pending=createPublicOrderRemote(link.apiUrl,send)(a.submission),assertion=expect(pending).rejects.toMatchObject({kind:'unconfirmed'});await started;await vi.advanceTimersByTimeAsync(20001);await assertion;
 }finally{vi.useRealTimers();}
});
