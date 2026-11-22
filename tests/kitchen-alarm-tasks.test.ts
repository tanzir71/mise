import {beforeAll,afterAll,expect,it} from 'vitest';
import type {PGlite} from '@electric-sql/pglite';
import {createPairingDatabase,deviceId,deviceUid,type PairingDatabase} from './device-pairing-fixture';
import {orderFixture} from './order-fixture';
import {saveOrderCommand,changeOrderStatusCommand,nextOrderStatuses,undoOrderStatusCommand} from '../packages/core/orders';
import {encodeCommandRecord,decodeCommandRecord} from '../packages/core/cloud-records';
import {newKitchenId,prepareKitchenAction,kitchenContentHash,type KitchenReceipt} from '../packages/core/kitchen';
import {createKitchenAlarmsHandler,createKitchenAlarmsStore} from '../supabase/functions/_shared/kitchen-alarms-handler';
import {createKitchenActionsHandler,createKitchenActionsStore} from '../supabase/functions/_shared/kitchen-actions-handler';
import {createStaffPin} from '../supabase/functions/_shared/staff-pin';
import type {Order,AuditEvent} from '../packages/core/models';
import type {SharedDevice,StaffDeviceSession} from '../packages/core/device-access';
import {createKitchenTicketsStore,projectKitchenRead} from '../supabase/functions/_shared/kitchen-tickets-handler';
import {parseKitchenPage} from '../packages/core/kitchen-tickets';
import {readFileSync} from 'node:fs';
type Sql=Pick<PGlite,'exec'|'query'>;
let f:PairingDatabase,order:Order,device:SharedDevice&{token:string},session:StaffDeviceSession,lastSqlError='';
const key='A'.repeat(43),origin='https://desk.test',literal='বাংলা\0'+String.fromCharCode(0xd800);
const scope={businessId:deviceId(1),outletId:deviceId(11)};
async function role<T=unknown>(sql:Sql,selected:'service_role'|'authenticated'|'anon',n:number|null,query:string,args:unknown[]=[]):Promise<T>{
 await sql.exec('set local role '+selected);await sql.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:selected,...(n===null?{}:{sub:deviceUid(n)}),user_metadata:{role:'owner'}})]);
 const data=(await sql.query<{data:T}>(query,args)).rows[0]?.data;await sql.exec('reset role');return data;
}
async function rollback(work:(sql:Sql)=>Promise<void>){const sentinel=Error('rollback');try{await f.db.transaction(async sql=>{await work(sql);throw sentinel;});}catch(error){if(error!==sentinel)throw error;}}
function rpc(sql:Sql):typeof fetch {
 return async(url,options)=>{
  const name=new URL(String(url)).pathname.split('/').at(-1)!;
  if(!['prepare_kitchen_alarms','finish_kitchen_alarm','prepare_kitchen_action','finish_kitchen_action','read_kitchen_acknowledgements'].includes(name))throw Error('Unexpected RPC');
  expect(options).toMatchObject({method:'POST',redirect:'error',headers:{apikey:'sb_secret_test_only'}});
  const body=JSON.parse(String(options?.body)),keys=Object.keys(body);if(keys.some(k=>!/^p_[a-z_]+$/.test(k)))throw Error('Invalid named argument');
  await sql.exec('savepoint alarm_rpc');
  try {
   const data=await role(sql,'service_role',null,`select public.${name}(${keys.map((k,i)=>k+'=> $'+(i+1)).join(',')}) data`,Object.values(body).map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v));
   await sql.exec('release savepoint alarm_rpc');return Response.json(data);
  }catch(error){lastSqlError=String((error as Error).message)+' '+String((error as {where?:string}).where??'');await sql.exec('rollback to savepoint alarm_rpc;release savepoint alarm_rpc');throw error;}
 };
}
const store=(sql:Sql)=>createKitchenAlarmsStore('https://rpc.test','sb_secret_test_only',rpc(sql));
const alarmRequest=()=>new Request('https://rpc.test/functions/v1/kitchen-alarms',{method:'POST',headers:{authorization:'Bearer '+key,'Content-Type':'application/json'},body:'{}'});
async function run(sql:Sql){const response=await createKitchenAlarmsHandler({key,store:store(sql)})(alarmRequest());expect(response.status,await response.clone().text()+' '+lastSqlError).toBe(200);return response.json();}
async function current(sql:Sql){return decodeCommandRecord('orders',(await sql.query<Record<string,unknown>>('select * from public.orders where id=$1',[order.id])).rows[0]) as unknown as Order;}
function ownerSetup(){const seed=orderFixture('corner_shop').context.setup;return {business:{...seed.business,id:scope.businessId},outlet:{...seed.outlet,id:scope.outletId,businessId:scope.businessId},owner:{...seed.owner,id:deviceId(101),businessId:scope.businessId,outletIds:[scope.outletId]}};}
async function persist(sql:Sql,changed:{order:Order;event:AuditEvent}){
 const audit=encodeCommandRecord('events',changed.event,scope.businessId),record=encodeCommandRecord('orders',changed.order,scope.businessId),keys=Object.keys(audit.values);
 await sql.query(`insert into public.events(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(audit.values));const changes=Object.entries(record.values).filter(([key])=>key!=='id');
 await sql.query(`update public.orders set ${changes.map(([key],i)=>key+'=$'+(i+1)).join(',')} where id=$${changes.length+1}`,[...changes.map(([,value])=>value),changed.order.id]);return changed.order;
}
async function transition(sql:Sql,status:Order['status']){const before=await current(sql);return persist(sql,changeOrderStatusCommand(before,status,ownerSetup(),before.revision));}
async function schedule(sql:Sql,scheduledFor:number){
 const before=await current(sql),seed=orderFixture('corner_shop');return persist(sql,saveOrderCommand({source:before.source,sourceText:before.sourceText,name:before.customer.name,phone:before.customer.phone??'',type:before.type,address:before.address,table:before.table,scheduledFor,lines:before.lines,deliveryFee:before.deliveryFee,discount:before.discount,payment:{method:before.payment.method}},{...seed.context,setup:ownerSetup(),sequence:before.sequence},before,before.revision));
}
async function tasks(sql:Sql){return(await sql.query<{id:string;status:string;generation:number;reason:string|null;acknowledgement_id:string|null;source_revision:number;content_hash:string}>(
 'select t.id,t.status,b.generation,b.reason,b.acknowledgement_id,b.source_revision,b.content_hash from public.tasks t join private.kitchen_alarm_tasks b on b.task_id=t.id where t.outlet_id=$1 order by t.id',[scope.outletId])).rows;}
async function acknowledge(sql:Sql){
 const tap=await prepareKitchenAction(await current(sql),'kitchen.acknowledge');
 const request=new Request('https://rpc.test/functions/v1/kitchen-actions',{method:'POST',headers:{origin,authorization:'Bearer '+device.token,'Content-Type':'application/json'},body:JSON.stringify({sessionToken:session.token,action:tap})});
 const response=await createKitchenActionsHandler({origins:new Set([origin]),store:createKitchenActionsStore('https://rpc.test','sb_secret_test_only',rpc(sql))})(request);
 expect(response.status,await response.clone().text()).toBe(200);return response.json() as Promise<KitchenReceipt>;
}
async function settings(sql:Sql,enabled:boolean,minutes:number,revision=0,id=newKitchenId()){
 return role(sql,'authenticated',1,'select public.set_kitchen_alarm_settings($1,$2,$3,$4,$5) data',[scope.outletId,revision,enabled,minutes,id]);
}
async function finishFirst(sql:Sql,prepared:unknown){
 const raw=prepared as {jobs:{businessId:string;outletId:string;orderId:string;version:number;stamp:string}[]},job=raw.jobs.find(x=>x.orderId===order.id)!;
 const source=await current(sql),{kitchenContentHash}=await import('../packages/core/kitchen');
 return store(sql).finish({...job,contentHash:await kitchenContentHash(source),taskId:newKitchenId(),eventId:newKitchenId(),resolveEventId:newKitchenId()});
}
beforeAll(async()=>{
 f=await createPairingDatabase();await f.seed();
 for(const outlet of [11,12,21]){
  const original=orderFixture('corner_shop'),seed=original.context.setup,business=outlet===21?2:1,owner=business===2?107:101;
  const setup={business:{...seed.business,id:deviceId(business)},outlet:{...seed.outlet,id:deviceId(outlet),businessId:deviceId(business)},owner:{...seed.owner,id:deviceId(owner),businessId:deviceId(business),outletIds:[deviceId(outlet)]}};
  const made=saveOrderCommand({...original.input,type:'delivery',sourceText:'PRIVATE CHAT '+literal,name:'PRIVATE CUSTOMER',address:'PRIVATE ADDRESS',lines:original.input.lines.map(l=>({...l,name:literal,note:literal}))},{...original.context,setup},null,0,Date.now()-180000);
  let saved=made.order;const events=[made.event];while(saved.status!=='accepted'){const next=changeOrderStatusCommand(saved,nextOrderStatuses(saved)[0],setup,saved.revision,saved.updatedAt+1);saved=next.order;events.push(next.event);}
  await f.db.transaction(async sql=>{for(const record of [...events.map(e=>encodeCommandRecord('events',e,deviceId(business))),encodeCommandRecord('orders',saved,deviceId(business))]){
   const keys=Object.keys(record.values);await sql.query(`insert into public.${record.table}(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(record.values));
  }});
  if(outlet===11)order=saved;
 }
 const pin=await createStaffPin('0042',{businessId:scope.businessId,memberId:deviceId(105)},f.pepper);
 await f.asRole(1,'authenticated','select public.set_staff_pin($1,$2,$3,$4,$5,$6) data',[scope.outletId,deviceId(105),newKitchenId(),pin.salt,pin.verifier,pin.pepperVersion]);
 device=await f.asRole(1,'authenticated','select public.enrol_device($1,$2,$3,$4,$5) data',[newKitchenId(),newKitchenId(),scope.outletId,'Alarm test','kitchen']);
 const attempt=await f.asRole<{attemptId:string}>(null,'service_role','select public.begin_staff_pin($1,$2,$3) data',[newKitchenId(),device.token,deviceId(105)]);
 session=await f.asRole(null,'service_role','select public.finish_staff_pin($1,$2,$3,$4,$5) data',[device.token,attempt.attemptId,pin.verifier,newKitchenId(),newKitchenId()]);
},30000);
afterAll(async()=>{await f?.db.close();});

