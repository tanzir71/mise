import {newPublicOrderSubmission,type CustomerOrderFields} from '@mise/core/public-order-new';
import {parsePublicOrderingLink,publicOrderShopSource,type PublicOrderingLink} from '@mise/core/public-order-link';
import {publicRecord} from '@mise/core/public-shop';
import {parsePublicOrderSubmission,parsePublicOrderOutcome,publicOrderHash,publicOrderAttemptIdFromHash,publicOrderIntentJson,type PublicOrderOutcome,type PublicOrderSubmission} from '@mise/core/public-order-submission';
import {createPublicOrderRemote,PublicOrderError} from './order-remote';
export type {CustomerOrderFields} from '@mise/core/public-order-new';
export interface SavedPublicOrder {submission:PublicOrderSubmission;closeRequested:boolean;outcome:PublicOrderOutcome|null}
interface Journal {v:1;attempts:SavedPublicOrder[]}
type StorageAccess=Pick<Storage,'getItem'|'setItem'>;
const bad=()=>new PublicOrderError('review');
const exact=(v:unknown,keys:string)=>{const r=publicRecord(v,keys.split(','));if(Object.keys(r).sort().join(',')!==keys.split(',').sort().join(','))throw bad();return r;};
/** A full original intent and customer secret must survive storage readback
 * before HTTP. Unconfirmed attempts are never discarded or silently replaced. */
export async function createPublicOrderSession(value:PublicOrderingLink,deps:{storage:StorageAccess;locks:Pick<LockManager,'request'>;send?:typeof fetch;isCurrent?:()=>boolean}){
 const link=parsePublicOrderingLink(value),shop=publicOrderShopSource(link.sourceUrl).shop,
  key='mise.public-orders.v1.'+await publicOrderHash(JSON.stringify(link)),remote=createPublicOrderRemote(link.apiUrl,deps.send);
 let active=true;
 const current=()=>{if(!active||deps.isCurrent&&!deps.isCurrent())throw bad();};
 async function saved():Promise<Journal>{
  try{
  current();let raw:string|null;try{raw=deps.storage.getItem(key);}catch{throw bad();}
  if(raw===null)return {v:1,attempts:[]};if(raw.length>2000000)throw bad();
  const r=exact(JSON.parse(raw),'v,attempts');if(r.v!==1||!Array.isArray(r.attempts)||r.attempts.length>100)throw bad();
  const attempts:SavedPublicOrder[]=[];
  for(const entry of r.attempts){
   const a=exact(entry,'submission,closeRequested,outcome'),submission=parsePublicOrderSubmission(a.submission);
   if(submission.action!=='submit'||submission.website!==''||submission.expectedTable!==link.table||submission.shopToken!==link.shopToken||JSON.stringify(submission.intent.shop)!==JSON.stringify(shop)||typeof a.closeRequested!=='boolean'||
    (submission.intent.fulfilment==='dine_in')!==(link.table!==null)||submission.intent.id!==publicOrderAttemptIdFromHash(await publicOrderHash(submission.trackingToken)))throw bad();
   attempts.push({submission,closeRequested:a.closeRequested,outcome:a.outcome===null?null:parsePublicOrderOutcome(a.outcome,submission.intent)});
  }
  if(new Set(attempts.map(a=>a.submission.intent.id)).size!==attempts.length||attempts.slice(0,-1).some(a=>!a.outcome||a.outcome.state==='pending'))throw bad();
  current();return {v:1,attempts};
  }catch{throw bad();}
 }
 async function persist(previous:Journal,next:Journal){
  current();const before=JSON.stringify(previous),raw=JSON.stringify(next);if(raw.length>2000000||JSON.stringify(await saved())!==before)throw bad();
  try{deps.storage.setItem(key,raw);if(deps.storage.getItem(key)!==raw)throw bad();}catch{throw bad();}current();
 }
 const exclusive=<T>(run:()=>Promise<T>)=>deps.locks.request(key,{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock)throw new PublicOrderError('unconfirmed');current();return run();});
 function original(record:Journal,id:string){const a=record.attempts.at(-1);if(!a||a.submission.intent.id!==id)throw bad();return a;}
 async function prepare(fields:CustomerOrderFields,website=''){
  if(website!=='')throw bad();
  return exclusive(async()=>{
   const previous=await saved(),last=previous.attempts.at(-1);if(last&&(!last.outcome||last.outcome.state==='pending'))throw bad();if(previous.attempts.length>=100)throw bad();
   const submission=parsePublicOrderSubmission({...await newPublicOrderSubmission(link.shopToken,shop,fields),expectedTable:link.table}),
    attempt:SavedPublicOrder={submission,closeRequested:false,outcome:null};
   if((submission.intent.fulfilment==='dine_in')!==(link.table!==null))throw bad();
   await persist(previous,{v:1,attempts:[...previous.attempts,attempt]});return structuredClone(attempt);
  });
 }
 async function call(id:string,action:'submit'|'inspect'|'close',signal?:AbortSignal){
  return exclusive(async()=>{
   let previous=await saved(),a=original(previous,id);
   if(action==='submit'&&(a.closeRequested||a.outcome?.state==='closed'))throw bad();
   if(action==='close'&&!a.closeRequested){const next=structuredClone(previous);original(next,id).closeRequested=true;await persist(previous,next);previous=next;a=original(next,id);}
   const encoded=JSON.stringify(previous),outcome=await remote({...a.submission,action},signal);current();
   if(JSON.stringify(await saved())!==encoded)throw bad();
   if(a.outcome?.state==='created'&&(outcome.state!=='created'||JSON.stringify(outcome.receipt)!==JSON.stringify(a.outcome.receipt))||a.outcome?.state==='closed'&&outcome.state!=='closed')throw bad();
   const next=structuredClone(previous);original(next,id).outcome=outcome;await persist(previous,next);
   return {attempt:structuredClone(original(next,id)),outcome};
  });
 }
 return {key,link,saved,prepare,call,stop(){active=false;},originalJson:(a:SavedPublicOrder)=>publicOrderIntentJson(a.submission.intent)};
}
export type PublicOrderSession=Awaited<ReturnType<typeof createPublicOrderSession>>;
