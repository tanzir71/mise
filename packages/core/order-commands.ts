import {orderStatusLabels,type OrderInput} from './orders';
import {orderLineTotal,type OrderLineInput} from './order-lines';
import {ORDER_SOURCE_MAX_TEXT} from './order-limits';
import type {OrderRefundInput,OrderSettlementInput} from './order-payments';
import type {OrderCommunication,OrderStatus} from './models';
import type {OverLimitConfirmation} from './khata';

export const orderBodyHeader='X-Mise-Order-Write',orderBodyLimit=2_000_000;
/** Reserve companion identities once, including branches that may not create money. */
export interface OrderFinanceIds {saleId:string;saleEventId:string;entryId:string;creditEventId:string;refundId:string;refundEventId:string}
export interface OrderSettlement {id:string;input:OrderSettlementInput;ids:OrderFinanceIds}
interface Base {id:string;outletId:string;orderId:string;occurredAt:number}
export type OrderCommand=
 |(Base&{type:'order.create'|'order.update';revision:number;input:OrderInput;newLineIds:string[];settlement:OrderSettlement|null})
 |(Base&{type:'order.status';revision:number;status:OrderStatus;sourceSaleId:string|null;ids:OrderFinanceIds})
 |(Base&{type:'order.status-undo';revision:number;sourceSaleId:string|null;ids:OrderFinanceIds})
 |(Base&{type:'order.note';revision:number;noteId:string;text:string})
 |(Base&{type:'order.communication';revision:number;communicationId:string;input:Pick<OrderCommunication,'purpose'|'channel'|'text'>})
 |(Base&{type:'order.payment';revision:number;input:OrderSettlementInput;ids:OrderFinanceIds})
 |(Base&{type:'order.payment-undo';revision:number;sourceSaleId:string|null;sourcePaymentAt:number;ids:OrderFinanceIds})
 |(Base&{type:'order.refund';revision:number;sourceSaleId:string;input:OrderRefundInput;ids:OrderFinanceIds})
 |(Base&{type:'order.refund-undo';revision:number;refundId:string;ids:OrderFinanceIds})
 |{id:string;outletId:string;occurredAt:number;type:'order.warning-settings';minutes:number};