it('closes a handed-off preparation warning immediately, fences a prepared worker and allows an actual owner undo',async()=>rollback(async sql=>{
 await run(sql);const first=(await tasks(sql))[0],before=await current(sql);
 await sql.query('update public.orders set updated_at=updated_at+1 where id=$1',[order.id]);const prepared=await store(sql).prepare(25);
 await transition(sql,'packing');await transition(sql,'ready');const handed=await transition(sql,'delivering');
 expect(handed.payment).toEqual(before.payment);expect(handed.total).toBe(before.total);
 expect((await tasks(sql))[0]).toMatchObject({id:first.id,status:'resolved',reason:'finished',generation:1});
 expect(await finishFirst(sql,prepared)).toMatchObject({state:'stale',raised:false});
 await settings(sql,true,1);expect((await store(sql).prepare(25) as {jobs:{orderId:string}[]}).jobs.some(job=>job.orderId===order.id)).toBe(false);
 const raw=(await sql.query<Record<string,unknown>>('select * from public.events where id=$1',[handed.statusEventId])).rows[0],event=decodeCommandRecord('events',raw) as unknown as AuditEvent;
 await persist(sql,undoOrderStatusCommand(handed,event,ownerSetup(),handed.revision));await run(sql);
 expect((await tasks(sql))[0]).toMatchObject({id:first.id,status:'open',generation:2});
 expect((await current(sql)).payment).toEqual(before.payment);expect((await current(sql)).total).toBe(before.total);
}));

