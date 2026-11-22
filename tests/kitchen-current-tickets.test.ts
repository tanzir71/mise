import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,expect,it} from 'vitest';
import type {PGlite} from '@electric-sql/pglite';
import {createPairingDatabase,deviceId} from './device-pairing-fixture';
import {orderFixture} from './order-fixture';
import {deriveStaffPin} from '../supabase/functions/_shared/staff-pin';
import {applyKitchenAction,newKitchenId,prepareKitchenAction} from '../packages/core/kitchen';
import {saveOrderCommand,changeOrderStatusCommand,nextOrderStatuses,undoOrderStatusCommand} from '../packages/core/orders';
import {encodeCommandRecord,decodeCommandRecord} from '../packages/core/cloud-records';
import type {Order,AuditEvent} from '../packages/core/models';
import {parseStaffDeviceAccess,type SharedDevice,type StaffDeviceSession} from '../packages/core/device-access';
import type {PairingDatabase} from './device-pairing-fixture';

const migration='20261122121013_kitchen_current_tickets.sql';
type Row=Record<string,unknown>;
type CurrentPage={orders:{id:string}[];next:{createdAt:number;id:string}|null};
let opening:PairingDatabase|undefined;
async function insert(sql:Pick<PGlite,'query'>,table:string,rows:Row[]){
 if(!rows.length)return;const keys=Object.keys(rows[0]),args:unknown[]=[];
 const values=rows.map(row=>'('+keys.map(key=>{args.push(row[key]);return '$'+args.length;}).join(',')+')');
 await sql.query(`insert into ${table}(${keys.join(',')}) values${values.join(',')}`,args);
}

