import {AuthBodyError,readAuthBody} from './auth-http.ts';
import {isDeviceToken} from '../../../packages/core/device-access.ts';
import {parseDeskApplicationKey} from '../../../packages/core/desk-push.ts';
import {createKitchenAlarmsHandler,type KitchenAlarmsStore} from './kitchen-alarms-handler.ts';
import {createKitchenPushHandler,type KitchenPushStore} from './kitchen-push-handler.ts';
import {createKitchenDispatchAuthorization} from './kitchen-dispatch-auth.ts';

interface AlarmCounts {processed:number;raised:number;stale:number;failed:number;remaining:number}
interface PushCounts {processed:number;sent:number;expired:number;retried:number;skipped:number;failed:number;remaining:number}
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const count=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
function counts<T>(value:unknown,keys:string):T {
 if(!object(value)||value.v!==1||Object.keys(value).sort().join(',')!==('v,'+keys).split(',').sort().join(',')||keys.split(',').some(key=>!count(value[key])))throw Error('Dispatch result unconfirmed');
 return Object.fromEntries(keys.split(',').map(key=>[key,value[key]])) as T;
}
/** One authenticated invocation coordinates actual alarm inspection and its
 * delivery wake-ups. No request chooses an order, scope, clock or recipient. */
export function createKitchenDispatchHandler(deps:{key:string;applicationKey:string;alarms:KitchenAlarmsStore;push:KitchenPushStore;send:(subscription:unknown,notice:unknown)=>Promise<'sent'|'expired'|'retry'>}){
 if(!isDeviceToken(deps.key)||typeof deps.alarms.defer!=='function'||typeof deps.alarms.claimDispatch!=='function')throw Error('Kitchen dispatch unavailable');
 parseDeskApplicationKey(deps.applicationKey);const authorize=createKitchenDispatchAuthorization(deps.key);
 return async(request:Request):Promise<Response>=>{
  const reply=(status:number,value:unknown)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','Pragma':'no-cache'}});
  if(request.headers.has('origin'))return reply(403,{error:'Use the internal kitchen scheduler.'});
  if(request.method!=='POST')return reply(405,{error:'Use POST.'});
  const authorization=request.headers.get('authorization');if(!authorization?.startsWith('Bearer v1.'))return reply(401,{error:'Kitchen scheduler authorization is required.'});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return reply(415,{error:'Use JSON.'});
  let limit=25;try{const input=await readAuthBody(request,512);if(!object(input)||Object.keys(input).some(name=>name!=='limit')||input.limit!==undefined&&(!count(input.limit)||input.limit<1||input.limit>25))throw Error();limit=input.limit as number??25;}catch(problem){return reply(problem instanceof AuthBodyError?problem.status:400,{error:'Use a bounded kitchen batch.'});}
  const permit=await authorize(authorization,limit);if(!permit)return reply(401,{error:'Kitchen scheduler authorization is required.'});
  try{if(await deps.alarms.claimDispatch!(permit.nonce,permit.issuedAt,permit.limit)!==true)return reply(409,{error:'Use a current unused scheduler request.'});}
  catch{return reply(503,{error:'Kitchen dispatch authorization is unconfirmed.'});}
  const deadline=Date.now()+10000,push:PushCounts={processed:0,sent:0,expired:0,retried:0,skipped:0,failed:0,remaining:0};let running:Promise<void>|null=null,again=false,unconfirmedBatches=0;
  const internal=()=>new Request('https://scheduler.invalid/internal',{method:'POST',headers:{Authorization:'Bearer '+deps.key,'Content-Type':'application/json'},body:JSON.stringify({limit})});
  const deliver=createKitchenPushHandler({key:deps.key,applicationKey:deps.applicationKey,store:deps.push,send:deps.send,deadline});
  function wake():Promise<void>{
   again=true;if(running)return running;
   running=(async()=>{do{again=false;if(Date.now()>=deadline)return;try{
    const response=await deliver(internal()),result=counts<PushCounts>(await response.json(),'processed,sent,expired,retried,skipped,failed,remaining');
    if(result.processed+result.remaining>limit||result.sent+result.expired+result.retried+result.skipped+result.failed!==result.processed)throw Error();
    for(const key of ['processed','sent','expired','retried','skipped','failed'] as const)push[key]+=result[key];push.remaining=result.remaining;
   }catch{unconfirmedBatches++;} }while(again&&Date.now()<deadline);})().finally(()=>{running=null;if(again&&Date.now()<deadline)void wake();});return running;
  }
  const inspect=createKitchenAlarmsHandler({key:deps.key,store:deps.alarms,run:{deadline,deferFailures:true,onSettled:()=>{void wake();}}});
  try{
   // Existing ready deliveries can proceed while independent orders are being
   // inspected. Each successful inspection wakes the same single-flight pump.
   void wake();const response=await inspect(internal()),alarms=counts<AlarmCounts>(await response.json(),'processed,raised,stale,failed,remaining');
   if(alarms.processed+alarms.failed+alarms.remaining>limit||alarms.raised+alarms.stale>alarms.processed)throw Error();
   await wake();while(running)await running;return reply(response.ok&&push.failed===0&&unconfirmedBatches===0?200:503,{v:1,alarms,push,unconfirmedBatches});
  }catch{while(running)await running;return reply(503,{error:'Kitchen dispatch is unconfirmed. Durable work remains available.'});}
 };
}
