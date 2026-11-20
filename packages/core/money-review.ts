import {parseMoneyCommand,parseMoneyCommandReceipt,moneyWritePlan,type MoneyCommand,type MoneyCommandReceipt} from './money-commands';
import {savedMoneyCurrency} from './money-currency';
import type {LocalRowChange} from './local-outbox';
import type {OverLimitConfirmation} from './khata';

export type FinancialMoneyCommand=Exclude<MoneyCommand,{type:'khata.communication'}>;
export interface MoneyReviewRequest {
 id:string;replacementId:string;command:FinancialMoneyCommand;sourceHash:string;sourceJson:string;
}
export interface MoneyReviewDecision extends MoneyReviewRequest {
 token:string;outcome:'withdrawn'|'replaced';confirmCredit:boolean;
}
export interface MoneyReviewSource {
 v:1;entryId:string;sequence:number;commandIndex:number;at:number;
 money:LocalRowChange[];priorCommands:MoneyCommand[];
}
export interface OriginalMoneyFacts {
 currency:string;amount:number;accountId:string|null;customerId:string|null;methodName:string|null;
}
export interface MoneyResolutionReceipt {
 id:string;type:'command.resolved';commandId:string;commandType:FinancialMoneyCommand['type'];
 outletId:string;occurredAt:number;commandHash:string;sourceHash:string;at:number;
 outcome:'withdrawn'|'replaced';
 replacement:{id:string;commandHash:string;confirmation:OverLimitConfirmation|null;receipt:MoneyCommandReceipt}|null;
}
export interface PreparedMoneyReview {
 v:1;id:string;replacementId:string;commandId:string;commandHash:string;sourceHash:string;
 businessId:string;outletId:string;actorId:string;token:string;at:number;expiresAt:number;
 current:{
  profileCurrency:string;
  sale:{id:string;currency:string;amount:number;methodName:string;voided:boolean;closed:boolean}|null;
  entry:{id:string;currency:string;amount:number;type:string}|null;
  accountId:string|null;balance:number|null;limit:number|null;creditCurrency:string|null;
  creditCustomer:{id:string;name:string;phone:string|null}|null;
 };
 proposal:{enabled:false;reason:'currency'|'unavailable'}|{
  enabled:true;currency:string;amount:number;balance:number|null;
  confirmation:OverLimitConfirmation|null;requiresCreditConfirmation:boolean;
 };
}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const currency=(v:unknown):v is string=>typeof v==='string'&&/^[A-Z]{3}$/.test(v);
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max;
const time=(v:unknown):v is number=>integer(v,0,8640000000000000);
function confirmation(v:unknown):OverLimitConfirmation|null {
 if(v===null)return null;
 if(!object(v)||!exact(v,'balance,limit')||!integer(v.balance,-Number.MAX_SAFE_INTEGER)||!integer(v.limit))throw Error('Review the exact current credit balance and limit.');
 return {balance:v.balance,limit:v.limit};
}
export function financialMoneyCommand(value:unknown):FinancialMoneyCommand {
 const c=parseMoneyCommand(value);if(c.type==='khata.communication')throw Error('Choose an original financial action.');return c;
}
/** A distinct explicit intent; reserved financial IDs and the actual undo clock
 * remain original. Only fresh, explicitly reviewed credit consent may change. */
