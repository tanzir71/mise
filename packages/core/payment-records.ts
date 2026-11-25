import {literalToken} from './literal-token';
import {isCompactPaymentSnapshot,validateCompactPaymentSnapshot,PaymentEvidenceReader,PaymentEvidenceWriter} from './payment-evidence';
import type {AuditEvent,Payment,PaymentCheckedFields} from './models';
import {activePaymentPosting,paymentCheckedFields,validatePaymentPostings} from './payment-posting-shape';
import {currentPaymentReceipt} from './payment-receipts';
import type {InboxItem} from './inbox';
import {assertInboxId,validateInboxItem} from './inbox';
import {validateShop,type ShopSetup} from './shop-access';
import {marketPacks} from './packs';
import {parsePaymentText,type ParsedPaymentText,type PaymentTextContext} from './payments';
import {findPaymentTextMatches,type PaymentMatchRecords,type PaymentTextMatch,type PaymentMatchOptions} from './payment-matches';

export interface CheckedPaymentInput extends PaymentCheckedFields {checked:true}
export interface PaymentChange {payment:Payment;event:AuditEvent;evidenceEvents?:AuditEvent[]}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v:Record<string,unknown>,required:string,optional='')=>required.split(',').every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>(required+','+optional).split(',').includes(k));
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=253402300799999;
const amount=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const phone=(v:unknown):v is string=>typeof v==='string'&&/^\+[1-9]\d{6,14}$/.test(v);
const currency=(v:unknown):v is string=>typeof v==='string'&&/^[A-Z]{3}$/.test(v);
const literal=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max;
export const paymentOriginal=(item:InboxItem):Payment['original']=>({title:item.title,text:item.text,url:item.url,createdAt:item.createdAt});
export const paymentRawText=(original:Payment['original'])=>original.text||original.title;
export function paymentReferenceKey(p:Pick<Payment,'reference'|'referenceScope'|'methodName'|'currency'|'voidedAt'>):string|undefined{return p.voidedAt===undefined&&p.reference.trim()?JSON.stringify([p.methodName.normalize('NFKC').trim().toLowerCase(),p.currency,...(p.methodName==='Bank transfer'&&p.referenceScope?[p.referenceScope.normalize('NFKC').trim().toLowerCase()]:[]),p.reference.trim().toUpperCase()]):undefined;}
const matchKey=(p:Pick<Payment,'association'|'voidedAt'>)=>p.voidedAt===undefined&&p.association?JSON.stringify([p.association.kind,p.association.id]):undefined;
function keyed(p:Payment):Payment{const base={...p};delete base.referenceKey;delete base.matchKey;return {...base,...(paymentReferenceKey(p)!==undefined?{referenceKey:paymentReferenceKey(p)}:{}),...(matchKey(p)!==undefined?{matchKey:matchKey(p)}:{})};}
function validateParsed(v:unknown,original:Payment['original']):asserts v is ParsedPaymentText {
 if(!object(v)||!exact(v,'parserVersion,sourceContext,status,channel,direction,amount,currency,reference,fromPhone,receivedAt,timeSource,raw,warnings')||v.parserVersion!==1||!object(v.sourceContext)||!exact(v.sourceContext,'receivedAt,timeZone,currency','market,sender,dateOrder')||v.sourceContext.receivedAt!==original.createdAt||!['recognized','manual'].includes(v.status as string)||!['bkash','nagad','bank','unknown'].includes(v.channel as string)||!['incoming','outgoing','unknown'].includes(v.direction as string)||(v.amount!==null&&!amount(v.amount))||!currency(v.currency)||(v.reference!==null&&!literal(v.reference,120))||(v.fromPhone!==null&&!phone(v.fromPhone))||!time(v.receivedAt)||!['message','capture'].includes(v.timeSource as string)||v.raw!==paymentRawText(original)||!Array.isArray(v.warnings)||v.warnings.some(w=>!literal(w,1000)))throw new Error('Keep the complete original payment parser result and source context.');
 // Validate only the context through the parser. A later grammar/Intl update must
 // not reinterpret or overwrite a stored historical proposal during restore.
 parsePaymentText('',v.sourceContext as unknown as PaymentTextContext);
}
/** Strict native/backup shape, independent of any current membership or method list. */
export function validatePaymentRecord(v:unknown):asserts v is Payment {
 if(!object(v)||!exact(v,'id,createdAt,updatedAt,outletId,inboxId,revision,createdBy,eventId,source,original,parsed,amount,currency,method,methodName,reference,receivedAt','fromPhone,referenceScope,referenceKey,matchKey,association,voidedAt,postings')||![v.id,v.outletId,v.inboxId,v.createdBy,v.eventId].every(id)||v.id===v.inboxId||v.id===v.eventId||v.eventId===v.inboxId||!time(v.createdAt)||!time(v.updatedAt)||v.updatedAt<v.createdAt||!Number.isSafeInteger(v.revision)||(v.revision as number)<1||!['manual','sms','notification'].includes(v.source as string)||!object(v.original)||!exact(v.original,'title,text,url,createdAt')||!literal(v.original.title,200)||!literal(v.original.text,12000)||!literal(v.original.url,2400)||!time(v.original.createdAt)||!amount(v.amount)||!currency(v.currency)||!['cash','wallet','card'].includes(v.method as string)||!literal(v.methodName,120)||!v.methodName.trim()||!literal(v.reference,120)||v.fromPhone!==undefined&&!phone(v.fromPhone)||!time(v.receivedAt)||v.voidedAt!==undefined&&(!time(v.voidedAt)||v.voidedAt<v.createdAt))throw new Error('Keep a complete saved payment with checked integer money and its original source.');
 if(v.referenceScope!==undefined&&(!literal(v.referenceScope,120)||!v.referenceScope.trim()||v.method!=='wallet'||v.methodName!=='Bank transfer'))throw new Error('Name the bank/source using at most 120 characters.');
 validateParsed(v.parsed,v.original as unknown as Payment['original']);
 if(v.association!==undefined){
  const a=v.association;if(!object(a)||!exact(a,'kind,id,fingerprint,at,eventId')||!['order','sale','credit'].includes(a.kind as string)||!id(a.id)||!id(a.eventId)||typeof a.fingerprint!=='string'||!time(a.at)||a.at<v.createdAt||v.voidedAt!==undefined)throw new Error('Keep the complete checked payment association.');
  let snapshot:unknown;try{snapshot=JSON.parse(a.fingerprint);}catch{throw new Error('Keep the literal original payment candidate snapshot.');}
  if(object(snapshot)&&isCompactPaymentSnapshot(snapshot)){
   validateCompactPaymentSnapshot(snapshot,{stage:snapshot.stage==='match'?'match':'receipt',kind:a.kind as 'order'|'sale'|'credit',id:a.id,outletId:v.outletId as string,money:v as unknown as Payment});
   if(snapshot.stage!=='match'&&(!Array.isArray(v.postings)||!v.postings.some(post=>object(post)&&!post.undo&&object(post.receipt)&&post.receipt.fingerprint===a.fingerprint)))throw Error('Keep the original financial posting behind this compact association.');
  }else{
   validatePaymentAssociationSnapshot(v as unknown as Payment,a as unknown as NonNullable<Payment['association']>,snapshot);
  }
 }
 const p=v as unknown as Payment;validatePaymentPostings(p);if(p.referenceKey!==paymentReferenceKey(p)||p.matchKey!==matchKey(p))throw new Error('The payment reference or association key changed.');
}
function checked(input:CheckedPaymentInput,setup:ShopSetup,before?:Payment):Omit<CheckedPaymentInput,'checked'> {
 if(!object(input)||!exact(input,'checked,amount,currency,method,methodName,reference,receivedAt','fromPhone,referenceScope')||input.checked!==true||!amount(input.amount)||(input.currency!==setup.outlet.currency&&input.currency!==before?.currency)||!time(input.receivedAt)||!literal(input.reference,120)||input.fromPhone!==undefined&&!phone(input.fromPhone))throw new Error('Check the received amount, currency, time, reference and full phone number.');
 if(input.referenceScope!==undefined&&(!literal(input.referenceScope,120)||!input.referenceScope.trim()||input.method!=='wallet'||input.methodName!=='Bank transfer'))throw new Error('Name the bank/source using at most 120 characters.');
 const methods=[...marketPacks[setup.business.marketCode]['pay/wallets'].filter(name=>name!=='Cash'),'Bank transfer',...(before?.method==='wallet'?[before.methodName]:[])];
 if(input.method==='cash'?input.methodName!=='Cash':input.method==='card'?input.methodName!=='Card':input.method!=='wallet'||!methods.includes(input.methodName))throw new Error('Choose an actual configured payment method.');
 return paymentCheckedFields(input);
}
export function writePaymentChange(before:Payment|null,p:Payment,setup:ShopSetup,command:string,at:number,eventId:string,undoOf?:string):PaymentChange {
 assertInboxId(eventId);if(!time(at)||p.id===eventId||p.inboxId===eventId)throw new Error('Use a distinct payment audit identity and time.');
  if((command==='payment.capture'||command==='payment.edit')&&p.receivedAt>at+5*60000)throw new Error('Check the received time before saving a future payment.');
 const payment=keyed({...p,eventId,revision:(before?.revision??0)+1,updatedAt:Math.max(at,before?.updatedAt??p.createdAt)});validatePaymentRecord(payment);
 return {payment,event:{id:eventId,outletId:p.outletId,paymentId:p.id,paymentRevision:payment.revision,actor:{type:'member',id:setup.owner.id},command,before:before?structuredClone(before):null,after:structuredClone(payment),at,...(undoOf?{undoOf}:{})}};
}
export function assertCurrentPayment(before:Payment,revision:number,setup:ShopSetup){validateShop(setup);validatePaymentRecord(before);if(before.outletId!==setup.outlet.id||before.revision!==revision)throw new Error('This payment or the selected outlet changed. Open its current review.');if(before.revision===Number.MAX_SAFE_INTEGER)throw new Error('Keep this payment for manual review before another revision.');}
export function capturePaymentCommand(input:CheckedPaymentInput,setup:ShopSetup,source:InboxItem,context:PaymentTextContext,ids:{paymentId:string;eventId:string},kind:Payment['source']='sms',at=Date.now()):PaymentChange {
 validateShop(setup);validateInboxItem(source);if(source.outletId!==setup.outlet.id||source.archived)throw new Error('Open the current source in this outlet before recording a payment.');
 if(context.receivedAt!==source.createdAt||context.currency!==setup.outlet.currency||context.market!==setup.business.marketCode)throw new Error('Use the actual capture time, configured source timezone and this installation’s currency and market.');
 const original=paymentOriginal(source),parsed=parsePaymentText(paymentRawText(original),context);assertInboxId(ids.paymentId);
 const payment:Payment={id:ids.paymentId,createdAt:at,updatedAt:at,outletId:setup.outlet.id,inboxId:source.id,revision:1,createdBy:setup.owner.id,eventId:ids.eventId,source:kind,original,parsed,...checked(input,setup)};
 return writePaymentChange(null,payment,setup,'payment.capture',at,ids.eventId);
}
export function editPaymentCommand(before:Payment,revision:number,input:CheckedPaymentInput,setup:ShopSetup,eventId:string,at=Date.now()):PaymentChange {
 assertCurrentPayment(before,revision,setup);if(before.voidedAt!==undefined||before.association||activePaymentPosting(before))throw new Error('Reopen or unmatch this payment before editing it.');
 const base={...before};delete base.fromPhone;delete base.referenceScope;return writePaymentChange(before,{...base,...checked(input,setup,before)},setup,'payment.edit',at,eventId);
}
/** Use checked fields for candidates, without overwriting the original proposal. */
export function paymentMatchSource(p:Payment):ParsedPaymentText {
 validatePaymentRecord(p);const channel=p.method==='wallet'?p.methodName==='bKash'?'bkash':p.methodName==='Nagad'?'nagad':p.methodName==='Bank transfer'?'bank':'unknown':'unknown',same=channel===p.parsed.channel&&p.amount===p.parsed.amount&&p.currency===p.parsed.currency&&p.receivedAt===p.parsed.receivedAt&&(p.fromPhone??null)===p.parsed.fromPhone;
 return {...p.parsed,channel,amount:p.amount,currency:p.currency,receivedAt:p.receivedAt,fromPhone:p.fromPhone??null,status:same?p.parsed.status:'manual'};
}
export function paymentCandidates(p:Payment,records:PaymentMatchRecords,payments:readonly Payment[],options:PaymentMatchOptions={}) {
 validatePaymentRecord(p);if(p.voidedAt!==undefined)throw new Error('Reopen this payment before matching it.');
 if(records.setup.outlet.id!==p.outletId||records.setup.outlet.businessId!==records.setup.business.id)throw new Error('Read candidates from this payment’s actual outlet.');
 const reserved=payments.filter(other=>other.id!==p.id&&other.outletId===p.outletId&&other.voidedAt===undefined&&other.association).map(other=>other.association!),orders=new Set(reserved.filter(a=>a.kind==='order').map(a=>a.id));
 const method=(name:string|undefined)=>name?.trim().normalize('NFKC').toLowerCase()===p.methodName.trim().normalize('NFKC').toLowerCase();
 return findPaymentTextMatches(paymentMatchSource(p),{...records,orders:records.orders.filter(o=>!orders.has(o.id)),sales:records.sales.filter(s=>s.method===p.method&&method(s.methodName)),entries:records.entries.filter(e=>e.type!=='payment'||method(e.methodName))},{...options,usedReceipts:reserved.filter((a):a is typeof a&{kind:'sale'|'credit'}=>a.kind==='sale'||a.kind==='credit')});
}
/** A later refund, payment, edit or reversal reopens review; it never restores money. */
export function paymentAssociationIsCurrent(p:Payment,records:PaymentMatchRecords,payments:readonly Payment[]):boolean|null {
 if(!p.association)return null;if(p.voidedAt!==undefined)return false;const a=p.association,posting=activePaymentPosting(p);
 if(posting){const actual=currentPaymentReceipt(records,posting.receipt.kind,posting.receipt.id);return !!actual&&actual.fingerprint===literalToken(new PaymentEvidenceReader(records.events??[],records.entries).expand(posting.receipt.fingerprint))&&actual.amount===p.amount&&actual.currency===p.currency&&actual.method===p.method&&actual.methodName===p.methodName&&!payments.some(other=>other.id!==p.id&&other.outletId===p.outletId&&other.voidedAt===undefined&&other.association?.kind===a.kind&&other.association.id===a.id);}
 const selected:PaymentMatchRecords={...records,orders:a.kind==='order'?records.orders.filter(o=>o.id===a.id):a.kind==='sale'?records.orders.filter(o=>records.sales.some(s=>s.id===a.id&&s.orderId===o.id)):[],sales:a.kind==='sale'?records.sales.filter(s=>s.id===a.id):[],entries:a.kind==='credit'?records.entries.filter(e=>e.id===a.id||e.reversalOf===a.id):[]};
 return paymentCandidates(p,selected,payments,{windowMs:86400000}).candidates.some(c=>c.kind===a.kind&&c.id===a.id&&c.fingerprint===literalToken(new PaymentEvidenceReader(records.events??[],records.entries).expand(a.fingerprint)));
}
export function associatePaymentCommand(before:Payment,revision:number,selected:Pick<PaymentTextMatch,'kind'|'id'|'fingerprint'>,setup:ShopSetup,records:PaymentMatchRecords,payments:readonly Payment[],eventId:string,at=Date.now(),options:PaymentMatchOptions={}):PaymentChange {
 assertCurrentPayment(before,revision,setup);if(before.association)throw new Error('Inspect or unmatch the existing association first.');
 if(records.setup.business.id!==setup.business.id||records.setup.outlet.id!==setup.outlet.id)throw new Error('Read candidates from the selected business and outlet.');
 const candidate=paymentCandidates(before,records,payments,options).candidates.find(c=>c.id===selected.id&&c.kind===selected.kind&&c.fingerprint===selected.fingerprint);
 if(!candidate)throw new Error('The selected payment candidate changed. Check the latest matches.');
 if(records.setup.owner.id!==setup.owner.id)throw Error('Compare the payment under the selected operator.');
 const writer=new PaymentEvidenceWriter(records.setup,records.events??[],at),fingerprint=writer.pack(candidate.fingerprint,'match',candidate.kind,candidate.id,before),change=writePaymentChange(before,{...before,association:{kind:candidate.kind,id:candidate.id,fingerprint,at,eventId}},setup,'payment.match',at,eventId);
 return {...change,evidenceEvents:writer.added};
}
export function unmatchPaymentCommand(before:Payment,revision:number,setup:ShopSetup,eventId:string,at=Date.now()):PaymentChange {
 assertCurrentPayment(before,revision,setup);if(activePaymentPosting(before))throw new Error('Undo this source’s recorded money before unmatching it.');if(!before.association||before.voidedAt!==undefined)throw new Error('Open an active matched payment.');
 const {association,...payment}=before;return writePaymentChange(before,payment,setup,'payment.unmatch',at,eventId,association.eventId);
}
export function setPaymentVoidedCommand(before:Payment,revision:number,voided:boolean,setup:ShopSetup,eventId:string,at=Date.now()):PaymentChange {
 assertCurrentPayment(before,revision,setup);if(activePaymentPosting(before))throw new Error('Undo this source’s recorded money before setting it aside.');if(before.association)throw new Error('Unmatch this payment before setting it aside.');if((before.voidedAt!==undefined)===voided)throw new Error('This payment already has that state.');
 const payment={...before};delete payment.voidedAt;return writePaymentChange(before,{...payment,...(voided?{voidedAt:at}:{})},setup,voided?'payment.void':'payment.reopen',at,eventId);
}

