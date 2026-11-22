import {createServer,type IncomingMessage} from 'node:http';
import {once} from 'node:events';
import {createPairingDatabase,deviceId} from '../device-pairing-fixture';
import {orderFixture} from '../order-fixture';
import {encodeCommandRecord,decodeCommandRecord} from '../../packages/core/cloud-records';
import {newKitchenId,prepareKitchenAction,type KitchenReceipt} from '../../packages/core/kitchen';
import type {Order,AuditEvent} from '../../packages/core/models';
import type {SharedDevice,StaffDeviceSession} from '../../packages/core/device-access';
import type {ScreenState} from '../../packages/core/device-screen-state';
import {createKitchenActionsHandler,createKitchenActionsStore} from '../../supabase/functions/_shared/kitchen-actions-handler';
import {createKitchenTicketsHandler,createKitchenTicketsStore} from '../../supabase/functions/_shared/kitchen-tickets-handler';
import {deriveStaffPin} from '../../supabase/functions/_shared/staff-pin';
import {saveOrderCommand,changeOrderStatusCommand,nextOrderStatuses,undoOrderStatusCommand} from '../../packages/core/orders';
import Socket,{WebSocketServer} from 'ws';
import {kitchenBroadcastSubscriber,type KitchenBroadcastSocketFactory} from '../../supabase/functions/_shared/kitchen-broadcast';
import {createKitchenLiveHandler} from '../../supabase/functions/_shared/kitchen-live-handler';
import {createKitchenRecoveryHandler,createKitchenRecoveryStore} from '../../supabase/functions/_shared/kitchen-recovery-handler';
import {createDeviceAccessHandler,createDeviceAccessStore} from '../../supabase/functions/_shared/device-access-handler';
import {createDevicePinHandler,createDevicePinStore} from '../../supabase/functions/_shared/device-pin-handler';

/** Real isolated PostgreSQL and production handlers. All identities, phone
 * accounts and credentials are synthetic; no provider or hosted service. */
