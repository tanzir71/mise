import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {createPublicOrderDatabase} from './public-order-fixture';
import {deviceId} from './device-pairing-fixture';
import {testCommandAccount} from './command-account-fixture';
import {createOrderEstimateSession} from '../apps/web/src/data/order-estimate-session';
import type {EstimateChange} from '../packages/core/order-estimates';
let f:Awaited<ReturnType<typeof createPublicOrderDatabase>>,orderId:string;
const config={apiUrl:'https://backend.example.invalid',publishableKey:'sb_publishable_test_only'};
beforeAll(async()=>{f=await createPublicOrderDatabase();},30000);beforeEach(async()=>{await f.seed();await f.publish();const request=await f.intent();await f.finish(request,await f.prepare(request));orderId=request.source.orderId;});afterAll(async()=>{await f?.db.close();});
const change=():EstimateChange=>({kind:'set',start:Date.now()+60000,end:Date.now()+300000,note:'আরও কিছু সময় লাগবে।',undoOf:null});
function boot(){
 let held=false,active=true,scoped=true,lose=false,offline=false,quota=false,corruptWrite=false,changeAfterSql=false;const values=new Map<string,string>();
 const storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{if(quota)throw Error('quota');values.set(k,corruptWrite?'{}':v);},removeItem:(k:string)=>{values.delete(k);}},scope={businessId:deviceId(1),outletId:deviceId(11),actorId:deviceId(101),actorRole:'owner' as const,orderId};
 const account=testCommandAccount(config,async()=>{if(!active)throw Error('account changed');return 'owner.original.signature';});account.assertCurrent=()=>{if(!active)throw Error('account changed');};
 const locks={request:async(_key:string,_options:unknown,run:(lock:Lock|null)=>Promise<unknown>)=>{if(held)return run(null);held=true;try{return await run({name:'estimate',mode:'exclusive'});}finally{held=false;}}} as Pick<LockManager,'request'>;
 const calls:string[]=[],send:typeof fetch=async(url,init)=>{if(offline)throw Error('offline');expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer owner.original.signature');const rpc=new URL(String(url)).pathname.split('/').at(-1)!,body=JSON.parse(String(init?.body));calls.push(rpc);
  if(rpc==='read_order_estimate')return Response.json(await f.asRole(1,'authenticated','select public.read_order_estimate($1) data',[body.p_order_id]));
  if(rpc!=='change_order_estimate')throw Error('Unexpected endpoint');expect([...values.values()].some(raw=>raw.includes(body.p_action_id))).toBe(true);
  const result=await f.asRole(1,'authenticated','select public.change_order_estimate($1,$2,$3,$4,$5,$6) data',[body.p_order_id,body.p_action_id,body.p_order_revision,body.p_estimate_revision,JSON.stringify(body.p_change),body.p_operation]);if(changeAfterSql){active=false;changeAfterSql=false;}if(lose){lose=false;throw Error('Lost completed reply');}return Response.json(result);
 };
 const session=()=>createOrderEstimateSession(config,account,scope,{storage,locks,send,assertScope:async()=>{if(!scoped)throw Error('operator changed');},assertDraftAccount:()=>{if(!active)throw Error('account changed');}});
 return {session,storage,values,calls,set lose(v:boolean){lose=v;},set offline(v:boolean){offline=v;},set active(v:boolean){active=v;},set scoped(v:boolean){scoped=v;},set quota(v:boolean){quota=v;},set corruptWrite(v:boolean){corruptWrite=v;},set changeAfterSql(v:boolean){changeAfterSql=v;},set held(v:boolean){held=v;}};
}
it('saves the complete original before HTTP and recovers a lost completed reply using exactly that action',async()=>{
 const b=boot(),s=b.session(),a=await s.prepare(change(),await s.read());expect(s.saved().actions[0]).toEqual({action:a,closeRequested:false,outcome:null});b.lose=true;await expect(s.call(a.id,'submit')).rejects.toMatchObject({kind:'retry'});expect(s.saved().actions[0].outcome).toBeNull();
 const reload=b.session();await expect(reload.prepare(change(),await reload.read())).rejects.toMatchObject({kind:'review'});expect((await reload.call(a.id,'inspect')).state).toBe('applied');expect(reload.saved().actions[0].action).toEqual(a);expect((await f.db.query<{n:number}>('select count(*) n from private.order_estimate_actions')).rows[0].n).toBe(1);
});
it('retains offline closure across a new session, blocks submission and creates the actual fence when online',async()=>{
 const b=boot(),s=b.session(),a=await s.prepare(change(),await s.read());b.offline=true;await expect(s.call(a.id,'submit')).rejects.toMatchObject({kind:'retry'});await expect(s.call(a.id,'close')).rejects.toMatchObject({kind:'retry'});expect(s.saved().actions[0].closeRequested).toBe(true);
 const reload=b.session();await expect(reload.call(a.id,'submit')).rejects.toMatchObject({kind:'review'});expect(reload.saved().actions[0].action).toEqual(a);b.offline=false;expect((await reload.call(a.id,'close')).state).toBe('closed');expect((await reload.read()).estimate).toBeNull();await reload.prepare(change(),await reload.read());
});
it('refuses quota, failed readback, malformed journals and competing tabs before changing SQL',async()=>{
 const b=boot(),s=b.session(),context=await s.read();b.quota=true;await expect(s.prepare(change(),context)).rejects.toMatchObject({kind:'review'});b.quota=false;b.held=true;await expect(s.prepare(change(),context)).rejects.toMatchObject({kind:'retry'});b.held=false;b.corruptWrite=true;await expect(s.prepare(change(),context)).rejects.toMatchObject({kind:'review'});expect(()=>s.saved()).toThrow();expect(b.calls).toEqual(['read_order_estimate']);expect((await f.db.query<{n:number}>('select count(*) n from private.order_estimate_actions')).rows[0].n).toBe(0);
});
it('never promotes a cached context or copied response into authority for another action',async()=>{
 const b=boot(),s=b.session(),context=await s.read();await expect(s.prepare(change(),JSON.parse(JSON.stringify(context)))).rejects.toMatchObject({kind:'review'});expect(s.saved().actions).toEqual([]);b.scoped=false;await expect(s.prepare(change(),context)).rejects.toThrow('operator changed');expect(s.saved().actions).toEqual([]);
});
it('keeps a committed original unconfirmed after an account change until the original account checks it',async()=>{
 const b=boot(),s=b.session(),a=await s.prepare(change(),await s.read());b.changeAfterSql=true;await expect(s.call(a.id,'submit')).rejects.toMatchObject({kind:'auth'});expect(s.saved().actions[0]).toEqual({action:a,closeRequested:false,outcome:null});b.active=true;const reload=b.session();expect((await reload.call(a.id,'inspect')).state).toBe('applied');expect((await f.db.query<{n:number}>('select count(*) n from private.order_estimate_actions')).rows[0].n).toBe(1);
});
it('rejects an old stopped session and prevents a new original while the existing action is unconfirmed',async()=>{
 const b=boot(),s=b.session(),context=await s.read();await s.prepare(change(),context);await expect(s.prepare(change(),context)).rejects.toMatchObject({kind:'review'});s.stop();await expect(s.read()).rejects.toMatchObject({kind:'review'});
});
