import type {MiseDatabase} from './db';
import type {InboxDestination,StoredInboxItem} from './inbox';
import {captureBindingToken} from './inbox';
import {inboxSnapshot,newInboxId,assertInboxId} from '@mise/core/inbox';
import type {Payment,SetupSnapshot,AuditEvent} from '@mise/core/models';
import {parsePaymentText,type PaymentTextContext,type ParsedPaymentText} from '@mise/core/payments';
import {capturePaymentCommand,editPaymentCommand,associatePaymentCommand,unmatchPaymentCommand,setPaymentVoidedCommand,paymentCandidates,paymentAssociationIsCurrent,paymentOriginal,type CheckedPaymentInput,type PaymentChange} from '@mise/core/payment-records';
import {validatePaymentHistory} from '@mise/core/payment-history';
import {paymentCheckedFields} from '@mise/core/payment-posting-shape';
import {validatePaymentFinanceLinks} from '@mise/core/payment-finance-links';
import {previewPaymentMoney,recordPaymentMoneyCommand,previewPaymentMoneyUndo,undoPaymentMoneyCommand,type PaymentFinanceRecords,type PaymentFinanceIds,type PaymentMoneyTarget,type PaymentMoneyPreview,type PaymentMoneyChange} from '@mise/core/payment-finance';
import type {PaymentTextMatches,PaymentTextMatch,PaymentMatchOptions} from '@mise/core/payment-matches';
import {literalToken as syncDownloadToken} from '@mise/core/literal-token';
import {parseLocalCloudState} from '@mise/core/local-outbox';

