import type {LocalOutboxEntry} from '@mise/core/local-outbox';
import {isCustomerCommand,parseShopCommand,parseShopCommandReceipt} from '@mise/core/shop-commands';
import {customerReviewSourceAudits,parseCustomerReviewRequest,type CustomerReviewRequest} from '@mise/core/customer-review-source';
import {nativeRowHash} from './canonical-writes';
import type {CustomerCommand} from '@mise/core/customer-commands';

function originalAudits(row:LocalOutboxEntry,command:CustomerCommand){
 const wanted=[command.id,...('ids'in command?[command.ids.accountEventId,command.ids.openingEventId]:[])],selected=row.changes.filter(change=>change.table==='events'&&wanted.includes(change.key));
 if(new Set(selected.map(c=>c.key)).size!==selected.length||selected.some(c=>c.before!==null||c.after===null))throw Error('Keep every original append-only customer audit.');
 const byId=new Map(selected.map(c=>[c.key,c.after]));
 if(!byId.has(command.id))throw Error('Keep the original customer action audit.');
 return customerReviewSourceAudits(command,wanted.filter(key=>byId.has(key)).map(key=>byId.get(key)),row.businessId);
}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);

/** Read-only extraction. Later grouped rows cannot replace the selected action's
 * immediate audit, and a receipt prefix cannot authorize skipping an action. */
export async function prepareCustomerReviewSource(row:LocalOutboxEntry,index:number,id:string,replacementId:string):Promise<CustomerReviewRequest>{
 if(row.version!==1||row.status!=='pending'||!Number.isSafeInteger(index)||index<0||index!==row.receipts.length||!row.commands[index])throw Error('Review the first unconfirmed original customer action.');
 const commands=row.commands.map(parseShopCommand),command=commands[index];
 if(!isCustomerCommand(command)||command.outletId!==row.outletId)throw Error('Choose the original saved customer action.');
 for(let i=0;i<index;i++)parseShopCommandReceipt(row.receipts[i],commands[i]);
 const events=originalAudits(row,command),account=events.find(e=>e.kind==='account');
 if('ids'in command){
  const accountId=command.ids.accountId,rows=row.changes.filter(c=>c.table==='creditAccounts'&&c.key===accountId),changed=rows[0];
  if(rows.length>1||changed&&(!object(changed.after)||changed.after.id!==accountId||changed.after.customerId!==command.customerId||changed.after.outletId!==command.outletId)||account&&(!changed||!object(changed.after)||changed.after.currency!==account.after.currency||account.before===null&&changed.before!==null))throw Error('Keep the complete original khata row and audit.');
  if(!account&&changed?.before===null){
   // A grouped entry can start by creating the account and later edit contact
   // details only. Require that actual earlier creation witness; otherwise a
   // missing optional audit could conceal this action's implicit creation.
   const earlier=commands.slice(0,index).some(prior=>{
    if(!isCustomerCommand(prior)||!('ids'in prior)||prior.ids.accountId!==accountId||prior.customerId!==command.customerId||prior.outletId!==command.outletId)return false;
    return originalAudits(row,prior).some(e=>e.kind==='account'&&e.before===null&&e.after.currency===(changed.after as Record<string,unknown>).currency);
   });
   if(!earlier)throw Error('Keep the original implicit khata creation audit.');
  }
 }
 const opening=events.find(e=>e.kind==='opening');
 if(opening){
  const entries=row.changes.filter(c=>c.table==='creditEntries'&&c.key===opening.after.id),entry=entries[0],after=entry?.after;
  if(entries.length!==1||entry.before!==null||!object(after)||Object.entries(after).filter(([,v])=>v!==undefined).length!==Object.keys(opening.after).length||Object.entries(opening.after).some(([k,v])=>after[k]!==v))throw Error('Keep the complete original opening entry and its audit.');
 }
 return parseCustomerReviewRequest({id,replacementId,command,sourceHash:await nativeRowHash({...row,commands,status:'pending',receipts:[]}),sourceJson:JSON.stringify({v:1,businessId:row.businessId,entryId:row.id,sequence:row.sequence,commandIndex:index,at:events[0].at,events})},false);
}
