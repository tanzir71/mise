import {customerFingerprint,parseCustomerCommandReceipt,type CustomerCommand,type CustomerCommandReceipt} from '../../../packages/core/customer-commands.ts';
import {customerReviewFacts,parseCustomerReviewRequest,parseCustomerReviewSource,customerReviewBodyLimit,type CustomerReviewRequest,type CustomerReviewDecision} from '../../../packages/core/customer-review-source.ts';
import {prepareCustomerReviewView,customerReviewProjection,readCustomerReviewContext,type CustomerReviewCurrent,type PreparedCustomerReview} from '../../../packages/core/customer-review-view.ts';
import {reviewedCustomerProposal,parseCustomerResolutionReceipt,type CustomerResolutionReceipt} from '../../../packages/core/customer-review.ts';
import {syncHash} from '../../../packages/core/sync-read.ts';
import {syncDownloadToken} from '../../../packages/core/sync-download.ts';
import {customerReviewEffectsMatch} from '../../../packages/core/customer-review-effects.ts';
import {commandReviewHeader} from '../../../packages/core/command-resolution.ts';
import {customerWriteFields} from './customer-write.ts';
import {authHttp,readAuthBody,AuthBodyError} from './auth-http.ts';
import {deviceAuthId} from './device-pin-handler.ts';
import type {CloudRecord} from '../../../packages/core/cloud-records.ts';

const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
const same=(a:unknown,b:unknown)=>syncDownloadToken(a)===syncDownloadToken(b);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const invalid=()=>new Error('Keep the genuine original customer comparison.');
type CustomerOutcome=CustomerCommandReceipt|CustomerResolutionReceipt;
class CustomerReviewFailure extends Error {constructor(readonly status:400|401|403|409|429|503){super('Review the original customer action and current values.');}}
export interface CustomerReviewStore {admit(jwt:string,outletId:string):Promise<void>;prepare(jwt:string,input:CustomerReviewRequest):Promise<unknown>;resolve(jwt:string,input:CustomerReviewDecision):Promise<unknown>}
/** Format only an admitted database preparation. A client-supplied role,
 * context, source hash or proposal cannot replace the original SQL ticket. */