it('uses the original future schedule for SQL warning deadlines and resolves an earlier warning without inventing Got it',async()=>rollback(async sql=>{
 await run(sql);const first=(await tasks(sql))[0],before=await current(sql),start=Date.now()+3600000;
 const scheduled=await schedule(sql,start);await run(sql);
 expect((await tasks(sql))[0]).toMatchObject({id:first.id,status:'resolved',reason:'waiting'});
 expect((await sql.query<{next_at:number}>('select next_at from private.kitchen_alarm_work where order_id=$1',[order.id])).rows[0].next_at).toBe(start+120000);
 expect((await sql.query<{n:number}>('select count(*)::int n from private.kitchen_action_receipts where order_id=$1',[order.id])).rows[0].n).toBe(0);
 expect(scheduled.payment).toEqual(before.payment);expect(scheduled.total).toBe(before.total);expect(scheduled.createdAt).toBe(before.createdAt);
}));

it('upgrades an existing premature scheduled warning without rewriting its original order, event prefix or task identity',async()=>{
 const migration='20261122144829_kitchen_preparation_scope.sql',local=await createPairingDatabase(undefined,false,migration);
 try{
  await local.seed();const seed=orderFixture('corner_shop'),setup=ownerSetup(),at=Date.now()-180000,start=Date.now()+3600000;
  const made=saveOrderCommand({...seed.input,type:'delivery',address:'Fixture address',scheduledFor:start},{...seed.context,setup,sequence:1},null,0,at);
  let saved=made.order;const events=[made.event];while(saved.status!=='accepted'){const next=changeOrderStatusCommand(saved,nextOrderStatuses(saved)[0],setup,saved.revision,at+events.length);saved=next.order;events.push(next.event);}
  await local.db.transaction(async sql=>{for(const record of [...events.map(event=>encodeCommandRecord('events',event,scope.businessId)),encodeCommandRecord('orders',saved,scope.businessId)]){const keys=Object.keys(record.values);await sql.query(`insert into public.${record.table}(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(record.values));}});
  await local.db.exec('begin');
  const prepared=await store(local.db).prepare(25) as {jobs:{businessId:string;outletId:string;orderId:string;version:number;stamp:string}[]};
  await run(local.db);const first=(await tasks(local.db))[0];expect(first.status).toBe('open');
  const source=(await local.db.query<{data:unknown}>('select row_to_json(o) data from public.orders o where id=$1',[saved.id])).rows[0].data;
  const prefix=(await local.db.query<{id:string;data:unknown}>('select id,row_to_json(e) data from public.events e where business_id=$1 order by id',[scope.businessId])).rows;
  await local.db.exec(readFileSync(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8'));
  expect((await local.db.query<{data:unknown}>('select row_to_json(o) data from public.orders o where id=$1',[saved.id])).rows[0].data).toEqual(source);
  for(const row of prefix)expect((await local.db.query<{data:unknown}>('select row_to_json(e) data from public.events e where id=$1',[row.id])).rows[0].data).toEqual(row.data);
  expect((await tasks(local.db))[0]).toMatchObject({id:first.id,generation:1,status:'resolved',reason:'waiting'});
  const job=prepared.jobs.find(job=>job.orderId===saved.id)!;
  expect(await store(local.db).finish({...job,contentHash:await kitchenContentHash(saved),taskId:newKitchenId(),eventId:newKitchenId(),resolveEventId:newKitchenId()})).toMatchObject({state:'stale',raised:false});
  await run(local.db);expect((await local.db.query<{next_at:number}>('select next_at from private.kitchen_alarm_work where order_id=$1',[saved.id])).rows[0].next_at).toBe(start+120000);
  expect((await local.db.query<{n:number}>('select count(*)::int n from private.kitchen_action_receipts where order_id=$1',[saved.id])).rows[0].n).toBe(0);
 }finally{try{await local.db.exec('rollback');}finally{await local.db.close();}}
},30000);

it('raises a real Inbox task and one pending notification without changing the order or its money',async()=>rollback(async sql=>{
 const before=await current(sql);expect(await run(sql)).toMatchObject({processed:3,raised:3,failed:0});
 expect(await current(sql)).toEqual(before);expect(await tasks(sql)).toMatchObject([{status:'open',generation:1,source_revision:before.revision}]);
 const rows=(await sql.query<{actor_type:string;actor_id:string;command:string}>('select actor_type,actor_id,command from public.events where command like $1',['kitchen.alarm.%'])).rows;
 expect(rows).toHaveLength(3);expect(rows.every(x=>x.actor_type==='system'&&x.actor_id==='kitchen-alarm'&&x.command==='kitchen.alarm.raised')).toBe(true);
 expect((await sql.query('select * from private.kitchen_alarm_notifications')).rows).toHaveLength(3);
 const page=await role(sql,'authenticated',1,'select public.read_kitchen_alarm_tasks($1) data',[scope.outletId]);
 expect(JSON.stringify(page)).not.toMatch(/PRIVATE|CUSTOMER|CHAT|ADDRESS|unitPrice|payment|sessionToken/);
 expect(JSON.stringify(page)).not.toContain(literal);expect(page).toMatchObject({v:1,...scope,settings:{enabled:true,minutes:2,revision:0},tasks:[{id:(await tasks(sql))[0].id,orderId:order.id}]});
}));
it('does not duplicate a task, audit or notification after a committed response is lost',async()=>rollback(async sql=>{
 const prepared=await store(sql).prepare(25);expect(await finishFirst(sql,prepared)).toMatchObject({state:'due',raised:true});
 expect(await finishFirst(sql,prepared)).toMatchObject({state:'stale',raised:false});
 expect(await tasks(sql)).toHaveLength(1);expect((await sql.query('select * from private.kitchen_alarm_notifications where task_id=$1',[(await tasks(sql))[0].id])).rows).toHaveLength(1);
}));
it('waits for the configured period and saves the original due time',async()=>rollback(async sql=>{
 await settings(sql,true,5);await run(sql);expect(await tasks(sql)).toHaveLength(0);
 expect((await sql.query<{next_at:number}>('select next_at from private.kitchen_alarm_work where order_id=$1',[order.id])).rows[0].next_at).toBe(order.createdAt+300000);
}));
it('stops immediately on a genuine Got it and cancels pending push before another scheduler tick',async()=>rollback(async sql=>{
 await run(sql);const receipt=await acknowledge(sql),saved=(await tasks(sql))[0];expect(saved).toMatchObject({status:'resolved',reason:'acknowledged',acknowledgement_id:receipt.id});
 expect((await sql.query('select status from private.kitchen_alarm_notifications where task_id=$1',[saved.id])).rows).toEqual([{status:'cancelled'}]);
 await run(sql);expect((await tasks(sql))[0]).toMatchObject({status:'resolved',generation:1});
}));
it('does not silence the alarm merely because the owner marks an order Ready',async()=>rollback(async sql=>{
 await sql.query("update public.orders set status='ready' where id=$1",[order.id]);await run(sql);expect((await tasks(sql))[0].status).toBe('open');
}));
it('reopens the original task after its actual Got it is undone and keeps the historical receipt',async()=>rollback(async sql=>{
 await run(sql);const first=(await tasks(sql))[0],receipt=await acknowledge(sql),before=await current(sql);
 const raw=(await sql.query<Record<string,unknown>>('select * from public.events where id=$1',[before.statusEventId])).rows[0],event=decodeCommandRecord('events',raw) as unknown as AuditEvent;
 const seed=orderFixture('corner_shop').context.setup,setup={business:{...seed.business,id:scope.businessId},outlet:{...seed.outlet,id:scope.outletId,businessId:scope.businessId},owner:{...seed.owner,id:deviceId(101),businessId:scope.businessId,outletIds:[scope.outletId]}};
 const undone=undoOrderStatusCommand(before,event,setup,before.revision),audit=encodeCommandRecord('events',undone.event,scope.businessId),record=encodeCommandRecord('orders',undone.order,scope.businessId);
 const keys=Object.keys(audit.values);await sql.query(`insert into public.events(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(audit.values));
 const entries=Object.entries(record.values).filter(([k])=>k!=='id');await sql.query(`update public.orders set ${entries.map(([k],i)=>k+'=$'+(i+1)).join(',')} where id=$${entries.length+1}`,[...entries.map(([,v])=>v),order.id]);
 await run(sql);expect((await tasks(sql))[0]).toMatchObject({id:first.id,status:'open',generation:2,reason:null,acknowledgement_id:null});
 expect((await sql.query('select id from private.kitchen_action_receipts where id=$1',[receipt.id])).rows).toHaveLength(1);
 const next=await acknowledge(sql);expect((await tasks(sql))[0]).toMatchObject({status:'resolved',generation:2,acknowledgement_id:next.id});
 expect((await sql.query('select * from public.events where command=$1 and order_id=$2',['kitchen.alarm.resolved',order.id])).rows).toHaveLength(2);
}));
it('keeps a newer order edit queued when a worker tries to finish an older observation',async()=>rollback(async sql=>{
 const prepared=await store(sql).prepare(25);await sql.query('update public.orders set table_label=$1,revision=revision+1 where id=$2',[JSON.stringify('Table 9'),order.id]);
 expect(await finishFirst(sql,prepared)).toMatchObject({state:'stale',raised:false});expect(await tasks(sql)).toHaveLength(0);
 await run(sql);expect((await tasks(sql))[0].status).toBe('open');
}));
it('does not raise an old observation after Got it commits',async()=>rollback(async sql=>{
 const prepared=await store(sql).prepare(25);await acknowledge(sql);expect(await finishFirst(sql,prepared)).toMatchObject({state:'stale',raised:false});
 await run(sql);expect(await tasks(sql)).toHaveLength(0);
}));
it('closes the previous content task and preserves it when the actual preparation content changes',async()=>rollback(async sql=>{
 await run(sql);const first=(await tasks(sql))[0];await sql.query('update public.orders set table_label=$1,revision=revision+1 where id=$2',[JSON.stringify('Table 9'),order.id]);await run(sql);
 const rows=await tasks(sql);expect(rows).toHaveLength(2);expect(rows.find(x=>x.id===first.id)).toMatchObject({status:'resolved',reason:'changed',content_hash:first.content_hash,source_revision:first.source_revision});
 expect(rows.filter(x=>x.status==='open')).toHaveLength(1);
}));
it.each(['cancelled','done'])('closes and cancels pending notification immediately for %s',async status=>rollback(async sql=>{
 await run(sql);await sql.query('update public.orders set status=$1 where id=$2',[status,order.id]);expect((await tasks(sql))[0]).toMatchObject({status:'resolved',reason:status==='cancelled'?'cancelled':'finished'});
 await run(sql);expect((await tasks(sql))[0].status).toBe('resolved');
}));
it('disables active alarms, then can re-enable them without losing task history',async()=>rollback(async sql=>{
 await run(sql);const first=(await tasks(sql))[0];await settings(sql,false,2);expect((await tasks(sql))[0]).toMatchObject({status:'resolved',reason:'disabled'});
 await run(sql);expect((await tasks(sql))[0].generation).toBe(1);await settings(sql,true,2,1);await run(sql);expect((await tasks(sql))[0]).toMatchObject({id:first.id,status:'open',generation:2});
}));
it('retries the original settings receipt and rejects changed intent or stale revisions',async()=>rollback(async sql=>{
 const id=newKitchenId(),first=await settings(sql,true,5,0,id);expect(await settings(sql,true,5,0,id)).toEqual(first);
 await sql.exec('savepoint invalid');await expect(settings(sql,true,4,0,id)).rejects.toMatchObject({code:'PT409'});await sql.exec('rollback to savepoint invalid');
 await expect(settings(sql,true,4,0)).rejects.toMatchObject({code:'PT409'});await sql.exec('rollback to savepoint invalid');
}));
it.each([3,4,5])('rejects an unassigned, foreign or anonymous account %s',async n=>rollback(async sql=>{
 await sql.exec('savepoint denied');await expect(role(sql,'authenticated',n,'select public.read_kitchen_alarm_tasks($1) data',[scope.outletId])).rejects.toMatchObject({code:'42501'});await sql.exec('rollback to savepoint denied');
 await expect(role(sql,'authenticated',n,'select public.set_kitchen_alarm_settings($1,0,true,2,$2) data',[scope.outletId,newKitchenId()])).rejects.toMatchObject({code:'42501'});await sql.exec('rollback to savepoint denied');
}));
it('gives an assigned manager only their outlet tasks and no scheduler execution',async()=>rollback(async sql=>{
 await run(sql);expect(await role(sql,'authenticated',2,'select public.read_kitchen_alarm_tasks($1) data',[scope.outletId])).toMatchObject({outletId:scope.outletId,tasks:[{orderId:order.id}]});
 expect(await role(sql,'authenticated',2,"select has_function_privilege(current_user,'public.prepare_kitchen_alarms(integer)','execute') data")).toBe(false);
 expect(await role(sql,'authenticated',2,"select has_function_privilege(current_user,'public.finish_kitchen_alarm(public.ulid,public.ulid,public.ulid,bigint,text,text,public.ulid,public.ulid,public.ulid)','execute') data")).toBe(false);
}));
it('enforces the phone-account boundary on direct RLS task and settings reads',async()=>rollback(async sql=>{
 await run(sql);await settings(sql,true,3);
 expect(await role(sql,'authenticated',2,'select count(*)::integer data from public.tasks')).toBe(1);
 expect(await role(sql,'authenticated',4,'select count(*)::integer data from public.tasks')).toBe(1);
 expect(await role(sql,'authenticated',5,'select count(*)::integer data from public.tasks')).toBe(0);
 expect(await role(sql,'authenticated',5,'select count(*)::integer data from public.kitchen_alarm_settings')).toBe(0);
 expect(await role(sql,'authenticated',2,"select has_table_privilege(current_user,'private.kitchen_alarm_work','select') data")).toBe(false);
}));
it('delivers configured and disabled warnings over the real kitchen reader and wakes its original cursor',async()=>rollback(async sql=>{
 const first=await role<{warningMinutes:number;watermark:number}>(sql,'service_role',null,'select public.read_kitchen_page($1,$2) data',[device.token,session.token]);
 expect(first.warningMinutes).toBe(2);await settings(sql,true,5);
 const changes=await role<{warningMinutes:number;nextSeq:number;orders:unknown[]}>(sql,'service_role',null,'select public.read_kitchen_changes($1,$2,$3) data',[device.token,session.token,first.watermark]);
 expect(changes.warningMinutes).toBe(5);expect(changes.nextSeq).toBeGreaterThan(first.watermark);expect(changes.orders).toHaveLength(1);
 await settings(sql,false,5,1);
 const raw=await role(sql,'service_role',null,'select public.read_kitchen_page($1,$2) data',[device.token,session.token]);
 const projected=await projectKitchenRead(raw,device.token,session.token,createKitchenTicketsStore('https://rpc.test','sb_secret_test_only',rpc(sql)),50,false);
 const page=await parseKitchenPage(projected,{device,session});expect(page.warningMinutes).toBeNull();expect(page.tickets[0].id).toBe(order.id);
}));
