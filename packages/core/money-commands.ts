import {normalizeExpression} from './calc';
import type {SaleInput} from './sales';
import type {PaymentMethod} from './models';
import type {OverLimitConfirmation} from './khata';
type Lines=NonNullable<SaleInput['items']>;
export type MoneyCommand=
 |{id:string;occurredAt:number;type:'sale.record';outletId:string;saleId:string;input:{expression:string;method:PaymentMethod;wallet:string|null;given:number|null;who:string;items:Lines}}
 |{id:string;occurredAt:number;type:'sale.credit';outletId:string;saleId:string;accountId:string;entryId:string;creditEventId:string;input:{expression:string;items:Lines;confirmation:OverLimitConfirmation|null}}
 |{id:string;occurredAt:number;type:'sale.undo';outletId:string;saleId:string;entryId:string|null;creditEventId:string|null}
 |{id:string;occurredAt:number;type:'khata.payment';outletId:string;accountId:string;entryId:string;input:{amount:number;method:PaymentMethod;wallet:string|null;note:string}}
 |{id:string;occurredAt:number;type:'khata.undo';outletId:string;entryId:string;reversalId:string}
 |{id:string;occurredAt:number;type:'khata.communication';outletId:string;accountId:string;entryId:string;input:{purpose:'reminder'|'receipt'|'call';text:string;channel:'whatsapp'|'manual'|'call'}};
