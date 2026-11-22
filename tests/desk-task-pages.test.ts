import {beforeAll,afterAll,expect,it} from 'vitest';
import type {PGlite} from '@electric-sql/pglite';
import {createPairingDatabase,deviceId,deviceUid,type PairingDatabase} from './device-pairing-fixture';
import {orderFixture} from './order-fixture';
import {saveOrderCommand} from '../packages/core/orders';
import {encodeCommandRecord} from '../packages/core/cloud-records';
import {newKitchenId} from '../packages/core/kitchen';
import {createKitchenAlarmsHandler,createKitchenAlarmsStore} from '../supabase/functions/_shared/kitchen-alarms-handler';
import {parseDeskTaskPage,appendDeskTaskPage,completeDeskTaskList,deskTaskListWire,parseDeskTaskList,type DeskTaskCursor,type DeskTaskPage} from '../packages/core/desk-tasks';
import type {DeskPushContext} from '../packages/core/desk-push';
type Sql=Pick<PGlite,'exec'|'query'>;
let f:PairingDatabase;const expected=new Set<string>(),scope:DeskPushContext={v:1,businessId:deviceId(1),outletId:deviceId(11),memberId:deviceId(101),role:'owner'};
async function role<T=unknown>(sql:Sql,n:number|null,selected:'authenticated'|'anon'|'service_role',query:string,args:unknown[]=[]):Promise<T>{
 await sql.exec('set local role '+selected);await sql.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:selected,...(n===null?{}:{sub:deviceUid(n)}),user_metadata:{role:'owner'}})]);
 const data=(await sql.query<{data:T}>(query,args)).rows[0]?.data;await sql.exec('reset role');return data;
}
async function rollback(work:(sql:Sql)=>Promise<void>){const end=Error('rollback');try{await f.db.transaction(async sql=>{await work(sql);throw end;});}catch(error){if(error!==end)throw error;}}
async function rejected(sql:Sql,work:()=>Promise<unknown>,code:string){await sql.exec('savepoint rejected_page');await expect(work()).rejects.toMatchObject({code});await sql.exec('rollback to savepoint rejected_page;release savepoint rejected_page');}
function page(sql:Sql,n=1,after:DeskTaskCursor|null=null,version:number|null=null,limit=50,outlet=11){
 return role(sql,n,'authenticated','select public.read_kitchen_alarm_task_page(p_outlet_id=>$1,p_after_due=>$2,p_after_id=>$3,p_version=>$4,p_limit=>$5) data',[deviceId(outlet),after?.dueAt??null,after?.id??null,version,limit]);
}
beforeAll(async()=>{
 f=await createPairingDatabase();await f.seed();const original=orderFixture('corner_shop'),seed=original.context.setup,at=Date.now()-180000;
 await f.db.transaction(async sql=>{
  for(let i=0;i<127;i++){
   const outlet=i<125?11:i===125?12:21,business=outlet===21?2:1,owner=business===2?107:101;
   const setup={business:{...seed.business,id:deviceId(business)},outlet:{...seed.outlet,id:deviceId(outlet),businessId:deviceId(business)},owner:{...seed.owner,id:deviceId(owner),businessId:deviceId(business),outletIds:[deviceId(outlet)]}};
   const made=saveOrderCommand({...original.input,name:'PRIVATE CUSTOMER',sourceText:'PRIVATE CHAT বাংলা\0'+String.fromCharCode(0xd800)},{...original.context,setup,sequence:i+1},null,0,at);
   if(outlet===11)expected.add(made.order.id);
   for(const record of [encodeCommandRecord('events',made.event,deviceId(business)),encodeCommandRecord('orders',made.order,deviceId(business))]){const keys=Object.keys(record.values);await sql.query(`insert into public.${record.table}(${keys.join(',')}) values(${keys.map((_,j)=>'$'+(j+1)).join(',')})`,Object.values(record.values));}
  }
 });
 const send:typeof fetch=async(url,init)=>{
  const route=new URL(String(url)).pathname.split('/').at(-1)!;if(!['prepare_kitchen_alarms','finish_kitchen_alarm'].includes(route))throw Error('Unexpected scheduler RPC');
  const input=JSON.parse(String(init?.body)),keys=Object.keys(input);if(keys.some(k=>!/^p_[a-z][a-z0-9_]*$/.test(k)))throw Error('Unexpected argument');
  const value=await f.asRole(null,'service_role',`select public.${route}(${keys.map((k,j)=>k+'=> $'+(j+1)).join(',')}) data`,Object.values(input));return Response.json(value);
 };
 const handler=createKitchenAlarmsHandler({key:'A'.repeat(43),store:createKitchenAlarmsStore('https://rpc.test','sb_secret_test_only',send)});
 let raised=0;for(let i=0;i<3;i++){const response=await handler(new Request('https://rpc.test/functions/v1/kitchen-alarms',{method:'POST',headers:{authorization:'Bearer '+'A'.repeat(43),'Content-Type':'application/json'},body:JSON.stringify({limit:50})}));expect(response.status,await response.clone().text()).toBe(200);raised+=(await response.json()).raised;}
 expect(raised).toBe(127);
},30000);
afterAll(async()=>{await f?.db.close();});
it('reads all 125 actual alarm tasks beyond the old 100-row cap with stable tie-breaking cursors and no other outlet or private order content',async()=>rollback(async sql=>{
 let complete:DeskTaskPage|null=null,after:DeskTaskCursor|null=null,version:number|null=null;const sizes:number[]=[];
 do{
  const raw=await page(sql,1,after,version),next=parseDeskTaskPage(raw,scope,after);expect(JSON.stringify(raw)).not.toMatch(/PRIVATE|CUSTOMER|CHAT|p256dh|auth_user_id|payment/);
  sizes.push(next.tasks.length);complete=complete?appendDeskTaskPage(complete,next):next;after=next.next;version=next.version;
 }while(after);
 const list=completeDeskTaskList(complete!);expect(sizes).toEqual([50,50,25]);expect(new Set(list.tasks.map(t=>t.orderId))).toEqual(expected);expect(list.tasks).toHaveLength(125);
 expect(parseDeskTaskList(deskTaskListWire(list),scope)).toEqual(list);expect(list.settings).toEqual({enabled:true,minutes:2,revision:0});
}));
it('does not accept an incomplete first page as an exhaustive replacement',async()=>rollback(async sql=>{
 const first=parseDeskTaskPage(await page(sql),scope);expect(first.next).not.toBeNull();expect(()=>completeDeskTaskList(first)).toThrow('complete task list');
}));
it('invalidates the original cursor when the real alarm-close function resolves a task',async()=>rollback(async sql=>{
 const first=parseDeskTaskPage(await page(sql),scope);await sql.query("select private.close_kitchen_alarm($1,'disabled',null,$2)",[first.tasks[0].id,Date.now()]);
 await rejected(sql,()=>page(sql,1,first.next,first.version),'PT409');
 const current=parseDeskTaskPage(await page(sql),scope);expect(current.version).toBeGreaterThan(first.version);
}));
it('invalidates settings-only changes even while all original tasks remain open',async()=>rollback(async sql=>{
 const first=parseDeskTaskPage(await page(sql),scope),count=(await sql.query<{count:number}>("select count(*)::integer count from public.tasks where outlet_id=$1 and status='open'",[deviceId(11)])).rows[0].count;
 await role(sql,1,'authenticated','select public.set_kitchen_alarm_settings($1,0,true,4,$2) data',[deviceId(11),newKitchenId()]);
 expect((await sql.query<{count:number}>("select count(*)::integer count from public.tasks where outlet_id=$1 and status='open'",[deviceId(11)])).rows[0].count).toBe(count);
 await rejected(sql,()=>page(sql,1,first.next,first.version),'PT409');
 const current=parseDeskTaskPage(await page(sql),scope);expect(current.settings).toEqual({enabled:true,minutes:4,revision:1});expect(current.version).toBeGreaterThan(first.version);
}));
it('rechecks actual manager assignment on every continuation page',async()=>rollback(async sql=>{
 const manager={...scope,memberId:deviceId(102),role:'manager' as const},first=parseDeskTaskPage(await page(sql,2),manager);
 await sql.query('delete from public.member_outlets where member_id=$1 and outlet_id=$2',[manager.memberId,manager.outletId]);
 await rejected(sql,()=>page(sql,2,first.next,first.version),'42501');
}));
it.each([3,4,5])('denies unassigned, foreign or anonymous phone account %s despite editable owner claims',async n=>rollback(async sql=>{
 await rejected(sql,()=>page(sql,n),'42501');
}));
it('returns only the foreign owner own outlet and permits an authorized empty task list',async()=>rollback(async sql=>{
 const foreign:DeskPushContext={v:1,businessId:deviceId(2),outletId:deviceId(21),memberId:deviceId(107),role:'owner'},list=parseDeskTaskPage(await page(sql,4,null,null,50,21),foreign);
 expect(list.tasks).toHaveLength(1);expect(list.next).toBeNull();expect(expected.has(list.tasks[0].orderId)).toBe(false);
 await sql.query("select private.close_kitchen_alarm($1,'disabled',null,$2)",[list.tasks[0].id,Date.now()]);
 const empty=parseDeskTaskPage(await page(sql,4,null,null,50,21),foreign);expect(completeDeskTaskList(empty).tasks).toEqual([]);
}));
it.each([0,101])('rejects an invalid page size %s',async limit=>rollback(async sql=>{await rejected(sql,()=>page(sql,1,null,null,limit),'22023');}));
it('rejects a continuation without its original version and a half cursor',async()=>rollback(async sql=>{
 const first=parseDeskTaskPage(await page(sql),scope);await rejected(sql,()=>page(sql,1,first.next,null),'22023');
 await rejected(sql,()=>role(sql,1,'authenticated','select public.read_kitchen_alarm_task_page($1,$2,null,$3,50) data',[scope.outletId,first.next!.dueAt,first.version]),'22023');
}));
it('forces version-table RLS with no direct client/service grants or anonymous paging',async()=>rollback(async sql=>{
 for(const selected of ['authenticated','anon','service_role'] as const)expect(await role(sql,selected==='authenticated'?1:null,selected,'select has_table_privilege(current_user,$1,$2) data',['private.inbox_task_versions','select'])).toBe(false);
 expect(await role(sql,null,'anon','select has_function_privilege(current_user,$1,$2) data',['public.read_kitchen_alarm_task_page(public.ulid,public.utc_ms,public.ulid,bigint,integer)','execute'])).toBe(false);
 expect((await sql.query<{safe:boolean}>("select c.relrowsecurity and c.relforcerowsecurity safe from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname='inbox_task_versions'")).rows[0].safe).toBe(true);
}));
