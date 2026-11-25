import Dexie from 'dexie';
import {assertNativePaymentAccess,assertNativePaymentScope,type NativePaymentAccess} from './native-payment-access';
import {recordNativePaymentMutation} from './native-payment-outbox';
import {PaymentEvidenceReader} from '@mise/core/payment-evidence';
import {inspectOriginalPaymentTargets,type OriginalPaymentInspection} from './payment-inspection';
import type {MiseDatabase} from './db';
import type {InboxDestination,StoredInboxItem} from './inbox';
import {captureBindingToken} from './inbox';
import {inboxSnapshot,newInboxId} from '@mise/core/inbox';
import type {Payment,SetupSnapshot,AuditEvent} from '@mise/core/models';
import {parsePaymentText,type PaymentTextContext,type ParsedPaymentText} from '@mise/core/payments';
import {paymentCandidates,paymentAssociationIsCurrent,paymentOriginal,type CheckedPaymentInput,type PaymentChange} from '@mise/core/payment-records';
import {nativePaymentId,nativePaymentMatchOptions,paymentInvocationHash,readNativePaymentInvocation,validateNativePaymentInvocations,type NativePaymentCommand} from '@mise/core/payment-invocations';
import {nativePaymentCommandBase,executeNativePaymentCommand} from '@mise/core/payment-native-commands';
import {validatePaymentHistory} from '@mise/core/payment-history';
import {paymentCheckedFields} from '@mise/core/payment-posting-shape';
import {validatePaymentFinanceLinks} from '@mise/core/payment-finance-links';
import {previewPaymentMoney,previewPaymentMoneyUndo,type PaymentFinanceRecords,type PaymentMoneyTarget,type PaymentMoneyPreview,type PaymentMoneyChange} from '@mise/core/payment-finance';
import type {PaymentTextMatches,PaymentTextMatch,PaymentMatchOptions} from '@mise/core/payment-matches';
import {literalToken as syncDownloadToken} from '@mise/core/literal-token';
import {parseLocalCloudState} from '@mise/core/local-outbox';

