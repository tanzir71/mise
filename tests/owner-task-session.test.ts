import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {ownerTasksFixture} from './owner-tasks-fixture';
import {createOwnerTaskSession} from '../apps/web/src/data/owner-task-session';
import {testCommandAccount} from './command-account-fixture';
import {deviceId} from './device-pairing-fixture';
import {assertLiveCommandReceipt} from '../apps/web/src/data/command-request';
import type {DeskPushContext} from '../packages/core/desk-push';
let f:Awaited<ReturnType<typeof ownerTasksFixture>>;
beforeAll(async()=>{f=await ownerTasksFixture();},30000);beforeEach(async()=>{await f.seed();});afterAll(async()=>{await f?.db.close();});
const config={apiUrl:'https://backend.example.invalid',publishableKey:'sb_publishable_test_only'};
function boot(){
 let active=true,native=true,offline=false,lost=false,quota=false,lateAccount=false,lateNative=false,mutateWriter=false,held=false,changePage=false;
 const values=new Map<string,string>(),requests:{rpc:string;operation:string|null;source:string|null}[]=[],storage={getItem:(key:string)=>values.get(key)??null,removeItem:(key:string)=>{values.delete(key);},setItem:(key:string,value:string)=>{if(quota)throw Error('quota');values.set(key,value);if(mutateWriter){mutateWriter=false;native=false;}}};
 const account=testCommandAccount(config,async()=>{if(!active)throw Error('changed');return 'original.owner.signature';});account.assertCurrent=()=>{if(!active)throw Error('changed');};
 const locks={request:async(_key:string,_options:unknown,run:(lock:Lock|null)=>Promise<unknown>)=>{if(held)return run(null);held=true;try{return await run({name:'owner-tasks',mode:'exclusive'});}finally{held=false;}}} as Pick<LockManager,'request'>;
 const send:typeof fetch=async(url,init)=>{
  if(offline)throw Error('offline');const rpc=new URL(url as URL).pathname.split('/').at(-1)!,body=JSON.parse(String(init?.body));requests.push({rpc,operation:body.p_operation??null,source:body.p_intent_json??null});let value:unknown;
  try{if(rpc==='read_owner_task_page'){expect(Object.keys(body).sort()).toEqual(['p_after_at','p_after_id','p_filter','p_limit','p_outlet_id','p_version']);value=await f.asRole(1,'authenticated','select public.read_owner_task_page($1,$2,$3,$4,$5,$6) data',[body.p_outlet_id,body.p_filter,body.p_after_at,body.p_after_id,body.p_version,body.p_limit]);if(changePage&&body.p_after_id===null){changePage=false;await f.db.query("update public.tasks set body='\"New source\"' where id=(select id from public.tasks order by id limit 1)");}}
   else if(rpc==='act_owner_task'){expect(Object.keys(body).sort()).toEqual(['p_intent_json','p_operation','p_outlet_id']);value=await f.asRole(1,'authenticated','select public.act_owner_task($1,$2,$3) data',[body.p_outlet_id,body.p_operation,body.p_intent_json]);}
   else throw Error('Unexpected route');
  }catch(error){const code=(error as {code?:string}).code;return new Response('{}',{status:code==='42501'?403:code==='22023'?400:409});}
  if(rpc==='act_owner_task'&&lateAccount){lateAccount=false;active=false;}if(rpc==='act_owner_task'&&lateNative){lateNative=false;native=false;}if(rpc==='act_owner_task'&&lost){lost=false;throw Error('lost committed reply');}return Response.json(value);
 };
 const open=(scope:DeskPushContext=f.scope())=>createOwnerTaskSession(config,account,scope,{storage,locks,send,assertScope:async()=>{if(!native)throw Error('native changed');},assertDraftAccount:()=>{if(!active)throw Error('account changed');}});
 return {open,values,requests,account,set active(v:boolean){active=v;},set native(v:boolean){native=v;},set offline(v:boolean){offline=v;},set lost(v:boolean){lost=v;},set quota(v:boolean){quota=v;},set lateAccount(v:boolean){lateAccount=v;},set lateNative(v:boolean){lateNative=v;},set mutateWriter(v:boolean){mutateWriter=v;},set changePage(v:boolean){changePage=v;}};
}
const draft={kind:'question' as const,mode:'decision' as const,title:'Can we leave early?',body:'A real request awaiting a human.'};
it('journals the complete original before HTTP and recovers one actual committed receipt after a lost reply',async()=>{
 const b=boot(),s=b.open(),intent=await s.prepareCreate(draft);expect(b.requests).toEqual([]);b.lost=true;await expect(s.call(intent.id,'submit')).rejects.toMatchObject({kind:'retry'});expect(s.saved().actions[0]).toMatchObject({intent,receipt:null});s.stop();const reopened=b.open(),receipt=await reopened.call(intent.id,'inspect');expect(receipt.state).toBe('applied');expect((await f.read()).counts.total).toBe(1);expect(b.requests.map(r=>r.source)).toEqual([JSON.stringify(intent),JSON.stringify(intent)]);const raw=[...b.values.values()].join('');for(const hidden of [config.apiUrl,config.publishableKey,'original.owner.signature','Bearer'])expect(raw).not.toContain(hidden);
});
it('requires actual unmodified HTTP task proof before preparing Allow, then keeps a verifiable undo',async()=>{
 const b=boot(),s=b.open();await s.call((await s.prepareCreate(draft)).id,'submit');const task=(await s.read()).tasks[0];expect(()=>assertLiveCommandReceipt(task)).not.toThrow();await expect(s.prepare(structuredClone(task),'allow')).rejects.toMatchObject({kind:'review'});const source={...task};task.titleJson=JSON.stringify('Forged request');await expect(s.prepare(task,'allow')).rejects.toMatchObject({kind:'review'});Object.assign(task,source);const intent=await s.prepare(task,'allow'),receipt=await s.call(intent.id,'submit');expect(receipt.after?.status).toBe('resolved');const resolved=(await s.read('resolved')).tasks[0],undo=await s.prepare(resolved,'undo');expect((await s.call(undo.id,'submit')).after?.status).toBe('open');
});
it('records closure offline and a reload sends only that exact closure before any new choice',async()=>{
 const b=boot(),s=b.open(),intent=await s.prepareCreate(draft);b.offline=true;await expect(s.call(intent.id,'close')).rejects.toMatchObject({kind:'retry'});expect(s.saved().actions[0].closeRequested).toBe(true);s.stop();const reopened=b.open();await expect(reopened.prepareCreate(draft)).rejects.toMatchObject({kind:'review'});b.offline=false;expect((await reopened.call(intent.id,'submit')).state).toBe('closed');expect(b.requests.at(-1)?.operation).toBe('close');expect((await f.read()).counts.total).toBe(0);
});
it('does not send or replace the native original if saving its complete source fails',async()=>{
 const b=boot(),s=b.open();b.quota=true;await expect(s.prepareCreate(draft)).rejects.toMatchObject({kind:'review'});expect(b.requests).toEqual([]);expect(s.saved().actions).toEqual([]);b.quota=false;const first=await s.prepareCreate(draft),before=JSON.stringify(s.saved());b.quota=true;await expect(s.call(first.id,'close')).rejects.toMatchObject({kind:'review'});expect(JSON.stringify(s.saved())).toBe(before);expect(b.requests).toEqual([]);
});
it('rejects late outcomes after actual SQL completion when the account or native selection changes',async()=>{
 for(const mode of ['account','native'] as const){const b=boot(),s=b.open(),intent=await s.prepareCreate(draft);if(mode==='account')b.lateAccount=true;else b.lateNative=true;await expect(s.call(intent.id,'submit')).rejects.toBeDefined();b.active=true;b.native=true;expect(s.saved().actions[0].receipt).toBeNull();expect((await s.call(intent.id,'inspect')).state).toBe('applied');s.stop();}
 expect((await f.read()).counts.total).toBe(2);
});
it('returns no complete list after a real source change between pages and later reads every task',async()=>{
 for(let n=0;n<103;n++)await f.call(f.draft({body:'Question '+n}));const b=boot(),s=b.open();b.changePage=true;await expect(s.read()).rejects.toMatchObject({kind:'review'});const complete=await s.read();expect(complete.tasks).toHaveLength(103);expect(complete.next).toBeNull();expect(()=>assertLiveCommandReceipt(complete)).not.toThrow();expect(()=>assertLiveCommandReceipt(structuredClone(complete))).toThrow();
});
it('keeps older-role originals inspectable and closeable without rebinding or submitting them under a new role',async()=>{
 const b=boot(),old=b.open(),intent=await old.prepareCreate(draft);old.stop();await f.db.query("update public.members set role='manager' where id=$1",[deviceId(101)]);await f.db.query('insert into public.member_outlets values($1,$2,$3)',[deviceId(1),deviceId(101),deviceId(11)]);const manager=b.open({...f.scope(),role:'manager'});expect(manager.saved().actions[0].intent).toEqual(intent);await expect(manager.call(intent.id,'submit')).rejects.toMatchObject({kind:'review'});expect((await manager.call(intent.id,'close')).state).toBe('closed');expect((await manager.read()).access.role).toBe('manager');
});
it('a native change inside the writer keeps a genuine historical receipt in its own scope and rejects current activation',async()=>{
 const b=boot(),s=b.open(),intent=await s.prepareCreate(draft);b.mutateWriter=true;await expect(s.call(intent.id,'submit')).rejects.toBeDefined();b.native=true;expect(s.saved().actions[0].receipt?.state).toBe('applied');expect(b.open({...f.scope(),outletId:deviceId(12)}).saved().actions).toEqual([]);expect((await f.read()).counts.total).toBe(1);
});
