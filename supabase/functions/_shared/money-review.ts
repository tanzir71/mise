import {authHttp,readAuthBody,AuthBodyError} from './auth-http.ts';
import {commandReviewHeader,commandReviewBodyLimit} from '../../../packages/core/command-resolution.ts';
import {parseMoneyReviewRequest,parsePreparedMoneyReview,parseMoneyResolutionReceipt,originalMoneyFacts,reviewedMoneyProposal,type MoneyReviewRequest,type MoneyReviewDecision,type PreparedMoneyReview,type FinancialMoneyCommand,type MoneyResolutionReceipt} from '../../../packages/core/money-review.ts';
import {moneyWritePlan,parseMoneyCommandReceipt,type MoneyCommandReceipt} from '../../../packages/core/money-commands.ts';
import {moneyFingerprint,replayMoneyRecords} from '../../../packages/core/money-replay.ts';
import {proposedMoneyCurrencyMatches} from '../../../packages/core/money-currency.ts';
import {moneyWriteFields} from './money-write.ts';
import {decodeCommandRecord,decodeProposedCommandRecord} from '../../../packages/core/cloud-records.ts';
import {creditBalance,type OverLimitConfirmation} from '../../../packages/core/khata.ts';
import {syncHash} from '../../../packages/core/sync-read.ts';
import {syncDownloadToken} from '../../../packages/core/sync-download.ts';
import {deviceAuthId} from './device-pin-handler.ts';
import type {Business,Outlet,Customer,CreditAccount,CreditEntry,Sale,Item} from '../../../packages/core/models.ts';

