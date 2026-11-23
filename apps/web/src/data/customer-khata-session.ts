import {parseKhataIntent,parseKhataView,parseKhataOutcome,type KhataIntent,type KhataView,type KhataOutcome} from '@mise/core/customer-khata';
import {customerApiOrigin,type CustomerViewerLink} from '@mise/core/customer-link-url';
import {newInboxId} from '@mise/core/inbox';
import type {KeyStorage} from '@mise/core/cloud-connection';
export class KhataVisitError extends Error {constructor(readonly kind:'missing'|'limited'|'changed'|'unavailable',readonly retryAfter=0){super(kind==='missing'?'This khata link is unavailable. Ask the shop for a current link.':kind==='limited'?'Wait a moment before checking this original again.':kind==='changed'?'Keep this original request and check it before starting another.':'This request is unconfirmed. Keep the original or copy it for the shop.');}}
export interface KhataOriginal {intent:KhataIntent;closeRequested:boolean;outcome:KhataOutcome|null}
interface Journal {v:1;scope:string;actions:KhataOriginal[]}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const bad=()=>new KhataVisitError('changed'),bytes=(text:string)=>new TextEncoder().encode(text).length;
export async function createCustomerKhataSession(source:CustomerViewerLink,deps:{storage:KeyStorage;locks?:Pick<LockManager,'request'>;send?:typeof fetch}){
 const api=customerApiOrigin(source.apiUrl);if(source.v!==1||source.kind!=='khata'||!/^[A-Za-z0-9_-]{43}$/.test(source.token))throw bad();
 const scope=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(api+'\n'+source.token))),b=>b.toString(16).padStart(2,'0')).join(''),key='mise.customer-khata.v1:'+scope,controller=new AbortController();let active=true,storageReady=true,latest:KhataView|null=null;
 const current=()=>{if(!active)throw bad();};
 function saved():Journal {
  current();const raw=deps.storage.getItem(key);if(raw===null)return {v:1,scope,actions:[]};if(bytes(raw)>8388608)throw bad();const v:unknown=JSON.parse(raw);
  if(!object(v)||Object.keys(v).sort().join(',')!=='actions,scope,v'||v.v!==1||v.scope!==scope||!Array.isArray(v.actions)||v.actions.length>200)throw bad();
  const actions=v.actions.map(r=>{if(!object(r)||Object.keys(r).sort().join(',')!=='closeRequested,intent,outcome'||typeof r.closeRequested!=='boolean')throw bad();const intent=parseKhataIntent(r.intent);return {intent,closeRequested:r.closeRequested,outcome:r.outcome===null?null:parseKhataOutcome(r.outcome,intent)};});
  if(new Set(actions.map(r=>r.intent.id)).size!==actions.length||actions.slice(0,-1).some(r=>!r.outcome||r.outcome.state==='pending')||actions.some(r=>r.intent.linkId!==actions[0].intent.linkId||r.intent.accountId!==actions[0].intent.accountId))throw bad();return {v:1,scope,actions};
 }
 function persist(before:Journal,next:Journal){current();const text=JSON.stringify(next);if(bytes(text)>8388608||JSON.stringify(saved())!==JSON.stringify(before))throw bad();try{deps.storage.setItem(key,text);if(deps.storage.getItem(key)!==text)throw bad();}catch(e){storageReady=false;throw e;}current();}
 const exclusive=<T>(run:()=>Promise<T>)=>{const locks=deps.locks??globalThis.navigator?.locks;if(!locks)throw new KhataVisitError('unavailable');return locks.request(key,{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock)throw new KhataVisitError('unavailable');current();return run();});};
 try{saved();}catch{storageReady=false;}
 async function request(operation:'read'|'submit'|'inspect'|'close',intent:KhataIntent|null,after=0,signal?:AbortSignal){
  current();const timeout=new AbortController(),lifetime=AbortSignal.any([controller.signal,timeout.signal,...(signal?[signal]:[])]);let timer:ReturnType<typeof setTimeout>|undefined,response:Response|undefined;const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{timeout.abort();reject(new KhataVisitError('unavailable'));},20000);});
  try{
   response=await Promise.race([(deps.send??fetch)(new URL('functions/v1/public/khata',api+'/'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:source.token,operation,intent,after}),credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:lifetime}),deadline]);current();
   if(response.status===404){latest=null;throw new KhataVisitError('missing');}if(response.status===409)throw bad();if(response.status===429){const raw=response.headers.get('Retry-After');throw new KhataVisitError('limited',raw&&/^[1-9]\d?$/.test(raw)&&Number(raw)<=60?Number(raw):60);}if(!response.ok)throw new KhataVisitError('unavailable');
   const declared=response.headers.get('Content-Length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>8388608))throw bad();const reader=response.body?.getReader();if(!reader)throw bad();const chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;size+=part.value.length;if(size>8388608)throw bad();chunks.push(part.value);}}catch(e){void reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
   const data=new Uint8Array(size);let offset=0;for(const part of chunks){data.set(part,offset);offset+=part.length;}current();if(lifetime.aborted)throw bad();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
  }catch(e){if(e instanceof KhataVisitError)throw e;throw new KhataVisitError('unavailable');}finally{clearTimeout(timer);timeout.abort();void response?.body?.cancel().catch(()=>{});}
 }
 const knownEntries=new Set<string>();
 async function read(after=0,signal?:AbortSignal){try{const view=parseKhataView(await request('read',null,after,signal),after);current();let original:KhataIntent|undefined;try{original=saved().actions[0]?.intent;}catch{storageReady=false;}if(original&&(original.linkId!==view.linkId||original.accountId!==view.accountId)||latest&&(latest.linkId!==view.linkId||latest.accountId!==view.accountId))throw bad();for(const row of view.entries)knownEntries.add(row.id);latest=view;return view;}catch(e){latest=null;knownEntries.clear();throw e;}}
 async function prepare(kind:KhataIntent['kind'],entryId:string|null,message:string){return exclusive(async()=>{
  const view=latest,before=saved();if(!view||Date.now()-view.serverAt>60000||!storageReady||before.actions.length>=200||before.actions.some(r=>!r.outcome||r.outcome.state==='pending')||kind==='question'&&!knownEntries.has(entryId??''))throw bad();
  const intent=parseKhataIntent({v:1,id:newInboxId(),eventId:newInboxId(),taskId:newInboxId(),linkId:view.linkId,accountId:view.accountId,kind,entryId,message,at:Date.now()});persist(before,{...before,actions:[...before.actions,{intent,closeRequested:false,outcome:null}]});return intent;
 });}
 async function call(id:string,operation:'submit'|'inspect'|'close'){return exclusive(async()=>{
  let before=saved(),row=before.actions.at(-1);if(!row||row.intent.id!==id)throw bad();
  if(operation==='close'&&!row.closeRequested){const next=structuredClone(before);next.actions.at(-1)!.closeRequested=true;persist(before,next);before=next;row=next.actions.at(-1)!;}
  const effect=row.closeRequested&&operation==='submit'?'close':operation,outcome=parseKhataOutcome(await request(effect,row.intent),row.intent);current();if(row.outcome&&row.outcome.state!=='pending'&&JSON.stringify(row.outcome)!==JSON.stringify(outcome))throw bad();
  const next=structuredClone(before);next.actions.at(-1)!.outcome=outcome;persist(before,next);return outcome;
 });}
 return {key,saved,read,prepare,call,get storageReady(){return storageReady;},get canPrepare(){return active&&storageReady&&!!latest&&Date.now()-latest.serverAt<=60000;},stop(){active=false;latest=null;controller.abort();}};
}
export type CustomerKhataSession=Awaited<ReturnType<typeof createCustomerKhataSession>>;
