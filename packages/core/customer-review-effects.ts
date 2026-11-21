import {decodeProposedCommandRecord,encodeCommandRecord,type CloudRecord} from './cloud-records';
import {reviewedCustomerProposal} from './customer-review';
import {customerReviewSourceAudits,parseCustomerReviewRequest,parseCustomerReviewSource,type CustomerReviewRequest} from './customer-review-source';
import {syncDownloadToken} from './sync-download';

/** Additional invariant for an ordinary tentative replay, not authorization.
 * A review cannot turn a contact edit into account creation, replace an existing
 * financial parent, drop an original creation or reinterpret a saved phone/unit.
 * Server admission and current-state consent are still independently required. */
export function customerReviewEffectsMatch(request:CustomerReviewRequest,records:readonly CloudRecord[]):boolean{
 try{
  const input=parseCustomerReviewRequest(request,false),source=parseCustomerReviewSource(input),command=reviewedCustomerProposal(input.command,input.replacementId);
  if(!Array.isArray(records)||records.some(r=>!r||typeof r!=='object'||!r.values||r.values.business_id!==source.businessId||!['customers','credit_accounts','credit_entries','events'].includes(r.table)))return false;
  const rawAudits=records.filter(r=>r.table==='events').map(r=>decodeProposedCommandRecord('events',r)),proposed=customerReviewSourceAudits(command,rawAudits,source.businessId);
  if(proposed.length!==source.events.length)return false;
  for(let i=0;i<proposed.length;i++){
   const saved=source.events[i],next=proposed[i];
   if(saved.kind!==next.kind||saved.actorId!==next.actorId||(saved.before===null)!==(next.before===null))return false;
   if(saved.kind==='account'&&next.kind==='account'&&saved.after.currency!==next.after.currency)return false;
   if(saved.kind==='opening'&&next.kind==='opening'&&saved.after.currency!==next.after.currency)return false;
   if(saved.kind==='customer'&&next.kind==='customer'&&(command.type==='customer.create'||command.type==='customer.update')&&saved.after.phone!==next.after.phone)return false;
  }
  // Bind every projected business row to its genuine tentative audit. A valid
  // audit set must not conceal a different row, duplicate or unrelated mutation.
  const expected:CloudRecord[]=[];
  for(let i=0;i<rawAudits.length;i++){
   const event=rawAudits[i],kind=proposed[i].kind;
   expected.push(encodeCommandRecord('events',event,source.businessId));
   expected.push(encodeCommandRecord(kind==='customer'?'customers':kind==='account'?'creditAccounts':'creditEntries',event.after,source.businessId));
  }
  if(expected.length!==records.length)return false;
  const key=(r:CloudRecord)=>r.table+':'+r.values.id,byKey=new Map(expected.map(r=>[key(r),r]));
  if(byKey.size!==expected.length||new Set(records.map(key)).size!==records.length)return false;
  return records.every(r=>syncDownloadToken(r)===syncDownloadToken(byKey.get(key(r))));
 }catch{return false;}
}