type MoneyOutcome=MoneyCommandReceipt|MoneyResolutionReceipt;
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
class MoneyReviewFailure extends Error {
 constructor(readonly status:400|401|403|409|429|503){super('Review the original money action and current financial values.');}
}
export interface MoneyReviewStore {
 admit(jwt:string,outletId:string):Promise<void>;
 prepare(jwt:string,input:MoneyReviewRequest):Promise<unknown>;
 resolve(jwt:string,input:MoneyReviewDecision):Promise<unknown>;
}
async function reviewFields(value:unknown,input:MoneyReviewRequest):Promise<{view:PreparedMoneyReview;proposal:FinancialMoneyCommand|null}> {
 const c=input.command,original=originalMoneyFacts(input);
 if(!object(value)||value.done!==false||value.id!==input.id||value.replacementId!==input.replacementId||value.commandId!==c.id||value.type!==c.type||value.occurredAt!==c.occurredAt||value.outletId!==c.outletId||!id(value.businessId)||!id(value.actorId)||
  value.commandHash!==await moneyFingerprint(c)||value.sourceHash!==input.sourceHash||value.sourceJsonHash!==await syncHash(new TextEncoder().encode(input.sourceJson))||value.savedCurrency!==original.currency||
  syncDownloadToken(value.plan)!==syncDownloadToken(moneyWritePlan(c))||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||!time(value.at)||!time(value.expiresAt)||typeof value.contextJson!=='string'||typeof value.selectionValid!=='boolean'||typeof value.reserved!=='boolean')throw new MoneyReviewFailure(503);
 const raw:unknown=JSON.parse(value.contextJson);
 if(!object(raw)||!object(raw.business)||!object(raw.outlet)||![raw.customer,raw.account,raw.sale,raw.entry].every(row=>row===null||object(row))||!Array.isArray(raw.entries)||!raw.entries.every(object)||!Array.isArray(raw.items)||!raw.items.every(object))throw new MoneyReviewFailure(503);
 const business=decodeCommandRecord('businesses',raw.business) as unknown as Business,outlet=decodeCommandRecord('outlets',raw.outlet) as unknown as Outlet,
  customer=raw.customer?decodeCommandRecord('customers',raw.customer as Record<string,unknown>) as unknown as Customer:null,
  account=raw.account?decodeCommandRecord('creditAccounts',raw.account as Record<string,unknown>) as unknown as CreditAccount:null,
  sale=raw.sale?decodeCommandRecord('sales',raw.sale as Record<string,unknown>) as unknown as Sale:null,
  entry=raw.entry?decodeCommandRecord('creditEntries',raw.entry as Record<string,unknown>) as unknown as CreditEntry:null,
  entries=raw.entries.map(row=>decodeCommandRecord('creditEntries',row) as unknown as CreditEntry),
  items=raw.items.map(row=>decodeCommandRecord('items',row) as unknown as Item);
 if(business.id!==value.businessId||outlet.id!==c.outletId||outlet.businessId!==business.id||customer&&customer.businessId!==business.id||account&&(!customer||account.outletId!==c.outletId||account.customerId!==customer.id)||
  sale&&sale.outletId!==c.outletId||entry&&(!account||entry.outletId!==c.outletId||entry.accountId!==account.id||entry.customerId!==account.customerId)||entries.some(row=>!account||row.outletId!==c.outletId||row.accountId!==account.id||row.customerId!==account.customerId)||items.some(row=>row.outletId!==c.outletId))throw new MoneyReviewFailure(503);
 const balance=account?creditBalance(account,entries):null;
 let proposal:FinancialMoneyCommand|null=null,preview:PreparedMoneyReview['proposal']={enabled:false,reason:'unavailable'};
 try{
  if(!value.selectionValid||value.reserved||original.accountId!==(account?.id??null)||original.customerId!==(account?customer?.id??null:null))throw Error();
  const tentative:OverLimitConfirmation|null=c.type==='sale.credit'&&account&&balance!==null?{balance,limit:account.limit}:null;
  proposal=reviewedMoneyProposal(c,input.replacementId,tentative);
  let records=replayMoneyRecords(value,proposal);const afterEntries=new Map(entries.map(row=>[row.id,row]));
  for(const row of records)if(row.table==='credit_entries'){const next=decodeProposedCommandRecord('creditEntries',row) as unknown as CreditEntry;afterEntries.set(next.id,next);}
  const afterBalance=account?creditBalance(account,[...afterEntries.values()]):null,
   consent=c.type==='sale.credit'&&account&&afterBalance!==null&&afterBalance>account.limit?tentative:null;
  if(tentative!==null&&consent===null){proposal=reviewedMoneyProposal(c,input.replacementId);records=replayMoneyRecords(value,proposal);}
  if(!proposedMoneyCurrencyMatches(proposal,records,original.currency)){
   preview={enabled:false,reason:'currency'};proposal=null;
  }else{
   const nextSale=records.find(row=>row.table==='sales'),nextEntry=records.find(row=>row.table==='credit_entries'),
    proposedSale=nextSale?decodeProposedCommandRecord('sales',nextSale) as unknown as Sale:null,
    proposedEntry=nextEntry?decodeProposedCommandRecord('creditEntries',nextEntry) as unknown as CreditEntry:null,
    amount=proposedSale?(c.type==='sale.undo'?-proposedSale.amount:proposedSale.amount):proposedEntry?.amount;
   if(amount===undefined)throw Error();
   preview={enabled:true,currency:original.currency,amount,balance:afterBalance,confirmation:consent,requiresCreditConfirmation:consent!==null};
  }
 }catch{proposal=null;}
 const view=parsePreparedMoneyReview({v:1,id:input.id,replacementId:input.replacementId,commandId:c.id,commandHash:value.commandHash,sourceHash:input.sourceHash,businessId:value.businessId,outletId:c.outletId,actorId:value.actorId,token:value.token,at:value.at,expiresAt:value.expiresAt,
  current:{profileCurrency:outlet.currency,sale:sale?{id:sale.id,currency:sale.currency,amount:sale.amount,methodName:sale.methodName,voided:sale.voidedAt!==undefined,closed:sale.closingId!==undefined}:null,entry:entry?{id:entry.id,currency:entry.currency,amount:entry.amount,type:entry.type}:null,
   accountId:account?.id??null,balance,limit:account?.limit??null,creditCurrency:account?.currency??null,creditCustomer:account&&customer?{id:customer.id,name:customer.name,phone:customer.phone??null}:null},proposal:preview},input);
 return {view,proposal};
}
export function createMoneyReviewHandler(deps:{store:MoneyReviewStore;origins:ReadonlySet<string>}){
 const origins=new Set(deps.origins);
 return async(request:Request):Promise<Response>=>{
  const {reply,blocked}=authHttp(request,origins,[commandReviewHeader.toLowerCase()]);if(blocked)return blocked;
  const jwt=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1],outlet=request.headers.get(commandReviewHeader),query=new URL(request.url).searchParams,mode=query.get('review');
  if(!jwt||jwt.length>8192)return reply(401,{error:'Verify the original phone account again.'});
  if(!id(outlet)||!['money-read','money-resolve'].includes(mode??'')||query.getAll('review').length!==1||[...query.keys()].some(key=>key!=='review'))return reply(400,{error:'Choose the original saved money review.'});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return reply(415,{error:'Use JSON.'});
  try{
   await deps.store.admit(jwt,outlet);const raw=await readAuthBody(request,commandReviewBodyLimit);let input:MoneyReviewRequest|MoneyReviewDecision;
   try{input=mode==='money-resolve'?parseMoneyReviewRequest(raw,true):parseMoneyReviewRequest(raw,false);}catch{throw new MoneyReviewFailure(400);}
   if(input.command.outletId!==outlet)return reply(400,{error:'Keep the original reviewed outlet.'});
   return reply(200,mode==='money-resolve'?await deps.store.resolve(jwt,input as MoneyReviewDecision):await deps.store.prepare(jwt,input));
  }catch(error){
   const status=error instanceof MoneyReviewFailure?error.status:error instanceof AuthBodyError?error.status:error instanceof SyntaxError||error instanceof TypeError?400:503;
   return reply(status,{error:status===409?'The financial comparison changed. Review the current values again.':status===401||status===403?'Verify the original account and outlet access.':status===429?'Finish an existing saved review before starting another.':status===400?'Keep the complete original money action and source.':'The financial review is unconfirmed. Keep its original source and try again.'});
  }
 };
}
export function createMoneyReviewStore(apiUrl:string,publishableKey:string,serviceKey:string,send:typeof fetch=fetch,newId:()=>string=deviceAuthId):MoneyReviewStore {
 const root=new URL(apiUrl);
 if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname))||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)||!/^sb_secret_[A-Za-z0-9_-]+$/.test(serviceKey))throw Error('Financial reviews are unavailable.');
 async function rpc(name:string,args:Record<string,unknown>,jwt?:string):Promise<unknown>{
  const response=await send(new URL('rest/v1/rpc/'+name,root),{method:'POST',headers:{'Content-Type':'application/json',apikey:jwt?publishableKey:serviceKey,...(jwt?{Authorization:'Bearer '+jwt}:{})},body:JSON.stringify(args),redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok){const status=response.status;throw new MoneyReviewFailure(status===400||status===401||status===403||status===409||status===429?status:503);}return response.json();
 }
 async function receipt(value:unknown,input:MoneyReviewRequest):Promise<MoneyOutcome>{
  if(object(value)&&value.type==='command.resolved'){
   const result=parseMoneyResolutionReceipt(value,input.command);
   if(result.sourceHash!==input.sourceHash||result.commandHash!==await moneyFingerprint(input.command))throw new MoneyReviewFailure(409);
   if(result.replacement&&result.replacement.commandHash!==await moneyFingerprint(reviewedMoneyProposal(input.command,result.replacement.id,result.replacement.confirmation)))throw new MoneyReviewFailure(503);
   return result;
  }
  return parseMoneyCommandReceipt(value,input.command);
 }
 async function outcome(jwt:string,input:MoneyReviewRequest){const value=await rpc('inspect_money_outcome',{p_command_id:input.command.id,p_type:input.command.type,p_outlet_id:input.command.outletId,p_hash:await moneyFingerprint(input.command)},jwt);return value===null?null:receipt(value,input);}
 return {
  admit:async(jwt,outletId)=>{if(await rpc('admit_money_review',{p_outlet_id:outletId},jwt)!==true)throw new MoneyReviewFailure(403);},
  prepare:async(jwt,value)=>{
   const input=parseMoneyReviewRequest(value,false),found=await outcome(jwt,input);if(found)return {done:true,receipt:found};
   const c=input.command,prepared=await rpc('prepare_money_review',{p_id:input.id,p_replacement_id:input.replacementId,p_command_id:c.id,p_type:c.type,p_outlet_id:c.outletId,p_plan:moneyWritePlan(c),p_hash:await moneyFingerprint(c),p_occurred_at:c.occurredAt,p_intent_json:JSON.stringify(c),p_source_hash:input.sourceHash,p_source_json:input.sourceJson,p_saved_currency:originalMoneyFacts(input).currency},jwt);
   if(object(prepared)&&prepared.done===true)return {done:true,receipt:await receipt(prepared.receipt,input)};
   return {done:false,review:(await reviewFields(prepared,input)).view};
  },
  resolve:async(jwt,value)=>{
   const input=parseMoneyReviewRequest(value,true),found=await outcome(jwt,input);if(found)return found;
   const prepared=await rpc('read_money_review',{p_id:input.id,p_token:input.token},jwt);
   if(object(prepared)&&prepared.done===true)return receipt(prepared.receipt,input);
   const selected=await reviewFields(prepared,input);let fields:Record<string,unknown>|null=null,hash:string|null=null,consent:OverLimitConfirmation|null=null;
   if(input.outcome==='replaced'){
    if(!selected.proposal||!selected.view.proposal.enabled||selected.view.proposal.requiresCreditConfirmation!==input.confirmCredit)throw new MoneyReviewFailure(409);
    const c=selected.proposal,ticket=newId();consent=selected.view.proposal.confirmation;hash=await moneyFingerprint(c);
    const normal=await rpc('prepare_money_write',{p_id:c.id,p_ticket_id:ticket,p_type:c.type,p_outlet_id:c.outletId,p_plan:moneyWritePlan(c),p_hash:hash,p_occurred_at:c.occurredAt},jwt);
    if(object(normal)&&normal.done===true)throw new MoneyReviewFailure(409);
    fields=moneyWriteFields(normal,c,ticket);
    if(!proposedMoneyCurrencyMatches(c,fields.p_records,originalMoneyFacts(input).currency))throw new MoneyReviewFailure(409);
   }
   const result=await rpc('finish_money_review',{p_id:input.id,p_token:input.token,p_outcome:input.outcome,p_confirm_credit:input.confirmCredit,p_confirmation:consent,p_replacement_ticket:fields?.p_ticket_id??null,p_replacement_token:fields?.p_token??null,p_replacement_hash:hash,p_replacement_records:fields?.p_records??null});
   return receipt(result,input);
  },
 };
}
