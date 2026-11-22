import {readFileSync} from 'node:fs';
import {createECDH,randomBytes,randomUUID,createHmac} from 'node:crypto';
import {generateVAPIDKeys,generateRequestDetails} from 'web-push';
import {vi} from 'vitest';
import {createPairingDatabase,deviceId,deviceUid} from './device-pairing-fixture';
import {orderFixture} from './order-fixture';
import {saveOrderCommand,changeOrderStatusCommand,nextOrderStatuses} from '../packages/core/orders';
import {encodeCommandRecord,decodeCommandRecord} from '../packages/core/cloud-records';
import {newKitchenId,prepareKitchenAction} from '../packages/core/kitchen';
import {createKitchenAlarmsStore} from '../supabase/functions/_shared/kitchen-alarms-handler';
import {createKitchenPushStore} from '../supabase/functions/_shared/kitchen-push-handler';
import {createKitchenDispatchHandler} from '../supabase/functions/_shared/kitchen-dispatch-handler';
import {createDeskPushSender} from '../supabase/functions/_shared/desk-push-sender';
import {createKitchenActionsHandler,createKitchenActionsStore} from '../supabase/functions/_shared/kitchen-actions-handler';
import {deriveStaffPin} from '../supabase/functions/_shared/staff-pin';
import type {Order,SetupSnapshot} from '../packages/core/models';
import type {SharedDevice,StaffDeviceSession} from '../packages/core/device-access';
export async function kitchenDispatchFixture(){
 const f=await createPairingDatabase(undefined,true);await f.db.exec(readFileSync(new URL('./fixtures/kitchen-dispatch-platform.sql',import.meta.url),'utf8'));
 const originalNet=(await f.db.query<{source:string}>("select pg_get_functiondef('net.http_post(text,jsonb,jsonb,jsonb,integer)'::regprocedure) source")).rows[0].source;
 const key='A'.repeat(43),configId=deviceUid(801),keyId=deviceUid(802),vapid=generateVAPIDKeys(),browser=createECDH('prime256v1');browser.generateKeys();
 const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/kitchen-dispatch-synthetic-only',expirationTime:null,keys:{p256dh:browser.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
 let tail=Promise.resolve();const serial=<T>(work:()=>Promise<T>)=>{const pending=tail.then(work);tail=pending.then(()=>{},()=>{});return pending;};
 const serviceNames=new Set(['prepare_kitchen_alarms','finish_kitchen_alarm','defer_kitchen_alarm','claim_kitchen_dispatch','prepare_kitchen_push','claim_kitchen_push','finish_kitchen_push','prepare_kitchen_action','finish_kitchen_action']);
 const rpc=vi.fn<typeof fetch>(async(url,init)=>{
  const name=new URL(String(url)).pathname.split('/').at(-1)!,headers=new Headers(init?.headers);if(!serviceNames.has(name)||headers.get('apikey')!=='sb_secret_test_only')throw Error('Unexpected scheduler fixture request');
  const body=JSON.parse(String(init?.body)),keys=Object.keys(body);if(keys.some(name=>!/^p_[a-z0-9_]+$/.test(name)))throw Error('Unexpected scheduler argument');
  const data=await serial(()=>f.asRole(null,'service_role',`select public.${name}(${keys.map((name,index)=>name+'=> $'+(index+1)).join(',')}) data`,Object.values(body).map(value=>value!==null&&typeof value==='object'?JSON.stringify(value):value)));return Response.json(data);
 });
 const packets:Request[]=[],capture:typeof fetch=async(url,init)=>{packets.push(new Request(url,init));return new Response(null,{status:201});},transport=vi.fn(capture);
 const alarms=createKitchenAlarmsStore('https://rpc.test','sb_secret_test_only',rpc),push=createKitchenPushStore('https://rpc.test','sb_secret_test_only',rpc),sender=createDeskPushSender(generateRequestDetails,{publicKey:vapid.publicKey,privateKey:vapid.privateKey,subject:'https://desk.test/contact'},transport);
 const handler=createKitchenDispatchHandler({key,applicationKey:vapid.publicKey,alarms,push,send:sender});
 const admin=<T=unknown>(query:string,args:unknown[]=[])=>serial(async()=>(await f.db.query<{data:T}>(query,args)).rows[0]?.data);
 const currentOrder=async(id:string)=>serial(async()=>decodeCommandRecord('orders',(await f.db.query<Record<string,unknown>>('select * from public.orders where id=$1',[id])).rows[0]) as unknown as Order);
 async function reset(){
  await tail;await f.seed();await f.db.exec(originalNet);
  await f.db.exec("truncate cron.job,net.http_request_queue,net._http_response,vault.secrets,private.kitchen_dispatch_grants; update private.kitchen_dispatch_state set enabled=false,config_secret=null,key_secret=null,next_at=0,request_id=null,queued_at=null,signature=null,failures=0,outcome='not-configured'; alter role anon nologin; grant all on all tables in schema net,cron to public; grant execute on all functions in schema net,cron to public; revoke all on vault.secrets,vault.decrypted_secrets from public,anon,authenticated,service_role;");
  await f.db.query('insert into vault.secrets(id,secret) values($1,$2),($3,$4)',[configId,JSON.stringify({apiUrl:'https://worker.test'}),keyId,key]);packets.length=0;rpc.mockClear();transport.mockReset().mockImplementation(capture);
 }
 async function addOrder(sequence=2041,outlet=11,age=180000){
  const source=orderFixture('corner_shop'),seed=source.context.setup,setup:SetupSnapshot={business:{...seed.business,id:deviceId(1)},outlet:{...seed.outlet,id:deviceId(outlet),businessId:deviceId(1)},owner:{...seed.owner,id:deviceId(101),businessId:deviceId(1),outletIds:[deviceId(outlet)]}};
  const created=saveOrderCommand({...source.input,name:'PRIVATE CUSTOMER',sourceText:'PRIVATE SOURCE'},{...source.context,setup,sequence},null,0,Date.now()-age);let order=created.order;const events=[created.event];while(order.status!=='accepted'){const change=changeOrderStatusCommand(order,nextOrderStatuses(order)[0],setup,order.revision,order.updatedAt+1);order=change.order;events.push(change.event);}
  await serial(()=>f.db.transaction(async tx=>{for(const record of [...events.map(value=>encodeCommandRecord('events',value,deviceId(1))),encodeCommandRecord('orders',order,deviceId(1))]){const keys=Object.keys(record.values);await tx.query(`insert into public.${record.table}(${keys.join(',')}) values(${keys.map((_,index)=>'$'+(index+1)).join(',')})`,Object.values(record.values));}}));return order;
 }
 async function acknowledge(id:string){
  const device=await serial(()=>f.asRole<SharedDevice&{token:string}>(1,'authenticated','select public.enrol_device($1,$2,$3,$4,$5) data',[newKitchenId(),newKitchenId(),deviceId(11),'Dispatch kitchen fixture','kitchen']));
  const attempt=await serial(()=>f.asRole<{attemptId:string;salt:string}>(null,'service_role','select public.begin_staff_pin($1,$2,$3) data',[newKitchenId(),device.token,deviceId(105)]));
  const proof=await deriveStaffPin('0042',attempt.salt,{businessId:deviceId(1),memberId:deviceId(105)},f.pepper),session=await serial(()=>f.asRole<StaffDeviceSession>(null,'service_role','select public.finish_staff_pin($1,$2,$3,$4,$5) data',[device.token,attempt.attemptId,proof,newKitchenId(),newKitchenId()]));
  const action=await prepareKitchenAction(await currentOrder(id),'kitchen.acknowledge'),apply=createKitchenActionsHandler({origins:new Set(['https://desk.test']),store:createKitchenActionsStore('https://rpc.test','sb_secret_test_only',rpc)}),response=await apply(new Request('https://worker.test/functions/v1/kitchen-actions',{method:'POST',headers:{origin:'https://desk.test',Authorization:'Bearer '+device.token,'Content-Type':'application/json'},body:JSON.stringify({sessionToken:session.token,action})}));if(!response.ok)throw Error('Actual SQL Got it was not accepted');return response.json();
 }
 await reset();
 const configure=(enabled=true)=>admin('select private.configure_kitchen_dispatch($1,$2,$3) data',[enabled,enabled?configId:null,enabled?keyId:null]);
 const internalRequest=(body:unknown={})=>new Request('https://worker.test/internal',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body)});
 async function request(body:unknown={}){
  const current=await admin<{enabled:boolean;revision:number}>('select private.read_kitchen_dispatch_status() data');if(!current.enabled)await configure();
  const issuedAt=Date.now(),nonce=randomUUID(),input=body as {limit?:unknown},limit=Number.isInteger(input.limit)&&Number(input.limit)>=1&&Number(input.limit)<=25?Number(input.limit):25;
  await admin('insert into private.kitchen_dispatch_grants(nonce,revision,issued_at,batch_size,expires_at) select $1::uuid,revision,$2::bigint,$3::integer,$2::bigint+60000 from private.kitchen_dispatch_state where id returning true data',[nonce,issuedAt,limit]);
  const mac=createHmac('sha256',key).update(`mise:kitchen-dispatch:v1\n${issuedAt}\n${nonce}\n${limit}`).digest('hex');
  return new Request('https://worker.test/functions/v1/kitchen-dispatch',{method:'POST',headers:{Authorization:`Bearer v1.${issuedAt}.${nonce}.${mac}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
 }
 return {...f,key,configId,keyId,vapid,subscription,alarms,push,rpc,transport,packets,handler,admin,addOrder,currentOrder,acknowledge,reset,
  configure,request,internalRequest,
  dispatch:()=>admin<{state:string}>('select private.dispatch_kitchen_work() data'),
  signature:()=>admin<string|null>('select private.kitchen_dispatch_due_signature(floor(extract(epoch from clock_timestamp())*1000)::bigint) data'),
  async register(){return serial(()=>f.asRole(1,'authenticated','select public.register_desk_push($1,$2,$3,$4,$5,$6,$7,$8) data',[newKitchenId(),deviceId(11),subscription.endpoint,subscription.keys.p256dh,subscription.keys.auth,vapid.publicKey,null,newKitchenId()]));},
  async bridge(){const row=await serial(async()=>(await f.db.query<{id:number;url:string;headers:Record<string,string>;body:Uint8Array}>('select * from net.http_request_queue order by id limit 1')).rows[0]);if(!row)throw Error('No committed synthetic net request');const response=await handler(new Request(row.url,{method:'POST',headers:row.headers,body:row.body as BodyInit}));await serial(()=>f.db.query('delete from net.http_request_queue where id=$1',[row.id]));return response;},
  async close(){await tail;await f.db.close();},
 };
}
export type KitchenDispatchFixture=Awaited<ReturnType<typeof kitchenDispatchFixture>>;
