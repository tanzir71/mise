import {readAuthBody,AuthBodyError} from './auth-http.ts';
import {isDeviceId,isDeviceToken} from '../../../packages/core/device-access.ts';
import {newKitchenId} from '../../../packages/core/kitchen.ts';
import {evaluateKitchenAlarm,parseKitchenAlarmSettings} from '../../../packages/core/kitchen-alarms.ts';
import {projectKitchenTicketRow} from './kitchen-tickets-handler.ts';

export interface KitchenAlarmWork {
 businessId:string;outletId:string;orderId:string;version:number;stamp:string;contentHash:string|null;
 taskId:string;eventId:string;resolveEventId:string;
}
export interface KitchenAlarmsStore {prepare(limit:number):Promise<unknown>;finish(work:KitchenAlarmWork):Promise<unknown>}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const unavailable=()=>Error('Kitchen alarms are unavailable.');
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;

/** Called only by the authenticated scheduler. No request supplies a shop,
 * order, clock, acknowledgement, task outcome or notification recipient. */
export function createKitchenAlarmsHandler(deps:{key:string;store:KitchenAlarmsStore}) {
 if(!isDeviceToken(deps.key))throw unavailable();
 const expected=crypto.subtle.digest('SHA-256',new TextEncoder().encode(deps.key));
 return async(request:Request):Promise<Response>=>{
  const reply=(status:number,data:unknown)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','Pragma':'no-cache'}});
  if(request.headers.has('origin'))return reply(403,{error:'Use the internal alarm scheduler.'});
  if(request.method!=='POST')return reply(405,{error:'Use POST.'});
  const key=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if(!key)return reply(401,{error:'Alarm scheduler authorization is required.'});
  const a=new Uint8Array(await expected),b=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key)));
  let different=0;for(let i=0;i<a.length;i++)different|=a[i]^b[i];
  if(different)return reply(401,{error:'Alarm scheduler authorization is required.'});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return reply(415,{error:'Use JSON.'});
  let limit=25;
  try {
   const input=await readAuthBody(request);
   if(!object(input)||Object.keys(input).some(key=>key!=='limit')||input.limit!==undefined&&(typeof input.limit!=='number'||!Number.isInteger(input.limit)||input.limit<1||input.limit>50))throw Error();
   limit=input.limit as number??25;
  }catch(error){return reply(error instanceof AuthBodyError?error.status:400,{error:'Use a bounded alarm batch.'});}
  try {
   const raw=await deps.store.prepare(limit);
   if(!object(raw)||!exact(raw,'v,at,jobs')||raw.v!==1||!time(raw.at)||!Array.isArray(raw.jobs)||raw.jobs.length>limit)throw unavailable();
   let raised=0,failed=0,stale=0,processed=0;
   for(const job of raw.jobs) {
    try {
     if(!object(job)||!exact(job,'businessId,outletId,orderId,version,settings,source,stamp')||![job.businessId,job.outletId,job.orderId].every(isDeviceId)||
      typeof job.version!=='number'||!Number.isSafeInteger(job.version)||job.version<1||!hash(job.stamp))throw unavailable();
     const scope={businessId:job.businessId as string,outletId:job.outletId as string};
     const settings=parseKitchenAlarmSettings(job.settings);
     let contentHash:string|null=null;
     if(job.source!==null) {
      const ticket=await projectKitchenTicketRow(job.source,scope,raw.at);
      if(ticket.id!==job.orderId)throw unavailable();
      // Shared pure validation/timing; the final transaction independently
      // checks fresh settings, order bytes, clock and the actual current ACK.
      evaluateKitchenAlarm(ticket,settings,scope,raw.at);contentHash=ticket.contentHash;
     }
     const result=await deps.store.finish({...scope,orderId:job.orderId as string,version:job.version,stamp:job.stamp,contentHash,
      taskId:newKitchenId(),eventId:newKitchenId(),resolveEventId:newKitchenId()});
     if(!object(result)||!['stale','removed','disabled','cancelled','finished','acknowledged','waiting','due'].includes(result.state as string)||typeof result.raised!=='boolean'||
      result.raised&&result.state!=='due')throw unavailable();
     processed++;if(result.raised)raised++;if(result.state==='stale')stale++;
    }catch{failed++;}
   }
   // Counts only: private order data, task IDs and RPC errors never appear in
   // scheduler responses or logs. Failed jobs stay durable for the next tick.
   return reply(failed?503:200,{v:1,processed,raised,stale,failed});
  }catch{return reply(503,{error:'Kitchen alarms are unconfirmed. Retry the saved work.'});}
 };
}

export function createKitchenAlarmsStore(apiUrl:string,serviceKey:string,send:typeof fetch=fetch):KitchenAlarmsStore {
 const root=new URL(apiUrl);
 if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname))||!/^sb_secret_[A-Za-z0-9_-]+$/.test(serviceKey))throw unavailable();
 async function rpc(route:string,body:Record<string,unknown>) {
  const controller=new AbortController();let response:Response|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},5000);});
  try {
   response=await Promise.race([send(new URL('rest/v1/rpc/'+route,root),{method:'POST',redirect:'error',signal:controller.signal,
    headers:{apikey:serviceKey,'Content-Type':'application/json'},body:JSON.stringify(body)}),deadline]);
   if(!response.ok)throw unavailable();
   const reader=response.body?.getReader();if(!reader)throw unavailable();
   const chunks:Uint8Array[]=[];let length=0;
   try {for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;length+=part.value.byteLength;if(length>32*1024*1024)throw unavailable();chunks.push(part.value);}}
   catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
   return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
  }finally{clearTimeout(timer);controller.abort();void response?.body?.cancel().catch(()=>{});}
 }
 return {
  prepare:limit=>rpc('prepare_kitchen_alarms',{p_limit:limit}),
  finish:work=>rpc('finish_kitchen_alarm',{p_business_id:work.businessId,p_outlet_id:work.outletId,p_order_id:work.orderId,p_version:work.version,
   p_stamp:work.stamp,p_content_hash:work.contentHash,p_task_id:work.taskId,p_event_id:work.eventId,p_resolve_event_id:work.resolveEventId}),
 };
}