export interface MoneyCommandReceipt {id:string;occurredAt:number;type:MoneyCommand['type'];outletId:string;saleId:string|null;accountId:string|null;entryId:string|null;amount:number;at:number;saleUpdatedAt:number|null;entrySequence:number|null;undoOf:string|null}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const integer=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys;
const method=(v:unknown):v is PaymentMethod=>v==='cash'||v==='wallet'||v==='card';
const wallet=(v:unknown):v is string|null=>v===null||typeof v==='string'&&v.length<=80;
function lines(v:unknown):Lines {
 if(!Array.isArray(v)||v.length>200||!v.every(l=>object(l)&&exact(l,'itemId,qty,unitPrice')&&id(l.itemId)&&integer(l.qty,1,999)&&integer(l.unitPrice)))throw new Error('Check the item lines.');
 return v.map(l=>({itemId:l.itemId,qty:l.qty,unitPrice:l.unitPrice}));
}
function expression(v:unknown):string {if(typeof v!=='string'||!normalizeExpression(v)||normalizeExpression(v).length>160)throw new Error('Check the calculation.');return v;}
function confirmation(v:unknown):OverLimitConfirmation|null {
 if(v===null)return null;if(!object(v)||!exact(v,'balance,limit')||!integer(v.balance,-Number.MAX_SAFE_INTEGER)||!integer(v.limit))throw new Error('Check the exact credit confirmation.');return {balance:v.balance,limit:v.limit};
}
export function isMoneyCommandType(v:unknown):v is MoneyCommand['type'] {return typeof v==='string'&&['sale.record','sale.credit','sale.undo','khata.payment','khata.undo','khata.communication'].includes(v);}
/** Only IDs needed for a scoped server read; never a caller-selected tenant/actor. */
export function moneyWritePlan(c:MoneyCommand){return {saleId:'saleId'in c?c.saleId:null,accountId:'accountId'in c?c.accountId:null,entryId:'entryId'in c?c.entryId:null,reversalId:c.type==='khata.undo'?c.reversalId:null,creditEventId:'creditEventId'in c?c.creditEventId:null,itemIds:'input'in c&&'items'in c.input?[...new Set(c.input.items.map(l=>l.itemId))].sort():[]};}
export function parseMoneyCommand(v:unknown):MoneyCommand {
 if(!object(v)||!id(v.id)||!id(v.outletId)||!integer(v.occurredAt,0,8640000000000000))throw new Error('Use valid command and outlet IDs.');
 const base={id:v.id,outletId:v.outletId,occurredAt:v.occurredAt};let command:MoneyCommand;
 if(v.type==='sale.record'&&exact(v,'id,input,occurredAt,outletId,saleId,type')&&id(v.saleId)&&object(v.input)){
  const p=v.input;if(!exact(p,'expression,given,items,method,wallet,who')||!method(p.method)||!wallet(p.wallet)||!(p.given===null||integer(p.given))||typeof p.who!=='string'||p.who.trim().length>80)throw new Error('Check the sale details.');
  command={...base,type:v.type,saleId:v.saleId,input:{expression:expression(p.expression),method:p.method,wallet:p.wallet,given:p.given,who:p.who,items:lines(p.items)}};
 }else if(v.type==='sale.credit'&&exact(v,'accountId,creditEventId,entryId,id,input,occurredAt,outletId,saleId,type')&&id(v.saleId)&&id(v.accountId)&&id(v.entryId)&&id(v.creditEventId)&&object(v.input)&&exact(v.input,'confirmation,expression,items')){
  command={...base,type:v.type,saleId:v.saleId,accountId:v.accountId,entryId:v.entryId,creditEventId:v.creditEventId,input:{expression:expression(v.input.expression),items:lines(v.input.items),confirmation:confirmation(v.input.confirmation)}};
 }else if(v.type==='sale.undo'&&exact(v,'creditEventId,entryId,id,occurredAt,outletId,saleId,type')&&id(v.saleId)&&(v.entryId===null||id(v.entryId))&&(v.creditEventId===null||id(v.creditEventId))&&((v.entryId===null)===(v.creditEventId===null))){
  command={...base,type:v.type,saleId:v.saleId,entryId:v.entryId,creditEventId:v.creditEventId};
 }else if(v.type==='khata.payment'&&exact(v,'accountId,entryId,id,input,occurredAt,outletId,type')&&id(v.accountId)&&id(v.entryId)&&object(v.input)){
  const p=v.input;if(!exact(p,'amount,method,note,wallet')||!integer(p.amount,1)||!method(p.method)||!wallet(p.wallet)||typeof p.note!=='string'||p.note.length>4000)throw new Error('Check the payment details.');
  command={...base,type:v.type,accountId:v.accountId,entryId:v.entryId,input:{amount:p.amount,method:p.method,wallet:p.wallet,note:p.note}};
 }else if(v.type==='khata.undo'&&exact(v,'entryId,id,occurredAt,outletId,reversalId,type')&&id(v.entryId)&&id(v.reversalId)){
  command={...base,type:v.type,entryId:v.entryId,reversalId:v.reversalId};
 }else if(v.type==='khata.communication'&&exact(v,'accountId,entryId,id,input,occurredAt,outletId,type')&&id(v.accountId)&&id(v.entryId)&&object(v.input)){
  const p=v.input;if(!exact(p,'channel,purpose,text')||!['reminder','receipt','call'].includes(p.purpose as string)||!['whatsapp','manual','call'].includes(p.channel as string)||typeof p.text!=='string'||p.text.length>4000)throw new Error('Check the communication record.');
  command={...base,type:v.type,accountId:v.accountId,entryId:v.entryId,input:{purpose:p.purpose as 'reminder'|'receipt'|'call',channel:p.channel as 'whatsapp'|'manual'|'call',text:p.text}};
 }else throw new Error('Choose a supported money action and its exact fields.');
 const ids=[command.id,...('saleId'in command?[command.saleId]:[]),...('entryId'in command&&command.entryId?[command.entryId]:[]),...('creditEventId'in command&&command.creditEventId?[command.creditEventId]:[]),...('reversalId'in command?[command.reversalId]:[])];
 if(new Set(ids).size!==ids.length)throw new Error('Use distinct record and audit IDs.');return command;
}
export function parseMoneyCommandReceipt(v:unknown,c:MoneyCommand):MoneyCommandReceipt {
 if(!object(v)||v.id!==c.id||v.type!==c.type||v.outletId!==c.outletId||v.occurredAt!==c.occurredAt||!(v.saleId===null||id(v.saleId))||!(v.accountId===null||id(v.accountId))||!(v.entryId===null||id(v.entryId))||!integer(v.amount,-Number.MAX_SAFE_INTEGER)||!integer(v.at,0,8640000000000000)||!(v.saleUpdatedAt===null||integer(v.saleUpdatedAt,0,8640000000000000))||!(v.entrySequence===null||integer(v.entrySequence,1))||((v.saleId===null)!==(v.saleUpdatedAt===null))||((v.entryId===null)!==(v.entrySequence===null)))throw new Error('Invalid money receipt.');
 const expectedSale='saleId'in c?c.saleId:null,expectedEntry=c.type==='khata.undo'?c.reversalId:'entryId'in c?c.entryId:null,undo=c.type==='sale.undo'?c.saleId:c.type==='khata.undo'?c.entryId:null;
 if(v.saleId!==expectedSale||v.entryId!==expectedEntry||v.undoOf!==undo||('accountId'in c&&v.accountId!==c.accountId)||((c.type==='sale.record'||c.type==='sale.credit')&&v.amount<=0)||(c.type==='sale.record'&&v.accountId!==null)||(c.type==='sale.undo'&&(v.amount>=0||((v.entryId===null)!==(v.accountId===null))))||(c.type==='khata.payment'&&v.amount!==c.input.amount)||(c.type==='khata.communication'&&v.amount!==0)||(v.entryId!==null&&v.accountId===null))throw new Error('Money receipt does not match the intent.');
 return {id:c.id,occurredAt:c.occurredAt,type:c.type,outletId:c.outletId,saleId:v.saleId,accountId:v.accountId,entryId:v.entryId,amount:v.amount,at:v.at,saleUpdatedAt:v.saleUpdatedAt,entrySequence:v.entrySequence,undoOf:v.undoOf as string|null};
}
