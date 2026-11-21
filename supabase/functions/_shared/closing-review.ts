import {closingFingerprint} from '../../../packages/core/closing-replay.ts';
import {reviewedClosingProposal,parseClosingResolutionReceipt,type ClosingResolutionReceipt} from '../../../packages/core/closing-review.ts';
import {closingReviewFacts,parseClosingReviewRequest,parseClosingReviewSource,closingReviewBodyLimit,type ClosingReviewRequest,type ClosingReviewDecision} from '../../../packages/core/closing-review-source.ts';
import {prepareClosingReviewView,closingReviewProjection,closingReviewResponseLimit,type PreparedClosingReview} from '../../../packages/core/closing-review-view.ts';
import {syncHash} from '../../../packages/core/sync-read.ts';
import {syncDownloadToken} from '../../../packages/core/sync-download.ts';
import {closingWritePlan,parseClosingCommandReceipt,type ClosingCommand,type ClosingCommandReceipt} from '../../../packages/core/closing-commands.ts';
import {commandReviewHeader} from '../../../packages/core/command-resolution.ts';
import {authHttp,readAuthBody,AuthBodyError} from './auth-http.ts';
import {deviceAuthId} from './device-pin-handler.ts';
import {closingWriteFields,ClosingMutationConflict,ClosingMutationInvalid} from './closing-write.ts';
import type {CloudRecord} from '../../../packages/core/cloud-records.ts';

const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
const same=(a:unknown,b:unknown)=>syncDownloadToken(a)===syncDownloadToken(b);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
type ClosingOutcome=ClosingCommandReceipt|ClosingResolutionReceipt;
class ClosingReviewFailure extends Error {constructor(readonly status:400|401|403|409|429|503){super('Review the original closing action and current values.');}}
export interface ClosingReviewStore {admit(jwt:string,outletId:string):Promise<void>;prepare(jwt:string,input:ClosingReviewRequest):Promise<unknown>;resolve(jwt:string,input:ClosingReviewDecision):Promise<unknown>}
/** Bind every actual SQL preparation fact before deriving a comparison. This
 * helper cannot finalize a review or turn a local snapshot into authorization. */
