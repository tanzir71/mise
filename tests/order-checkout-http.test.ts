import {beforeAll,beforeEach,afterAll,it,expect,vi} from 'vitest';
import {createPublicOrderDatabase} from './public-order-fixture';
import {createOrderCheckoutHandler,createOrderCheckoutStore,type OrderCheckoutStore} from '../supabase/functions/_shared/order-checkout-handler';
import {parseQuotedOrder,parseConfirmationOutcome,confirmationIntentJson} from '../packages/core/order-confirmation-protocol';
import type {OrderConfirmation} from '../packages/core/order-confirmation';
import {newInboxId} from '../packages/core/inbox';
import {publicOrderHash} from '../packages/core/public-order-submission';
let f:Awaited<ReturnType<typeof createPublicOrderDatabase>>,lost=false;
const origin='https://shop.example.invalid',token='T'.repeat(43),origins=new Set([origin]);
const request=(path:string,body:unknown,from=origin)=>new Request('https://backend.example.invalid/functions/v1/public/'+path,{method:'POST',headers:{Origin:from,'Content-Type':'application/json'},body:JSON.stringify(body)});
const store:OrderCheckoutStore={prepare:async(i,l)=>f.asRole(null,'service_role','select public.prepare_order_confirmation($1,$2,$3,$4,$5) data',[i.token,i.intent===null?null:confirmationIntentJson(i.intent),i.action,l.global,l.link]),finish:async(i,p,records)=>{const result=await f.asRole(null,'service_role','select public.finish_order_confirmation($1,$2,$3) data',[i.id,p.ticketToken,JSON.stringify(records)]);if(lost){lost=false;throw Error('Lost committed reply');}return result;}};
const handler=createOrderCheckoutHandler({store,origins});
beforeAll(async()=>{f=await createPublicOrderDatabase();},30000);
beforeEach(async()=>{lost=false;await f.seed();await f.db.exec('update private.order_confirmation_budget set window_at=0,requests=0');await f.publish();const r=await f.intent();await f.finish(r,await f.prepare(r));});
afterAll(async()=>{await f?.db.close();});
async function prepared(){const response=await handler(request('order-quote',{v:1,token}));expect(response.status).toBe(200);const q=await parseQuotedOrder(await response.json());const i:OrderConfirmation={v:1,id:newInboxId(),quoteHash:q.quoteHash,swaps:[],payment:{method:'cash',walletId:null},ids:{updateEventId:newInboxId(),pricedEventId:newInboxId(),acceptedEventId:newInboxId(),paymentEventId:newInboxId(),saleId:newInboxId(),saleEventId:newInboxId(),entryId:newInboxId(),creditEventId:newInboxId()}};return {q,i};}
const submit=(i:OrderConfirmation,action='submit')=>handler(request('order-confirmations',{v:1,token,action,intent:i}));
it('confirms through the actual anonymous HTTP, Core and SQL boundary and exposes only its verified public receipt',async()=>{
 const {q,i}=await prepared(),response=await submit(i);expect(response.status).toBe(201);const raw=await response.json(),outcome=parseConfirmationOutcome(raw,i,q.quote);expect(outcome).toMatchObject({state:'applied',receipt:{orderId:q.quote.orderId,total:20000,paymentStatus:'pending'}});expect(Object.keys(raw).sort()).toEqual(['closedAt','id','intentJson','receipt','state','v']);expect(JSON.stringify(raw)).not.toContain('contextJson');expect(response.headers.get('Cache-Control')).toBe('no-store');expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
 const read=await f.asRole<Record<string,unknown>>(null,'service_role',"select public.read_public_capability($1,'order',0,50,3000,60) data",[token]);expect((read.data as {order:{status:string}}).order.status).toBe('accepted');
});
it('recovers the exact committed result after a lost reply without recreating money or a second action',async()=>{
 const {q,i}=await prepared();lost=true;expect((await submit(i)).status).toBe(503);const retry=await submit(i);expect(retry.status).toBe(200);expect(parseConfirmationOutcome(await retry.json(),i,q.quote).state).toBe('applied');expect((await f.db.query<{n:number}>('select count(*) n from private.order_confirmation_actions')).rows[0].n).toBe(1);expect((await f.db.query<{n:number}>('select count(*) n from public.sales')).rows[0].n).toBe(0);
});
it('retains closure before submission and rejects a changed original, guessed resource selector and query credentials',async()=>{
 const {q,i}=await prepared(),closed=await submit(i,'close');expect(parseConfirmationOutcome(await closed.json(),i,q.quote).state).toBe('closed');expect(parseConfirmationOutcome(await (await submit(i)).json(),i,q.quote).state).toBe('closed');
 expect((await submit({...i,payment:{method:'credit',walletId:null}},'inspect')).status).toBe(409);expect((await handler(request('order-confirmations',{v:1,token,action:'submit',intent:i,orderId:newInboxId()}))).status).toBe(400);expect((await handler(request('order-quote?token='+token,{v:1,token}))).status).toBe(400);
});
it('rejects bad origins, unsupported methods and extra authority before accepting a customer request',async()=>{
 expect((await handler(request('order-quote',{v:1,token},'https://other.example.invalid'))).status).toBe(403);expect((await handler(new Request('https://backend.example.invalid/functions/v1/public/order-quote'))).status).toBe(405);expect((await handler(request('order-quote',{v:1,token,businessId:newInboxId()}))).status).toBe(400);expect((await handler(request('order-quote',{v:1,token:'bad'}))).status).toBe(400);
});
it('fails closed on upstream private fields or a changed public quote instead of returning them to the customer',async()=>{
 const {q}=await prepared(),unsafe=JSON.stringify({...q.quote,privateCustomerAddress:'PRIVATE DATA'}),bad=createOrderCheckoutHandler({origins,store:{...store,prepare:async()=>({v:1,state:'quote',quoteJson:unsafe,quoteHash:await publicOrderHash(unsafe)})}}),response=await bad(request('order-quote',{v:1,token}));expect(response.status).toBe(503);expect(await response.text()).not.toContain('PRIVATE DATA');
 const corrupt=createOrderCheckoutHandler({origins,store:{...store,prepare:async()=>({v:1,state:'quote',quoteJson:q.quoteJson,quoteHash:'0'.repeat(64)})}});expect((await corrupt(request('order-quote',{v:1,token}))).status).toBe(503);
});
it('uses the actual installation budget and returns bounded retry guidance without writing an order',async()=>{
 const limited=createOrderCheckoutHandler({origins,store,limits:{global:1,link:30}});expect((await limited(request('order-quote',{v:1,token}))).status).toBe(200);const response=await limited(request('order-quote',{v:1,token}));expect(response.status).toBe(429);expect(Number(response.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);expect((await f.db.query<{n:number}>('select count(*) n from private.order_confirmation_actions')).rows[0].n).toBe(0);
});
it('pins backend transport to the fixed RPC with only a private service key and complete original body',async()=>{
 const {i}=await prepared(),key='sb_secret_'+'synthetic_checkout_transport';let body:Record<string,unknown>|undefined;
 const remote=createOrderCheckoutStore('https://backend.example.invalid',key,async(url,options)=>{expect(String(url)).toBe('https://backend.example.invalid/rest/v1/rpc/prepare_order_confirmation');expect(new Headers(options?.headers).get('apikey')).toBe(key);expect(new Headers(options?.headers).has('authorization')).toBe(false);expect(options).toMatchObject({credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});body=JSON.parse(options!.body as string);return Response.json({v:1,state:'missing'});});
 expect(await remote.prepare({token,action:'inspect',intent:i},{global:300,link:30})).toEqual({v:1,state:'missing'});expect(body).toEqual({p_token:token,p_intent_json:confirmationIntentJson(i),p_operation:'inspect',p_global_limit:300,p_link_limit:30});
});
it('applies the deadline to a stalled response body and never accepts an incomplete outcome',async()=>{
 vi.useFakeTimers();let cancelled=false;
 try{const remote=createOrderCheckoutStore('https://backend.example.invalid','sb_secret_'+'synthetic_checkout_transport',async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"v":1'));},cancel(){cancelled=true;}})));const outcome=remote.prepare({token,action:'quote',intent:null},{global:300,link:30}).catch(error=>error);await vi.advanceTimersByTimeAsync(15001);expect(await outcome).toBeInstanceOf(Error);expect(cancelled).toBe(true);}finally{vi.useRealTimers();}
});
