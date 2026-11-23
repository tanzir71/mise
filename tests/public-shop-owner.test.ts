import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {createPublicOrderDatabase} from './public-order-fixture';
import {deviceId} from './device-pairing-fixture';
import {testCommandAccount} from './command-account-fixture';
import {createPublicShopSession} from '../apps/web/src/data/public-shop-session';
import {decodePublicOrdering} from '../packages/core/public-order-link';
let f:Awaited<ReturnType<typeof createPublicOrderDatabase>>;
const config={apiUrl:'https://backend.example.invalid',publishableKey:'sb_publishable_test_only'};
beforeAll(async()=>{f=await createPublicOrderDatabase();},30000);beforeEach(async()=>{await f.seed();});afterAll(async()=>{await f?.db.close();});
function boot(){
 const scope={businessId:deviceId(1),outletId:deviceId(11),actorId:deviceId(101),actorRole:'owner' as const},values=new Map<string,string>(),storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{if(quota)throw Error('quota');values.set(k,v);},removeItem:(k:string)=>values.delete(k)};
 let held=false,active=true,lose=false,offline=false,quota=false;
 const account=testCommandAccount(config,async()=>{if(!active)throw Error('account changed');return 'owner.original.signature';});account.assertCurrent=()=>{if(!active)throw Error('account changed');};
 const locks={request:async(_name:string,_options:unknown,run:(lock:Lock|null)=>Promise<unknown>)=>{if(held)return run(null);held=true;try{return await run({name:'test',mode:'exclusive'});}finally{held=false;}}} as Pick<LockManager,'request'>;
 const send:typeof fetch=async(url,init)=>{if(offline)throw Error('offline');expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer owner.original.signature');
  const name=new URL(String(url)).pathname.split('/').at(-1),body=JSON.parse(String(init?.body));let value:unknown;
  if(name==='read_public_shop_page')value=await f.asRole(1,'authenticated','select public.read_public_shop_page($1,$2,$3) data',[body.p_outlet_id,body.p_after_id,body.p_page_size]);
  else if(name==='publish_public_shop')value=await f.asRole(1,'authenticated','select public.publish_public_shop($1,$2,$3,$4,$5,$6,$7,$8) data',[body.p_id,body.p_event_id,body.p_outlet_id,body.p_source_url,body.p_payload_json,body.p_secret_hash,body.p_table,body.p_expiry]);
  else if(name==='revoke_public_shop')value=await f.asRole(1,'authenticated','select public.revoke_public_shop($1,$2,$3) data',[body.p_id,body.p_event_id,body.p_outlet_id]);else throw Error('Unexpected owner RPC');
  if(lose&&name!=='read_public_shop_page'){lose=false;throw Error('Lost committed reply');}return Response.json(value);
 };
 const session=()=>createPublicShopSession(config,account,scope,{storage,locks,send,assertScope:async()=>{if(!active)throw Error('scope changed');}});
 return {session,storage,values,scope,set active(v:boolean){active=v;},set lose(v:boolean){lose=v;},set offline(v:boolean){offline=v;},set quota(v:boolean){quota=v;}};
}
const input=()=>({sourceUrl:f.sourceUrl,table:null,expiresAt:null});
it('publishes an actual approved M20 snapshot and shares only a live original capability, with no key or owner token in its URL',async()=>{
 const b=boot(),s=b.session(),result=await s.begin(input()),url=s.url(result.source),decoded=decodePublicOrdering(new URL(url).hash,url);
 expect(decoded.shop).toEqual(f.shop);expect(decoded.link?.shopToken).toBe(result.source.shopToken);expect(url).not.toContain(config.publishableKey);expect(url).not.toContain('owner.original.signature');
 const page=await s.page();expect(page.links).toEqual([result.metadata]);expect(JSON.stringify(page)).not.toContain(result.source.shopToken);expect(JSON.stringify(page)).not.toContain('token_hash');
 const fresh=b.session();expect(()=>fresh.url(result.source)).toThrow();expect(fresh.saved().publications[0].source).toEqual(result.source);
 const recovered=await fresh.resume(result.source.id);expect(recovered.metadata).toEqual(result.metadata);expect(fresh.url(recovered.source)).toBe(url);
});
it('recovers a lost publication reply with the same IDs and secret rather than creating another publication',async()=>{
 const b=boot(),s=b.session();b.lose=true;await expect(s.begin(input())).rejects.toMatchObject({kind:'retry'});
 const original=s.saved().publications[0];expect(original.metadata).toBeNull();await expect(s.begin(input())).rejects.toMatchObject({kind:'review'});
 const fresh=b.session(),result=await fresh.resume(original.source.id);expect(result.source).toEqual(original.source);expect(result.metadata.createdAt).not.toBeNull();
 expect((await f.db.query<{n:number}>('select count(*) n from private.public_shops')).rows[0].n).toBe(1);
});
it('a locally recorded disable blocks sharing and publication replay while the actual revoke response is lost',async()=>{
 const b=boot(),s=b.session(),published=await s.begin(input());b.lose=true;await expect(s.revoke(published.source.id)).rejects.toMatchObject({kind:'retry'});
 expect(()=>s.url(published.source)).toThrow();expect(s.saved().revocations[0].metadata).toBeNull();await expect(b.session().resume(published.source.id)).rejects.toMatchObject({kind:'review'});
 const original=s.saved().revocations[0],actual=await b.session().revoke(published.source.id);expect(actual.revokedAt).not.toBeNull();expect(s.saved().revocations[0].eventId).toBe(original.eventId);
 expect((await f.db.query<{n:number}>("select count(*) n from public.events where command='public_shop.revoke'")).rows[0].n).toBe(1);
});
it('can close an unconfirmed publication before a delayed original create and preserve the real closure',async()=>{
 const b=boot(),s=b.session();b.quota=true;await expect(s.begin(input())).rejects.toMatchObject({kind:'review'});expect((await f.db.query<{n:number}>('select count(*) n from private.public_shops')).rows[0].n).toBe(0);
 b.quota=false;b.lose=true;await expect(s.begin(input())).rejects.toMatchObject({kind:'retry'});const source=s.saved().publications[0].source;
 // This original did commit; closure must retain that actual publication.
 const actual=await s.revoke(source.id);expect(actual.createEventId).toBe(source.eventId);expect(actual.createdAt).not.toBeNull();expect(()=>s.url(source)).toThrow();
});
it('owner metadata pages are bounded, sorted, account/outlet scoped and contain neither source nor secret',async()=>{
 const b=boot(),s=b.session();await s.begin(input());await s.begin({...input(),table:'Table 4'});const first=await s.page(null,1),second=await s.page(first.nextId,1);
 expect(first.links).toHaveLength(1);expect(first.nextId).not.toBeNull();expect(second.links[0].id>first.links[0].id).toBe(true);expect(second.nextId).toBeNull();
 expect(JSON.stringify(first)).not.toContain(f.sourceUrl);expect(()=>s.page(null,101)).toThrow();
 for(const n of [3,4,5])await expect(f.asRole(n,'authenticated','select public.read_public_shop_page($1,null,50) data',[deviceId(11)])).rejects.toMatchObject({code:'42501'});
 const manager=await f.asRole<Record<string,unknown>>(2,'authenticated','select public.read_public_shop_page($1,null,50) data',[deviceId(11)]);expect(manager.actorRole).toBe('manager');
 for(const role of ['anon','service_role'] as const)await expect(f.asRole(null,role,'select public.read_public_shop_page($1,null,50) data',[deviceId(11)])).rejects.toMatchObject({code:'42501'});
});
it('a stopped or changed owner cannot publish, share or overwrite another account journal',async()=>{
 const b=boot(),s=b.session(),published=await s.begin(input()),source=structuredClone(published.source);source.shopToken='Z'.repeat(43);expect(()=>s.url(source)).toThrow();b.active=false;
 expect(()=>s.url(published.source)).toThrow();await expect(s.revoke(published.source.id)).rejects.toThrow();s.stop();await expect(s.page()).rejects.toThrow();
});