export interface OrderCommandReceipt {id:string;type:OrderCommand['type'];outletId:string;orderId:string|null;occurredAt:number;at:number;revision:number|null;sequence:number|null;number:string|null;total:number|null;updatedAt:number;saleId:string|null;entryId:string|null;refundId:string|null;noteId:string|null;communicationId:string|null;undoOf:string|null}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const integer=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const fields=(v:Record<string,unknown>,required:string,optional='')=>required.split(',').every(k=>k in v)&&Object.keys(v).every(k=>(required+','+optional).split(',').includes(k));
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys;
function text(v:unknown,max:number,nonempty=false,single=false):string {if(typeof v!=='string'||v.trim().length>max||nonempty&&!v.trim()||single&&/[\r\n]/.test(v))throw new Error('Check the order text.');return v;}
function finance(v:unknown):OrderFinanceIds {if(!object(v)||!exact(v,'creditEventId,entryId,refundEventId,refundId,saleEventId,saleId')||!Object.values(v).every(id))throw new Error('Keep the device financial IDs.');return {saleId:v.saleId as string,saleEventId:v.saleEventId as string,entryId:v.entryId as string,creditEventId:v.creditEventId as string,refundId:v.refundId as string,refundEventId:v.refundEventId as string};}
function confirmation(v:unknown):OverLimitConfirmation|undefined {if(v===undefined)return undefined;if(!object(v)||!exact(v,'balance,limit')||!integer(v.balance,-Number.MAX_SAFE_INTEGER)||!integer(v.limit))throw new Error('Check the current credit confirmation.');return {balance:v.balance,limit:v.limit};}
function payment(v:unknown):OrderSettlementInput {
 if(!object(v)||!fields(v,'method','wallet,given,accountId,confirmation')||!['cash','wallet','card','credit'].includes(v.method as string)||v.wallet!==undefined&&typeof v.wallet!=='string'||typeof v.wallet==='string'&&v.wallet.length>80||v.given!==undefined&&!integer(v.given)||v.accountId!==undefined&&!id(v.accountId)||v.method!=='credit'&&(v.accountId!==undefined||v.confirmation!==undefined)||v.method!=='wallet'&&v.wallet!==undefined||v.method!=='cash'&&v.given!==undefined)throw new Error('Check the payment.');
 return {method:v.method as OrderSettlementInput['method'],wallet:v.wallet as string|undefined,given:v.given as number|undefined,accountId:v.accountId as string|undefined,confirmation:confirmation(v.confirmation)};
}
function line(v:unknown):OrderLineInput {
 if(!object(v)||!fields(v,'name,unit,qty,unitPrice','id,itemId,note,unavailable,substitution')||v.id!==undefined&&!id(v.id)||v.itemId!==undefined&&!id(v.itemId)||!(v.unitPrice===null||integer(v.unitPrice))||typeof v.qty!=='number'||v.unavailable!==undefined&&typeof v.unavailable!=='boolean')throw new Error('Check the order lines.');
 orderLineTotal(v.unitPrice??0,v.qty);
 let substitution:OrderLineInput['substitution'];if(v.substitution!==undefined){const s=v.substitution;if(!object(s)||!exact(s,'accepted,from')||typeof s.accepted!=='boolean')throw new Error('Confirm a swap explicitly.');substitution={from:text(s.from,120,true,true),accepted:s.accepted};}
 return {id:v.id as string|undefined,itemId:v.itemId as string|undefined,name:text(v.name,120,true,true),unit:text(v.unit,24,true,true),qty:v.qty,unitPrice:v.unitPrice as number|null,note:v.note===undefined?undefined:text(v.note,500),unavailable:v.unavailable as boolean|undefined,substitution};
}
function input(v:unknown):OrderInput {
 if(!object(v)||!fields(v,'source,sourceText,name,phone,type,address,table,lines,deliveryFee,discount,payment','customerId,scheduledFor')||!['phone','walk_in','table','paste','other'].includes(v.source as string)||!['delivery','pickup','dine_in'].includes(v.type as string)||v.customerId!==undefined&&!id(v.customerId)||v.scheduledFor!==undefined&&!integer(v.scheduledFor,0,8640000000000000)||!integer(v.deliveryFee)||!integer(v.discount)||!Array.isArray(v.lines)||v.lines.length<1||v.lines.length>200||!object(v.payment)||!fields(v.payment,'method','wallet')||!['cash','wallet','card','credit'].includes(v.payment.method as string)||v.payment.wallet!==undefined&&(typeof v.payment.wallet!=='string'||v.payment.wallet.length>80)||typeof v.sourceText!=='string'||v.sourceText.length>ORDER_SOURCE_MAX_TEXT)throw new Error('Check the order details.');
 return {source:v.source as OrderInput['source'],sourceText:v.sourceText,customerId:v.customerId as string|undefined,name:text(v.name,80,false,true),phone:text(v.phone,80),type:v.type as OrderInput['type'],address:text(v.address,250),table:text(v.table,40),scheduledFor:v.scheduledFor as number|undefined,lines:v.lines.map(line),deliveryFee:v.deliveryFee,discount:v.discount,payment:{method:v.payment.method as OrderInput['payment']['method'],wallet:v.payment.wallet as string|undefined}};
}
export function isOrderCommandType(v:unknown):v is OrderCommand['type'] {return typeof v==='string'&&['order.create','order.update','order.status','order.status-undo','order.note','order.communication','order.payment','order.payment-undo','order.refund','order.refund-undo','order.warning-settings'].includes(v);}
export const isOrderSave=(c:OrderCommand):c is Extract<OrderCommand,{type:'order.create'|'order.update'}>=>c.type==='order.create'||c.type==='order.update';
export function parseOrderCommand(v:unknown):OrderCommand {
 if(!object(v)||!id(v.id)||!id(v.outletId)||!integer(v.occurredAt,0,8640000000000000))throw new Error('Use valid order command IDs and time.');
 const base={id:v.id,outletId:v.outletId,occurredAt:v.occurredAt};let c:OrderCommand;
 if(v.type==='order.warning-settings'&&exact(v,'id,minutes,occurredAt,outletId,type')&&integer(v.minutes,1,1440))return {...base,type:v.type,minutes:v.minutes};
 const steps=(v.type==='order.create'||v.type==='order.update')&&v.settlement!==null?2:1;
 if(!id(v.orderId)||!integer(v.revision,v.type==='order.create'?0:1,Number.MAX_SAFE_INTEGER-steps))throw new Error('Keep the order and reviewed revision.');
 const b={...base,orderId:v.orderId,revision:v.revision};
 if((v.type==='order.create'||v.type==='order.update')&&exact(v,'id,input,newLineIds,occurredAt,orderId,outletId,revision,settlement,type')){
  if(v.type==='order.create'&&v.revision!==0||!Array.isArray(v.newLineIds)||!v.newLineIds.every(id))throw new Error('Keep the new order line identities.');
  const p=input(v.input);if(v.newLineIds.length!==p.lines.filter(l=>!l.id).length||v.type==='order.create'&&p.lines.some(l=>l.id))throw new Error('Allocate each new line exactly once.');
  let settlement:OrderSettlement|null=null;if(v.settlement!==null){const s=v.settlement;if(!object(s)||!exact(s,'id,ids,input')||!id(s.id))throw new Error('Keep the companion payment identity.');settlement={id:s.id,input:payment(s.input),ids:finance(s.ids)};}
  c={...b,type:v.type,input:p,newLineIds:[...v.newLineIds],settlement};
 }else if(v.type==='order.status'&&exact(v,'id,ids,occurredAt,orderId,outletId,revision,sourceSaleId,status,type')&&typeof v.status==='string'&&Object.hasOwn(orderStatusLabels,v.status)&&(v.sourceSaleId===null||id(v.sourceSaleId)))c={...b,type:v.type,status:v.status as OrderStatus,sourceSaleId:v.sourceSaleId,ids:finance(v.ids)};
 else if(v.type==='order.status-undo'&&exact(v,'id,ids,occurredAt,orderId,outletId,revision,sourceSaleId,type')&&(v.sourceSaleId===null||id(v.sourceSaleId)))c={...b,type:v.type,sourceSaleId:v.sourceSaleId,ids:finance(v.ids)};
 else if(v.type==='order.payment-undo'&&exact(v,'id,ids,occurredAt,orderId,outletId,revision,sourcePaymentAt,sourceSaleId,type')&&(v.sourceSaleId===null||id(v.sourceSaleId))&&integer(v.sourcePaymentAt,0,8640000000000000))c={...b,type:v.type,sourceSaleId:v.sourceSaleId,sourcePaymentAt:v.sourcePaymentAt,ids:finance(v.ids)};
 else if(v.type==='order.note'&&exact(v,'id,noteId,occurredAt,orderId,outletId,revision,text,type')&&id(v.noteId))c={...b,type:v.type,noteId:v.noteId,text:text(v.text,2000,true)};
 else if(v.type==='order.communication'&&exact(v,'communicationId,id,input,occurredAt,orderId,outletId,revision,type')&&id(v.communicationId)&&object(v.input)&&exact(v.input,'channel,purpose,text')&&['quote','message','call'].includes(v.input.purpose as string)&&['whatsapp','manual','call'].includes(v.input.channel as string))c={...b,type:v.type,communicationId:v.communicationId,input:{purpose:v.input.purpose as OrderCommunication['purpose'],channel:v.input.channel as OrderCommunication['channel'],text:text(v.input.text,4000,true)}};
 else if(v.type==='order.payment'&&exact(v,'id,ids,input,occurredAt,orderId,outletId,revision,type'))c={...b,type:v.type,input:payment(v.input),ids:finance(v.ids)};
 else if(v.type==='order.refund'&&exact(v,'id,ids,input,occurredAt,orderId,outletId,revision,sourceSaleId,type')&&id(v.sourceSaleId)&&object(v.input)&&fields(v.input,'amount,method','wallet,note')&&integer(v.input.amount,1)&&['cash','wallet','card'].includes(v.input.method as string)&&(v.input.wallet===undefined||typeof v.input.wallet==='string'&&v.input.wallet.length<=80))c={...b,type:v.type,sourceSaleId:v.sourceSaleId,input:{amount:v.input.amount,method:v.input.method as OrderRefundInput['method'],wallet:v.input.wallet as string|undefined,note:v.input.note===undefined?undefined:text(v.input.note,1000)},ids:finance(v.ids)};
 else if(v.type==='order.refund-undo'&&exact(v,'id,ids,occurredAt,orderId,outletId,refundId,revision,type')&&id(v.refundId))c={...b,type:v.type,refundId:v.refundId,ids:finance(v.ids)};
 else throw new Error('Choose a supported order action and its exact fields.');
 const f='ids'in c?c.ids:isOrderSave(c)?c.settlement?.ids:undefined;
 const allocated=[c.id,...('orderId'in c?[c.orderId]:[]),...(f?Object.values(f):[]),...(isOrderSave(c)?[...c.newLineIds,...c.input.lines.flatMap(l=>l.id?[l.id]:[]),...(c.settlement?[c.settlement.id]:[])]:[]),...(c.type==='order.note'?[c.noteId]:[]),...(c.type==='order.communication'?[c.communicationId]:[]),...(c.type==='order.refund-undo'?[c.refundId]:[]),...('sourceSaleId'in c&&c.sourceSaleId?[c.sourceSaleId]:[])];
 if(new Set(allocated).size!==allocated.length)throw new Error('Use distinct order, line, related-record and audit IDs.');return c;
}
/** Safe JSONB IDs plus the escaped canonical text; customer text remains inert. */
export function orderWritePlan(command:OrderCommand){
 const c=parseOrderCommand(command),save=isOrderSave(c)?c:null,settlement=save?.settlement;
 return {orderId:'orderId'in c?c.orderId:null,revision:'revision'in c?c.revision:null,customerId:save?.input.customerId??null,accountId:c.type==='order.payment'?c.input.accountId??null:settlement?.input.accountId??null,refundId:c.type==='order.refund-undo'?c.refundId:null,itemIds:save?[...new Set(save.input.lines.flatMap(l=>l.itemId?[l.itemId]:[]))].sort():[],newLineIds:save?.newLineIds??[],noteId:c.type==='order.note'?c.noteId:null,communicationId:c.type==='order.communication'?c.communicationId:null,finance:'ids'in c?c.ids:settlement?.ids??null,settlementId:settlement?.id??null,status:c.type==='order.status'?c.status:null,sourceSaleId:'sourceSaleId'in c?c.sourceSaleId:null,sourcePaymentAt:c.type==='order.payment-undo'?c.sourcePaymentAt:null,intentJson:JSON.stringify(c),bindings:{method:c.type==='order.payment'?c.input.method:settlement?.input.method??null,minutes:c.type==='order.warning-settings'?c.minutes:null,refundAmount:c.type==='order.refund'?c.input.amount:null,noteJson:c.type==='order.note'?JSON.stringify(c.text.trim()):null,purpose:c.type==='order.communication'?c.input.purpose:null,channel:c.type==='order.communication'?c.input.channel:null,textJson:c.type==='order.communication'?JSON.stringify(c.input.text.trim()):null}};
}
/** These intents carry no settlement; current domain/financial source guards still apply. */
export function usesCurrentOrderRevision(c:OrderCommand):boolean {
 return c.type==='order.note'||c.type==='order.communication'||c.type==='order.update'&&c.settlement===null||c.type==='order.status'&&c.status!=='cancelled';
}
export function parseOrderCommandReceipt(v:unknown,c:OrderCommand):OrderCommandReceipt {
 if(!object(v)||!exact(v,'at,communicationId,entryId,id,noteId,number,occurredAt,orderId,outletId,refundId,revision,saleId,sequence,total,type,undoOf,updatedAt')||v.id!==c.id||v.type!==c.type||v.outletId!==c.outletId||v.occurredAt!==c.occurredAt||!integer(v.at,0,8640000000000000)||!integer(v.updatedAt,0,8640000000000000)||!['orderId','saleId','entryId','refundId','noteId','communicationId','undoOf'].every(k=>v[k]===null||id(v[k]))||!(v.total===null||integer(v.total)))throw new Error('Invalid order receipt.');
 if(c.type==='order.warning-settings'){if(['orderId','revision','sequence','number','total','saleId','entryId','refundId','noteId','communicationId','undoOf'].some(k=>v[k]!==null))throw new Error('Invalid order settings receipt.');}
 else{
  const f='ids'in c?c.ids:isOrderSave(c)?c.settlement?.ids:undefined,steps=isOrderSave(c)&&c.settlement?2:1,revisionMatches=usesCurrentOrderRevision(c)?integer(v.revision,c.revision+steps):v.revision===c.revision+steps;
  if(v.orderId!==c.orderId||!revisionMatches||!integer(v.sequence,1)||typeof v.number!=='string'||!v.number||v.number.length>64||v.noteId!==(c.type==='order.note'?c.noteId:null)||v.communicationId!==(c.type==='order.communication'?c.communicationId:null)||v.entryId!==null&&v.entryId!==f?.entryId||v.refundId!==(c.type==='order.refund'?c.ids.refundId:c.type==='order.refund-undo'?c.refundId:null)||v.saleId!==null&&(c.type==='order.payment'||isOrderSave(c)&&c.settlement)&&v.saleId!==f?.saleId||v.undoOf!==(c.type==='order.refund-undo'?c.refundId:c.type==='order.payment-undo'||c.type==='order.status-undo'?c.orderId:null))throw new Error('The order receipt does not match the device intent.');
  const settlement=c.type==='order.payment'?c.input:isOrderSave(c)?c.settlement?.input:undefined;
  if(v.updatedAt<v.at||v.updatedAt<c.occurredAt||settlement&&(v.total===null||v.total===0&&(v.saleId!==null||v.entryId!==null)||(v.total as number)>0&&(v.saleId!==f?.saleId||v.entryId!==(settlement.method==='credit'?f?.entryId:null))))throw new Error('The order receipt is missing its financial result.');
  if((c.type==='order.payment-undo'||c.type==='order.status'&&c.status==='cancelled')&&v.saleId!==c.sourceSaleId
   ||c.type==='order.status-undo'&&v.saleId!==null&&v.saleId!==c.sourceSaleId
   ||(c.type==='order.note'||c.type==='order.communication'||isOrderSave(c)&&!c.settlement||c.type==='order.status'&&c.status!=='cancelled')&&(v.saleId!==null||v.entryId!==null)
   ||(c.type==='order.refund'||c.type==='order.refund-undo')&&v.saleId!==null)throw new Error('The order receipt changes unrelated money.');
 }
 return {id:c.id,type:c.type,outletId:c.outletId,occurredAt:c.occurredAt,at:v.at,updatedAt:v.updatedAt,orderId:v.orderId as string|null,revision:v.revision as number|null,sequence:v.sequence as number|null,number:v.number as string|null,total:v.total as number|null,saleId:v.saleId as string|null,entryId:v.entryId as string|null,refundId:v.refundId as string|null,noteId:v.noteId as string|null,communicationId:v.communicationId as string|null,undoOf:v.undoOf as string|null};
}