export async function customerReviewFields(value:unknown,request:CustomerReviewRequest):Promise<{view:PreparedCustomerReview;proposal:CustomerCommand|null}>{
 const input=parseCustomerReviewRequest(request,false),c=input.command,source=parseCustomerReviewSource(input);
 if(!object(value)||!exact(value,'done,id,replacementId,commandId,type,customerId,accountId,businessId,outletId,actorId,commandHash,sourceHash,sourceJsonHash,ids,facts,token,at,expiresAt,stateJson')||value.done!==false||
  value.id!==input.id||value.replacementId!==input.replacementId||value.commandId!==c.id||value.type!==c.type||value.customerId!==c.customerId||value.accountId!==(c.type==='khata.settings'?c.accountId:null)||
  value.businessId!==source.businessId||value.outletId!==c.outletId||value.actorId!==source.events[0].actorId||value.commandHash!==await customerFingerprint(c)||value.sourceHash!==input.sourceHash||
  value.sourceJsonHash!==await syncHash(new TextEncoder().encode(input.sourceJson))||!same(value.ids,'ids'in c?c.ids:null)||!same(value.facts,customerReviewFacts(input))||
  typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||!time(value.at)||!time(value.expiresAt)||typeof value.stateJson!=='string')throw invalid();
 const state:unknown=JSON.parse(value.stateJson),status=c.type==='customer.archive'||c.type==='customer.restore';
 if(!object(state)||!exact(state,'contextJson,balances,phoneTaken,available,statusHash')||typeof state.contextJson!=='string'||!Array.isArray(state.balances)||typeof state.phoneTaken!=='boolean'||typeof state.available!=='boolean'||
  (status?typeof state.statusHash!=='string'||!/^[a-f0-9]{64}$/.test(state.statusHash):state.statusHash!==null))throw invalid();
 const current:CustomerReviewCurrent={stateHash:await syncHash(new TextEncoder().encode(value.stateJson)),contextJson:state.contextJson,balances:state.balances,phoneTaken:state.phoneTaken,available:state.available};
 const view=prepareCustomerReviewView({v:1,id:input.id,replacementId:input.replacementId,commandId:c.id,commandHash:value.commandHash,sourceHash:input.sourceHash,businessId:source.businessId,outletId:c.outletId,actorId:source.events[0].actorId,token:value.token,at:value.at,expiresAt:value.expiresAt},current,input);
 return {view,proposal:view.proposal.enabled?reviewedCustomerProposal(c,input.replacementId):null};
}
export function createCustomerReviewHandler(deps:{store:CustomerReviewStore;origins:ReadonlySet<string>}){
 const origins=new Set(deps.origins);return async(request:Request):Promise<Response>=>{
  const {reply,blocked}=authHttp(request,origins,[commandReviewHeader.toLowerCase()]);if(blocked)return blocked;
  const jwt=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1],outlet=request.headers.get(commandReviewHeader),query=new URL(request.url).searchParams,mode=query.get('review');
  if(!jwt||jwt.length>8192)return reply(401,{error:'Verify the original phone account again.'});
  if(!id(outlet)||!['customer-read','customer-resolve'].includes(mode??'')||query.getAll('review').length!==1||[...query.keys()].some(k=>k!=='review'))return reply(400,{error:'Choose the original saved customer review.'});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return reply(415,{error:'Use JSON.'});
  try{
   await deps.store.admit(jwt,outlet);const raw=await readAuthBody(request,customerReviewBodyLimit,30000);let input:CustomerReviewRequest|CustomerReviewDecision;
   try{input=mode==='customer-resolve'?parseCustomerReviewRequest(raw,true):parseCustomerReviewRequest(raw,false);}catch{throw new CustomerReviewFailure(400);}
   if(input.command.outletId!==outlet)return reply(400,{error:'Keep the original reviewed outlet.'});
   return reply(200,mode==='customer-resolve'?await deps.store.resolve(jwt,input as CustomerReviewDecision):await deps.store.prepare(jwt,input));
  }catch(error){
   const status=error instanceof CustomerReviewFailure?error.status:error instanceof AuthBodyError?error.status:error instanceof SyntaxError||error instanceof TypeError?400:503;
   return reply(status,{error:status===409?'The customer comparison changed. Review current values again.':status===401||status===403?'Verify the original account and outlet access.':status===429?'Finish an existing saved review before starting another.':status===400?'Keep the complete original customer action and source.':'The customer review is unconfirmed. Keep its original source and try again.'});
  }
 };
}
export function createCustomerReviewStore(apiUrl:string,publishableKey:string,serviceKey:string,send:typeof fetch=fetch,newId:()=>string=deviceAuthId):CustomerReviewStore{
 const root=new URL(apiUrl);
 if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname))||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)||!/^sb_secret_[A-Za-z0-9_-]+$/.test(serviceKey))throw Error('Customer reviews are unavailable.');
 async function rpc(name:string,args:Record<string,unknown>,jwt?:string):Promise<unknown>{
  const response=await send(new URL('rest/v1/rpc/'+name,root),{method:'POST',headers:{'Content-Type':'application/json',apikey:jwt?publishableKey:serviceKey,...(jwt?{Authorization:'Bearer '+jwt}:{})},body:JSON.stringify(args),redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok){const status=response.status;throw new CustomerReviewFailure(status===400||status===401||status===403||status===409||status===429?status:503);}
  try{return await response.json();}catch{throw new CustomerReviewFailure(503);}
 }
 async function receipt(value:unknown,input:CustomerReviewRequest):Promise<CustomerOutcome>{
  if(object(value)&&value.type==='command.resolved'){
   const result=parseCustomerResolutionReceipt(value,input.command);
   if(result.sourceHash!==input.sourceHash||result.commandHash!==await customerFingerprint(input.command))throw new CustomerReviewFailure(409);
   if(result.replacement&&result.replacement.commandHash!==await customerFingerprint(reviewedCustomerProposal(input.command,result.replacement.id)))throw new CustomerReviewFailure(503);
   return result;
  }
  return parseCustomerCommandReceipt(value,input.command);
 }
 async function outcome(jwt:string,input:CustomerReviewRequest){const c=input.command,value=await rpc('inspect_customer_outcome',{p_command_id:c.id,p_type:c.type,p_customer_id:c.customerId,p_outlet_id:c.outletId,p_hash:await customerFingerprint(c)},jwt);return value===null?null:receipt(value,input);}
 return {
  admit:async(jwt,outletId)=>{if(await rpc('admit_customer_review',{p_outlet_id:outletId},jwt)!==true)throw new CustomerReviewFailure(403);},
  prepare:async(jwt,value)=>{
   const input=parseCustomerReviewRequest(value,false),found=await outcome(jwt,input);if(found)return {done:true,receipt:found};const c=input.command,
    prepared=await rpc('prepare_customer_review',{p_id:input.id,p_replacement_id:input.replacementId,p_command_id:c.id,p_type:c.type,p_customer_id:c.customerId,p_outlet_id:c.outletId,p_account_id:c.type==='khata.settings'?c.accountId:null,p_ids:'ids'in c?c.ids:null,p_hash:await customerFingerprint(c),p_intent_json:JSON.stringify(c),p_source_hash:input.sourceHash,p_source_json:input.sourceJson,p_facts:customerReviewFacts(input)},jwt);
   if(object(prepared)&&prepared.done===true)return {done:true,receipt:await receipt(prepared.receipt,input)};
   return {done:false,review:(await customerReviewFields(prepared,input)).view};
  },
  resolve:async(jwt,value)=>{
   const input=parseCustomerReviewRequest(value,true),original=parseCustomerReviewRequest({id:input.id,replacementId:input.replacementId,command:input.command,sourceHash:input.sourceHash,sourceJson:input.sourceJson},false),found=await outcome(jwt,original);if(found)return found;
   const prepared=await rpc('read_customer_review',{p_id:input.id,p_token:input.token},jwt);if(object(prepared)&&prepared.done===true)return receipt(prepared.receipt,original);
   const selected=await customerReviewFields(prepared,original);let fields:Record<string,unknown>|null=null,hash:string|null=null;
   if(input.outcome==='replaced'){
    if(!selected.proposal||!selected.view.proposal.enabled)throw new CustomerReviewFailure(409);
    const c=selected.proposal,ticket=newId();hash=await customerFingerprint(c);
    const normal=await rpc('prepare_customer_intent',{p_id:c.id,p_ticket_id:ticket,p_type:c.type,p_customer_id:c.customerId,p_outlet_id:c.outletId,p_account_id:c.type==='khata.settings'?c.accountId:null,p_hash:hash,p_ids:'ids'in c?c.ids:null},jwt);
    if(!object(normal)||normal.done!==false||normal.businessId!==selected.view.businessId||normal.actorId!==selected.view.actorId)throw new CustomerReviewFailure(409);
    fields=customerWriteFields(normal,c,ticket);const records=fields.p_records as CloudRecord[];
    if(!customerReviewEffectsMatch(original,records))throw new CustomerReviewFailure(409);
    const current=readCustomerReviewContext(selected.view.current.contextJson,selected.view.businessId,c.outletId,c.customerId);
    if(!same(customerReviewProjection(records,current.customer),selected.view.proposal))throw new CustomerReviewFailure(409);
   }
   return receipt(await rpc('finish_customer_review',{p_id:input.id,p_token:input.token,p_outcome:input.outcome,p_replacement_ticket:fields?.p_ticket_id??null,p_replacement_token:fields?.p_token??null,p_replacement_hash:hash,p_replacement_records:fields?.p_records??null}),original);
  },
 };
}
