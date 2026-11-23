import {newInboxId} from '@mise/core/inbox';
import {parseAttendanceIntent,type CheckInType,type AttendanceIntent} from '@mise/core/staff-attendance';
import {customerApiOrigin} from '@mise/core/customer-link-url';
import {parseStaffPublicOutcome,parseStaffView,staffToken,type StaffViewerLink,type StaffView,type StaffHistoryCursor,type StaffPublicOutcome} from '@mise/core/staff-links';
import type {KeyStorage} from '@mise/core/cloud-connection';
export class StaffVisitError extends Error {
 constructor(readonly kind:'missing'|'limited'|'changed'|'unavailable',readonly retryAfter=0){super(kind==='missing'?'This staff link is unavailable. Tell the manager by hand.':kind==='limited'?'Wait a moment, then check this original again.':kind==='changed'?'Presence or the original changed. Keep this choice and review it before another tap.':'The check-in is unconfirmed. Keep the original or tell the manager by hand.');}
}
export interface SavedStaffCheckIn {intent:AttendanceIntent;name:string;nameLocal:string;language:'en'|'bn';closeRequested:boolean;outcome:StaffPublicOutcome|null}
interface Journal {v:1;view:StaffView|null;actions:SavedStaffCheckIn[]}
const bad=()=>new StaffVisitError('changed'),maximum=8*1024*1024,bytes=(value:string)=>new TextEncoder().encode(value).byteLength;
export async function createStaffPublicSession(source:StaffViewerLink,deps:{storage:KeyStorage;locks?:Pick<LockManager,'request'>;send?:typeof fetch}){
 const apiUrl=customerApiOrigin(source.apiUrl);if(source.v!==1||!staffToken(source.token))throw bad();
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(apiUrl+'\n'+source.token))),b=>b.toString(16).padStart(2,'0')).join('');
 const key='mise.staff-public.v1:'+digest;let active=true,storageReady=true,latestView:StaffView|null=null;
 const current=()=>{if(!active)throw bad();};
 function saved():Journal {
  try{const raw=deps.storage.getItem(key);if(raw===null)return {v:1,view:null,actions:[]};if(bytes(raw)>maximum)throw bad();const value=JSON.parse(raw);
   if(!value||Object.keys(value).sort().join(',')!=='actions,v,view'||value.v!==1||!Array.isArray(value.actions)||value.actions.length>200)throw bad();
   const view=value.view===null?null:parseStaffView(value.view,null);
   const actions:SavedStaffCheckIn[]=value.actions.map((v:unknown)=>{if(!v||typeof v!=='object'||Object.keys(v).sort().join(',')!=='closeRequested,intent,language,name,nameLocal,outcome')throw bad();const row=v as Record<string,unknown>,intent=parseAttendanceIntent(row.intent);
    if(typeof row.name!=='string'||row.name.length>160||typeof row.nameLocal!=='string'||row.nameLocal.length>160||!['en','bn'].includes(row.language as string)||typeof row.closeRequested!=='boolean'||view&&(intent.memberId!==view.memberId||intent.outletId!==view.outletId))throw bad();
    return {intent,name:row.name,nameLocal:row.nameLocal,language:row.language as 'en'|'bn',closeRequested:row.closeRequested,outcome:row.outcome===null?null:parseStaffPublicOutcome(row.outcome,intent)};
   });
   if(new Set(actions.map(row=>row.intent.id)).size!==actions.length||actions.slice(0,-1).some(row=>!row.outcome||row.outcome.state==='pending')||actions.some(row=>row.intent.memberId!==actions[0].intent.memberId||row.intent.outletId!==actions[0].intent.outletId))throw bad();
   return {v:1,view,actions};
  }catch{throw bad();}
 }
 const exclusive=<T>(run:()=>Promise<T>)=>{const locks=deps.locks??globalThis.navigator?.locks;if(!locks)throw bad();return locks.request(key,{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock)throw new StaffVisitError('unavailable');current();return run();});};
 function persist(before:Journal,next:Journal){current();const raw=JSON.stringify(next);if(bytes(raw)>maximum||JSON.stringify(saved())!==JSON.stringify(before))throw bad();
  try{deps.storage.setItem(key,raw);if(deps.storage.getItem(key)!==raw)throw bad();}catch{throw bad();}current();
 }
 async function request(operation:'read'|'submit'|'inspect'|'close',intent:AttendanceIntent|null,after:StaffHistoryCursor|null=null,signal?:AbortSignal):Promise<unknown>{
  current();const controller=new AbortController(),lifetime=signal?AbortSignal.any([signal,controller.signal]):controller.signal;let timer:ReturnType<typeof setTimeout>|undefined,response:Response|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new StaffVisitError('unavailable'));},20000);});
  try{
   response=await Promise.race([(deps.send??fetch)(new URL('functions/v1/public/staff',apiUrl+'/'),{method:'POST',body:JSON.stringify({token:source.token,operation,intent,after}),
    headers:{'Content-Type':'application/json'},credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:lifetime}),deadline]);current();
   if(response.status===404)throw new StaffVisitError('missing');if(response.status===409)throw bad();
   if(response.status===429){const raw=response.headers.get('Retry-After');throw new StaffVisitError('limited',raw&&/^\d+$/.test(raw)&&Number(raw)>=1&&Number(raw)<=60?Number(raw):60);}
   if(!response.ok)throw new StaffVisitError('unavailable');const declared=response.headers.get('Content-Length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>2097152))throw bad();
   const reader=response.body?.getReader();if(!reader)throw bad();const chunks:Uint8Array[]=[];let length=0;
   try{for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;length+=part.value.byteLength;if(length>2097152)throw bad();chunks.push(part.value);}}
   catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   current();if(lifetime.aborted)throw new StaffVisitError('unavailable');const data=new Uint8Array(length);let offset=0;for(const part of chunks){data.set(part,offset);offset+=part.length;}
   return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
  }catch(error){if(error instanceof StaffVisitError)throw error;throw new StaffVisitError('unavailable');}
  finally{clearTimeout(timer);controller.abort();void response?.body?.cancel().catch(()=>{});}
 }
 async function read(after:StaffHistoryCursor|null=null,signal?:AbortSignal){const raw=await request('read',null,after,signal);current();
  if(!raw||typeof raw!=='object'||Object.keys(raw).sort().join(',')!=='state,v,view'||(raw as Record<string,unknown>).v!==1||(raw as Record<string,unknown>).state!=='view')throw bad();
  const view=parseStaffView((raw as Record<string,unknown>).view,after);
  if(latestView&&(view.memberId!==latestView.memberId||view.outletId!==latestView.outletId))throw bad();
  if(after===null){
   if(latestView&&(view.memberId!==latestView.memberId||view.outletId!==latestView.outletId))throw bad();
   if(!latestView||latestView.serverAt<=view.serverAt)latestView=view;
   // A read remains usable for manual copy when native storage/locks fail.
   // Every actual tap still requires a complete original and readback first.
   try{await exclusive(async()=>{const before=saved();if(before.view&&(view.memberId!==before.view.memberId||view.outletId!==before.view.outletId)||before.actions.some(row=>row.intent.memberId!==view.memberId||row.intent.outletId!==view.outletId))throw bad();
    if(before.view&&before.view.serverAt>view.serverAt)return;persist(before,{...before,view});});storageReady=true;}catch{storageReady=false;}
  }return view;
 }
 async function prepare(view:StaffView,type:CheckInType,occurredAt=Date.now()){return exclusive(async()=>{
  const before=saved(),currentView=parseStaffView(view,null),known=latestView??before.view;if(!known||known.memberId!==view.memberId||known.outletId!==view.outletId||JSON.stringify(known.latest)!==JSON.stringify(currentView.latest)||
   before.actions.length>=200||before.actions.some(row=>!row.outcome||row.outcome.state==='pending'))throw bad();
  const state=currentView.latest?.type??'out';if(state===type||type==='break'&&state!=='in')throw bad();
  const intent=parseAttendanceIntent({v:1,id:newInboxId(),eventId:newInboxId(),memberId:view.memberId,outletId:view.outletId,type,occurredAt,expectedLastId:view.latest?.id??null});
  persist(before,{...before,actions:[...before.actions,{intent,name:view.name,nameLocal:view.nameLocal,language:view.language,closeRequested:false,outcome:null}]});return intent;
 });}
 async function call(id:string,operation:'submit'|'inspect'|'close',signal?:AbortSignal){return exclusive(async()=>{
  let before=saved(),original=before.actions.at(-1);if(!original||original.intent.id!==id)throw bad();
  if(operation==='close'&&!original.closeRequested){const next=structuredClone(before);next.actions.at(-1)!.closeRequested=true;persist(before,next);before=next;original=next.actions.at(-1)!;}
  const effect=original.closeRequested&&operation==='submit'?'close':operation,outcome=parseStaffPublicOutcome(await request(effect,original.intent,null,signal),original.intent);current();
  if(original.outcome&&original.outcome.state!=='pending'&&JSON.stringify(original.outcome)!==JSON.stringify(outcome))throw bad();const next=structuredClone(before);next.actions.at(-1)!.outcome=outcome;persist(before,next);return outcome;
 });}
 return {key,saved,read,prepare,call,get storageReady(){return storageReady;},stop(){active=false;}};
}
export type StaffPublicSession=Awaited<ReturnType<typeof createStaffPublicSession>>;
