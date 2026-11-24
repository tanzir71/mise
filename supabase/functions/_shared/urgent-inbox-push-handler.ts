import {AuthBodyError,readAuthBody} from './auth-http.ts';
import {isDeviceId,isDeviceToken} from '../../../packages/core/device-access.ts';
import {newKitchenId} from '../../../packages/core/kitchen.ts';
import {parseDeskPushSubscription} from '../../../packages/core/desk-push.ts';
import {parseUrgentInboxNotice} from '../../../packages/core/urgent-inbox.ts';
import {createUrgentInboxAuthorization} from './urgent-inbox-authorization.ts';
export interface UrgentInboxJob {taskId:string;generation:number;consentId:string;subscriptionId:string}
export interface UrgentInboxPushStore {
 claimDispatch(nonce:string,issuedAt:number,limit:number):Promise<unknown>;
 prepare(key:string,limit:number):Promise<unknown>;
 claim(job:UrgentInboxJob,lease:string,key:string):Promise<unknown>;
 finish(job:UrgentInboxJob,lease:string,outcome:'sent'|'expired'|'retry'):Promise<unknown>;
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const unavailable=()=>Error('Urgent Inbox notifications are unavailable.');
function parseJob(v:unknown):UrgentInboxJob {
 if(!object(v)||!exact(v,'taskId,generation,consentId,subscriptionId')||![v.taskId,v.consentId,v.subscriptionId].every(isDeviceId)||typeof v.generation!=='number'||!Number.isSafeInteger(v.generation)||v.generation<1)throw unavailable();
 return {taskId:v.taskId as string,generation:v.generation,consentId:v.consentId as string,subscriptionId:v.subscriptionId as string};
}
/** No caller chooses a recipient or message. SQL supplies actual current jobs;
 * the dedicated installation-owned key authorizes only bounded worker ticks. */
export function createUrgentInboxPushHandler(deps:{key:string;applicationKey:string;store:UrgentInboxPushStore;send:(subscription:unknown,notice:unknown)=>Promise<'sent'|'expired'|'retry'>;now?:()=>number}) {
 if(!isDeviceToken(deps.key)||!/^B[A-Za-z0-9_-]{86}$/.test(deps.applicationKey))throw unavailable();
 const authorize=createUrgentInboxAuthorization(deps.key),now=deps.now??Date.now;
 return async(request:Request):Promise<Response>=>{
  const reply=(status:number,value:unknown)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','Pragma':'no-cache'}});
  if(request.headers.has('origin'))return reply(403,{error:'Use the internal urgent notification worker.'});
  if(request.method!=='POST')return reply(405,{error:'Use POST.'});
  const authorization=request.headers.get('authorization');if(!authorization?.startsWith('Bearer v1.'))return reply(401,{error:'Worker authorization is required.'});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return reply(415,{error:'Use JSON.'});
  let limit=25;
  try{const input=await readAuthBody(request,1024);if(!object(input)||Object.keys(input).some(k=>k!=='limit')||input.limit!==undefined&&(typeof input.limit!=='number'||!Number.isInteger(input.limit)||input.limit<1||input.limit>25))throw unavailable();limit=input.limit as number??25;}
  catch(error){return reply(error instanceof AuthBodyError?error.status:400,{error:'Use a bounded urgent notification batch.'});}
  const permit=await authorize(authorization,limit,now());if(!permit)return reply(401,{error:'Worker authorization is required.'});
  try{if(await deps.store.claimDispatch(permit.nonce,permit.issuedAt,permit.limit)!==true)return reply(409,{error:'Use a current unused worker request.'});}
  catch{return reply(503,{error:'Worker authorization is unconfirmed.'});}
  const until=now()+4000;
  try{
   const raw=await deps.store.prepare(deps.applicationKey,limit);
   if(!object(raw)||!exact(raw,'v,at,jobs')||raw.v!==1||typeof raw.at!=='number'||!Number.isSafeInteger(raw.at)||raw.at<0||!Array.isArray(raw.jobs)||raw.jobs.length>limit)throw unavailable();
   const jobs=raw.jobs.map(parseJob),identities=jobs.map(j=>j.taskId+':'+j.generation+':'+j.consentId);if(new Set(identities).size!==identities.length)throw unavailable();
   let cursor=0,processed=0,sent=0,expired=0,retried=0,skipped=0,failed=0;
   async function consume(){while(cursor<jobs.length&&now()<until){const job=jobs[cursor++],lease=newKitchenId();try{
    const raw=await deps.store.claim(job,lease,deps.applicationKey);if(raw===null){skipped++;processed++;continue;}
    if(!object(raw)||!exact(raw,'v,leaseId,subscription,notice')||raw.v!==1||raw.leaseId!==lease)throw unavailable();
    const notice=parseUrgentInboxNotice(raw.notice),subscription=parseDeskPushSubscription(raw.subscription);
    if(notice.taskId!==job.taskId||notice.generation!==job.generation||notice.consentId!==job.consentId||notice.subscriptionId!==job.subscriptionId)throw unavailable();
    // A late claim remains leased for recovery. Do not begin a provider request
    // outside this tick's bounded admission window.
    if(now()>=until){skipped++;processed++;continue;}
    const outcome=await deps.send(subscription,notice),result=await deps.store.finish(job,lease,outcome);
    if(!object(result)||!exact(result,'state')||!['stale','pending','sent','expired','cancelled','failed'].includes(result.state as string))throw unavailable();
    if(result.state==='stale'||result.state==='cancelled')skipped++;else if(result.state==='sent'&&outcome==='sent')sent++;else if(result.state==='expired'&&outcome==='expired')expired++;else if(result.state==='pending'&&outcome==='retry')retried++;else if(result.state==='failed')failed++;else throw unavailable();
    processed++;
   }catch{failed++;processed++;}}}
   await Promise.all(Array.from({length:Math.min(4,jobs.length)},()=>consume()));
   return reply(failed?503:200,{v:1,processed,sent,expired,retried,skipped,failed,remaining:jobs.length-cursor});
  }catch{return reply(503,{error:'Urgent notification work is unconfirmed. Keep its original queue.'});}
 };
}
export function createUrgentInboxPushStore(apiUrl:string,serviceKey:string,send:typeof fetch=fetch):UrgentInboxPushStore {
 const root=new URL(apiUrl);
 if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname))||!/^sb_secret_[A-Za-z0-9_-]+$/.test(serviceKey))throw unavailable();
 async function rpc(route:string,body:Record<string,unknown>){
  const controller=new AbortController();let response:Response|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},1500);});
  try{
   response=await Promise.race([send(new URL('rest/v1/rpc/'+route,root),{method:'POST',redirect:'error',signal:controller.signal,headers:{apikey:serviceKey,'Content-Type':'application/json'},body:JSON.stringify(body)}),deadline]);
   if(!response.ok)throw unavailable();const reader=response.body?.getReader();if(!reader)throw unavailable();const chunks:Uint8Array[]=[];let length=0;
   try{for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;length+=part.value.byteLength;if(length>65536)throw unavailable();chunks.push(part.value);}}catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   const bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
  }finally{clearTimeout(timer);controller.abort();void response?.body?.cancel().catch(()=>{});}
 }
 const args=(j:UrgentInboxJob)=>({p_task_id:j.taskId,p_generation:j.generation,p_consent_id:j.consentId,p_subscription_id:j.subscriptionId});
 return {claimDispatch:(nonce,issuedAt,limit)=>rpc('claim_urgent_inbox_dispatch',{p_nonce:nonce,p_issued_at:issuedAt,p_limit:limit}),prepare:(key,limit)=>rpc('prepare_urgent_inbox_push',{p_application_key:key,p_limit:limit}),claim:(j,lease,key)=>rpc('claim_urgent_inbox_push',{...args(j),p_lease_id:lease,p_application_key:key}),finish:(j,lease,outcome)=>rpc('finish_urgent_inbox_push',{...args(j),p_lease_id:lease,p_outcome:outcome})};
}
