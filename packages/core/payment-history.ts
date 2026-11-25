import type {AuditEvent,Payment} from './models';
import type {InboxItem} from './inbox';
import {paymentOriginal,validatePaymentRecord} from './payment-records';
import {activePaymentPosting,paymentCheckedFields} from './payment-posting-shape';
import {literalToken as syncDownloadToken} from './literal-token';
const same=(a:unknown,b:unknown)=>syncDownloadToken(a)===syncDownloadToken(b);
const ensure=(ok:unknown):void=>{if(!ok)throw new Error('Invalid backup: the saved payment source or audit history is incomplete or inconsistent.');};
const fields=['id','createdAt','outletId','inboxId','createdBy','source','original','parsed'] as const;
const mutable=['amount','currency','method','methodName','reference','referenceScope','fromPhone','receivedAt'] as const;
function unchanged(before:Payment,after:Payment,keys:readonly (keyof Payment)[]){ensure(keys.every(k=>same(before[k]??null,after[k]??null)));}
/** Validate the whole local chain, including original capture and metadata undo.
 * A restored association is evidence to inspect, never fresh recording authority. */
export function validatePaymentHistory(payments:readonly Payment[],events:readonly AuditEvent[],sources:readonly InboxItem[]):void {
 const rows=new Map(payments.map(p=>[p.id,p])),groups=new Map<string,AuditEvent[]>(),inbox=new Map(sources.map(s=>[s.id,s]));
 for(const event of events){if(event.paymentId===undefined&&event.paymentRevision===undefined&&!event.command.startsWith('payment.'))continue;ensure(typeof event.paymentId==='string'&&rows.has(event.paymentId)&&Number.isSafeInteger(event.paymentRevision));const list=groups.get(event.paymentId!)??[];list.push(event);groups.set(event.paymentId!,list);}
 const sourceKeys=new Set<string>(),references=new Set<string>(),matches=new Set<string>();
 for(const payment of payments){
  validatePaymentRecord(payment);const source=inbox.get(payment.inboxId);ensure(source&&source.outletId===payment.outletId&&same(paymentOriginal(source),payment.original));
  const key=JSON.stringify([payment.outletId,payment.inboxId]);ensure(!sourceKeys.has(key));sourceKeys.add(key);
  for(const [value,seen]of [[payment.referenceKey,references],[payment.matchKey,matches]] as const)if(value!==undefined){const key=JSON.stringify([payment.outletId,value]);ensure(!seen.has(key));seen.add(key);}
  const chain=(groups.get(payment.id)??[]).sort((a,b)=>a.paymentRevision!-b.paymentRevision!);ensure(chain.length===payment.revision);let before:Payment|null=null;
  for(const [index,event]of chain.entries()){
   validatePaymentRecord(event.after);const after=event.after;ensure(event.paymentRevision===index+1&&after.revision===index+1&&after.id===payment.id&&event.outletId===after.outletId&&event.actor.type==='member'&&after.eventId===event.id&&same(event.before,before));
   if(!before)ensure(event.command==='payment.capture'&&after.createdBy===event.actor.id&&after.createdAt===event.at&&after.updatedAt===event.at&&!after.association&&!after.postings&&after.voidedAt===undefined&&!event.undoOf);
   else{
    unchanged(before,after,fields);ensure(after.updatedAt===Math.max(before.updatedAt,event.at));
    if(event.command!=='payment.edit')unchanged(before,after,mutable);
    if(!['payment.record','payment.record-undo'].includes(event.command))unchanged(before,after,['postings']);
    switch(event.command){
     case 'payment.edit':ensure(!activePaymentPosting(before)&&!before.association&&!after.association&&before.voidedAt===undefined&&after.voidedAt===undefined&&!event.undoOf);break;
     case 'payment.match':ensure(!before.association&&after.association&&after.association.eventId===event.id&&after.association.at===event.at&&before.voidedAt===undefined&&after.voidedAt===undefined&&!event.undoOf);break;
     case 'payment.unmatch':ensure(!activePaymentPosting(before)&&before.association&&!after.association&&event.undoOf===before.association.eventId&&before.voidedAt===undefined&&after.voidedAt===undefined);break;
     case 'payment.void':ensure(!activePaymentPosting(before)&&!before.association&&!after.association&&before.voidedAt===undefined&&after.voidedAt===event.at&&!event.undoOf);break;
     case 'payment.reopen':ensure(!before.association&&!after.association&&before.voidedAt!==undefined&&after.voidedAt===undefined&&!event.undoOf);break;
     case 'payment.record':{
      const old=before.postings??[],next=after.postings??[],posting=next.at(-1);ensure(!activePaymentPosting(before)&&before.voidedAt===undefined&&after.voidedAt===undefined&&next.length===old.length+1&&same(next.slice(0,-1),old)&&posting&&posting.eventId===event.id&&posting.at===event.at&&!posting.undo&&same(posting.money,paymentCheckedFields(before))&&!event.undoOf);
      ensure(!before.association||posting!.target.kind==='order'&&before.association.kind==='order'&&before.association.id===posting!.target.id);break;
     }
     case 'payment.record-undo':{
      const old=before.postings??[],next=after.postings??[],posting=old.at(-1),undone=next.at(-1);ensure(posting&&!posting.undo&&old.length===next.length&&same(old.slice(0,-1),next.slice(0,-1))&&undone?.undo&&same(posting,{...undone,undo:undefined})&&undone.undo.eventId===event.id&&undone.undo.at===event.at&&event.undoOf===posting.eventId&&!after.association&&before.voidedAt===undefined&&after.voidedAt===undefined);break;
     }
     default:ensure(false);
    }
   }
   before=after;
  }
  ensure(same(before,payment));
 }
}
