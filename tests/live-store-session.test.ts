import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {liveStoreFixture} from './live-store-fixture';
import {deviceId} from './device-pairing-fixture';
import {testCommandAccount} from './command-account-fixture';
import {createLiveStoreSession} from '../apps/web/src/data/live-store-session';
import {assertLiveCommandReceipt} from '../apps/web/src/data/command-request';
let f:Awaited<ReturnType<typeof liveStoreFixture>>;
beforeAll(async()=>{f=await liveStoreFixture();},30000);beforeEach(async()=>{await f.seed();});afterAll(async()=>{await f?.db.close();});
const config={apiUrl:'https://backend.example.invalid',publishableKey:'sb_publishable_test_only'},scope={businessId:deviceId(1),anchorId:deviceId(11),actorId:deviceId(101),actorRole:'owner' as const};
function boot(){let active=true,scoped=true,changeAfter=false,scopeAfter=false,malformed=false;const calls:string[]=[];
 const account=testCommandAccount(config,async()=>{if(!active)throw Error('changed');return 'owner.original.signature';});account.assertCurrent=()=>{if(!active)throw Error('changed');};
 const send:typeof fetch=async(input,init)=>{expect(new URL(input as URL).pathname).toBe('/rest/v1/rpc/read_live_store');const body=JSON.parse(String(init?.body));calls.push(String(init?.body));const value=await f.asRole<Record<string,unknown>>(1,'authenticated','select public.read_live_store($1,$2,$3,$4,$5) data',[body.p_outlet_id,body.p_all_outlets,body.p_period,body.p_after_outlet,body.p_view_outlet_id]);if(changeAfter)active=false;if(scopeAfter)scoped=false;return Response.json(malformed?{...value,privateValue:'Never attach this'}:value);};
 const session=createLiveStoreSession(config,account,scope,{send,assertScope:async()=>{if(!scoped)throw Error('operator changed');},assertAccount:()=>{if(!active)throw Error('account changed');}});
 return {session,calls,set active(v:boolean){active=v;},set scoped(v:boolean){scoped=v;},set changeAfter(v:boolean){changeAfter=v;},set scopeAfter(v:boolean){scopeAfter=v;},set malformed(v:boolean){malformed=v;}};
}
it('binds a real scoped SQL view to current runtime Auth without persisting a ledger or accepting a serialized proof',async()=>{const b=boot(),view=await b.session.read();expect(view.outlets).toHaveLength(1);expect(b.calls).toHaveLength(1);expect(()=>assertLiveCommandReceipt(view)).not.toThrow();expect(()=>assertLiveCommandReceipt(JSON.parse(JSON.stringify(view)))).toThrow();b.session.stop();expect(()=>assertLiveCommandReceipt(view)).toThrow();});
it('does not attach a genuine completed view after the phone account changed',async()=>{const b=boot();b.changeAfter=true;await expect(b.session.read()).rejects.toBeDefined();expect(b.calls).toHaveLength(1);});
it('does not attach a genuine completed view after the native operator scope changed',async()=>{const b=boot();b.scopeAfter=true;await expect(b.session.read()).rejects.toBeDefined();expect(b.calls).toHaveLength(1);});
it('blocks an old native selection before HTTP and rejects extra private response fields',async()=>{const b=boot();b.scoped=false;await expect(b.session.read()).rejects.toBeDefined();expect(b.calls).toHaveLength(0);const c=boot();c.malformed=true;await expect(c.session.read()).rejects.toMatchObject({kind:'review'});});