export function reviewedMoneyProposal(original:FinancialMoneyCommand,replacementId:string,credit:OverLimitConfirmation|null=null):FinancialMoneyCommand {
 const c=financialMoneyCommand(original),consent=confirmation(credit);
 if(!id(replacementId)||replacementId===c.id||c.type!=='sale.credit'&&consent!==null)throw Error('Keep distinct original and reviewed money identities.');
 return financialMoneyCommand(c.type==='sale.credit'?{...c,id:replacementId,input:{...c.input,confirmation:consent}}:{...c,id:replacementId});
}
function sourceRows(c:FinancialMoneyCommand):{table:'sales'|'creditEntries';key:string}[]{
 if(c.type==='khata.payment')return [{table:'creditEntries',key:c.entryId}];
 if(c.type==='khata.undo')return [{table:'creditEntries',key:c.reversalId}];
 return [{table:'sales',key:c.saleId},...('entryId'in c&&c.entryId?[{table:'creditEntries' as const,key:c.entryId}]:[])];
}
export function parseMoneyReviewSource(input:MoneyReviewRequest):MoneyReviewSource {
 const c=financialMoneyCommand(input.command);let value:unknown;try{value=JSON.parse(input.sourceJson);}catch{throw Error('Keep the original money source.');}
 if(!object(value)||!exact(value,'v,entryId,sequence,commandIndex,at,money,priorCommands')||value.v!==1||!id(value.entryId)||!integer(value.sequence,1)||!integer(value.commandIndex)||!time(value.at)||!Array.isArray(value.money)||!Array.isArray(value.priorCommands)||value.priorCommands.length>1)throw Error('Keep the original money source.');
 const wanted=sourceRows(c);
 if(value.money.length!==wanted.length||!value.money.every(row=>object(row)&&exact(row,'table,key,before,after')&&wanted.some(w=>w.table===row.table&&w.key===row.key)&&object(row.after)&&row.after.id===row.key&&row.after.outletId===c.outletId&&currency(row.after.currency)&&integer(row.after.amount,-Number.MAX_SAFE_INTEGER)&&(row.before===null||object(row.before)))||new Set(value.money.map(row=>row.table+':'+row.key)).size!==wanted.length)throw Error('Keep each original financial companion.');
 const money=value.money as LocalRowChange[],priorCommands=value.priorCommands.map(parseMoneyCommand);
 if(priorCommands.some(p=>c.type!=='sale.undo'||!(p.type==='sale.record'||p.type==='sale.credit')||p.saleId!==c.saleId||p.outletId!==c.outletId||p.id===c.id)||priorCommands.length&&money.find(row=>row.table==='sales')?.before!==null)throw Error('Keep the actual earlier creation intent.');
 if(!savedMoneyCurrency(c,money,priorCommands))throw Error('Keep the original saved monetary unit.');
 return {v:1,entryId:value.entryId,sequence:value.sequence,commandIndex:value.commandIndex,at:value.at,money,priorCommands};
}
export function originalMoneyFacts(input:MoneyReviewRequest):OriginalMoneyFacts {
 const source=parseMoneyReviewSource(input),c=input.command,entry=source.money.find(row=>row.table==='creditEntries')?.after,
  sale=source.money.find(row=>row.table==='sales')?.after,primary=sale??entry;
 if(!object(primary)||!integer(primary.amount,-Number.MAX_SAFE_INTEGER)||(primary.methodName!==undefined&&!text(primary.methodName,100))||sale!==undefined&&!text(primary.methodName,100))throw Error('Keep the original financial amount and method.');
 let accountId:string|null=null,customerId:string|null=null;
 if(object(entry)){
  if(!id(entry.accountId)||!id(entry.customerId))throw Error('Keep the original khata and customer.');
  accountId=entry.accountId;customerId=entry.customerId;
  if(object(sale)&&(sale.creditAccountId!==accountId||sale.customerId!==customerId))throw Error('Keep the matching original credit sale.');
 }
 if(c.type==='khata.payment'&&primary.amount!==c.input.amount)throw Error('Keep the original saved payment amount.');
 return {currency:savedMoneyCurrency(c,source.money,source.priorCommands)!,amount:c.type==='sale.undo'?-primary.amount:primary.amount,accountId,customerId,methodName:typeof primary.methodName==='string'?primary.methodName:null};
}
export function parseMoneyReviewRequest(value:unknown,decision:false):MoneyReviewRequest;
export function parseMoneyReviewRequest(value:unknown,decision:true):MoneyReviewDecision;
export function parseMoneyReviewRequest(value:unknown,decision:boolean):MoneyReviewRequest|MoneyReviewDecision {
 if(!object(value)||!exact(value,decision?'command,id,replacementId,sourceHash,sourceJson,token,outcome,confirmCredit':'command,id,replacementId,sourceHash,sourceJson')||!id(value.id)||!id(value.replacementId)||!hash(value.sourceHash)||typeof value.sourceJson!=='string'||new TextEncoder().encode(value.sourceJson).length>4_000_000)throw Error('Keep the complete original saved money action.');
 const command=financialMoneyCommand(value.command),plan=moneyWritePlan(command),reserved=new Set([command.id,command.outletId,...Object.values(plan).flatMap(v=>Array.isArray(v)?v:typeof v==='string'?[v]:[])]);
 if(value.id===value.replacementId||reserved.has(value.id)||reserved.has(value.replacementId))throw Error('Use distinct original and reviewed identities.');
 const input:MoneyReviewRequest={id:value.id,replacementId:value.replacementId,command,sourceHash:value.sourceHash,sourceJson:value.sourceJson};originalMoneyFacts(input);
 if(!decision)return input;
 if(typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||!['withdrawn','replaced'].includes(value.outcome as string)||typeof value.confirmCredit!=='boolean'||value.confirmCredit&&(command.type!=='sale.credit'||value.outcome!=='replaced'))throw Error('Choose the current review and explicit credit consent.');
 return {...input,token:value.token,outcome:value.outcome as MoneyReviewDecision['outcome'],confirmCredit:value.confirmCredit};
}
export function parseMoneyResolutionReceipt(value:unknown,original:FinancialMoneyCommand):MoneyResolutionReceipt {
 const c=financialMoneyCommand(original);
 if(!object(value)||!exact(value,'id,type,commandId,commandType,outletId,occurredAt,commandHash,sourceHash,at,outcome,replacement')||!id(value.id)||value.id===c.id||value.type!=='command.resolved'||value.commandId!==c.id||value.commandType!==c.type||value.outletId!==c.outletId||value.occurredAt!==c.occurredAt||!hash(value.commandHash)||!hash(value.sourceHash)||!time(value.at)||!['withdrawn','replaced'].includes(value.outcome as string))throw Error('Keep the actual original money resolution proof.');
 let replacement:MoneyResolutionReceipt['replacement']=null;
 if(value.outcome==='withdrawn'){
  if(value.replacement!==null)throw Error('A withdrawal has no cash or payment receipt.');
 }else{
  const r=value.replacement;
  if(!object(r)||!exact(r,'id,commandHash,confirmation,receipt')||!id(r.id)||r.id===value.id||!hash(r.commandHash))throw Error('Keep the actual replacement money receipt.');
  const consent=confirmation(r.confirmation),command=reviewedMoneyProposal(c,r.id,consent);
  replacement={id:command.id,commandHash:r.commandHash,confirmation:consent,receipt:parseMoneyCommandReceipt(r.receipt,command)};
 }
 return {id:value.id,type:'command.resolved',commandId:c.id,commandType:c.type,outletId:c.outletId,occurredAt:c.occurredAt,commandHash:value.commandHash,sourceHash:value.sourceHash,at:value.at,outcome:value.outcome as MoneyResolutionReceipt['outcome'],replacement};
}
/** Strict bounded comparison, bound to the selected original request. Runtime
 * permission and command/source hashes are independently checked by transports. */
