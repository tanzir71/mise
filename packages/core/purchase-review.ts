import {parsePurchaseCommand,parsePurchaseCommandReceipt,purchaseWritePlan,type PurchaseCommand,type PurchaseCommandReceipt} from './purchase-commands';
import {purchaseLineValue} from './purchases';
import {savedPurchaseCurrency} from './purchase-currency';
import type {LocalRowChange} from './local-outbox';
import type {Purchase,PurchaseLine} from './models';

export type FinancialPurchaseCommand=Extract<PurchaseCommand,{type:'purchase.record'|'purchase.undo'}>;
export interface PurchaseReviewRequest {id:string;replacementId:string;command:FinancialPurchaseCommand;sourceHash:string;sourceJson:string}
export interface PurchaseReviewDecision extends PurchaseReviewRequest {token:string;outcome:'withdrawn'|'replaced'}
export interface PurchaseReviewSource {v:1;entryId:string;sequence:number;commandIndex:number;at:number;purchase:LocalRowChange;priorCommands:FinancialPurchaseCommand[]}
export interface PurchaseReviewInvoice {
 id:string;currency:string;timezone:string;total:number;paid:Purchase['paid'];methodName:string;
 supplierId:string|null;supplierName:string;reference:string;lines:PurchaseLine[];createdAt:number;voided:boolean;
}
export interface OriginalPurchaseFacts extends PurchaseReviewInvoice {eventId:string;createdBy:string}
export interface PurchaseResolutionReceipt {
 id:string;type:'command.resolved';commandId:string;commandType:FinancialPurchaseCommand['type'];outletId:string;occurredAt:number;
 commandHash:string;sourceHash:string;at:number;outcome:'withdrawn'|'replaced';
 replacement:{id:string;commandHash:string;receipt:PurchaseCommandReceipt}|null;
}
export interface PreparedPurchaseReview {
 v:1;id:string;replacementId:string;commandId:string;commandHash:string;sourceHash:string;businessId:string;outletId:string;actorId:string;token:string;at:number;expiresAt:number;
 current:{profileCurrency:string;profileTimezone:string;supplier:{id:string;name:string;archived:boolean}|null;invoice:PurchaseReviewInvoice|null};
 proposal:{enabled:false;reason:'currency'|'unavailable'}|{enabled:true;invoice:PurchaseReviewInvoice};
}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=(v:unknown,min=0):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min;
const time=(v:unknown):v is number=>integer(v)&&v<=8640000000000000;
const currency=(v:unknown):v is string=>typeof v==='string'&&/^[A-Z]{3}$/.test(v);
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max;
function timezone(v:unknown):v is string {if(!text(v,128))return false;try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}}
function lines(value:unknown):PurchaseLine[] {
 if(!Array.isArray(value)||value.length<1||value.length>200)throw Error('Keep every original invoice line.');
 return value.map(row=>{
  if(!object(row)||Object.keys(row).some(k=>!['stockItemId','name','unit','qty','unitPrice','lineTotal'].includes(k))||row.stockItemId!==undefined&&!id(row.stockItemId)||typeof row.name!=='string'||typeof row.unit!=='string'||typeof row.qty!=='number'||!integer(row.unitPrice)||!integer(row.lineTotal))throw Error('Keep the original priced invoice lines.');
  const line=purchaseLineValue({stockItemId:row.stockItemId,name:row.name,unit:row.unit,qty:row.qty,unitPrice:row.unitPrice});
  if(line.name!==row.name||line.unit!==row.unit||line.lineTotal!==row.lineTotal)throw Error('Keep the exact original invoice prices and quantities.');return line;
 });
}
function invoice(value:unknown):PurchaseReviewInvoice {
 if(!object(value)||!exact(value,'id,currency,timezone,total,paid,methodName,supplierId,supplierName,reference,lines,createdAt,voided')||!id(value.id)||!currency(value.currency)||!timezone(value.timezone)||!integer(value.total)||!['cash','wallet','card','due'].includes(value.paid as string)||!text(value.methodName,100)||!value.methodName.trim()||!(value.supplierId===null||id(value.supplierId))||!text(value.supplierName,120)||!value.supplierName.trim()||!text(value.reference,120)||!time(value.createdAt)||typeof value.voided!=='boolean')throw Error('Keep the complete invoice comparison.');
 const priced=lines(value.lines),total=priced.reduce((sum,line)=>sum+BigInt(line.lineTotal),0n);if(total!==BigInt(value.total))throw Error('Keep the original invoice total.');
 const method=value.paid==='due'?'Due':value.paid==='cash'?'Cash':value.paid==='card'?'Card':value.methodName;
 if(value.methodName!==method)throw Error('Keep the original invoice payment method.');
 return {id:value.id,currency:value.currency,timezone:value.timezone,total:value.total,paid:value.paid as Purchase['paid'],methodName:value.methodName,supplierId:value.supplierId,supplierName:value.supplierName,reference:value.reference,lines:priced,createdAt:value.createdAt,voided:value.voided};
}
function sourceInvoice(value:unknown):OriginalPurchaseFacts {
 const allowed=['id','outletId','supplierId','supplierName','reference','lines','total','currency','timezone','paid','methodName','note','photoRef','createdBy','eventId','createdAt','updatedAt','voidedAt'];
 if(!object(value)||Object.keys(value).some(k=>!allowed.includes(k))||!id(value.outletId)||!id(value.eventId)||!id(value.createdBy)||!time(value.updatedAt)||!time(value.createdAt)||value.updatedAt<value.createdAt||!text(value.note,4000)||value.photoRef!==undefined&&!text(value.photoRef,2048)||value.voidedAt!==undefined&&(!time(value.voidedAt)||value.voidedAt<value.createdAt||value.updatedAt<value.voidedAt))throw Error('Keep the original complete invoice image.');
 return {...invoice({id:value.id,currency:value.currency,timezone:value.timezone,total:value.total,paid:value.paid,methodName:value.methodName,supplierId:value.supplierId??null,supplierName:value.supplierName,reference:value.reference,lines:value.lines,createdAt:value.createdAt,voided:value.voidedAt!==undefined}),eventId:value.eventId,createdBy:value.createdBy};
}
export function purchaseReviewInvoice(value:Purchase):PurchaseReviewInvoice {
 return invoice({id:value.id,currency:value.currency,timezone:value.timezone,total:value.total,paid:value.paid,methodName:value.methodName,supplierId:value.supplierId??null,supplierName:value.supplierName,reference:value.reference,lines:value.lines,createdAt:value.createdAt,voided:value.voidedAt!==undefined});
}
export function financialPurchaseCommand(value:unknown):FinancialPurchaseCommand {
 const command=parsePurchaseCommand(value);if(command.type!=='purchase.record'&&command.type!=='purchase.undo')throw Error('Choose the original saved invoice action.');return command;
}
/** A distinct audited choice preserves invoice identity, original input and time. */
export function reviewedPurchaseProposal(original:FinancialPurchaseCommand,replacementId:string):FinancialPurchaseCommand {
 const c=financialPurchaseCommand(original);if(!id(replacementId)||replacementId===c.id)throw Error('Keep distinct original and reviewed invoice identities.');return financialPurchaseCommand({...c,id:replacementId});
}
function creationMatches(c:Extract<FinancialPurchaseCommand,{type:'purchase.record'}>,after:OriginalPurchaseFacts):boolean {
 const expected=c.input.lines.map(l=>purchaseLineValue({...l,stockItemId:l.stockItemId??undefined})),method=c.input.paid==='wallet'?c.input.wallet:c.input.paid==='due'?'Due':c.input.paid==='cash'?'Cash':'Card';
 return after.eventId===c.id&&after.createdAt===c.occurredAt&&after.supplierId===c.input.supplierId&&(after.supplierId!==null||after.supplierName===c.input.supplierName.trim())&&after.reference===c.input.reference.trim()&&after.paid===c.input.paid&&after.methodName===method&&JSON.stringify(after.lines)===JSON.stringify(expected);
}
export function parsePurchaseReviewSource(input:PurchaseReviewRequest):PurchaseReviewSource {
 const c=financialPurchaseCommand(input.command);let value:unknown;try{value=JSON.parse(input.sourceJson);}catch{throw Error('Keep the original invoice source.');}
 if(!object(value)||!exact(value,'v,entryId,sequence,commandIndex,at,purchase,priorCommands')||value.v!==1||!id(value.entryId)||!integer(value.sequence,1)||!integer(value.commandIndex)||!time(value.at)||!object(value.purchase)||!exact(value.purchase,'table,key,before,after')||value.purchase.table!=='purchases'||value.purchase.key!==c.purchaseId||!Array.isArray(value.priorCommands)||value.priorCommands.length>1)throw Error('Keep the original invoice source.');
 const row=value.purchase,after=sourceInvoice(row.after);if(!object(row.after)||row.after.outletId!==c.outletId||after.id!==c.purchaseId)throw Error('Keep the original invoice destination.');
 const priorCommands=value.priorCommands.map(financialPurchaseCommand);
 if(priorCommands.some(p=>c.type!=='purchase.undo'||p.type!=='purchase.record'||p.purchaseId!==c.purchaseId||p.outletId!==c.outletId||p.id===c.id||!creationMatches(p,after)||!object(row.after)||row.after.note!==p.input.note.trim())||priorCommands.length&&row.before!==null)throw Error('Keep the actual earlier invoice creation.');
 if(c.type==='purchase.record'){
  if(row.before!==null||priorCommands.length||!creationMatches(c,after)||row.after.note!==c.input.note.trim())throw Error('Keep the original invoice values and creation identity.');
 }else{
  if(row.after.voidedAt!==c.occurredAt)throw Error('Keep the original invoice undo time.');
  if(row.before!==null){const before=sourceInvoice(row.before);if(!object(row.before)||row.before.outletId!==c.outletId||before.voided||row.before.note!==row.after.note||row.before.photoRef!==row.after.photoRef||JSON.stringify({...before,voided:true})!==JSON.stringify(after))throw Error('Keep the same original invoice before and after undo.');}
  else if(priorCommands.length!==1)throw Error('Keep the actual original invoice creation.');
 }
 const purchase=row as unknown as LocalRowChange;if(!savedPurchaseCurrency(c,[purchase],priorCommands))throw Error('Keep the original invoice currency.');
 return {v:1,entryId:value.entryId,sequence:value.sequence,commandIndex:value.commandIndex,at:value.at,purchase,priorCommands};
}
export function originalPurchaseFacts(input:PurchaseReviewRequest):OriginalPurchaseFacts {return sourceInvoice(parsePurchaseReviewSource(input).purchase.after);}
export function parsePurchaseReviewRequest(value:unknown,decision:false):PurchaseReviewRequest;
export function parsePurchaseReviewRequest(value:unknown,decision:true):PurchaseReviewDecision;
export function parsePurchaseReviewRequest(value:unknown,decision:boolean):PurchaseReviewRequest|PurchaseReviewDecision {
 if(!object(value)||!exact(value,decision?'id,replacementId,command,sourceHash,sourceJson,token,outcome':'id,replacementId,command,sourceHash,sourceJson')||!id(value.id)||!id(value.replacementId)||!hash(value.sourceHash)||typeof value.sourceJson!=='string'||new TextEncoder().encode(value.sourceJson).length>4_000_000)throw Error('Keep the complete original invoice action.');
 const command=financialPurchaseCommand(value.command),plan=purchaseWritePlan(command),reserved=new Set([command.id,command.outletId,command.purchaseId,plan.supplierId,...plan.stockItemIds]);
 if(value.id===value.replacementId||reserved.has(value.id)||reserved.has(value.replacementId))throw Error('Use distinct original and reviewed invoice identities.');
 const input:PurchaseReviewRequest={id:value.id,replacementId:value.replacementId,command,sourceHash:value.sourceHash,sourceJson:value.sourceJson},facts=originalPurchaseFacts(input);
 if(value.id===facts.eventId||value.replacementId===facts.eventId)throw Error('Keep the original invoice audit identity.');
 if(!decision)return input;if(typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||!['withdrawn','replaced'].includes(value.outcome as string))throw Error('Choose the current invoice comparison.');
 return {...input,token:value.token,outcome:value.outcome as PurchaseReviewDecision['outcome']};
}
export function parsePurchaseResolutionReceipt(value:unknown,original:FinancialPurchaseCommand):PurchaseResolutionReceipt {
 const c=financialPurchaseCommand(original);
 if(!object(value)||!exact(value,'id,type,commandId,commandType,outletId,occurredAt,commandHash,sourceHash,at,outcome,replacement')||!id(value.id)||value.id===c.id||value.type!=='command.resolved'||value.commandId!==c.id||value.commandType!==c.type||value.outletId!==c.outletId||value.occurredAt!==c.occurredAt||!hash(value.commandHash)||!hash(value.sourceHash)||!time(value.at)||!['withdrawn','replaced'].includes(value.outcome as string))throw Error('Keep the actual original invoice resolution.');
 let replacement:PurchaseResolutionReceipt['replacement']=null;
 if(value.outcome==='withdrawn'){if(value.replacement!==null)throw Error('A withdrawal has no invoice receipt.');}
 else{const r=value.replacement;if(!object(r)||!exact(r,'id,commandHash,receipt')||!id(r.id)||r.id===value.id||!hash(r.commandHash))throw Error('Keep the actual replacement invoice receipt.');const command=reviewedPurchaseProposal(c,r.id);replacement={id:command.id,commandHash:r.commandHash,receipt:parsePurchaseCommandReceipt(r.receipt,command)};}
 return {id:value.id,type:'command.resolved',commandId:c.id,commandType:c.type,outletId:c.outletId,occurredAt:c.occurredAt,commandHash:value.commandHash,sourceHash:value.sourceHash,at:value.at,outcome:value.outcome as PurchaseResolutionReceipt['outcome'],replacement};
}
export function parsePreparedPurchaseReview(value:unknown,input:PurchaseReviewRequest):PreparedPurchaseReview {
 const original=originalPurchaseFacts(input),c=input.command;
 if(!object(value)||!exact(value,'v,id,replacementId,commandId,commandHash,sourceHash,businessId,outletId,actorId,token,at,expiresAt,current,proposal')||value.v!==1||value.id!==input.id||value.replacementId!==input.replacementId||value.commandId!==c.id||value.outletId!==c.outletId||value.sourceHash!==input.sourceHash||!hash(value.commandHash)||!id(value.businessId)||!id(value.actorId)||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||!time(value.at)||!time(value.expiresAt)||value.expiresAt<=value.at||value.expiresAt-value.at>300000||!object(value.current)||!object(value.proposal))throw Error('Review the original invoice again.');
 const current=value.current;if(!exact(current,'profileCurrency,profileTimezone,supplier,invoice')||!currency(current.profileCurrency)||!timezone(current.profileTimezone))throw Error('Keep the current invoice comparison.');
 const supplier=current.supplier;if(supplier!==null&&(!object(supplier)||!exact(supplier,'id,name,archived')||supplier.id!==original.supplierId||!text(supplier.name,120)||typeof supplier.archived!=='boolean'))throw Error('Keep the original supplier destination.');
 const existing=current.invoice===null?null:invoice(current.invoice);if(existing&&existing.id!==c.purchaseId)throw Error('Keep the original invoice identity.');
 const proposal=value.proposal;
 if(proposal.enabled===false){if(!exact(proposal,'enabled,reason')||!['currency','unavailable'].includes(proposal.reason as string))throw Error('Keep the unavailable invoice proposal.');}
 else{
  if(proposal.enabled!==true||!exact(proposal,'enabled,invoice'))throw Error('Keep the complete replacement invoice comparison.');const next=invoice(proposal.invoice);
  if(next.id!==c.purchaseId||next.currency!==original.currency||next.total!==original.total||next.paid!==original.paid||next.methodName!==original.methodName||next.supplierId!==original.supplierId||next.reference!==original.reference||JSON.stringify(next.lines)!==JSON.stringify(original.lines)||next.createdAt!==original.createdAt||next.voided!==(c.type==='purchase.undo'))throw Error('Keep the original invoice values and clock.');
  if(c.type==='purchase.record'){
   if(existing||current.profileCurrency!==original.currency||next.timezone!==current.profileTimezone||next.supplierName!==(supplier&&object(supplier)?supplier.name:original.supplierName)||original.supplierId!==null&&(!supplier||supplier.archived))throw Error('Keep the original currency and current active supplier.');
  }else if(!existing||existing.voided||existing.currency!==original.currency||JSON.stringify({...existing,voided:true})!==JSON.stringify(next)||value.at<existing.createdAt||value.at-existing.createdAt>600000||c.occurredAt<existing.createdAt)throw Error('Keep the original unvoided invoice and ten-minute undo limit.');
 }
 return structuredClone(value) as unknown as PreparedPurchaseReview;
}
