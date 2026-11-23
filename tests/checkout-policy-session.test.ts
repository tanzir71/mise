import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {createPublicOrderDatabase} from './public-order-fixture';
import {deviceId} from './device-pairing-fixture';
import {testCommandAccount} from './command-account-fixture';
import {newInboxId} from '../packages/core/inbox';
import {createCheckoutPolicySession} from '../apps/web/src/data/checkout-policy-session';
let f:Awaited<ReturnType<typeof createPublicOrderDatabase>>;
const config={apiUrl:'https://backend.example.invalid',publishableKey:'sb_publishable_test_only'};
beforeAll(async()=>{f=await createPublicOrderDatabase();},30000);beforeEach(async()=>{await f.seed();});afterAll(async()=>{await f?.db.close();});
const change=()=>({kind:'wallets' as const,wallets:[{id:newInboxId(),name:'bKash',phone:'+14155550199',url:'bkash://'}]});
function boot(){
 let held=false,active=true,scoped=true,lost=false,offline=false,quota=false,changeAfterSql=false;const values=new Map<string,string>(),calls:string[]=[];
 const storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{if(quota)throw Error('quota');values.set(k,v);},removeItem:(k:string)=>{values.delete(k);}},scope={businessId:deviceId(1),outletId:deviceId(11),actorId:deviceId(101),actorRole:'owner' as const,orderId:null};
 const account=testCommandAccount(config,async()=>{if(!active)throw Error('changed');return 'owner.original.signature';});account.assertCurrent=()=>{if(!active)throw Error('changed');};
 const locks={request:async(_key:string,_options:unknown,run:(lock:Lock|null)=>Promise<unknown>)=>{if(held)return run(null);held=true;try{return await run({name:'policy',mode:'exclusive'});}finally{held=false;}}} as Pick<LockManager,'request'>;
 const send:typeof fetch=async(url,init)=>{if(offline)throw Error('offline');expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer owner.original.signature');expect(init?.credentials).toBe('omit');const rpc=new URL(String(url)).pathname.split('/').at(-1)!,body=JSON.parse(String(init?.body));calls.push(rpc);
  if(rpc==='read_checkout_policy')return Response.json(await f.asRole(1,'authenticated','select public.read_checkout_policy($1,$2) data',[body.p_outlet_id,body.p_order_id]));
  if(rpc!=='change_checkout_policy')throw Error('Unexpected endpoint');expect([...values.values()].some(raw=>raw.includes(body.p_action.id))).toBe(true);
  const result=await f.asRole(1,'authenticated','select public.change_checkout_policy($1,$2,$3) data',[body.p_outlet_id,JSON.stringify(body.p_action),body.p_operation]);if(changeAfterSql){active=false;changeAfterSql=false;}if(lost){lost=false;throw Error('Lost completed reply');}return Response.json(result);
 };
 const session=()=>createCheckoutPolicySession(config,account,scope,{storage,locks,send,assertScope:async()=>{if(!scoped)throw Error('operator changed');},assertDraftAccount:()=>{if(!active)throw Error('account changed');}});
 return {session,values,calls,set lost(v:boolean){lost=v;},set offline(v:boolean){offline=v;},set active(v:boolean){active=v;},set scoped(v:boolean){scoped=v;},set quota(v:boolean){quota=v;},set changeAfterSql(v:boolean){changeAfterSql=v;},set held(v:boolean){held=v;}};
}
it('persists the full original public target before HTTP and recovers one real setting after a lost completed reply',async()=>{
 const b=boot(),s=b.session(),a=await s.prepare(change(),await s.read());expect(s.saved().actions[0]).toEqual({action:a,closeRequested:false,outcome:null});b.lost=true;await expect(s.call(a.id,'submit')).rejects.toMatchObject({kind:'retry'});expect(s.saved().actions[0].outcome).toBeNull();const reload=b.session();await expect(reload.prepare(change(),await reload.read())).rejects.toMatchObject({kind:'review'});expect((await reload.call(a.id,'inspect')).state).toBe('applied');expect((await reload.read()).settings.wallets).toEqual(a.wallets);expect((await f.db.query<{n:number}>('select count(*) n from private.checkout_policy_actions')).rows[0].n).toBe(1);
});
it('retains offline closure across reload and sends the closure fence before a delayed submission',async()=>{
 const b=boot(),s=b.session(),a=await s.prepare(change(),await s.read());b.offline=true;await expect(s.call(a.id,'close')).rejects.toMatchObject({kind:'retry'});expect(s.saved().actions[0].closeRequested).toBe(true);s.stop();b.offline=false;const reload=b.session();expect((await reload.call(a.id,'submit')).state).toBe('closed');expect((await reload.read()).settings).toEqual({revision:0,wallets:[]});await reload.prepare(change(),await reload.read());
});
it('refuses quota, a competing tab and corrupt originals before a server write',async()=>{
 const b=boot(),s=b.session(),context=await s.read();b.quota=true;await expect(s.prepare(change(),context)).rejects.toMatchObject({kind:'review'});b.quota=false;b.held=true;await expect(s.prepare(change(),context)).rejects.toMatchObject({kind:'retry'});b.held=false;b.values.set(s.key,'{damaged original');await expect(s.prepare(change(),context)).rejects.toMatchObject({kind:'review'});expect(b.values.get(s.key)).toBe('{damaged original');expect(b.calls).toEqual(['read_checkout_policy']);expect((await f.db.query<{n:number}>('select count(*) n from private.checkout_policy_actions')).rows[0].n).toBe(0);
});
it('does not turn serialized configuration into live account authority or permit a different native operator',async()=>{
 const b=boot(),s=b.session(),context=await s.read();await expect(s.prepare(change(),JSON.parse(JSON.stringify(context)))).rejects.toMatchObject({kind:'review'});b.scoped=false;await expect(s.prepare(change(),context)).rejects.toThrow('operator changed');expect(s.saved().actions).toEqual([]);
});
it('retains a committed original unconfirmed across an actual account change until its original account checks it',async()=>{
 const b=boot(),s=b.session(),a=await s.prepare(change(),await s.read());b.changeAfterSql=true;await expect(s.call(a.id,'submit')).rejects.toMatchObject({kind:'auth'});expect(s.saved().actions[0].outcome).toBeNull();b.active=true;const reload=b.session();expect((await reload.call(a.id,'inspect')).state).toBe('applied');expect(reload.saved().actions[0].action).toEqual(a);expect((await f.db.query<{n:number}>('select count(*) n from private.checkout_policy_actions')).rows[0].n).toBe(1);
});
it('preserves older receipts while requiring current revisions for another configuration and stops obsolete sessions',async()=>{
 const b=boot(),s=b.session(),old=await s.read(),a=await s.prepare(change(),old);await s.call(a.id,'submit');const stale=await s.prepare(change(),old);await expect(s.call(stale.id,'submit')).rejects.toThrow();expect((await s.call(stale.id,'close')).state).toBe('closed');const current=await s.read(),next=await s.prepare({kind:'wallets',wallets:[]},current);await s.call(next.id,'submit');expect((await s.read()).settings.wallets).toEqual([]);expect(s.saved().actions[0].outcome?.state).toBe('applied');s.stop();await expect(s.read()).rejects.toMatchObject({kind:'review'});
});