// Building the original 5,004 orders and their complete audit/receipt history
// is setup. The unchanged test deadline covers the actual upgrade and reads.
async function historicalFixture(){
 const f=await createPairingDatabase(undefined,false,migration);
 opening=f;
 const started=performance.now(),progress=(stage:string,count?:number)=>console.info(JSON.stringify({stage,count,elapsedMs:Math.round(performance.now()-started)}));
 try{
  await f.seed();
  progress('seeded');
  const device=await f.asRole<SharedDevice&{token:string}>(1,'authenticated','select public.enrol_device($1,$2,$3,$4,$5) data',[newKitchenId(),newKitchenId(),deviceId(11),'Current ticket fixture','kitchen']);
  const attempt=await f.asRole<{attemptId:string;salt:string}>(null,'service_role','select public.begin_staff_pin($1,$2,$3) data',[newKitchenId(),device.token,deviceId(105)]);
  const proof=await deriveStaffPin('0042',attempt.salt,{businessId:deviceId(1),memberId:deviceId(105)},f.pepper);
  const session=await f.asRole<StaffDeviceSession>(null,'service_role','select public.finish_staff_pin($1,$2,$3,$4,$5) data',[device.token,attempt.attemptId,proof,newKitchenId(),newKitchenId()]);
  const access=parseStaffDeviceAccess(await f.asRole(null,'service_role','select public.read_device_session($1,$2) data',[device.token,session.token]));
  progress('authorized');
  const seed=orderFixture('corner_shop').context.setup,setup={business:{...seed.business,id:deviceId(1)},outlet:{...seed.outlet,id:deviceId(11),businessId:deviceId(1)},owner:{...seed.owner,id:deviceId(101),businessId:deviceId(1),outletIds:[deviceId(11)]}};
  const context={setup,items:[],sequence:0},createdAt=Date.now()-600000,current:string[]=[],history:string[]=[];
  let recancelled:{orderId:string;contentHash:string;revision:number}|undefined;
  let orders:Row[]=[],events:Row[]=[],receipts:Row[]=[];
  const flush=async()=>{
   await f.db.transaction(async sql=>{await insert(sql,'public.events',events);await insert(sql,'public.orders',orders);await insert(sql,'private.kitchen_action_receipts',receipts);});
   orders=[];events=[];receipts=[];
  };
  // Validate the four operational cases first; all 5,000 earlier original
  // records still follow with their original created-time ordering and IDs.
  for(const i of [5000,5001,5002,5003,...Array.from({length:5000},(_,index)=>index)]){
   const at=createdAt+i*10,created=saveOrderCommand({source:'walk_in',sourceText:'',name:'Fixture customer',phone:'',type:'pickup',address:'',table:'',lines:[{name:'Rice',unit:'plate',qty:1,unitPrice:100}],deliveryFee:0,discount:0,payment:{method:'cash'}},{...context,sequence:i+1},null,0,at);
   let order=created.order;const audit=[created.event],cancelled=i<5000?i%2===1:i>=5002;
   if(i<5000||cancelled){
    const target=cancelled?'cancelled':'done';
    while(order.status!==target){const next=target==='cancelled'?target:nextOrderStatuses(order)[0];if(!next)throw Error('Historical fixture cannot finish its genuine flow.');const change=changeOrderStatusCommand(order,next,setup,order.revision,at+audit.length);order=change.order;audit.push(change.event);}
   }
   if(i<5000&&cancelled||i===5003){
    const action=await prepareKitchenAction(order,'kitchen.acknowledge'),result=await applyKitchenAction({order,shop:setup,access,action,admittedAt:Date.now(),acknowledgement:null});
    expect(result.order).toEqual(order);audit.push(...result.events);
    receipts.push({id:action.id,business_id:setup.business.id,outlet_id:setup.outlet.id,order_id:order.id,device_id:access.deviceId,session_id:access.sessionId,member_id:access.memberId,action:JSON.stringify(action),receipt:JSON.stringify(result.receipt),accepted_at:result.receipt.acceptedAt});
    if(i===5003){
     const cancel=audit.find(event=>event.id===order.statusEventId)!;
     const undone=undoOrderStatusCommand(order,cancel,setup,order.revision);audit.push(undone.event);
     const next=changeOrderStatusCommand(undone.order,'cancelled',setup,undone.order.revision,undone.order.updatedAt+1);order=next.order;audit.push(next.event);
     recancelled={orderId:order.id,contentHash:action.contentHash,revision:order.revision};
    }
   }
   (i<5000?history:current).push(order.id);orders.push(encodeCommandRecord('orders',order,setup.business.id).values);
   events.push(...audit.map(event=>encodeCommandRecord('events',event,setup.business.id).values));if(orders.length===250)await flush();
   if((i+1)%1000===0){await f.db.exec('analyze');progress('original-records',i+1);}
  }
  await flush();
  progress('source-complete',5004);
  const digest=async()=>{
   const result:Record<string,string>={};for(const table of ['public.orders','public.events','private.kitchen_action_receipts'])result[table]=(await f.db.query<{hash:string}>(`select encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(row_to_json(x)::text,'UTF8')),'hex'),'' order by x.id),''),'UTF8')),'hex') hash from ${table} x`)).rows[0].hash;return result;
  };
  const before=await digest(),old=await f.asRole<{orders:{id:string}[];watermark:number}>(null,'service_role','select public.read_kitchen_page($1,$2,null,null,50) data',[device.token,session.token]);
  progress('original-read');
  expect(old.orders).toHaveLength(50);expect(old.orders.every(order=>history.includes(order.id))).toBe(true);
  if(!recancelled)throw Error('The original recancellation source is unavailable.');
  const oldAck=await f.asRole<{entries:{receipt:unknown}[]}>(null,'service_role','select public.read_kitchen_acknowledgements($1,$2,$3) data',[device.token,session.token,JSON.stringify([recancelled])]);
  expect(oldAck.entries[0].receipt).not.toBeNull();

  return {f,device,session,setup,before,current,digest,progress,recancelled,oldWatermark:old.watermark};
 }catch(error){await f.db.close();throw error;}
}
let loaded:Awaited<ReturnType<typeof historicalFixture>>|undefined;
beforeAll(async()=>{loaded=await historicalFixture();},120000);
afterAll(async()=>{await(loaded?.f??opening)?.db.close();});
it('upgrades 5,000 genuinely completed or acknowledged original orders without loading their history or changing source records',async()=>{
 if(!loaded)throw Error('The original history fixture is unavailable.');
 const {f,device,session,setup,before,current,digest,progress,recancelled,oldWatermark}=loaded;
  await f.db.exec(readFileSync(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8'));
  progress('upgraded');
  expect(await digest()).toEqual(before);
  expect((await f.db.query<{n:number}>('select count(*)::int n from private.kitchen_cancellation_work')).rows[0].n).toBe(2);
  const refreshed=await f.asRole<{orders:{id:string;status:string}[]}>(null,'service_role','select public.read_kitchen_changes($1,$2,$3,null,50) data',[device.token,session.token,oldWatermark]);
  expect(refreshed.orders.map(order=>order.id).sort()).toEqual(current.slice(2).sort());expect(refreshed.orders.every(order=>order.status==='cancelled')).toBe(true);
  const acknowledgement=await f.asRole<{entries:{receipt:unknown}[]}>(null,'service_role','select public.read_kitchen_acknowledgements($1,$2,$3) data',[device.token,session.token,JSON.stringify([recancelled])]);
  expect(acknowledgement.entries[0].receipt).toBeNull();
  const ids:string[]=[];let after:CurrentPage['next']=null;
  do{
   const page:CurrentPage=await f.asRole<CurrentPage>(null,'service_role','select public.read_kitchen_page($1,$2,$3,$4,1) data',[device.token,session.token,after?.createdAt??null,after?.id??null]);
   expect(page.orders).toHaveLength(1);ids.push(page.orders[0].id);after=page.next;
  }while(after);
  expect(ids).toEqual(current);expect(new Set(ids).size).toBe(4);
  await f.db.exec('analyze public.orders;analyze private.kitchen_cancellation_work;analyze private.kitchen_action_receipts');
  const body=(await f.db.query<{source:string}>("select prosrc source from pg_proc where oid='private.read_kitchen_page(text,text,public.utc_ms,public.ulid,integer)'::regprocedure")).rows[0].source;
  const start=body.indexOf('with candidates as materialized ('),end=body.indexOf('), sized as (',start);expect(start).toBeGreaterThan(-1);expect(end).toBeGreaterThan(start);
  let query=body.slice(start,end)+') select * from candidates';
  for(const[name,value]of Object.entries({business:'$1',outlet:'$2',after_time:'$3::bigint',after_id:'$4::public.ulid',page_size:'$5::integer'}))query=query.replace(new RegExp('\\b'+name+'\\b','g'),()=>value);
  const plan=(await f.db.query<Record<string,unknown>>('explain (analyze,format json) '+query,[setup.business.id,setup.outlet.id,null,null,50])).rows[0]['QUERY PLAN'];
  const scans:Record<string,unknown>[]=[];function visit(value:unknown){if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object'){const row=value as Record<string,unknown>;if(row['Relation Name']==='orders')scans.push(row);Object.values(row).forEach(visit);}}visit(plan);
  expect(scans.length).toBeGreaterThan(0);expect(scans.some(row=>row['Index Name']==='orders_kitchen_current_idx')).toBe(true);expect(scans.every(row=>row['Node Type']!=='Seq Scan')).toBe(true);
  expect(await digest()).toEqual(before);

  // A real owner hands off one of the current orders. The next migration
  // must exclude that work without walking or rewriting the 5,000 originals.
  let handed=decodeCommandRecord('orders',(await f.db.query<Row>('select * from public.orders where id=$1',[current[0]])).rows[0]) as unknown as Order;
  async function persist(changed:{order:Order;event:AuditEvent}){
   const audit=encodeCommandRecord('events',changed.event,setup.business.id),record=encodeCommandRecord('orders',changed.order,setup.business.id);
   await f.db.transaction(async sql=>{const keys=Object.keys(audit.values);await sql.query(`insert into public.events(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(audit.values));const changes=Object.entries(record.values).filter(([key])=>key!=='id');await sql.query(`update public.orders set ${changes.map(([key],i)=>key+'=$'+(i+1)).join(',')} where id=$${changes.length+1}`,[...changes.map(([,value])=>value),changed.order.id]);});return changed.order;
  }
  handed=await persist(saveOrderCommand({source:handed.source,sourceText:handed.sourceText,name:handed.customer.name,phone:handed.customer.phone??'',type:'delivery',address:'Fixture door',table:handed.table,lines:handed.lines,deliveryFee:handed.deliveryFee,discount:handed.discount,payment:{method:handed.payment.method}},{...orderFixture('corner_shop').context,setup,sequence:handed.sequence},handed,handed.revision));
  while(handed.status!=='delivering')handed=await persist(changeOrderStatusCommand(handed,nextOrderStatuses(handed)[0],setup,handed.revision));
  const sourceBefore=await digest();
  await f.db.exec(readFileSync(new URL('../supabase/migrations/20261122144829_kitchen_preparation_scope.sql',import.meta.url),'utf8'));
  expect(await digest()).toEqual(sourceBefore);
  const scoped:string[]=[];let cursor:CurrentPage['next']=null;
  do{const page:CurrentPage=await f.asRole<CurrentPage>(null,'service_role','select public.read_kitchen_page($1,$2,$3,$4,1) data',[device.token,session.token,cursor?.createdAt??null,cursor?.id??null]);scoped.push(...page.orders.map(order=>order.id));cursor=page.next;}while(cursor);
  expect(scoped).toEqual(current.slice(1));
  const currentBody=(await f.db.query<{source:string}>("select prosrc source from pg_proc where oid='private.read_kitchen_page(text,text,public.utc_ms,public.ulid,integer)'::regprocedure")).rows[0].source;
  const begin=currentBody.indexOf('with candidates as materialized ('),last=currentBody.indexOf('), sized as (',begin);expect(begin).toBeGreaterThan(-1);expect(last).toBeGreaterThan(begin);
  let currentQuery=currentBody.slice(begin,last)+') select * from candidates';
  for(const[name,value]of Object.entries({business:'$1',outlet:'$2',after_time:'$3::bigint',after_id:'$4::public.ulid',page_size:'$5::integer'}))currentQuery=currentQuery.replace(new RegExp('\\b'+name+'\\b','g'),()=>value);
  const currentPlan=(await f.db.query<Row>('explain (analyze,format json) '+currentQuery,[setup.business.id,setup.outlet.id,null,null,50])).rows[0]['QUERY PLAN'];
  const currentScans:Row[]=[];function walk(value:unknown){if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object'){const row=value as Row;if(row['Relation Name']==='orders')currentScans.push(row);Object.values(row).forEach(walk);}}walk(currentPlan);
  expect(currentScans.some(row=>row['Index Name']==='orders_kitchen_current_idx')).toBe(true);expect(currentScans.every(row=>row['Node Type']!=='Seq Scan')).toBe(true);
  expect(await digest()).toEqual(sourceBefore);
  const raw=(await f.db.query<Row>('select * from public.events where id=$1',[handed.statusEventId])).rows[0],event=decodeCommandRecord('events',raw) as unknown as AuditEvent;
  const returned=await persist(undoOrderStatusCommand(handed,event,setup,handed.revision));
  const refreshedPage=await f.asRole<CurrentPage>(null,'service_role','select public.read_kitchen_page($1,$2,null,null,50) data',[device.token,session.token]);expect(refreshedPage.orders.map(order=>order.id)).toEqual(current);
  expect(returned.payment).toEqual(handed.payment);expect(returned.total).toBe(handed.total);
},60000);