export interface SavedPaymentSource {readonly itemId:string;readonly original:Readonly<Payment['original']>;readonly parsed:Readonly<ParsedPaymentText>}
export interface SavedPaymentReceipt {payment:Payment;original:Payment;events:AuditEvent[];associationCurrent:boolean|null;inspection:OriginalPaymentInspection}
export interface SavedPaymentMatches {readonly paymentId:string;readonly revision:number;readonly result:PaymentTextMatches}
export interface SavedPaymentAction {id:string;revision:number}
export interface SavedPaymentMoneyComparison {readonly paymentId:string;readonly revision:number;readonly preview:PaymentMoneyPreview;readonly note:string}
export interface SavedPaymentUndoComparison {readonly paymentId:string;readonly revision:number;readonly preview:ReturnType<typeof previewPaymentMoneyUndo>}
type SourceProof={db:MiseDatabase;destination:InboxDestination;selection:string;binding:string;shop:string;source:string;context:PaymentTextContext;paymentId:string;captureId:string;kind:Payment['source'];nativeAccess?:NativePaymentAccess};
const sources=new WeakMap<SavedPaymentSource,SourceProof>();
const comparisons=new WeakMap<SavedPaymentMatches,{source:SavedPaymentSource;payment:string;token:string;options:PaymentMatchOptions}>();
const moneyComparisons=new WeakMap<SavedPaymentMoneyComparison,{source:SavedPaymentSource;payment:string;token:string;target:PaymentMoneyTarget}>();
const undoComparisons=new WeakMap<SavedPaymentUndoComparison,{source:SavedPaymentSource;payment:string;token:string}>();
const token=syncDownloadToken;
async function guard(db:MiseDatabase,review:SavedPaymentSource,write=false){
 const proof=sources.get(review);if(!proof||proof.db!==db)throw new Error('Open the saved payment source again.');
 const [setup,item,selection,binding]=await Promise.all([db.setup(),db.inboxItems.get(review.itemId),db.operatorState.get('active'),db.cloudState.get('binding')]);
 if(!setup||setup.business.id!==proof.destination.businessId||setup.outlet.id!==proof.destination.outletId||setup.owner.id!==proof.destination.actorId||token(selection??null)!==proof.selection||captureBindingToken(binding)!==proof.binding||token(setup)!==proof.shop)throw new Error('The selected outlet, member or connection changed. Open the payment source again.');
 if(!item||item.outletId!==setup.outlet.id||token(inboxSnapshot(item))!==proof.source)throw new Error('The original saved source was changed, sorted or archived. Open its current review.');
 if(proof.nativeAccess){await assertNativePaymentScope(proof.nativeAccess,db);assertNativePaymentAccess(proof.nativeAccess,db,proof.destination);}
 if(write&&binding&&parseLocalCloudState(binding).phase!=='cancelled'){if(!proof.nativeAccess)throw new Error('Native payment sync is not enabled yet. Keep the original source and use the existing manual money flow.');const identity=assertNativePaymentAccess(proof.nativeAccess,db,proof.destination),state=parseLocalCloudState(binding);if(state.phase!=='ready'||state.targetHash!==identity.targetHash)throw Error('Keep the original native payment account and admission.');}
 return {proof,setup,item};
}
export async function openSavedPaymentSource(db:MiseDatabase,itemId:string,destination:InboxDestination,options:{sender?:string;timeZone?:string;dateOrder?:'DMY'|'MDY';kind?:Payment['source']}={}):Promise<SavedPaymentSource>{
 destination=structuredClone(destination);options=structuredClone(options);
 const ids=[nativePaymentId(itemId,'payment'),nativePaymentId(itemId,'capture')];
 return db.transaction('r',db.tables,async()=>{
  const [setup,item,selection,binding]=await Promise.all([db.setup(),db.inboxItems.get(itemId),db.operatorState.get('active'),db.cloudState.get('binding')]);
  if(!setup||!item||item.outletId!==setup.outlet.id||setup.business.id!==destination.businessId||setup.outlet.id!==destination.outletId||setup.owner.id!==destination.actorId||destination.selectionToken!==undefined&&destination.selectionToken!==token(selection??null)||destination.bindingToken!==undefined&&destination.bindingToken!==captureBindingToken(binding))throw new Error('Open the actual saved payment source in the selected outlet.');
  const original=paymentOriginal(item),context:PaymentTextContext={receivedAt:item.createdAt,timeZone:options.timeZone??setup.outlet.timezone,currency:setup.outlet.currency,market:setup.business.marketCode,...(options.sender!==undefined?{sender:options.sender}:{}),...(options.dateOrder!==undefined?{dateOrder:options.dateOrder}:{})};
  const review=Object.freeze({itemId,original:Object.freeze(original),parsed:Object.freeze(parsePaymentText(original.text||original.title,context))});
  sources.set(review,{db,destination,selection:token(selection??null),binding:captureBindingToken(binding),shop:token(setup),source:token(inboxSnapshot(item)),context,paymentId:ids[0],captureId:ids[1],kind:options.kind??'sms'});return review;
 });
}
/** Actual connected reviews require the SDK/native capability, never a boolean flag. */
export async function openQueuedPaymentSource(db:MiseDatabase,itemId:string,access:NativePaymentAccess,options:Parameters<typeof openSavedPaymentSource>[3]={}):Promise<SavedPaymentSource>{
 const identity=await assertNativePaymentScope(access,db),destination={businessId:identity.businessId,outletId:identity.outletId,actorId:identity.actorId},review=await openSavedPaymentSource(db,itemId,destination,options);
 sources.get(review)!.nativeAccess=access;await assertNativePaymentScope(access,db);assertNativePaymentAccess(access,db,destination);return review;
}
async function receipt(db:MiseDatabase,proof:SourceProof,item:StoredInboxItem):Promise<SavedPaymentReceipt|null>{
 const payment=await db.payments.get(proof.paymentId),events=await db.events.where('paymentId').equals(proof.paymentId).toArray();
 if(!payment&&!events.length)return null;if(!payment)throw new Error('The original payment receipt is incomplete. Keep its source and backup.');
 validatePaymentHistory([payment],events,[item]);events.sort((a,b)=>a.paymentRevision!-b.paymentRevision!);
 if(events[0].id!==proof.captureId||payment.inboxId!==item.id)throw new Error('This source belongs to a different original payment.');
 const data=payment.association||payment.postings||events.some(e=>(e.after as Payment).association)?await records(db,(await db.setup())!):null;
 const reader=data?validatePaymentFinanceLinks(data.payments,{outlets:[data.records.setup.outlet],orders:data.records.orders.slice(),sales:data.records.sales.slice(),creditEntries:data.records.entries.slice(),creditAccounts:data.records.accounts.slice(),customers:data.records.customers.slice(),events:data.records.events.slice()}):null;
 if(!reader){const setup=(await db.setup())!;validateNativePaymentInvocations(await db.events.where('outletId').equals(payment.outletId).toArray(),undefined,outletId=>outletId===setup.outlet.id?setup.business.id:undefined);}
 const inspection=reader?inspectOriginalPaymentTargets(payment,events,reader):{associations:[],postings:[]};
 return {inspection,payment,original:structuredClone(events[0].after as Payment),events,associationCurrent:data?paymentAssociationIsCurrent(payment,data.records,data.payments):null};
}
export async function savedPaymentReceipt(db:MiseDatabase,review:SavedPaymentSource):Promise<SavedPaymentReceipt|null>{return db.transaction('r',db.tables,async()=>{const {proof,item}=await guard(db,review);return receipt(db,proof,item);});}
function checkedFields(p:Payment):CheckedPaymentInput{return {checked:true,...paymentCheckedFields(p)};}
async function persist(db:MiseDatabase,change:PaymentChange){await db.payments.put(change.payment);await db.events.add(change.event);for(const event of change.evidenceEvents??[])await db.events.add(event);}
export async function recordSavedPayment(db:MiseDatabase,review:SavedPaymentSource,input:CheckedPaymentInput):Promise<SavedPaymentReceipt>{
 input=structuredClone(input);
 return db.transaction('rw',db.tables,async()=>{
  const {proof,setup,item}=await guard(db,review),existing=await receipt(db,proof,item);
  if(existing){if(token(checkedFields(existing.original))!==token(input)||existing.original.source!==proof.kind)throw new Error('This source was already recorded with different checked details. Inspect its original receipt.');return existing;}
  await guard(db,review,true);await commitNative(db,review,setup,item,{...nativePaymentCommandBase(setup,item,null,proof.captureId),type:'payment.capture',input,context:proof.context,kind:proof.kind});return (await receipt(db,proof,item))!;
 });
}
async function records(db:MiseDatabase,setup:SetupSnapshot):Promise<{records:PaymentFinanceRecords;payments:Payment[]}>{
 const [orders,sales,entries,accounts,customers,refunds,payments,events]=await Promise.all([db.orders.where('outletId').equals(setup.outlet.id).toArray(),db.sales.where('outletId').equals(setup.outlet.id).toArray(),db.creditEntries.where('outletId').equals(setup.outlet.id).toArray(),db.creditAccounts.where('outletId').equals(setup.outlet.id).toArray(),db.customers.where('businessId').equals(setup.business.id).toArray(),db.orderRefunds.where('outletId').equals(setup.outlet.id).toArray(),db.payments.where('outletId').equals(setup.outlet.id).toArray(),db.events.where('outletId').equals(setup.outlet.id).toArray()]);
 return {records:{setup,orders,sales,entries,accounts,customers,refunds,events},payments};
}
export async function compareSavedPayment(db:MiseDatabase,review:SavedPaymentSource,options:PaymentMatchOptions={}):Promise<SavedPaymentMatches>{
 options=nativePaymentMatchOptions(structuredClone(options));return db.transaction('r',db.tables,async()=>{const {proof,setup,item}=await guard(db,review),saved=await receipt(db,proof,item);if(!saved)throw new Error('Save and check the payment before matching it.');const data=await records(db,setup),result=paymentCandidates(saved.payment,data.records,data.payments,options),comparison=Object.freeze({paymentId:saved.payment.id,revision:saved.payment.revision,result});comparisons.set(comparison,{source:review,payment:token(saved.payment),token:token(comparison),options});return comparison;});
}
async function originalAction(db:MiseDatabase,saved:SavedPaymentReceipt,action:SavedPaymentAction,type:string,actorId:string):Promise<AuditEvent|null>{
 const event=await db.events.get(action.id);if(!event)return null;
 if(event.paymentId!==saved.payment.id||event.command!==type||event.actor.id!==actorId||event.paymentRevision!==action.revision+1)throw new Error('This action identity belongs to a different original request.');return event;
}
export async function editSavedPayment(db:MiseDatabase,review:SavedPaymentSource,action:SavedPaymentAction,input:CheckedPaymentInput):Promise<SavedPaymentReceipt>{
 action=structuredClone(action);input=structuredClone(input);return db.transaction('rw',db.tables,async()=>{const {proof,setup,item}=await guard(db,review),saved=await receipt(db,proof,item);if(!saved)throw new Error('Payment not found.');const original=await originalAction(db,saved,action,'payment.edit',setup.owner.id);if(original){if(token(checkedFields(original.after as Payment))!==token(input))throw new Error('This original edit used different checked details.');return saved;}await guard(db,review,true);await commitNative(db,review,setup,item,{...nativePaymentCommandBase(setup,item,saved.payment,action.id),revision:action.revision,type:'payment.edit',input});return (await receipt(db,proof,item))!;});
}
export async function associateSavedPayment(db:MiseDatabase,review:SavedPaymentSource,comparison:SavedPaymentMatches,selected:Pick<PaymentTextMatch,'kind'|'id'>,actionId=newInboxId()):Promise<SavedPaymentReceipt>{
 selected=structuredClone(selected);const original=comparisons.get(comparison);if(!original||original.source!==review||token(comparison)!==original.token)throw new Error('Compare the actual saved payment again before selecting a match.');
 const candidate=comparison.result.candidates.find(c=>c.id===selected.id&&c.kind===selected.kind);if(!candidate)throw new Error('Choose one of the actual current payment candidates.');
 return db.transaction('rw',db.tables,async()=>{const {proof,setup,item}=await guard(db,review),saved=await receipt(db,proof,item);if(!saved)throw new Error('Payment not found.');const previous=await originalAction(db,saved,{id:actionId,revision:comparison.revision},'payment.match',setup.owner.id);if(previous){const prior=(previous.after as Payment).association!,data=await records(db,setup),invocation=readNativePaymentInvocation(previous,data.records.events);if(invocation&&(invocation.command.type!=='payment.match'||token(invocation.command.options)!==token(nativePaymentMatchOptions(original.options))||invocation.command.mode!=='manual'))throw Error('This original match used different invocation controls.');if(token({...prior,fingerprint:token(new PaymentEvidenceReader(data.records.events,data.records.entries).expand(prior.fingerprint))})!==token({kind:candidate.kind,id:candidate.id,fingerprint:candidate.fingerprint,at:previous.at,eventId:previous.id}))throw new Error('This original match selected different checked data.');return saved;}
  if(token(saved.payment)!==original.payment)throw new Error('This payment changed after comparison. Check it again.');await guard(db,review,true);const data=await records(db,setup);await commitNative(db,review,setup,item,{...nativePaymentCommandBase(setup,item,saved.payment,actionId),revision:comparison.revision,type:'payment.match',selected:{kind:candidate.kind,id:candidate.id,hash:paymentInvocationHash(JSON.parse(candidate.fingerprint))},options:nativePaymentMatchOptions(original.options),mode:'manual'},data);return (await receipt(db,proof,item))!;
 });
}
/** Automatic association of one checked source; this never posts or undoes money. */
export async function autoMatchSavedPayment(db:MiseDatabase,review:SavedPaymentSource,receivedTimeConfirmed=false):Promise<SavedPaymentReceipt>{
 return db.transaction('rw',db.tables,async()=>{const {proof,setup,item}=await guard(db,review),saved=await receipt(db,proof,item);if(!saved)throw new Error('Payment not found.');if(saved.payment.association)return saved;const data=await records(db,setup),options=nativePaymentMatchOptions({receivedTimeConfirmed}),matches=paymentCandidates(saved.payment,data.records,data.payments,options);if(matches.selection!=='automatic')return saved;await guard(db,review,true);const candidate=matches.candidates[0];await commitNative(db,review,setup,item,{...nativePaymentCommandBase(setup,item,saved.payment,newInboxId()),type:'payment.match',selected:{kind:candidate.kind,id:candidate.id,hash:paymentInvocationHash(JSON.parse(candidate.fingerprint))},options,mode:'automatic'},data);return (await receipt(db,proof,item))!;});
}
export async function unmatchSavedPayment(db:MiseDatabase,review:SavedPaymentSource,action:SavedPaymentAction):Promise<SavedPaymentReceipt>{
 action=structuredClone(action);return db.transaction('rw',db.tables,async()=>{const {proof,setup,item}=await guard(db,review),saved=await receipt(db,proof,item);if(!saved)throw new Error('Payment not found.');if(await originalAction(db,saved,action,'payment.unmatch',setup.owner.id))return saved;await guard(db,review,true);await commitNative(db,review,setup,item,{...nativePaymentCommandBase(setup,item,saved.payment,action.id),revision:action.revision,type:'payment.unmatch'});return (await receipt(db,proof,item))!;});
}
export async function setSavedPaymentVoided(db:MiseDatabase,review:SavedPaymentSource,action:SavedPaymentAction,voided:boolean):Promise<SavedPaymentReceipt>{
 action=structuredClone(action);return db.transaction('rw',db.tables,async()=>{const {proof,setup,item}=await guard(db,review),saved=await receipt(db,proof,item);if(!saved)throw new Error('Payment not found.');if(await originalAction(db,saved,action,voided?'payment.void':'payment.reopen',setup.owner.id))return saved;await guard(db,review,true);await commitNative(db,review,setup,item,{...nativePaymentCommandBase(setup,item,saved.payment,action.id),revision:action.revision,type:voided?'payment.void':'payment.reopen'});return (await receipt(db,proof,item))!;});
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
async function persistMoney(db:MiseDatabase,change:PaymentMoneyChange){
 // add() preserves financial/audit identity uniqueness; the enclosing native
 // transaction rolls back all domain writes if any companion cannot be saved.
 for(const order of change.orders)await db.orders.put(order);
 for(const sale of change.sales)if(sale.voidedAt===undefined)await db.sales.add(sale);else await db.sales.put(sale);
 for(const entry of change.entries)await db.creditEntries.add(entry);
 for(const event of change.events)await db.events.add(event);
 await persist(db,change.payment);
}
async function commitNative(db:MiseDatabase,review:SavedPaymentSource,setup:SetupSnapshot,item:StoredInboxItem,command:NativePaymentCommand,current?:Awaited<ReturnType<typeof records>>){
 const tx=Dexie.currentTransaction;try{
 const data=current??await records(db,setup),change=executeNativePaymentCommand(command,data.records,data.payments,item);
 const access=sources.get(review)?.nativeAccess,identity=access?assertNativePaymentAccess(access,db,{businessId:setup.business.id,outletId:setup.outlet.id,actorId:setup.owner.id}):null;
 await recordNativePaymentMutation(db,change,async()=>{await persistMoney(db,change);await db.events.add(change.invocation);},identity,access?()=>{assertNativePaymentAccess(access,db);}:undefined);
 await guard(db,review,true);
 }catch(error){try{tx?.abort();}catch{}throw error;}
}
export async function recordSavedPaymentMoney(db:MiseDatabase,review:SavedPaymentSource,comparison:SavedPaymentMoneyComparison,confirmedNewMoney:boolean,actionId=newInboxId()):Promise<SavedPaymentReceipt>{
 const original=moneyComparisons.get(comparison);
 if(!original||original.source!==review||token(comparison)!==original.token)throw Error('Compare the actual financial target again.');
 if(confirmedNewMoney!==true)throw Error('Confirm that the money was received and is not already recorded.');
 return db.transaction('rw',db.tables,async()=>{
  const {proof,setup,item}=await guard(db,review),saved=await receipt(db,proof,item);if(!saved)throw Error('Payment not found.');
  const previous=await originalAction(db,saved,{id:actionId,revision:comparison.revision},'payment.record',setup.owner.id);
  if(previous){
   const posting=(previous.after as Payment).postings?.at(-1),data=await records(db,setup),invocation=readNativePaymentInvocation(previous,data.records.events);
   if(invocation&&(invocation.command.type!=='payment.record'||token(invocation.command.target)!==token(original.target)))throw Error('This original recording used different invocation controls.');
   if(token(previous.before)!==original.payment||!posting||token({...posting.target,fingerprint:token(new PaymentEvidenceReader(data.records.events,data.records.entries).expand(posting.target.fingerprint))})!==token(comparison.preview.target)||posting?.note!==comparison.note)throw Error('This original recording used different checked data.');return saved;
  }
  if(token(saved.payment)!==original.payment)throw Error('This payment changed after comparison. Check it again.');
  await guard(db,review,true);if(item.archived)throw Error('Reopen the original source before recording new money.');
  const data=await records(db,setup);await commitNative(db,review,setup,item,{...nativePaymentCommandBase(setup,item,saved.payment,actionId),revision:comparison.revision,type:'payment.record',target:original.target,targetHash:paymentInvocationHash(JSON.parse(comparison.preview.target.fingerprint)),note:comparison.note,confirmedNewMoney:true},data);
  return (await receipt(db,proof,item))!;
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
 return db.transaction('rw',db.tables,async()=>{
  const {proof,setup,item}=await guard(db,review),saved=await receipt(db,proof,item);if(!saved)throw Error('Payment not found.');
  const previous=await originalAction(db,saved,{id:actionId,revision:comparison.revision},'payment.record-undo',setup.owner.id);
  if(previous){if(token(previous.before)!==original.payment)throw Error('This original undo used different checked data.');return saved;}
  if(token(saved.payment)!==original.payment)throw Error('This payment changed after comparison. Check it again.');
  await guard(db,review,true);const data=await records(db,setup);await commitNative(db,review,setup,item,{...nativePaymentCommandBase(setup,item,saved.payment,actionId),revision:comparison.revision,type:'payment.record-undo',comparisonHash:paymentInvocationHash(JSON.parse(comparison.preview.fingerprint)),confirmedUndo:true},data);
  return (await receipt(db,proof,item))!;
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
