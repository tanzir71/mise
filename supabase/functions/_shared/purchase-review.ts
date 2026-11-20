import {authHttp,readAuthBody,AuthBodyError} from './auth-http.ts';
import {commandReviewHeader,commandReviewBodyLimit} from '../../../packages/core/command-resolution.ts';
import {parsePurchaseReviewRequest,parsePreparedPurchaseReview,parsePurchaseResolutionReceipt,originalPurchaseFacts,reviewedPurchaseProposal,purchaseReviewInvoice,type PurchaseReviewRequest,type PurchaseReviewDecision,type PreparedPurchaseReview,type FinancialPurchaseCommand,type PurchaseResolutionReceipt} from '../../../packages/core/purchase-review.ts';
import {purchaseWritePlan,parsePurchaseCommandReceipt,type PurchaseCommandReceipt} from '../../../packages/core/purchase-commands.ts';
import {purchaseFingerprint,replayPurchaseRecords} from '../../../packages/core/purchase-replay.ts';
import {proposedPurchaseCurrencyMatches} from '../../../packages/core/purchase-currency.ts';
import {purchaseWriteFields} from './purchase-write.ts';
import {decodeCommandRecord,decodeProposedCommandRecord} from '../../../packages/core/cloud-records.ts';
import {syncHash} from '../../../packages/core/sync-read.ts';
import {syncDownloadToken} from '../../../packages/core/sync-download.ts';
import {deviceAuthId} from './device-pin-handler.ts';
import type {Business,Outlet,Purchase,Supplier,StockItem} from '../../../packages/core/models.ts';
type PurchaseOutcome=PurchaseCommandReceipt|PurchaseResolutionReceipt;
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
class PurchaseReviewFailure extends Error {constructor(readonly status:400|401|403|409|429|503){super('Review the original invoice and current values.');}}
export interface PurchaseReviewStore {admit(jwt:string,outletId:string):Promise<void>;prepare(jwt:string,input:PurchaseReviewRequest):Promise<unknown>;resolve(jwt:string,input:PurchaseReviewDecision):Promise<unknown>}
async function reviewFields(value:unknown,input:PurchaseReviewRequest):Promise<{view:PreparedPurchaseReview;proposal:FinancialPurchaseCommand|null}> {
 const c=input.command,original=originalPurchaseFacts(input),plan=purchaseWritePlan(c);
 if(!object(value)||value.done!==false||value.id!==input.id||value.replacementId!==input.replacementId||value.commandId!==c.id||value.type!==c.type||value.occurredAt!==c.occurredAt||value.outletId!==c.outletId||!id(value.businessId)||!id(value.actorId)||value.commandHash!==await purchaseFingerprint(c)||value.sourceHash!==input.sourceHash||value.sourceJsonHash!==await syncHash(new TextEncoder().encode(input.sourceJson))||value.savedCurrency!==original.currency||syncDownloadToken(value.plan)!==syncDownloadToken(plan)||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||!time(value.at)||!time(value.expiresAt)||typeof value.contextJson!=='string'||typeof value.selectionValid!=='boolean'||typeof value.reserved!=='boolean')throw new PurchaseReviewFailure(503);
 const raw:unknown=JSON.parse(value.contextJson);
 if(!object(raw)||!object(raw.business)||!object(raw.outlet)||![raw.supplier,raw.purchase].every(row=>row===null||object(row))||!Array.isArray(raw.stock)||!raw.stock.every(object))throw new PurchaseReviewFailure(503);
 const business=decodeCommandRecord('businesses',raw.business) as unknown as Business,outlet=decodeCommandRecord('outlets',raw.outlet) as unknown as Outlet,supplier=raw.supplier?decodeCommandRecord('suppliers',raw.supplier as Record<string,unknown>) as unknown as Supplier:null,purchase=raw.purchase?decodeCommandRecord('purchases',raw.purchase as Record<string,unknown>) as unknown as Purchase:null,stock=raw.stock.map(row=>decodeCommandRecord('stockItems',row) as unknown as StockItem);
 if(business.id!==value.businessId||outlet.id!==c.outletId||outlet.businessId!==business.id||supplier&&(supplier.outletId!==outlet.id||supplier.id!==plan.supplierId)||purchase&&(purchase.outletId!==outlet.id||purchase.id!==c.purchaseId)||stock.some(row=>row.outletId!==outlet.id||!plan.stockItemIds.includes(row.id)))throw new PurchaseReviewFailure(503);
 const existing=purchase?purchaseReviewInvoice(purchase):null;let proposal:FinancialPurchaseCommand|null=null,preview:PreparedPurchaseReview['proposal']={enabled:false,reason:c.type==='purchase.record'&&outlet.currency!==original.currency?'currency':'unavailable'};
 try{
  if(!value.selectionValid||value.reserved)throw Error();
  proposal=reviewedPurchaseProposal(c,input.replacementId);const records=replayPurchaseRecords(value,proposal),invoiceRecord=records.find(row=>row.table==='purchases');if(!invoiceRecord)throw Error();
  if(!proposedPurchaseCurrencyMatches(proposal,records,original.currency)){proposal=null;preview={enabled:false,reason:'currency'};}
  else{
   const next=purchaseReviewInvoice(decodeProposedCommandRecord('purchases',invoiceRecord) as unknown as Purchase),candidate:PreparedPurchaseReview['proposal']={enabled:true,invoice:next};
   // Parse inside the attempt: an incompatible current invoice still permits
   // an explicit withdrawal, with its actual current comparison visible.
   parsePreparedPurchaseReview({v:1,id:input.id,replacementId:input.replacementId,commandId:c.id,commandHash:value.commandHash,sourceHash:input.sourceHash,businessId:value.businessId,outletId:c.outletId,actorId:value.actorId,token:value.token,at:value.at,expiresAt:value.expiresAt,current:{profileCurrency:outlet.currency,profileTimezone:outlet.timezone,supplier:supplier?{id:supplier.id,name:supplier.name,archived:supplier.archivedAt!==undefined}:null,invoice:existing},proposal:candidate},input);preview=candidate;
  }
 }catch{proposal=null;}
 const view=parsePreparedPurchaseReview({v:1,id:input.id,replacementId:input.replacementId,commandId:c.id,commandHash:value.commandHash,sourceHash:input.sourceHash,businessId:value.businessId,outletId:c.outletId,actorId:value.actorId,token:value.token,at:value.at,expiresAt:value.expiresAt,current:{profileCurrency:outlet.currency,profileTimezone:outlet.timezone,supplier:supplier?{id:supplier.id,name:supplier.name,archived:supplier.archivedAt!==undefined}:null,invoice:existing},proposal:preview},input);
 return {view,proposal};
}
export function createPurchaseReviewHandler(deps:{store:PurchaseReviewStore;origins:ReadonlySet<string>}) {
 const origins=new Set(deps.origins);return async(request:Request):Promise<Response>=>{
  const {reply,blocked}=authHttp(request,origins,[commandReviewHeader.toLowerCase()]);if(blocked)return blocked;
  const jwt=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1],outlet=request.headers.get(commandReviewHeader),query=new URL(request.url).searchParams,mode=query.get('review');
  if(!jwt||jwt.length>8192)return reply(401,{error:'Verify the original phone account again.'});
  if(!id(outlet)||!['purchase-read','purchase-resolve'].includes(mode??'')||query.getAll('review').length!==1||[...query.keys()].some(key=>key!=='review'))return reply(400,{error:'Choose the original saved invoice review.'});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return reply(415,{error:'Use JSON.'});
  try{
   await deps.store.admit(jwt,outlet);const raw=await readAuthBody(request,commandReviewBodyLimit);let input:PurchaseReviewRequest|PurchaseReviewDecision;
   try{input=mode==='purchase-resolve'?parsePurchaseReviewRequest(raw,true):parsePurchaseReviewRequest(raw,false);}catch{throw new PurchaseReviewFailure(400);}
   if(input.command.outletId!==outlet)return reply(400,{error:'Keep the original reviewed outlet.'});
   return reply(200,mode==='purchase-resolve'?await deps.store.resolve(jwt,input as PurchaseReviewDecision):await deps.store.prepare(jwt,input));
  }catch(error){const status=error instanceof PurchaseReviewFailure?error.status:error instanceof AuthBodyError?error.status:error instanceof SyntaxError||error instanceof TypeError?400:503;return reply(status,{error:status===409?'The invoice comparison changed. Review current values again.':status===401||status===403?'Verify the original account and outlet access.':status===429?'Finish an existing saved review before starting another.':status===400?'Keep the complete original invoice action and source.':'The invoice review is unconfirmed. Keep its original source and try again.'});}
 };
}
export function createPurchaseReviewStore(apiUrl:string,publishableKey:string,serviceKey:string,send:typeof fetch=fetch,newId:()=>string=deviceAuthId):PurchaseReviewStore {
 const root=new URL(apiUrl);if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname))||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)||!/^sb_secret_[A-Za-z0-9_-]+$/.test(serviceKey))throw Error('Invoice reviews are unavailable.');
 async function rpc(name:string,args:Record<string,unknown>,jwt?:string):Promise<unknown>{const response=await send(new URL('rest/v1/rpc/'+name,root),{method:'POST',headers:{'Content-Type':'application/json',apikey:jwt?publishableKey:serviceKey,...(jwt?{Authorization:'Bearer '+jwt}:{})},body:JSON.stringify(args),redirect:'error',signal:AbortSignal.timeout(20000)});if(!response.ok){const status=response.status;throw new PurchaseReviewFailure(status===400||status===401||status===403||status===409||status===429?status:503);}return response.json();}
 async function receipt(value:unknown,input:PurchaseReviewRequest):Promise<PurchaseOutcome>{
  if(object(value)&&value.type==='command.resolved'){const result=parsePurchaseResolutionReceipt(value,input.command);if(result.sourceHash!==input.sourceHash||result.commandHash!==await purchaseFingerprint(input.command))throw new PurchaseReviewFailure(409);if(result.replacement&&result.replacement.commandHash!==await purchaseFingerprint(reviewedPurchaseProposal(input.command,result.replacement.id)))throw new PurchaseReviewFailure(503);return result;}return parsePurchaseCommandReceipt(value,input.command);
 }
 async function outcome(jwt:string,input:PurchaseReviewRequest){const value=await rpc('inspect_purchase_outcome',{p_command_id:input.command.id,p_type:input.command.type,p_outlet_id:input.command.outletId,p_hash:await purchaseFingerprint(input.command)},jwt);return value===null?null:receipt(value,input);}
 return {
  admit:async(jwt,outletId)=>{if(await rpc('admit_purchase_review',{p_outlet_id:outletId},jwt)!==true)throw new PurchaseReviewFailure(403);},
  prepare:async(jwt,value)=>{
   const input=parsePurchaseReviewRequest(value,false),found=await outcome(jwt,input);if(found)return {done:true,receipt:found};const c=input.command,prepared=await rpc('prepare_purchase_review',{p_id:input.id,p_replacement_id:input.replacementId,p_command_id:c.id,p_type:c.type,p_outlet_id:c.outletId,p_plan:purchaseWritePlan(c),p_hash:await purchaseFingerprint(c),p_occurred_at:c.occurredAt,p_intent_json:JSON.stringify(c),p_source_hash:input.sourceHash,p_source_json:input.sourceJson,p_saved_currency:originalPurchaseFacts(input).currency},jwt);if(object(prepared)&&prepared.done===true)return {done:true,receipt:await receipt(prepared.receipt,input)};return {done:false,review:(await reviewFields(prepared,input)).view};
  },
  resolve:async(jwt,value)=>{
   const input=parsePurchaseReviewRequest(value,true),found=await outcome(jwt,input);if(found)return found;const prepared=await rpc('read_purchase_review',{p_id:input.id,p_token:input.token},jwt);if(object(prepared)&&prepared.done===true)return receipt(prepared.receipt,input);const selected=await reviewFields(prepared,input);let fields:Record<string,unknown>|null=null,hash:string|null=null;
   if(input.outcome==='replaced'){
    if(!selected.proposal||!selected.view.proposal.enabled)throw new PurchaseReviewFailure(409);const c=selected.proposal,ticket=newId();hash=await purchaseFingerprint(c);const normal=await rpc('prepare_purchase_write',{p_id:c.id,p_ticket_id:ticket,p_type:c.type,p_outlet_id:c.outletId,p_plan:purchaseWritePlan(c),p_hash:hash,p_occurred_at:c.occurredAt},jwt);if(object(normal)&&normal.done===true)throw new PurchaseReviewFailure(409);fields=purchaseWriteFields(normal,c,ticket);if(!proposedPurchaseCurrencyMatches(c,fields.p_records,originalPurchaseFacts(input).currency))throw new PurchaseReviewFailure(409);
   }
   return receipt(await rpc('finish_purchase_review',{p_id:input.id,p_token:input.token,p_outcome:input.outcome,p_replacement_ticket:fields?.p_ticket_id??null,p_replacement_token:fields?.p_token??null,p_replacement_hash:hash,p_replacement_records:fields?.p_records??null}),input);
  },
 };
}