export function validatePaymentAssociationSnapshot(v:Pick<Payment,'outletId'|'currency'|'amount'|'method'|'methodName'>,a:{kind:'order'|'sale'|'credit';id:string},snapshot:unknown):void {
  const keys=a.kind==='order'?'scope,order':a.kind==='sale'?'scope,sale,order,customer':'scope,entry,account,customer';
  if(!object(snapshot)||!exact(snapshot,keys)||!object(snapshot.scope)||!exact(snapshot.scope,'businessId,outletId')||!id(snapshot.scope.businessId)||snapshot.scope.outletId!==v.outletId)throw new Error('The payment candidate snapshot has a different scope.');
  const target=snapshot[a.kind==='credit'?'entry':a.kind as string];
  if(!object(target)||target.id!==a.id||target.outletId!==v.outletId||target.currency!==v.currency||(a.kind==='order'?target.total:target.amount)!==v.amount)throw new Error('The payment candidate snapshot has different money or identity.');
  const methodMatches=typeof target.methodName==='string'&&target.methodName.trim().normalize('NFKC').toLowerCase()===(v.methodName as string).trim().normalize('NFKC').toLowerCase();
  if(a.kind==='order'&&(!object(target.payment)||target.payment.status!=='pending')||a.kind==='sale'&&(target.voidedAt!==undefined||target.method!==v.method||!methodMatches)||a.kind==='credit'&&(target.type!=='payment'||target.reversalOf!==undefined||target.refundId!==undefined||!methodMatches))throw new Error('Keep the original eligible payment candidate.');
}