export async function closingReviewFields(value:unknown,request:ClosingReviewRequest):Promise<{view:PreparedClosingReview;proposal:ClosingCommand|null}>{
 const input=parseClosingReviewRequest(request,false),c=input.command,source=parseClosingReviewSource(input);
 if(!object(value)||!exact(value,'done,id,replacementId,commandId,type,closingId,saleId,saleEventId,occurredAt,businessId,outletId,actorId,commandHash,sourceHash,sourceJsonHash,facts,token,at,expiresAt,stateJson')||value.done!==false||
  value.id!==input.id||value.replacementId!==input.replacementId||value.commandId!==c.id||value.type!==c.type||value.closingId!==c.closingId||value.saleId!==c.saleId||value.saleEventId!==c.saleEventId||value.occurredAt!==c.occurredAt||value.businessId!==source.businessId||value.outletId!==c.outletId||value.actorId!==source.events[0].actorId||
  value.commandHash!==await closingFingerprint(c)||value.sourceHash!==input.sourceHash||value.sourceJsonHash!==await syncHash(new TextEncoder().encode(input.sourceJson))||!same(value.facts,closingReviewFacts(input))||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||!time(value.at)||!time(value.expiresAt)||typeof value.stateJson!=='string'||new TextEncoder().encode(value.stateJson).length>closingReviewResponseLimit)throw Error('Keep the genuine original closing preparation.');
 const state:unknown=JSON.parse(value.stateJson);
 if(!object(state)||!exact(state,'contextJson,available')||typeof state.contextJson!=='string'||typeof state.available!=='boolean')throw Error('Keep the complete current closing comparison.');
 const current={stateHash:await syncHash(new TextEncoder().encode(value.stateJson)),contextJson:state.contextJson,available:state.available},view=prepareClosingReviewView({v:1,id:input.id,replacementId:input.replacementId,commandId:c.id,commandHash:value.commandHash,sourceHash:input.sourceHash,businessId:source.businessId,outletId:c.outletId,actorId:source.events[0].actorId,token:value.token,at:value.at,expiresAt:value.expiresAt},current,input);
 return {view,proposal:view.proposal.enabled?reviewedClosingProposal(c,input.replacementId,view.proposal.reviewJson):null};
}
export function createClosingReviewHandler(deps:{store:ClosingReviewStore;origins:ReadonlySet<string>}){
 const origins=new Set(deps.origins);return async(request:Request):Promise<Response>=>{
  const {reply,blocked}=authHttp(request,origins,[commandReviewHeader.toLowerCase()]);if(blocked)return blocked;
  const jwt=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1],outlet=request.headers.get(commandReviewHeader),query=new URL(request.url).searchParams,mode=query.get('review');
  if(!jwt||jwt.length>8192)return reply(401,{error:'Verify the original phone account again.'});
  if(!id(outlet)||!['closing-read','closing-resolve'].includes(mode??'')||query.getAll('review').length!==1||[...query.keys()].some(k=>k!=='review'))return reply(400,{error:'Choose the original saved closing review.'});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return reply(415,{error:'Use JSON.'});
  try{
   await deps.store.admit(jwt,outlet);const raw=await readAuthBody(request,closingReviewBodyLimit,30000);let input:ClosingReviewRequest|ClosingReviewDecision;
   try{input=mode==='closing-resolve'?parseClosingReviewRequest(raw,true):parseClosingReviewRequest(raw,false);}catch{throw new ClosingReviewFailure(400);}
   if(input.command.outletId!==outlet)return reply(400,{error:'Keep the original reviewed outlet.'});
   return reply(200,mode==='closing-resolve'?await deps.store.resolve(jwt,input as ClosingReviewDecision):await deps.store.prepare(jwt,input));
  }catch(error){
   const status=error instanceof ClosingReviewFailure?error.status:error instanceof AuthBodyError?error.status:error instanceof SyntaxError||error instanceof TypeError?400:503;
   return reply(status,{error:status===409?'The closing comparison changed. Review current values again.':status===401||status===403?'Verify the original account and outlet access.':status===429?'Finish an existing saved review before starting another.':status===400?'Keep the complete original closing action and source.':'The closing review is unconfirmed. Keep its original source and try again.'});
  }
 };
}
export function createClosingReviewStore(apiUrl:string,publishableKey:string,serviceKey:string,send:typeof fetch=fetch,newId:()=>string=deviceAuthId):ClosingReviewStore{
 const root=new URL(apiUrl);
 if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname))||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)||!/^sb_secret_[A-Za-z0-9_-]+$/.test(serviceKey))throw Error('Closing reviews are unavailable.');
 async function rpc(name:string,args:Record<string,unknown>,jwt?:string):Promise<unknown>{
  const response=await send(new URL('rest/v1/rpc/'+name,root),{method:'POST',headers:{'Content-Type':'application/json',apikey:jwt?publishableKey:serviceKey,...(jwt?{Authorization:'Bearer '+jwt}:{})},body:JSON.stringify(args),redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok){const status=response.status;throw new ClosingReviewFailure(status===400||status===401||status===403||status===409||status===429?status:503);}
  try{return await response.json();}catch{throw new ClosingReviewFailure(503);}
 }
 async function receipt(value:unknown,input:ClosingReviewRequest):Promise<ClosingOutcome>{
  if(object(value)&&value.type==='command.resolved'){
   const result=parseClosingResolutionReceipt(value,input);
   if(result.sourceHash!==input.sourceHash||result.commandHash!==await closingFingerprint(input.command))throw new ClosingReviewFailure(409);
   if(result.replacement&&result.replacement.commandHash!==await closingFingerprint(reviewedClosingProposal(input.command,result.replacement.id,result.replacement.reviewJson)))throw new ClosingReviewFailure(503);
   return result;
  }
  return parseClosingCommandReceipt(value,input.command);
 }
 async function outcome(jwt:string,input:ClosingReviewRequest){const c=input.command,value=await rpc('inspect_closing_outcome',{p_command_id:c.id,p_type:c.type,p_closing_id:c.closingId,p_outlet_id:c.outletId,p_hash:await closingFingerprint(c)},jwt);return value===null?null:receipt(value,input);}
 return {
  admit:async(jwt,outletId)=>{if(await rpc('admit_closing_review',{p_outlet_id:outletId},jwt)!==true)throw new ClosingReviewFailure(403);},
  prepare:async(jwt,value)=>{
   const input=parseClosingReviewRequest(value,false),found=await outcome(jwt,input);if(found)return {done:true,receipt:found};const c=input.command,
    prepared=await rpc('prepare_closing_review',{p_id:input.id,p_replacement_id:input.replacementId,p_command_id:c.id,p_type:c.type,p_outlet_id:c.outletId,p_closing_id:c.closingId,p_sale_id:c.saleId,p_sale_event_id:c.saleEventId,p_occurred_at:c.occurredAt,p_hash:await closingFingerprint(c),p_intent_json:JSON.stringify(c),p_source_hash:input.sourceHash,p_source_json:input.sourceJson,p_facts:closingReviewFacts(input)},jwt);
   if(object(prepared)&&prepared.done===true)return {done:true,receipt:await receipt(prepared.receipt,input)};
   return {done:false,review:(await closingReviewFields(prepared,input)).view};
  },
  resolve:async(jwt,value)=>{
   const input=parseClosingReviewRequest(value,true),original=parseClosingReviewRequest({id:input.id,replacementId:input.replacementId,command:input.command,sourceHash:input.sourceHash,sourceJson:input.sourceJson},false),found=await outcome(jwt,original);if(found)return found;
   const prepared=await rpc('read_closing_review',{p_id:input.id,p_token:input.token},jwt);if(object(prepared)&&prepared.done===true)return receipt(prepared.receipt,original);
   const selected=await closingReviewFields(prepared,original);let fields:Record<string,unknown>|null=null,hash:string|null=null;
   if(input.outcome==='replaced'){
    if(!selected.proposal||!selected.view.proposal.enabled)throw new ClosingReviewFailure(409);
    const c=selected.proposal,ticket=newId();hash=await closingFingerprint(c);
    const normal=await rpc(c.type==='closing.undo'?'prepare_saved_closing':'prepare_closing_write',{p_id:c.id,p_ticket_id:ticket,p_type:c.type,p_outlet_id:c.outletId,p_plan:closingWritePlan(c),p_hash:hash,p_occurred_at:c.occurredAt,...(c.type==='closing.undo'?{p_parent_event_id:closingReviewFacts(original).closingEventId}:{})},jwt);
    if(!object(normal)||normal.done!==false||normal.businessId!==selected.view.businessId||normal.actorId!==selected.view.actorId)throw new ClosingReviewFailure(409);
    try{fields=closingWriteFields(normal,c,ticket);}catch(error){if(error instanceof ClosingMutationConflict||error instanceof ClosingMutationInvalid)throw new ClosingReviewFailure(409);throw error;}
    if(!same(closingReviewProjection(fields.p_records as CloudRecord[],c),selected.view.proposal))throw new ClosingReviewFailure(409);
   }
   return receipt(await rpc('finish_closing_review',{p_id:input.id,p_token:input.token,p_outcome:input.outcome,p_replacement_ticket:fields?.p_ticket_id??null,p_replacement_token:fields?.p_token??null,p_replacement_hash:hash,p_replacement_records:fields?.p_records??null}),original);
  },
 };
}
