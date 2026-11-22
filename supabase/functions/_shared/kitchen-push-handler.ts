import {AuthBodyError,readAuthBody} from './auth-http.ts';
import {isDeviceId,isDeviceToken} from '../../../packages/core/device-access.ts';
import {newKitchenId} from '../../../packages/core/kitchen.ts';
import {parseDeskPushSubscription,parseKitchenPushNotice} from '../../../packages/core/desk-push.ts';
export interface KitchenPushJob {taskId:string;generation:number;subscriptionId:string}
export interface KitchenPushStore {
 prepare(applicationKey:string,limit:number):Promise<unknown>;
 claim(job:KitchenPushJob,lease:string,applicationKey:string):Promise<unknown>;
 finish(job:KitchenPushJob,lease:string,outcome:'sent'|'expired'|'retry'):Promise<unknown>;
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const unavailable=()=>Error('Desk notifications are unavailable.');
function parseJob(value:unknown):KitchenPushJob {
 if(!object(value)||!exact(value,'taskId,generation,subscriptionId')||!isDeviceId(value.taskId)||!isDeviceId(value.subscriptionId)||
  typeof value.generation!=='number'||!Number.isSafeInteger(value.generation)||value.generation<1)throw unavailable();
 return {taskId:value.taskId,generation:value.generation,subscriptionId:value.subscriptionId};
}
/** Scheduled transport, not a public user-selected recipient/message API. SQL
 * supplies current original tasks/recipients and rechecks authorization at claim.
 * Responses contain counts; no endpoint, browser key or provider body is logged. */
export function createKitchenPushHandler(deps:{key:string;applicationKey:string;store:KitchenPushStore;
 send:(subscription:unknown,notice:unknown)=>Promise<'sent'|'expired'|'retry'>}){
 if(!isDeviceToken(deps.key)||!/^B[A-Za-z0-9_-]{86}$/.test(deps.applicationKey))throw unavailable();
 const expected=crypto.subtle.digest('SHA-256',new TextEncoder().encode(deps.key));
 return async(request:Request):Promise<Response>=>{
  const reply=(status:number,value:unknown)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','Pragma':'no-cache'}});
  if(request.headers.has('origin'))return reply(403,{error:'Use the internal notification scheduler.'});
  if(request.method!=='POST')return reply(405,{error:'Use POST.'});
  const key=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if(!key)return reply(401,{error:'Notification scheduler authorization is required.'});
  const a=new Uint8Array(await expected),b=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key)));
  let different=0;for(let i=0;i<a.length;i++)different|=a[i]^b[i];
  if(different)return reply(401,{error:'Notification scheduler authorization is required.'});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return reply(415,{error:'Use JSON.'});
  let limit=25;
  try{
   const input=await readAuthBody(request);
   if(!object(input)||Object.keys(input).some(k=>k!=='limit')||input.limit!==undefined&&(typeof input.limit!=='number'||!Number.isInteger(input.limit)||input.limit<1||input.limit>25))throw Error();
   limit=input.limit as number??25;
  }catch(error){return reply(error instanceof AuthBodyError?error.status:400,{error:'Use a bounded notification batch.'});}
  const until=Date.now()+10000;
  try{
   const raw=await deps.store.prepare(deps.applicationKey,limit);
   if(!object(raw)||!exact(raw,'v,at,jobs')||raw.v!==1||typeof raw.at!=='number'||!Number.isSafeInteger(raw.at)||raw.at<0||!Array.isArray(raw.jobs)||raw.jobs.length>limit)throw unavailable();
   const jobs=raw.jobs.map(parseJob),keys=jobs.map(x=>x.taskId+':'+x.generation+':'+x.subscriptionId);
   if(new Set(keys).size!==keys.length)throw unavailable();
   let position=0,processed=0,sent=0,expired=0,retried=0,skipped=0,failed=0;
   async function consume(){
    while(position<jobs.length&&Date.now()<until){
     const job=jobs[position++],lease=newKitchenId();
     try{
      const claim=await deps.store.claim(job,lease,deps.applicationKey);
      if(claim===null){skipped++;processed++;continue;}
      if(!object(claim)||!exact(claim,'v,leaseId,subscription,notice')||claim.v!==1||claim.leaseId!==lease)throw unavailable();
      const subscription=parseDeskPushSubscription(claim.subscription),notice=parseKitchenPushNotice(claim.notice);
      if(notice.taskId!==job.taskId||notice.generation!==job.generation||notice.subscriptionId!==job.subscriptionId)throw unavailable();
      const outcome=await deps.send(subscription,notice),result=await deps.store.finish(job,lease,outcome);
      if(!object(result)||!exact(result,'state')||!['stale','pending','sent','expired','failed','cancelled'].includes(result.state as string))throw unavailable();
      if(result.state==='stale'){skipped++;}
      else if(outcome==='sent'&&result.state==='sent')sent++;
      else if(outcome==='expired'&&result.state==='expired')expired++;
      else if(outcome==='retry'&&result.state==='pending')retried++;
      else if(result.state==='cancelled')skipped++;
      else if(result.state==='failed')failed++;
      else throw unavailable();
      processed++;
     }catch{failed++;processed++;}
    }
   }
   // At most four short HTTP deliveries in flight. Claims have server-owned
   // leases; anything not started within this tick stays ready for another one.
   await Promise.all(Array.from({length:Math.min(4,jobs.length)},()=>consume()));
   return reply(failed?503:200,{v:1,processed,sent,expired,retried,skipped,failed,remaining:jobs.length-position});
  }catch{return reply(503,{error:'Desk notifications are unconfirmed. Retry the saved work.'});}
 };
}

export function createKitchenPushStore(apiUrl:string,serviceKey:string,send:typeof fetch=fetch):KitchenPushStore {
 const root=new URL(apiUrl);
 if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname))||!/^sb_secret_[A-Za-z0-9_-]+$/.test(serviceKey))throw unavailable();
 async function rpc(route:string,body:Record<string,unknown>){
  const controller=new AbortController();let response:Response|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},5000);});
  try{
   response=await Promise.race([send(new URL('rest/v1/rpc/'+route,root),{method:'POST',redirect:'error',signal:controller.signal,
    headers:{apikey:serviceKey,'Content-Type':'application/json'},body:JSON.stringify(body)}),deadline]);
   if(!response.ok)throw unavailable();const reader=response.body?.getReader();if(!reader)throw unavailable();
   const chunks:Uint8Array[]=[];let length=0;
   try{for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;length+=part.value.byteLength;if(length>131072)throw unavailable();chunks.push(part.value);}}
   catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   const bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
   return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
  }finally{clearTimeout(timer);controller.abort();void response?.body?.cancel().catch(()=>{});}
 }
 const args=(job:KitchenPushJob)=>({p_task_id:job.taskId,p_generation:job.generation,p_subscription_id:job.subscriptionId});
 return {
  prepare:(key,limit)=>rpc('prepare_kitchen_push',{p_application_key:key,p_limit:limit}),
  claim:(job,lease,key)=>rpc('claim_kitchen_push',{...args(job),p_lease_id:lease,p_application_key:key}),
  finish:(job,lease,outcome)=>rpc('finish_kitchen_push',{...args(job),p_lease_id:lease,p_outcome:outcome}),
 };
}
