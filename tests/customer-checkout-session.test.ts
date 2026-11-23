import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {createPublicOrderDatabase} from './public-order-fixture';
import {createOrderCheckoutHandler} from '../supabase/functions/_shared/order-checkout-handler';
import {createCustomerCheckoutSession} from '../apps/web/src/data/customer-checkout-session';
import {confirmationIntentJson} from '../packages/core/order-confirmation-protocol';
import {newInboxId} from '../packages/core/inbox';
import {deviceId} from './device-pairing-fixture';
let f:Awaited<ReturnType<typeof createPublicOrderDatabase>>,orderId:string,storage:MemoryStorage,locks:Pick<LockManager,'request'>;
let offline=false,lost=false,corrupt=false;
const token='T'.repeat(43),apiUrl='https://backend.example.invalid';
class MemoryStorage {values=new Map<string,string>();quota=false;getItem(key:string){return this.values.get(key)??null;}setItem(key:string,value:string){if(this.quota)throw Error('Quota');this.values.set(key,value);}}
function mutex(){const pending=new Map<string,Promise<void>>();return {request:async(name:string,callback:()=>Promise<unknown>)=>{const prior=pending.get(name)??Promise.resolve();let release=()=>{};const next=new Promise<void>(resolve=>{release=resolve;});pending.set(name,next);await prior;try{return await callback();}finally{release();}}} as Pick<LockManager,'request'>;}
const handler=createOrderCheckoutHandler({origins:new Set(['https://shop.example.invalid']),store:{prepare:async(i,l)=>f.asRole(null,'service_role','select public.prepare_order_confirmation($1,$2,$3,$4,$5) data',[i.token,i.intent===null?null:confirmationIntentJson(i.intent),i.action,l.global,l.link]),finish:async(i,p,records)=>f.asRole(null,'service_role','select public.finish_order_confirmation($1,$2,$3) data',[i.id,p.ticketToken,JSON.stringify(records)])}});
const send:typeof fetch=async(url,options)=>{
 expect(options).toMatchObject({method:'POST',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});const headers=new Headers(options?.headers);expect(headers.has('authorization')).toBe(false);expect(headers.has('apikey')).toBe(false);expect(new URL(String(url)).search).toBe('');
 if(offline)throw Error('Offline');const response=await handler(new Request(url,options));
 if(String(url).endsWith('/order-confirmations')&&JSON.parse(options!.body as string).action==='submit'){
  if(lost){lost=false;throw Error('Lost reply');}if(corrupt&&response.ok){corrupt=false;const body=await response.json();body.receipt.total=1;return Response.json(body);}
 }return response;
};
const session=(extra:Partial<Parameters<typeof createCustomerCheckoutSession>[1]>={})=>createCustomerCheckoutSession({apiUrl,token,orderId},{storage,locks,send,...extra});
beforeAll(async()=>{f=await createPublicOrderDatabase();},30000);
beforeEach(async()=>{offline=false;lost=false;corrupt=false;storage=new MemoryStorage();locks=mutex();await f.seed();await f.db.exec('update private.order_confirmation_budget set window_at=0,requests=0');await f.publish();const r=await f.intent();await f.finish(r,await f.prepare(r));orderId=r.source.orderId;});
afterAll(async()=>{await f?.db.close();});
it('saves the entire quote and original identities before HTTP and recovers one actual result after a lost committed reply',async()=>{
 const s=await session(),q=await s.quote(),original=await s.prepare(q,[],{method:'cash',walletId:null});expect((await s.saved()).actions[0]).toEqual(original);lost=true;await expect(s.call(original.intent.id,'submit')).rejects.toThrow();s.stop();
 const reloaded=await session();expect((await reloaded.saved()).actions[0].intent).toEqual(original.intent);expect((await reloaded.saved()).actions[0].outcome).toBeNull();await expect(reloaded.prepare(q,[],{method:'cash',walletId:null})).rejects.toThrow('original');expect((await reloaded.call(original.intent.id,'inspect')).state).toBe('applied');expect((await f.db.query<{n:number}>('select count(*) n from private.order_confirmation_actions')).rows[0].n).toBe(1);reloaded.stop();
});
it('records closure while offline, retains it across reload and sends closure before permitting new choices',async()=>{
 const s=await session(),q=await s.quote(),original=await s.prepare(q,[],{method:'cash',walletId:null});offline=true;await expect(s.call(original.intent.id,'submit')).rejects.toThrow();await expect(s.call(original.intent.id,'close')).rejects.toThrow();expect((await s.saved()).actions[0].closeRequested).toBe(true);s.stop();
 const reloaded=await session();expect((await reloaded.saved()).actions[0].intent).toEqual(original.intent);offline=false;expect((await reloaded.call(original.intent.id,'submit')).state).toBe('closed');const fresh=await reloaded.prepare(await reloaded.quote(),[],{method:'cash',walletId:null});expect(fresh.intent.id).not.toBe(original.intent.id);expect((await reloaded.call(fresh.intent.id,'submit')).state).toBe('applied');expect((await reloaded.saved()).actions).toHaveLength(2);reloaded.stop();
});
it('reads only the current receiving target for the original accepted wallet choice and stops offering a removed or paid target',async()=>{
 const wallet={id:newInboxId(),name:'bKash',phone:'+14155550199',url:'bkash://'},policy=(wallets:unknown[],revision:number)=>f.asRole(1,'authenticated','select public.change_checkout_policy($1,$2,$3) data',[deviceId(11),JSON.stringify({v:1,id:newInboxId(),kind:'wallets',revision,orderId:null,orderRevision:null,wallets,enabled:null,maximum:null}),'submit']);
 await policy([wallet],0);const s=await session(),q=await s.quote(),original=await s.prepare(q,[],{method:'wallet',walletId:wallet.id});await expect(s.payment(original.intent.id)).rejects.toThrow();await s.call(original.intent.id,'submit');expect((await s.payment(original.intent.id)).wallet).toEqual(wallet);s.stop();
 const current={...wallet,phone:'+14155550188',url:'https://pay.example.invalid/shop'};await policy([current],1);const reload=await session();expect((await reload.payment(original.intent.id)).wallet).toEqual(current);expect((await reload.saved()).actions[0].quoteJson).toBe(original.quoteJson);
 await policy([],2);await expect(reload.payment(original.intent.id)).rejects.toThrow();await policy([current],3);await f.db.query(`update public.orders set payment='{"method":"wallet","wallet":"bKash","status":"paid"}'::json where id=$1`,[orderId]);await expect(reload.payment(original.intent.id)).rejects.toThrow();reload.stop();
});
it('serializes two sessions without allowing a second tab to replace an unconfirmed original',async()=>{
 const a=await session(),b=await session(),q=await a.quote(),results=await Promise.allSettled([a.prepare(q,[],{method:'cash',walletId:null}),b.prepare(q,[],{method:'cash',walletId:null})]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);expect((await a.saved()).actions).toEqual((await b.saved()).actions);a.stop();b.stop();
});
it('sends no effect after quota, corrupt original data or unavailable browser locks',async()=>{
 const s=await session(),q=await s.quote();storage.quota=true;await expect(s.prepare(q,[],{method:'cash',walletId:null})).rejects.toThrow('Quota');storage.quota=false;expect((await s.saved()).actions).toEqual([]);const unlocked=await session({locks:undefined});await expect(unlocked.prepare(q,[],{method:'cash',walletId:null})).rejects.toThrow('shared confirmation');unlocked.stop();storage.values.set(s.key,'{damaged original');s.stop();await expect(session()).rejects.toThrow('Keep');expect(storage.values.get(s.key)).toBe('{damaged original');expect((await f.db.query<{n:number}>('select count(*) n from private.order_confirmation_actions')).rows[0].n).toBe(0);
});
it('does not accept a malformed successful reply as proof and can inspect the same actual completion afterward',async()=>{
 const s=await session(),q=await s.quote(),original=await s.prepare(q,[],{method:'cash',walletId:null});corrupt=true;await expect(s.call(original.intent.id,'submit')).rejects.toThrow();expect((await s.saved()).actions[0].outcome).toBeNull();const actual=await s.call(original.intent.id,'inspect');expect(actual).toMatchObject({state:'applied',receipt:{total:20000}});expect((await s.saved()).actions[0].intent).toEqual(original.intent);s.stop();
});
it('keeps scope and original data pinned when a late committed response arrives after the session stops',async()=>{
 let release=()=>{},committed=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;}),done=new Promise<void>(resolve=>{committed=resolve;});const delayed:typeof fetch=async(url,options)=>{const response=await send(url,options);if(String(url).endsWith('/order-confirmations')){committed();await gate;}return response;};
 const s=await session({send:delayed}),q=await s.quote(),original=await s.prepare(q,[],{method:'cash',walletId:null}),pending=s.call(original.intent.id,'submit').catch(e=>e);await done;s.stop();release();expect(await pending).toBeInstanceOf(Error);const reloaded=await session();expect((await reloaded.saved()).actions[0].outcome).toBeNull();expect((await reloaded.call(original.intent.id,'inspect')).state).toBe('applied');reloaded.stop();
});
it('never lets another API or capability pick up the original local journal',async()=>{
 const s=await session(),q=await s.quote(),original=await s.prepare(q,[],{method:'cash',walletId:null});const other=await createCustomerCheckoutSession({apiUrl,token:'U'.repeat(43),orderId},{storage,locks,send});expect(other.key).not.toBe(s.key);expect((await other.saved()).actions).toEqual([]);await expect(other.call(original.intent.id,'inspect')).rejects.toThrow();expect((await s.saved()).actions[0]).toEqual(original);s.stop();other.stop();
});