export async function startKitchenUiService(){
 const f=await createPairingDatabase(process.cwd());await f.seed();
 const origin='http://127.0.0.1:4321',origins=new Set([origin]);
 const broker=new WebSocketServer({port:0,host:'127.0.0.1',maxPayload:16384,verifyClient:(info:{req:IncomingMessage})=>info.req.headers.apikey==='sb_secret_test_only'&&!info.req.url?.includes('apikey=')});
 await once(broker,'listening');
 const subscriptions=new Map<Socket,string>();let broadcasts=0;
 broker.on('connection',socket=>{
  socket.on('close',()=>subscriptions.delete(socket));
  socket.on('message',bytes=>{try{const value=JSON.parse(bytes.toString());if(value.event==='phx_join'&&value.payload?.config?.private===true&&/^realtime:kitchen:[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value.topic)){subscriptions.set(socket,value.topic);socket.send(JSON.stringify({topic:value.topic,event:'phx_reply',ref:value.ref,payload:{status:'ok'}}));}else if(value.event==='heartbeat')socket.send(JSON.stringify({topic:'phoenix',event:'phx_reply',ref:value.ref,payload:{status:'ok'}}));else socket.terminate();}catch{socket.terminate();}});
 });
 await f.db.exec("create schema realtime; create function realtime.send(payload jsonb,event text,topic text,private boolean default true) returns void language plpgsql as $$ begin perform pg_notify('mise_fixture_kitchen',jsonb_build_object('payload',payload,'event',event,'topic',topic,'private',private)::text); end $$;");
 const unlisten=await f.db.listen('mise_fixture_kitchen',text=>{const value=JSON.parse(text);if(value.private!==true)return;for(const [socket,topic]of subscriptions)if(topic==='realtime:'+value.topic&&socket.readyState===Socket.OPEN){broadcasts++;socket.send(JSON.stringify({topic,event:'broadcast',payload:{type:'broadcast',event:value.event,payload:value.payload}}));}});
 const open:KitchenBroadcastSocketFactory=(url,headers,events)=>{
  const socket=new Socket(url,{headers,handshakeTimeout:5000,followRedirects:false,perMessageDeflate:false,maxPayload:16384});socket.on('open',events.open);socket.on('message',(bytes,binary)=>{if(binary){events.close();socket.terminate();}else events.text(bytes.toString());});socket.on('close',events.close);socket.on('error',events.close);return {send:text=>socket.send(text),close:()=>socket.terminate()};
 };
 const live=createKitchenLiveHandler({origins,access:(device,session)=>f.asRole(null,'service_role','select public.read_device_session($1,$2) data',[device,session]),subscribe:kitchenBroadcastSubscriber('http://127.0.0.1:'+(broker.address() as {port:number}).port,'sb_secret_test_only',open)});
 const rpc:typeof fetch=async(url,init)=>{
  const name=new URL(String(url)).pathname.split('/').at(-1)!;
  if(!['prepare_kitchen_action','finish_kitchen_action','read_kitchen_page','read_kitchen_changes','read_kitchen_acknowledgements','recover_kitchen_tap',
    'request_device_pairing','read_device_pairing','read_device_signin','read_device_session','end_device_session','reset_device_signins','begin_staff_pin','finish_staff_pin'].includes(name))throw Error('Unexpected fixture RPC');
  const body=JSON.parse(init!.body as string),keys=Object.keys(body);if(keys.some(key=>!/^p_[a-z_]+$/.test(key)))throw Error('Invalid named RPC');
  try{const data=await f.asRole(null,'service_role',`select public.${name}(${keys.map((key,i)=>key+'=> $'+(i+1)).join(',')}) data`,Object.values(body).map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v));return Response.json(data);}
  catch(error){const code=(error as {code?:string}).code;return new Response('{}',{status:code==='PT409'?409:code==='PT429'?429:503});}
 };
 const actions=createKitchenActionsHandler({origins,store:createKitchenActionsStore('https://rpc.test','sb_secret_test_only',rpc)});
 const tickets=createKitchenTicketsHandler({origins,store:createKitchenTicketsStore('https://rpc.test','sb_secret_test_only',rpc)});
 const recovery=createKitchenRecoveryHandler({origins,store:createKitchenRecoveryStore('https://rpc.test','sb_secret_test_only',rpc)});
 const access=createDeviceAccessHandler({origins,store:createDeviceAccessStore('https://rpc.test','sb_secret_test_only',rpc)});
 const pin=createDevicePinHandler({origins,peppers:new Map([['v1',f.pepper]]),store:createDevicePinStore('https://rpc.test','sb_secret_test_only',rpc)});
 let apiUrl='',lose=false,loseAll=false,loseClose=false,actionCalls=0,recoveryCalls=0;const actionOrigins:string[]=[];
 let nextRecovery:{entered:()=>void;gate:Promise<void>}|null=null;const releases=new Set<()=>void>();
 const server=createServer(async(req,res)=>{
  const cors={'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization,apikey,content-type','Access-Control-Allow-Methods':'POST,OPTIONS','Cache-Control':'no-store'};
  try{
   if(req.method==='OPTIONS'){res.writeHead(204,cors).end();return;}
   const chunks:Buffer[]=[];for await(const part of req)chunks.push(Buffer.from(part));
   const headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);
   const controller=new AbortController();res.on('close',()=>controller.abort());
   const request=new Request(apiUrl+req.url,{method:req.method,headers,body:Buffer.concat(chunks),signal:controller.signal});
   const mutation=req.url==='/functions/v1/kitchen-actions',recovering=req.url==='/functions/v1/kitchen-recovery';if(mutation){actionCalls++;actionOrigins.push(JSON.parse(Buffer.concat(chunks).toString()).sessionToken===currentScreen?.session.token?'original':'later');}if(recovering)recoveryCalls++;
   const response=mutation?await actions(request):recovering?await recovery(request):req.url==='/functions/v1/device-access'?await access(request):req.url==='/functions/v1/device-pin'?await pin(request):req.url==='/functions/v1/kitchen-tickets'?await tickets(request):req.url==='/functions/v1/kitchen-live'?await live(request):new Response('{}',{status:404});
   if(recovering&&response.ok&&nextRecovery){const held=nextRecovery;nextRecovery=null;held.entered();await held.gate;}
   if(response.ok&&response.headers.get('content-type')?.startsWith('text/event-stream')){
    const out=new Headers(cors);for(const [key,value]of response.headers)out.set(key,value);res.writeHead(response.status,Object.fromEntries(out));res.flushHeaders();const reader=response.body!.getReader();controller.signal.addEventListener('abort',()=>void reader.cancel().catch(()=>{}),{once:true});try{for(;;){const part=await reader.read();if(part.done)break;if(!res.write(part.value))await once(res,'drain',{signal:controller.signal});}}finally{reader.releaseLock();res.end();}return;
   }
   const bytes=Buffer.from(await response.arrayBuffer()),out=new Headers(cors);for(const [key,value]of response.headers)out.set(key,value);out.set('Content-Length',String(bytes.length));
   const closeReply=recovering&&loseClose&&response.ok&&JSON.parse(Buffer.concat(chunks).toString()).action==='close';
   const drop=mutation&&(lose||loseAll)&&response.ok||closeReply;if(drop){if(closeReply)loseClose=false;else lose=false;out.set('Connection','close');}
   res.writeHead(response.status,Object.fromEntries(out)).end(drop?bytes.subarray(0,2):bytes);
  }catch{if(res.headersSent||res.destroyed)res.destroy();else res.writeHead(503,{...cors,'Content-Type':'application/json'}).end('{}');}
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');apiUrl='http://127.0.0.1:'+(server.address() as {port:number}).port;
 let orderId='',currentScreen:Extract<ScreenState,{phase:'signed-in'}>|undefined;
 async function addOrder(sequence=2041){
  const original=orderFixture('corner_shop'),at=Date.now(),seed=original.context.setup;
  const setup={business:{...seed.business,id:deviceId(1)},outlet:{...seed.outlet,id:deviceId(11),businessId:deviceId(1)},owner:{...seed.owner,id:deviceId(101),businessId:deviceId(1),outletIds:[deviceId(11)]}};
  const made=saveOrderCommand({...original.input,sourceText:'PRIVATE MESSAGE',name:'PRIVATE CUSTOMER',phone:'+14155550199',address:'PRIVATE ADDRESS',type:'delivery',lines:original.input.lines.map(line=>({...line,name:'চিকেন বিরিয়ানি',note:'Less spice'}))},{...original.context,setup,sequence},null,0,at-3000);
  let order=made.order;const events=[made.event];
  while(order.status!=='accepted'){const change=changeOrderStatusCommand(order,nextOrderStatuses(order)[0],setup,order.revision,at-2000+events.length);order=change.order;events.push(change.event);}
  await f.db.transaction(async tx=>{for(const record of [...events.map(event=>encodeCommandRecord('events',event,deviceId(1))),encodeCommandRecord('orders',order,deviceId(1))]){const keys=Object.keys(record.values);await tx.query(`insert into public.${record.table}(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(record.values));}});
  return order;
 }
 async function prepare(){
   for(const release of releases)release();nextRecovery=null;
   await f.seed();actionCalls=0;recoveryCalls=0;actionOrigins.length=0;lose=false;loseAll=false;loseClose=false;broadcasts=0;
   await f.db.query("update public.members set permissions=permissions||'{\"orders.acknowledge\":true}' where id=$1",[deviceId(104)]);
   const raw=await f.asRole<SharedDevice&{token:string}>(1,'authenticated','select public.enrol_device($1,$2,$3,$4,$5) data',[newKitchenId(),newKitchenId(),deviceId(11),'Kitchen test screen','kitchen']);
   const {token,...device}=raw;
   const attempt=await f.asRole<{attemptId:string;salt:string}>(null,'service_role','select public.begin_staff_pin($1,$2,$3) data',[newKitchenId(),token,deviceId(105)]);
   const proof=await deriveStaffPin('0042',attempt.salt,{businessId:deviceId(1),memberId:deviceId(105)},f.pepper);
   const session=await f.asRole<StaffDeviceSession>(null,'service_role','select public.finish_staff_pin($1,$2,$3,$4,$5) data',[token,attempt.attemptId,proof,newKitchenId(),newKitchenId()]);
   orderId=(await addOrder()).id;
   const screen:Extract<ScreenState,{phase:'signed-in'}>={phase:'signed-in',credential:{v:1,connection:{apiUrl,publishableKey:'sb_publishable_test_only'},device,token},outletNameJson:JSON.stringify('Outlet 11'),attemptId:attempt.attemptId,session};currentScreen=screen;
   return {screen,orderId};
 }
 async function prepareBoard(){
  const result=await prepare();
  const second=await addOrder(2042),third=await addOrder(2043);await addOrder(2044);
  const apply=async(id:string,kind:'kitchen.acknowledge'|'kitchen.ready',parent:string|null=null)=>{
   const raw=(await f.db.query<Record<string,unknown>>('select * from public.orders where id=$1',[id])).rows[0],order=decodeCommandRecord('orders',raw) as unknown as Order;
   const action=await prepareKitchenAction(order,kind,parent),response=await actions(new Request(apiUrl+'/functions/v1/kitchen-actions',{method:'POST',headers:{origin,Authorization:'Bearer '+currentScreen!.credential.token,'Content-Type':'application/json'},body:JSON.stringify({sessionToken:currentScreen!.session.token,action})}));
   if(!response.ok)throw Error('Could not prepare the actual kitchen visual state.');return await response.json() as KitchenReceipt;
  };
  await apply(second.id,'kitchen.acknowledge');const ack=await apply(third.id,'kitchen.acknowledge');await apply(third.id,'kitchen.ready',ack.id);
  return result;
 }
 return {
  prepare,
  prepareBoard,
  loseNext(){lose=true;},
  loseOriginalReplies(){loseAll=true;},
  loseNextClose(){loseClose=true;},
  holdNextRecovery(){let entered!:()=>void,finish!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{finish=resolve;});const release=()=>{finish();releases.delete(release);};releases.add(release);nextRecovery={entered,gate};return {started,release};},
  async readyFromAnotherScreen(){
   if(!currentScreen)throw Error('Prepare the synthetic screen first.');
   const row=(await f.db.query<Record<string,unknown>>('select * from public.orders where id=$1',[orderId])).rows[0],order=decodeCommandRecord('orders',row) as unknown as Order;
   const ack=(await f.db.query<{receipt:KitchenReceipt}>("select receipt from private.kitchen_action_receipts where order_id=$1 and action->>'type'='kitchen.acknowledge' order by accepted_at desc,id desc limit 1",[orderId])).rows[0]?.receipt;
   if(!ack)throw Error('A real acknowledgement is required.');const action=await prepareKitchenAction(order,'kitchen.ready',ack.id);
   const response=await fetch(apiUrl+'/functions/v1/kitchen-actions',{method:'POST',headers:{origin,Authorization:'Bearer '+currentScreen.credential.token,'Content-Type':'application/json'},body:JSON.stringify({sessionToken:currentScreen.session.token,action})});
   if(!response.ok)throw Error('The other screen did not prepare this order.');return await response.json() as KitchenReceipt;
  },
  async undoLastStatus(){
   const raw=(await f.db.query<Record<string,unknown>>('select * from public.orders where id=$1',[orderId])).rows[0],order=decodeCommandRecord('orders',raw) as unknown as Order;
   const eventRow=(await f.db.query<Record<string,unknown>>('select * from public.events where id=$1',[order.statusEventId])).rows[0],event=decodeCommandRecord('events',eventRow) as unknown as AuditEvent;
   const seed=orderFixture('corner_shop').context.setup,setup={business:{...seed.business,id:deviceId(1)},outlet:{...seed.outlet,id:deviceId(11),businessId:deviceId(1)},owner:{...seed.owner,id:deviceId(101),businessId:deviceId(1),outletIds:[deviceId(11)]}};
   const result=undoOrderStatusCommand(order,event,setup,order.revision),record=encodeCommandRecord('orders',result.order,deviceId(1)),audit=encodeCommandRecord('events',result.event,deviceId(1));
   await f.db.transaction(async tx=>{const keys=Object.keys(audit.values);await tx.query(`insert into public.events(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(audit.values));const changes=Object.entries(record.values).filter(([key])=>key!=='id');await tx.query(`update public.orders set ${changes.map(([key],i)=>key+'=$'+(i+1)).join(',')} where id=$${changes.length+1}`,[...changes.map(([,value])=>value),order.id]);});
  },
  addOrder,
  liveCounts(){return {connections:subscriptions.size,broadcasts};},
  async inspect(){const raw=(await f.db.query<Record<string,unknown>>('select * from public.orders where id=$1',[orderId])).rows[0];const order=decodeCommandRecord('orders',raw);return {status:order.status,payment:order.payment,total:order.total,actionCalls,actionOrigins:[...actionOrigins],recoveryCalls,receipts:(await f.db.query<{n:number}>('select count(*)::int n from private.kitchen_action_receipts')).rows[0].n,
    closures:(await f.db.query<{n:number}>('select count(*)::int n from private.kitchen_tap_closures')).rows[0].n};},
  async close(){for(const release of releases)release();await unlisten();for(const socket of broker.clients)socket.terminate();server.closeAllConnections();await new Promise<void>(resolve=>broker.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));await f.db.close();},
 };
}