export function parsePreparedMoneyReview(value:unknown,input:MoneyReviewRequest):PreparedMoneyReview {
 const original=originalMoneyFacts(input);
 if(!object(value)||!exact(value,'v,id,replacementId,commandId,commandHash,sourceHash,businessId,outletId,actorId,token,at,expiresAt,current,proposal')||value.v!==1||value.id!==input.id||value.replacementId!==input.replacementId||value.commandId!==input.command.id||value.outletId!==input.command.outletId||value.sourceHash!==input.sourceHash||!hash(value.commandHash)||!id(value.businessId)||!id(value.actorId)||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||!time(value.at)||!time(value.expiresAt)||value.expiresAt<=value.at||value.expiresAt-value.at>300000||!object(value.current)||!object(value.proposal))throw Error('Review this original money action again.');
 const current=value.current;
 if(!exact(current,'profileCurrency,sale,entry,accountId,balance,limit,creditCurrency,creditCustomer')||!currency(current.profileCurrency))throw Error('Keep the current financial comparison.');
 const sale=current.sale,entry=current.entry,customer=current.creditCustomer;
 if(sale!==null&&(!object(sale)||!exact(sale,'id,currency,amount,methodName,voided,closed')||!id(sale.id)||!currency(sale.currency)||!integer(sale.amount,1)||!text(sale.methodName,100)||typeof sale.voided!=='boolean'||typeof sale.closed!=='boolean'))throw Error('Keep the current sale comparison.');
 if(entry!==null&&(!object(entry)||!exact(entry,'id,currency,amount,type')||!id(entry.id)||!currency(entry.currency)||!integer(entry.amount,-Number.MAX_SAFE_INTEGER)||!text(entry.type,40)))throw Error('Keep the current entry comparison.');
 if(object(sale)&&(!('saleId'in input.command)||sale.id!==input.command.saleId)||object(entry)&&(input.command.type==='khata.undo'?entry.id!==input.command.entryId:input.command.type!=='sale.undo'||input.command.entryId===null))throw Error('Keep the original financial target.');
 if(current.accountId===null){if([current.balance,current.limit,current.creditCurrency,customer].some(v=>v!==null))throw Error('Keep the current khata comparison.');}
 else if(!id(current.accountId)||!integer(current.balance,-Number.MAX_SAFE_INTEGER)||!integer(current.limit)||!currency(current.creditCurrency)||!object(customer)||!exact(customer,'id,name,phone')||!id(customer.id)||!text(customer.name,80)||!(customer.phone===null||text(customer.phone,80)))throw Error('Keep the current khata comparison.');
 const proposal=value.proposal;
 if(proposal.enabled===false){if(!exact(proposal,'enabled,reason')||!['currency','unavailable'].includes(proposal.reason as string))throw Error('Keep the unavailable money proposal.');}
 else{
  if(proposal.enabled!==true||!exact(proposal,'enabled,currency,amount,balance,confirmation,requiresCreditConfirmation')||proposal.currency!==original.currency||!integer(proposal.amount,-Number.MAX_SAFE_INTEGER)||!(proposal.balance===null||integer(proposal.balance,-Number.MAX_SAFE_INTEGER))||typeof proposal.requiresCreditConfirmation!=='boolean'||(current.accountId===null)!==(proposal.balance===null)||original.accountId!==current.accountId||original.customerId!==(object(customer)?customer.id:null))throw Error('Keep the original money unit and destination.');
  const consent=confirmation(proposal.confirmation);
  const over=input.command.type==='sale.credit'&&typeof proposal.balance==='number'&&typeof current.limit==='number'&&proposal.balance>current.limit;
  if(proposal.requiresCreditConfirmation!==over||proposal.requiresCreditConfirmation!==(consent!==null)||consent!==null&&(consent.balance!==current.balance||consent.limit!==current.limit))throw Error('Review the exact credit override separately.');
  if((input.command.type==='sale.record'||input.command.type==='sale.credit')&&current.profileCurrency!==original.currency||current.accountId!==null&&current.creditCurrency!==original.currency||object(sale)&&sale.currency!==original.currency||object(entry)&&entry.currency!==original.currency||input.command.type==='sale.undo'&&sale===null||input.command.type==='khata.undo'&&entry===null)throw Error('Keep the original unit and existing financial parent.');
 }
 return structuredClone(value) as unknown as PreparedMoneyReview;
}
