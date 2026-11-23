import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createStaffLinkDatabase} from './staff-link-fixture';
import {createStaffLinkAdminSession} from '../apps/web/src/data/staff-link-admin-session';
import {testCommandAccount} from './command-account-fixture';
import {deviceId} from './device-pairing-fixture';
let f:Awaited<ReturnType<typeof createStaffLinkDatabase>>;
const config={apiUrl:'https://backend.example.invalid',publishableKey:'sb_publishable_test_only'};
beforeAll(async()=>{f=await createStaffLinkDatabase();},30000);beforeEach(async()=>{await f.seed();await f.configure();});afterAll(async()=>{await f?.db.close();});
function boot(){
 let active=true,held=false,lost=false,offline=false,quota=false,changeAfterSql=false;const values=new Map<string,string>(),calls:string[]=[];
 const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{if(quota)throw Error('quota');values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
 const account=testCommandAccount(config,async()=>{if(!active)throw Error('changed');return 'owner.original.signature';});account.assertCurrent=()=>{if(!active)throw Error('changed');};
 const locks={request:async(_key:string,_options:unknown,run:(lock:Lock|null)=>Promise<unknown>)=>{if(held)return run(null);held=true;try{return await run({name:'links',mode:'exclusive'});}finally{held=false;}}} as Pick<LockManager,'request'>;
 const send:typeof fetch=async(input,init)=>{if(offline)throw Error('offline');const rpc=new URL(input as URL).pathname.split('/').at(-1)!,body=JSON.parse(String(init?.body));calls.push(rpc);let value:unknown;
  try{if(rpc==='read_staff_links')value=await f.asRole(1,'authenticated','select public.read_staff_links($1,$2,$3) data',[body.p_outlet_id,body.p_member_id,body.p_after]);
   else if(rpc==='change_staff_link')value=await f.asRole(1,'authenticated','select public.change_staff_link($1,$2,$3) data',[body.p_outlet_id,body.p_action_json,body.p_operation]);else throw Error('Unexpected route');
  }catch{return new Response('{}',{status:409});}
  if(rpc==='change_staff_link'&&changeAfterSql){changeAfterSql=false;active=false;}if(rpc==='change_staff_link'&&lost){lost=false;throw Error('lost');}return Response.json(value);
 };
 const session=()=>createStaffLinkAdminSession(config,account,{...f.scope,memberId:deviceId(105)},{storage,locks,send,assertScope:async()=>{},assertDraftAccount:()=>{if(!active)throw Error('changed');}});
 return {values,calls,session,set active(v:boolean){active=v;},set lost(v:boolean){lost=v;},set offline(v:boolean){offline=v;},set quota(v:boolean){quota=v;},set held(v:boolean){held=v;},set changeAfterSql(v:boolean){changeAfterSql=v;}};
}
it('retains the original generated secret before HTTP, sends only its hash and recovers its single capability',async()=>{
 const b=boot(),s=b.session(),a=await s.prepare('issue',await s.read());const original=s.saved().actions[0];expect(original.token).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(JSON.stringify(a)).not.toContain(original.token!);expect(b.calls).toEqual(['read_staff_links']);
 b.lost=true;await expect(s.call(a.id,'submit')).rejects.toThrow();expect(s.saved().actions[0].outcome).toBe(null);const reload=b.session();expect((await reload.call(a.id,'inspect')).state).toBe('applied');expect(await reload.originalToken(a.linkId)).toBe(original.token);expect((await reload.read()).links).toHaveLength(1);
});
it('fences a cancelled original across offline reload and does not issue its retained secret later',async()=>{
 const b=boot(),s=b.session(),a=await s.prepare('issue',await s.read());b.offline=true;await expect(s.call(a.id,'close')).rejects.toThrow();expect(s.saved().actions[0].closeRequested).toBe(true);b.offline=false;const r=b.session();expect((await r.call(a.id,'submit')).state).toBe('closed');expect((await r.read()).links).toEqual([]);
});
it('keeps completion unconfirmed during an account change and recovers it only for the original account',async()=>{
 const b=boot(),s=b.session(),a=await s.prepare('issue',await s.read());b.changeAfterSql=true;await expect(s.call(a.id,'submit')).rejects.toMatchObject({kind:'auth'});expect(s.saved().actions[0].outcome).toBe(null);b.active=true;expect((await b.session().call(a.id,'inspect')).state).toBe('applied');
});
it('requires a live original context, a native lock and complete storage before issuing',async()=>{
 const b=boot(),s=b.session(),context=await s.read();await expect(s.prepare('issue',JSON.parse(JSON.stringify(context)))).rejects.toThrow();b.held=true;await expect(s.prepare('issue',context)).rejects.toThrow();b.held=false;b.quota=true;await expect(s.prepare('issue',context)).rejects.toThrow();expect(b.calls).toEqual(['read_staff_links']);expect(s.saved().actions).toEqual([]);
});
it('revokes the actual link without losing the original secret or rewriting historical receipts',async()=>{
 const b=boot(),s=b.session(),a=await s.prepare('issue',await s.read());const issued=await s.call(a.id,'submit'),revoke=await s.prepare('revoke',await s.read(),{linkId:a.linkId});expect((await s.call(revoke.id,'submit')).link?.revokedAt).not.toBe(null);expect(s.saved().actions[0].outcome).toEqual(issued);expect(await s.originalToken(a.linkId)).toMatch(/^[A-Za-z0-9_-]{43}$/);
});