export interface SavedPaymentSource {readonly itemId:string;readonly original:Readonly<Payment['original']>;readonly parsed:Readonly<ParsedPaymentText>}
export interface SavedPaymentReceipt {payment:Payment;original:Payment;events:AuditEvent[];associationCurrent:boolean|null}
export interface SavedPaymentMatches {readonly paymentId:string;readonly revision:number;readonly result:PaymentTextMatches}
export interface SavedPaymentAction {id:string;revision:number}
export interface SavedPaymentMoneyComparison {readonly paymentId:string;readonly revision:number;readonly preview:PaymentMoneyPreview;readonly note:string}
export interface SavedPaymentUndoComparison {readonly paymentId:string;readonly revision:number;readonly preview:ReturnType<typeof previewPaymentMoneyUndo>}
type SourceProof={db:MiseDatabase;destination:InboxDestination;selection:string;binding:string;shop:string;source:string;context:PaymentTextContext;paymentId:string;captureId:string;kind:Payment['source']};
const sources=new WeakMap<SavedPaymentSource,SourceProof>();
const comparisons=new WeakMap<SavedPaymentMatches,{source:SavedPaymentSource;payment:string;token:string;options:PaymentMatchOptions}>();
const moneyComparisons=new WeakMap<SavedPaymentMoneyComparison,{source:SavedPaymentSource;payment:string;token:string;target:PaymentMoneyTarget}>();
const undoComparisons=new WeakMap<SavedPaymentUndoComparison,{source:SavedPaymentSource;payment:string;token:string}>();
const token=syncDownloadToken;
async function derivedId(source:string,slot:string){const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`mise-payment-capture-v1\0${source}\0${slot}`));let value=BigInt('0x'+Array.from(new Uint8Array(hash).slice(0,10),b=>b.toString(16).padStart(2,'0')).join('')),suffix='';for(let n=0;n<16;n++){suffix='0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Number(value&31n)]+suffix;value>>=5n;}return source.slice(0,10)+suffix;}
async function guard(db:MiseDatabase,review:SavedPaymentSource,write=false){
 const proof=sources.get(review);if(!proof||proof.db!==db)throw new Error('Open the saved payment source again.');
 const [setup,item,selection,binding]=await Promise.all([db.setup(),db.inboxItems.get(review.itemId),db.operatorState.get('active'),db.cloudState.get('binding')]);
 if(!setup||setup.business.id!==proof.destination.businessId||setup.outlet.id!==proof.destination.outletId||setup.owner.id!==proof.destination.actorId||token(selection??null)!==proof.selection||captureBindingToken(binding)!==proof.binding||token(setup)!==proof.shop)throw new Error('The selected outlet, member or connection changed. Open the payment source again.');
 if(!item||item.outletId!==setup.outlet.id||token(inboxSnapshot(item))!==proof.source)throw new Error('The original saved source was changed, sorted or archived. Open its current review.');
 if(write&&binding&&parseLocalCloudState(binding).phase!=='cancelled')throw new Error('Native payment sync is not enabled yet. Keep the original source and use the existing manual money flow.');
 return {proof,setup,item};
}
export async function openSavedPaymentSource(db:MiseDatabase,itemId:string,destination:InboxDestination,options:{sender?:string;timeZone?:string;dateOrder?:'DMY'|'MDY';kind?:Payment['source']}={}):Promise<SavedPaymentSource>{
 destination=structuredClone(destination);options=structuredClone(options);
 const ids=await Promise.all([derivedId(itemId,'payment'),derivedId(itemId,'capture')]);
 return db.transaction('r',db.tables,async()=>{
  const [setup,item,selection,binding]=await Promise.all([db.setup(),db.inboxItems.get(itemId),db.operatorState.get('active'),db.cloudState.get('binding')]);
  if(!setup||!item||item.outletId!==setup.outlet.id||setup.business.id!==destination.businessId||setup.outlet.id!==destination.outletId||setup.owner.id!==destination.actorId||destination.selectionToken!==undefined&&destination.selectionToken!==token(selection??null)||destination.bindingToken!==undefined&&destination.bindingToken!==captureBindingToken(binding))throw new Error('Open the actual saved payment source in the selected outlet.');
  const original=paymentOriginal(item),context:PaymentTextContext={receivedAt:item.createdAt,timeZone:options.timeZone??setup.outlet.timezone,currency:setup.outlet.currency,market:setup.business.marketCode,...(options.sender!==undefined?{sender:options.sender}:{}),...(options.dateOrder!==undefined?{dateOrder:options.dateOrder}:{})};
  const review=Object.freeze({itemId,original:Object.freeze(original),parsed:Object.freeze(parsePaymentText(original.text||original.title,context))});
  sources.set(review,{db,destination,selection:token(selection??null),binding:captureBindingToken(binding),shop:token(setup),source:token(inboxSnapshot(item)),context,paymentId:ids[0],captureId:ids[1],kind:options.kind??'sms'});return review;
 });
}
async function receipt(db:MiseDatabase,proof:SourceProof,item:StoredInboxItem):Promise<SavedPaymentReceipt|null>{
 const payment=await db.payments.get(proof.paymentId),events=await db.events.where('paymentId').equals(proof.paymentId).toArray();
 if(!payment&&!events.length)return null;if(!payment)throw new Error('The original payment receipt is incomplete. Keep its source and backup.');
 validatePaymentHistory([payment],events,[item]);events.sort((a,b)=>a.paymentRevision!-b.paymentRevision!);
 if(events[0].id!==proof.captureId||payment.inboxId!==item.id)throw new Error('This source belongs to a different original payment.');
 const data=payment.association||payment.postings?await records(db,(await db.setup())!):null;
 if(data)validatePaymentFinanceLinks(data.payments,{outlets:[data.records.setup.outlet],orders:data.records.orders.slice(),sales:data.records.sales.slice(),creditEntries:data.records.entries.slice(),creditAccounts:data.records.accounts.slice(),customers:data.records.customers.slice(),events:data.records.events.slice()});
 return {payment,original:structuredClone(events[0].after as Payment),events,associationCurrent:data?paymentAssociationIsCurrent(payment,data.records,data.payments):null};
}
export async function savedPaymentReceipt(db:MiseDatabase,review:SavedPaymentSource):Promise<SavedPaymentReceipt|null>{return db.transaction('r',db.tables,async()=>{const {proof,item}=await guard(db,review);return receipt(db,proof,item);});}
function checkedFields(p:Payment):CheckedPaymentInput{return {checked:true,...paymentCheckedFields(p)};}
async function persist(db:MiseDatabase,change:PaymentChange){await db.payments.put(change.payment);await db.events.add(change.event);}
export async function recordSavedPayment(db:MiseDatabase,review:SavedPaymentSource,input:CheckedPaymentInput):Promise<SavedPaymentReceipt>{
 input=structuredClone(input);
 return db.transaction('rw',db.tables,async()=>{
  const {proof,setup,item}=await guard(db,review),existing=await receipt(db,proof,item);
  if(existing){if(token(checkedFields(existing.original))!==token(input)||existing.original.source!==proof.kind)throw new Error('This source was already recorded with different checked details. Inspect its original receipt.');return existing;}
  await guard(db,review,true);const change=capturePaymentCommand(input,setup,item,proof.context,{paymentId:proof.paymentId,eventId:proof.captureId},proof.kind);
  await persist(db,change);return (await receipt(db,proof,item))!;
 });
}
async function records(db:MiseDatabase,setup:SetupSnapshot):Promise<{records:PaymentFinanceRecords;payments:Payment[]}>{
 const [orders,sales,entries,accounts,customers,refunds,payments,events]=await Promise.all([db.orders.where('outletId').equals(setup.outlet.id).toArray(),db.sales.where('outletId').equals(setup.outlet.id).toArray(),db.creditEntries.where('outletId').equals(setup.outlet.id).toArray(),db.creditAccounts.where('outletId').equals(setup.outlet.id).toArray(),db.customers.where('businessId').equals(setup.business.id).toArray(),db.orderRefunds.where('outletId').equals(setup.outlet.id).toArray(),db.payments.where('outletId').equals(setup.outlet.id).toArray(),db.events.where('outletId').equals(setup.outlet.id).toArray()]);
 return {records:{setup,orders,sales,entries,accounts,customers,refunds,events},payments};
}
export async function compareSavedPayment(db:MiseDatabase,review:SavedPaymentSource,options:PaymentMatchOptions={}):Promise<SavedPaymentMatches>{
 options=structuredClone(options);return db.transaction('r',db.tables,async()=>{const {proof,setup,item}=await guard(db,review),saved=await receipt(db,proof,item);if(!saved)throw new Error('Save and check the payment before matching it.');const data=await records(db,setup),result=paymentCandidates(saved.payment,data.records,data.payments,options),comparison=Object.freeze({paymentId:saved.payment.id,revision:saved.payment.revision,result});comparisons.set(comparison,{source:review,payment:token(saved.payment),token:token(comparison),options});return comparison;});
}
async function originalAction(db:MiseDatabase,saved:SavedPaymentReceipt,action:SavedPaymentAction,type:string,actorId:string):Promise<AuditEvent|null>{
 const event=await db.events.get(action.id);if(!event)return null;
 if(event.paymentId!==saved.payment.id||event.command!==type||event.actor.id!==actorId||event.paymentRevision!==action.revision+1)throw new Error('This action identity belongs to a different original request.');return event;
}
export async function editSavedPayment(db:MiseDatabase,review:SavedPaymentSource,action:SavedPaymentAction,input:CheckedPaymentInput):Promise<SavedPaymentReceipt>{
 action=structuredClone(action);input=structuredClone(input);return db.transaction('rw',db.tables,async()=>{const {proof,setup,item}=await guard(db,review),saved=await receipt(db,proof,item);if(!saved)throw new Error('Payment not found.');const original=await originalAction(db,saved,action,'payment.edit',setup.owner.id);if(original){if(token(checkedFields(original.after as Payment))!==token(input))throw new Error('This original edit used different checked details.');return saved;}await guard(db,review,true);await persist(db,editPaymentCommand(saved.payment,action.revision,input,setup,action.id));return (await receipt(db,proof,item))!;});
}
export async function associateSavedPayment(db:MiseDatabase,review:SavedPaymentSource,comparison:SavedPaymentMatches,selected:Pick<PaymentTextMatch,'kind'|'id'>,actionId=newInboxId()):Promise<SavedPaymentReceipt>{
 selected=structuredClone(selected);const original=comparisons.get(comparison);if(!original||original.source!==review||token(comparison)!==original.token)throw new Error('Compare the actual saved payment again before selecting a match.');
 const candidate=comparison.result.candidates.find(c=>c.id===selected.id&&c.kind===selected.kind);if(!candidate)throw new Error('Choose one of the actual current payment candidates.');
 return db.transaction('rw',db.tables,async()=>{const {proof,setup,item}=await guard(db,review),saved=await receipt(db,proof,item);if(!saved)throw new Error('Payment not found.');const previous=await originalAction(db,saved,{id:actionId,revision:comparison.revision},'payment.match',setup.owner.id);if(previous){if(token((previous.after as Payment).association)!==token({kind:candidate.kind,id:candidate.id,fingerprint:candidate.fingerprint,at:previous.at,eventId:previous.id}))throw new Error('This original match selected different checked data.');return saved;}
  if(token(saved.payment)!==original.payment)throw new Error('This payment changed after comparison. Check it again.');await guard(db,review,true);const data=await records(db,setup);await persist(db,associatePaymentCommand(saved.payment,comparison.revision,candidate,setup,data.records,data.payments,actionId,Date.now(),original.options));return (await receipt(db,proof,item))!;
 });
}
/** Automatic association of one checked source; this never posts or undoes money. */
export async function autoMatchSavedPayment(db:MiseDatabase,review:SavedPaymentSource,receivedTimeConfirmed=false):Promise<SavedPaymentReceipt>{
 return db.transaction('rw',db.tables,async()=>{const {proof,setup,item}=await guard(db,review),saved=await receipt(db,proof,item);if(!saved)throw new Error('Payment not found.');if(saved.payment.association)return saved;const data=await records(db,setup),options={receivedTimeConfirmed},matches=paymentCandidates(saved.payment,data.records,data.payments,options);if(matches.selection!=='automatic')return saved;await guard(db,review,true);await persist(db,associatePaymentCommand(saved.payment,saved.payment.revision,matches.candidates[0],setup,data.records,data.payments,newInboxId(),Date.now(),options));return (await receipt(db,proof,item))!;});
}
export async function unmatchSavedPayment(db:MiseDatabase,review:SavedPaymentSource,action:SavedPaymentAction):Promise<SavedPaymentReceipt>{
 action=structuredClone(action);return db.transaction('rw',db.tables,async()=>{const {proof,setup,item}=await guard(db,review),saved=await receipt(db,proof,item);if(!saved)throw new Error('Payment not found.');if(await originalAction(db,saved,action,'payment.unmatch',setup.owner.id))return saved;await guard(db,review,true);await persist(db,unmatchPaymentCommand(saved.payment,action.revision,setup,action.id));return (await receipt(db,proof,item))!;});
}
export async function setSavedPaymentVoided(db:MiseDatabase,review:SavedPaymentSource,action:SavedPaymentAction,voided:boolean):Promise<SavedPaymentReceipt>{
 action=structuredClone(action);return db.transaction('rw',db.tables,async()=>{const {proof,setup,item}=await guard(db,review),saved=await receipt(db,proof,item);if(!saved)throw new Error('Payment not found.');if(await originalAction(db,saved,action,voided?'payment.void':'payment.reopen',setup.owner.id))return saved;await guard(db,review,true);await persist(db,setPaymentVoidedCommand(saved.payment,action.revision,voided,setup,action.id));return (await receipt(db,proof,item))!;});
}

/** Compare actual native money records without granting a serialized plan any
 * write authority. Explicit new-money confirmation is still required at save. */
export async function compareSavedPaymentMoney(db:MiseDatabase,review:SavedPaymentSource,target:PaymentMoneyTarget,note=''):Promise<SavedPaymentMoneyComparison>{
 target=structuredClone(target);
 return db.transaction('r',db.tables,async()=>{
  const {proof,setup,item}=await guard(db,review);if(item.archived)throw Error('Reopen the original source before recording new money.');
  const saved=await receipt(db,proof,item);if(!saved)throw Error('Save and check the payment first.');
  const data=await records(db,setup),preview=previewPaymentMoney(saved.payment,data.records,data.payments,target,note),comparison=Object.freeze({paymentId:saved.payment.id,revision:saved.payment.revision,preview,note});
  moneyComparisons.set(comparison,{source:review,payment:token(saved.payment),token:token(comparison),target});return comparison;
 });
}
async function financialIds(actionId:string):Promise<PaymentFinanceIds>{
 assertInboxId(actionId);const kinds=['orderEvent','sale','saleEvent','entry','creditEvent','refund','refundEvent'] as const;
 const values=await Promise.all(kinds.map(kind=>derivedId(actionId,`money-${kind}`))),ids=new Map(kinds.map((kind,i)=>[kind,values[i]]));return kind=>ids.get(kind)!;
}
async function persistMoney(db:MiseDatabase,change:PaymentMoneyChange){
 // add() preserves financial/audit identity uniqueness; the enclosing native
 // transaction rolls back all domain writes if any companion cannot be saved.
 for(const order of change.orders)await db.orders.put(order);
 for(const sale of change.sales)if(sale.voidedAt===undefined)await db.sales.add(sale);else await db.sales.put(sale);
 for(const entry of change.entries)await db.creditEntries.add(entry);
 for(const event of change.events)await db.events.add(event);
 await persist(db,change.payment);
}
export async function recordSavedPaymentMoney(db:MiseDatabase,review:SavedPaymentSource,comparison:SavedPaymentMoneyComparison,confirmedNewMoney:boolean,actionId=newInboxId()):Promise<SavedPaymentReceipt>{
 const original=moneyComparisons.get(comparison);
 if(!original||original.source!==review||token(comparison)!==original.token)throw Error('Compare the actual financial target again.');
 if(confirmedNewMoney!==true)throw Error('Confirm that the money was received and is not already recorded.');
 const ids=await financialIds(actionId);
 return db.transaction('rw',db.tables,async()=>{
  const {proof,setup,item}=await guard(db,review),saved=await receipt(db,proof,item);if(!saved)throw Error('Payment not found.');
  const previous=await originalAction(db,saved,{id:actionId,revision:comparison.revision},'payment.record',setup.owner.id);
  if(previous){
   const posting=(previous.after as Payment).postings?.at(-1);
   if(token(previous.before)!==original.payment||token(posting?.target)!==token(comparison.preview.target)||posting?.note!==comparison.note)throw Error('This original recording used different checked data.');return saved;
  }
  if(token(saved.payment)!==original.payment)throw Error('This payment changed after comparison. Check it again.');
  await guard(db,review,true);if(item.archived)throw Error('Reopen the original source before recording new money.');
  const data=await records(db,setup),change=recordPaymentMoneyCommand(saved.payment,comparison.revision,data.records,data.payments,original.target,comparison.preview.target.fingerprint,comparison.note,true,actionId,ids);
  await persistMoney(db,change);return (await receipt(db,proof,item))!;
 });
}
export async function compareSavedPaymentMoneyUndo(db:MiseDatabase,review:SavedPaymentSource):Promise<SavedPaymentUndoComparison>{
 return db.transaction('r',db.tables,async()=>{
  const {proof,setup,item}=await guard(db,review),saved=await receipt(db,proof,item);if(!saved)throw Error('Payment not found.');
  const data=await records(db,setup),comparison=Object.freeze({paymentId:saved.payment.id,revision:saved.payment.revision,preview:previewPaymentMoneyUndo(saved.payment,data.records)});
  undoComparisons.set(comparison,{source:review,payment:token(saved.payment),token:token(comparison)});return comparison;
 });
}
export async function undoSavedPaymentMoney(db:MiseDatabase,review:SavedPaymentSource,comparison:SavedPaymentUndoComparison,confirmedUndo:boolean,actionId=newInboxId()):Promise<SavedPaymentReceipt>{
 const original=undoComparisons.get(comparison);
 if(!original||original.source!==review||token(comparison)!==original.token)throw Error('Compare this original financial undo again.');
 if(confirmedUndo!==true)throw Error('Confirm which original financial recording to undo.');
 const ids=await financialIds(actionId);
 return db.transaction('rw',db.tables,async()=>{
  const {proof,setup,item}=await guard(db,review),saved=await receipt(db,proof,item);if(!saved)throw Error('Payment not found.');
  const previous=await originalAction(db,saved,{id:actionId,revision:comparison.revision},'payment.record-undo',setup.owner.id);
  if(previous){if(token(previous.before)!==original.payment)throw Error('This original undo used different checked data.');return saved;}
  if(token(saved.payment)!==original.payment)throw Error('This payment changed after comparison. Check it again.');
  await guard(db,review,true);const data=await records(db,setup),change=undoPaymentMoneyCommand(saved.payment,comparison.revision,data.records,comparison.preview.fingerprint,true,actionId,ids);
  await persistMoney(db,change);return (await receipt(db,proof,item))!;
 });
}
/** Read an original action after a lost reply/reload, independently of a new
 * comparison. Recovery returns current history and never replays old money. */
export async function recoverSavedPaymentMoneyAction(db:MiseDatabase,review:SavedPaymentSource,action:SavedPaymentAction,kind:'record'|'undo'):Promise<{receipt:SavedPaymentReceipt;event:AuditEvent}|null>{
 action=structuredClone(action);if(!['record','undo'].includes(kind))throw Error('Choose an original recording or undo.');
 return db.transaction('r',db.tables,async()=>{
  const {proof,setup,item}=await guard(db,review),saved=await receipt(db,proof,item);if(!saved)return null;
  const event=await originalAction(db,saved,action,kind==='record'?'payment.record':'payment.record-undo',setup.owner.id);return event?{receipt:saved,event}:null;
 });
}
