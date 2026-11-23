import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createPairingDatabase,deviceId} from './device-pairing-fixture';
import {testCommandAccount} from './command-account-fixture';
import {createStaffOwnerSession} from '../apps/web/src/data/staff-owner-session';
import {newInboxId} from '../packages/core/inbox';
import {emptyStaffProfile,type StaffDraft} from '../packages/core/staff';
let f:Awaited<ReturnType<typeof createPairingDatabase>>;
const config={apiUrl:'https://backend.example.invalid',publishableKey:'sb_publishable_test_only'};
const draft:StaffDraft={...emptyStaffProfile(),name:'Nadia Akter',nameLocal:'নাদিয়া',phone:null,role:'staff',active:true};
beforeAll(async()=>{f=await createPairingDatabase();},30000);beforeEach(async()=>{await f.seed();});afterAll(async()=>{await f?.db.close();});
function boot(){
 let held=false,active=true,scoped=true,lost=false,offline=false,quota=false,changeAfterSql=false;
 const values=new Map<string,string>(),calls:string[]=[];
 const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{if(quota)throw Error('quota');values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
 const scope={businessId:deviceId(1),outletId:deviceId(11),actorId:deviceId(101),actorRole:'owner' as const};
 const account=testCommandAccount(config,async()=>{if(!active)throw Error('changed');return 'owner.original.signature';});account.assertCurrent=()=>{if(!active)throw Error('changed');};
 const locks={request:async(_key:string,_options:unknown,run:(lock:Lock|null)=>Promise<unknown>)=>{if(held)return run(null);held=true;try{return await run({name:'staff',mode:'exclusive'});}finally{held=false;}}} as Pick<LockManager,'request'>;
 const send:typeof fetch=async(input,init)=>{
  if(offline)throw Error('offline');const rpc=new URL(input as URL).pathname.split('/').at(-1)!;calls.push(rpc);
  const body=JSON.parse(String(init?.body));let value:unknown;
  try{
   if(rpc==='read_staff_context')value=await f.asRole(1,'authenticated','select public.read_staff_context($1,$2) data',[body.p_outlet_id,body.p_member_id]);
   else if(rpc==='read_staff_board')value=await f.asRole(1,'authenticated','select public.read_staff_board($1,$2,$3) data',[body.p_outlet_id,body.p_after,body.p_page_size]);
   else if(rpc==='change_staff_action')value=await f.asRole(1,'authenticated','select public.change_staff_action($1,$2,$3) data',[body.p_outlet_id,body.p_action_json,body.p_operation]);
   else throw Error('Unexpected route');
  }catch{return new Response('{}',{status:409});}
  if(rpc==='change_staff_action'&&changeAfterSql){changeAfterSql=false;active=false;}
  if(rpc==='change_staff_action'&&lost){lost=false;throw Error('lost completion');}
  return Response.json(value);
 };
 const session=()=>createStaffOwnerSession(config,account,scope,{storage,locks,send,assertScope:async()=>{if(!scoped)throw Error('operator changed');},assertDraftAccount:()=>{if(!active)throw Error('account changed');}});
 return {values,calls,session,get active(){return active;},set active(v:boolean){active=v;},set scoped(v:boolean){scoped=v;},set lost(v:boolean){lost=v;},set offline(v:boolean){offline=v;},set quota(v:boolean){quota=v;},set held(v:boolean){held=v;},set changeAfterSql(v:boolean){changeAfterSql=v;}};
}
it('keeps the complete member change before HTTP and recovers one actual SQL result after a lost reply',async()=>{
 const b=boot(),s=b.session(),memberId=newInboxId(),context=await s.read(memberId),a=await s.prepare({kind:'save',draft},context);
 expect(b.calls).toEqual(['read_staff_context']);expect(s.saved().actions[0].action.draft).toEqual(draft);b.lost=true;
 await expect(s.call(a.id,'submit')).rejects.toMatchObject({kind:'retry'});expect(s.saved().actions[0].outcome).toBe(null);
 const reload=b.session(),result=await reload.call(a.id,'inspect');expect(result.state).toBe('applied');expect(result.member?.member.id).toBe(memberId);
 expect(reload.saved().actions[0].action).toEqual(a);expect((await reload.read(memberId)).current?.member.name).toBe(draft.name);
 expect((await f.db.query<{n:number}>('select count(*)::integer n from private.staff_owner_actions')).rows[0].n).toBe(1);
});
it('persists offline closure before HTTP and later fences the same original instead of sending it',async()=>{
 const b=boot(),s=b.session(),context=await s.read(newInboxId()),a=await s.prepare({kind:'save',draft},context);b.offline=true;
 await expect(s.call(a.id,'close')).rejects.toMatchObject({kind:'retry'});expect(s.saved().actions[0].closeRequested).toBe(true);
 await expect(s.prepare({kind:'save',draft},context)).rejects.toThrow();
 b.offline=false;const result=await b.session().call(a.id,'submit');expect(result.state).toBe('closed');expect((await s.read(a.memberId)).current).toBe(null);
});
it('requires a genuine current context and keeps quota failures or simultaneous tabs from sending a change',async()=>{
 const b=boot(),s=b.session(),context=await s.read(newInboxId());
 await expect(s.prepare({kind:'save',draft},JSON.parse(JSON.stringify(context)))).rejects.toMatchObject({kind:'review'});
 b.quota=true;await expect(s.prepare({kind:'save',draft},context)).rejects.toMatchObject({kind:'review'});expect(s.saved().actions).toEqual([]);b.quota=false;
 b.held=true;await expect(s.prepare({kind:'save',draft},context)).rejects.toMatchObject({kind:'retry'});b.held=false;
 await s.prepare({kind:'save',draft},context);await expect(b.session().prepare({kind:'save',draft},context)).rejects.toMatchObject({kind:'review'});
 expect(b.calls).toEqual(['read_staff_context']);
});
it('does not confirm a result for another live account after SQL commits; the original account can recover it',async()=>{
 const b=boot(),s=b.session(),a=await s.prepare({kind:'save',draft},await s.read(newInboxId()));b.changeAfterSql=true;
 await expect(s.call(a.id,'submit')).rejects.toMatchObject({kind:'auth'});expect(s.saved().actions[0].outcome).toBe(null);
 b.active=true;expect((await b.session().call(a.id,'inspect')).state).toBe('applied');
 expect((await f.db.query<{n:number}>('select count(*)::integer n from private.staff_owner_actions')).rows[0].n).toBe(1);
});
it('records a complete manual original and keeps an actual newer check-in for review',async()=>{
 const b=boot(),s=b.session(),context=await s.read(deviceId(105)),at=context.serverAt;
 const a=await s.prepare({kind:'check-in',type:'in',occurredAt:at},context),applied=await s.call(a.id,'submit');expect(applied.checkIn?.method).toBe('manual');
 const stale=await s.prepare({kind:'check-in',type:'in',occurredAt:at},context);await expect(s.call(stale.id,'submit')).rejects.toMatchObject({kind:'review'});
 expect(s.saved().actions.at(-1)?.action).toEqual(stale);expect((await s.read(deviceId(105))).latest?.id).toBe(a.checkIn?.id);
 expect((await s.call(stale.id,'close')).state).toBe('closed');
});
it('keeps cached originals after a native operator change and stops obsolete sessions without replacing them',async()=>{
 const b=boot(),s=b.session(),context=await s.read(newInboxId()),a=await s.prepare({kind:'save',draft},context),raw=[...b.values.values()][0];
 b.scoped=false;await expect(s.call(a.id,'submit')).rejects.toThrow();expect([...b.values.values()][0]).toBe(raw);
 b.scoped=true;s.stop();await expect(s.page()).rejects.toMatchObject({kind:'review'});expect(b.session().saved().actions[0].action).toEqual(a);
});
