import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createPublicOrderDatabase } from './public-order-fixture';
import { createPublicOrderHandler, createPublicOrderStore, publicOrderLimits } from '../supabase/functions/_shared/public-order-handler';
import { createPublicCapabilityHandler } from '../supabase/functions/_shared/public-capability-handler';
import type { PublicOrderSubmission } from '../packages/core/public-order-submission';
import { newInboxId } from '../packages/core/inbox';
import { deviceId } from './device-pairing-fixture';
let f:Awaited<ReturnType<typeof createPublicOrderDatabase>>;
const origin='https://shop.example.invalid',backend='https://backend.example.invalid/',serviceKey='sb_secret_test';
const calls:{rpc:string;keys:string[]}[]=[];let loseFinish=false;
const send:typeof fetch=async(input,init)=>{
  const url=new URL(String(input)),rpc=url.pathname.split('/').at(-1)!,body=JSON.parse(String(init?.body));
  expect(url.origin).toBe(new URL(backend).origin);expect(url.search).toBe('');expect(init?.redirect).toBe('error');expect(init?.credentials).toBe('omit');
  expect(new Headers(init?.headers).get('apikey')).toBe(serviceKey);expect(new Headers(init?.headers).get('authorization')).toBeNull();
  calls.push({rpc,keys:Object.keys(body)});
  let data:unknown;
  if(rpc==='prepare_public_order')data=await f.asRole(null,'service_role','select public.prepare_public_order($1,$2,$3,$4,$5,$6) data',
    [body.p_shop_secret,body.p_tracking_hash,body.p_intent_json,body.p_operation,body.p_global_limit,body.p_shop_limit]);
  else if(rpc==='finish_public_order'){
    data=await f.asRole(null,'service_role','select public.finish_public_order($1,$2,$3) data',[body.p_attempt_id,body.p_ticket,JSON.stringify(body.p_records)]);
    if(loseFinish){loseFinish=false;throw Error('Deliberately lost committed HTTP reply');}
  }else throw Error('Unexpected RPC');
  return Response.json(data);
};
const serve=(global=1000,shop=30)=>createPublicOrderHandler({store:createPublicOrderStore(backend,serviceKey,send),origins:new Set([origin]),limits:{global,shop}});
async function submission(trackingToken='T'.repeat(43)):Promise<PublicOrderSubmission>{const value=await f.intent(trackingToken);return {v:1,action:'submit',shopToken:f.shopSecret,trackingToken,intent:value.source,website:''};}
const request=(body:unknown,headers:Record<string,string>={})=>new Request(backend+'functions/v1/public/orders',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
beforeAll(async()=>{f=await createPublicOrderDatabase();},30000);
beforeEach(async()=>{vi.useRealTimers();await f.seed();await f.publish();calls.length=0;loseFinish=false;});
afterAll(async()=>{vi.useRealTimers();await f?.db.close();});
it('posts without an account, receives the actual tracker and immediately reads its own real order',async()=>{
  const input=await submission(),handler=serve(),response=await handler(request(input)),result=await response.json();
  expect(response.status).toBe(201);expect(result).toMatchObject({state:'created',receipt:{orderId:input.intent.orderId,total:20000,number:'A-0001'}});
  for(const secret of [input.shopToken,input.trackingToken,serviceKey,deviceId(1),deviceId(11),deviceId(101)])expect(JSON.stringify(result)).not.toContain(secret);
  expect(calls.map(c=>c.rpc)).toEqual(['prepare_public_order','finish_public_order']);
  const retry=await handler(request(input));expect(retry.status).toBe(200);expect(await retry.json()).toEqual(result);
  const reader=createPublicCapabilityHandler({origins:new Set([origin]),store:{read:(q,limits)=>f.asRole(null,'service_role','select public.read_public_capability($1,$2,$3,$4,$5,$6) data',[q.token,q.kind,q.afterSequence,q.pageSize,limits.global,limits.link])}});
  const tracked=await reader(new Request(backend+'functions/v1/public-read',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({kind:'order',token:input.trackingToken})}));
  expect(tracked.status).toBe(200);expect(await tracked.json()).toMatchObject({kind:'order',order:{id:input.intent.orderId,total:20000,status:'requested'}});
  expect(response.headers.get('Cache-Control')).toBe('no-store');expect(response.headers.get('Pragma')).toBe('no-cache');
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
});
it('a lost committed reply is explicitly unconfirmed and inspection recovers the actual original outcome without another order',async()=>{
  const input=await submission(),handler=serve();loseFinish=true;
  const lost=await handler(request(input));expect(lost.status).toBe(503);expect(await lost.text()).toContain('unconfirmed');
  const recovered=await handler(request({...input,action:'inspect'}));expect(recovered.status).toBe(200);expect(await recovered.json()).toMatchObject({state:'created',receipt:{orderId:input.intent.orderId}});
  expect(calls.filter(c=>c.rpc==='finish_public_order')).toHaveLength(1);
  expect((await f.db.query<{n:number}>('select count(*) n from public.orders')).rows[0].n).toBe(1);
});
it('a close-before-submit request leaves a durable fence and a delayed original returns the closed outcome',async()=>{
  const input=await submission(),handler=serve();const closed=await handler(request({...input,action:'close'}));expect(closed.status).toBe(200);expect(await closed.json()).toMatchObject({state:'closed'});
  const delayed=await handler(request(input));expect(delayed.status).toBe(200);expect(await delayed.json()).toMatchObject({state:'closed'});
  expect(calls.some(c=>c.rpc==='finish_public_order')).toBe(false);
});
it('a table QR binds the native order to its published table rather than a supplied label',async()=>{
  const tableSecret='Q'.repeat(43);await f.publish(1,newInboxId(),newInboxId(),'Table 4',tableSecret);
  const input=await submission('F'.repeat(43));input.shopToken=tableSecret;input.intent.fulfilment='dine_in';
  const response=await serve()(request(input));expect(response.status).toBe(201);
  expect((await f.db.query<{type:string;table:string}>('select type,table_label#>>\'{}\' "table" from public.orders where id=$1',[input.intent.orderId])).rows[0]).toEqual({type:'dine_in',table:'Table 4'});
  expect((await serve()(request({...input,intent:{...input.intent,table:'Table 9'}}))).status).toBe(400);
});
it('an unchanged request retries at the shop limit, while a new request receives the authoritative backoff',async()=>{
  const input=await submission(),handler=serve(1000,1);expect((await handler(request(input))).status).toBe(201);
  const limited=await handler(request(await submission('B'.repeat(43))));expect(limited.status).toBe(429);expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
  expect((await handler(request(input))).status).toBe(200);
});
it('the fixed global budget also charges unknown capabilities without storing attacker-selected rows',async()=>{
  const input=await submission(),handler=serve(1,30);input.shopToken='U'.repeat(43);
  expect((await handler(request(input))).status).toBe(404);expect((await handler(request(input))).status).toBe(429);
  expect((await f.db.query<{n:number}>('select count(*) n from private.public_order_attempts')).rows[0].n).toBe(0);
});
it.each(['https://bot.example.invalid',''])('invalid origin or honeypot is rejected before private data access (%s)',async foreign=>{
  const input=await submission();if(!foreign)input.website='https://bot.example.invalid';
  expect((await serve()(request(input,foreign?{Origin:foreign}:{}))).status).toBe(foreign?403:400);expect(calls).toHaveLength(0);
});
it('preflights configured origins but refuses queries, other methods, bad media, malformed UTF-8 and oversized bodies',async()=>{
  const handler=serve();expect((await handler(new Request(backend+'functions/v1/public/orders',{method:'OPTIONS',headers:{Origin:origin}}))).status).toBe(204);
  expect((await handler(new Request(backend+'functions/v1/public/orders',{method:'GET',headers:{Origin:origin}}))).status).toBe(405);
  expect((await handler(request(await submission(),{'Content-Type':'text/plain'}))).status).toBe(415);
  for(const body of ['{',new Uint8Array([255])])expect((await handler(new Request(backend+'functions/v1/public/orders',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body}))).status).toBe(400);
  expect((await handler(request({padding:'x'.repeat(65536)}))).status).toBe(413);
  const url=new URL(request(await submission()).url);url.search='?token=not-a-query-credential';
  expect((await handler(new Request(url,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'}))).status).toBe(400);expect(calls).toHaveLength(0);
});
it.each(['businessId','outletId','customerId','accountId','total','role','paymentStatus'])('rejects caller-selected %s before contacting the backend',async field=>{
  const input=await submission();Object.assign(input.intent,{[field]:'forged'});
  expect((await serve()(request(input))).status).toBe(400);expect(calls).toHaveLength(0);
});
it('reports a changed live item for review without creating a partial order',async()=>{
  const input=await submission();await f.db.query('update public.items set price=price+1 where id=$1',[f.item.id]);
  expect((await serve()(request(input))).status).toBe(409);expect(calls.filter(c=>c.rpc==='finish_public_order')).toHaveLength(0);
  expect((await f.db.query<{n:number}>('select count(*) n from public.orders')).rows[0].n).toBe(0);
});
it('rejects corrupted or private backend output instead of sending it to the customer',async()=>{
  const input=await submission(),handler=createPublicOrderHandler({origins:new Set([origin]),store:{prepare:async()=>({v:1,state:'pending',attemptId:input.intent.id,closedAt:null,receipt:null,link:null,serviceKey,contextJson:'PRIVATE SOURCE'}),finish:async()=>{throw Error();}}});
  const response=await handler(request(input));expect(response.status).toBe(503);const text=await response.text();expect(text).not.toContain(serviceKey);expect(text).not.toContain('PRIVATE SOURCE');
});
it('installer budgets are bounded integers and malformed connection settings never fetch',()=>{
  expect(publicOrderLimits()).toEqual({global:300,shop:30});expect(publicOrderLimits('60000','1')).toEqual({global:60000,shop:1});
  for(const value of ['0','60001','01','1.5',' 20','NaN'])expect(()=>publicOrderLimits(value)).toThrow();
  for(const url of ['https://name:password@backend.example.invalid/','https://backend.example.invalid/other/','https://backend.example.invalid/?key=secret','http://remote.example.invalid/'])
    expect(()=>createPublicOrderStore(url,serviceKey)).toThrow();
});
it('cancels oversized backend output and never reflects redirects, error bodies or malformed UTF-8',async()=>{
  const input=await submission();let cancelled=false;
  const oversized=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(262145));},cancel(){cancelled=true;}});
  await expect(createPublicOrderStore(backend,serviceKey,vi.fn(async()=>new Response(oversized))).prepare(input,{global:3,shop:1})).rejects.toThrow();expect(cancelled).toBe(true);
  for(const response of [new Response('PRIVATE SERVER CONFIG',{status:500}),new Response(null,{status:302,headers:{Location:'https://foreign.example.invalid'}}),new Response('{'),new Response(new Uint8Array([255]))])
    await expect(createPublicOrderStore(backend,serviceKey,vi.fn(async()=>response)).prepare(input,{global:3,shop:1})).rejects.toThrow('Public ordering is unavailable.');
});
it('bounds the whole backend lifetime even if headers or a partial response ignore abort',async()=>{
  const input=await submission();vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  try{for(const partial of [false,true]){
    let entered!:()=>void,signal:AbortSignal|undefined,cancelled=false;const started=new Promise<void>(resolve=>{entered=resolve;});
    const stalled:typeof fetch=async(_url,init)=>{signal=init?.signal??undefined;entered();return partial?new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;}})):new Promise<Response>(()=>{});};
    const pending=createPublicOrderStore(backend,serviceKey,stalled).prepare(input,{global:3,shop:1}),assertion=expect(pending).rejects.toThrow('Public ordering is unavailable.');
    await started;await vi.advanceTimersByTimeAsync(5001);await assertion;expect(signal?.aborted).toBe(true);if(partial)expect(cancelled).toBe(true);
  }}finally{vi.useRealTimers();}
});
