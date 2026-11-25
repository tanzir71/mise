import {backupToken,createBackup,parseBackup} from './backup';
import {backupTableNames,type BackupTable,type MiseBackup} from './backup-tables';
import {cloudRecordMaps,cloudRecordMap,decodeCommandRecord,encodeCommandRecord,type CloudRecord} from './cloud-records';
import {isMoneyCommand,isStockCommand,isOrderCommand,isPurchaseCommand,isCustomerCommand,parseShopCommand,type ShopCommand} from './shop-commands';
import {proposedMoneyCurrencyMatches} from './money-currency';
import {proposedOrderCurrencyMatches} from './order-currency';
import {proposedPurchaseCurrencyMatches} from './purchase-currency';
import {proposedCustomerCurrencyMatches} from './customer-currency';
import {replayMoneyRecords} from './money-replay';
import {replayStockRecords} from './stock-replay';
import {stockWritePlan} from './stock-commands';
import {stockReviewBoundary,StockReviewBoundaryError,type StockReviewBoundary} from './stock-review-boundary';
import {customerReviewBoundary,CustomerReviewBoundaryError,type CustomerReviewBoundary} from './customer-review-boundary';
import {validClosingParent} from './closing-source';
import {closingReviewBoundary,ClosingReviewBoundaryError,type ClosingReviewBoundary} from './closing-review-boundary';
import {syncDownloadToken} from './sync-download';
import {syncHash} from './sync-read';
import type {SyncCoverageIntent} from './sync-coverage';
import {replayOtherPending} from './pending-replay';
import {applyReplayProjection,PendingReplayError} from './replay-records';

export interface MaterializedRow {table:BackupTable;key:string;before:unknown|null;after:unknown|null}
export interface CanonicalApplication {
 id:string;version:1;previousApplicationHash:string|null;previousBaseHash:string|null;readSourceHash:string;readSeal:string;cursor:string;
 baseHash:string;throughSequence:number;queueHash:string;workingHash:string;overlay:MaterializedRow[];
 covered:SyncCoverageIntent[];pending:string[];proofs:{batchHash:string;sourceHash:string;resultHash:string}[];
 recoveryId?:string;
}
export interface LocalCanonicalApplication extends CanonicalApplication {hash:string}
export const localApplicationTableNames=['syncApplications'] as const;
export class ReconciliationError extends Error {
 constructor(readonly kind:'integrity'|'retained'|'conflict'|'review'='review',readonly commandId:string|null=null){super({integrity:'The original sync evidence changed. Keep local work and its recovery records.',retained:'Keep the original local action for review before applying this download.',conflict:'A pending action needs the latest shop values reviewed. Keep its original records.',review:'The outlet or local work changed. Retry from the current accepted snapshot.'}[kind]);}
}
export const materializationHash=(value:unknown)=>syncHash(new TextEncoder().encode(syncDownloadToken(value)));
export const applicationHash=(value:CanonicalApplication)=>materializationHash(value);
/** Match row_to_json for shared mutation projections, without any ticket or authority. */
function sqlRow(table:BackupTable,row:unknown,businessId:string):Record<string,unknown>{
 const values=encodeCommandRecord(table,row,businessId).values,fields=cloudRecordMap(table).fields as Record<string,string>;
 return Object.fromEntries(Object.entries(values).map(([key,value])=>[key,value!==null&&fields[key]?.startsWith('j:')?JSON.parse(value as string):value]));
}
function applyRecords(backup:MiseBackup,records:readonly CloudRecord[]):MiseBackup {
 const tables=structuredClone(backup.tables);
 for(const record of records){const table=Object.entries(cloudRecordMaps).find(([,map])=>map.table===record.table)?.[0] as BackupTable|undefined;if(!table)throw new ReconciliationError('integrity');
  const fields=cloudRecordMap(table).fields as Record<string,string>,raw=Object.fromEntries(Object.entries(record.values).map(([key,value])=>[key,value!==null&&fields[key]?.startsWith('j:')?JSON.parse(value as string):value])),row=decodeCommandRecord(table,raw);
  if(typeof row.id!=='string')throw new ReconciliationError('integrity');const list=tables[table] as unknown as Record<string,unknown>[],at=list.findIndex(r=>r.id===row.id);if(at>=0&&['events','creditEntries','stockMoves'].includes(table))throw new ReconciliationError('conflict');if(at<0)list.push(row);else list[at]=row;
 }
 return createBackup(tables,backup.exportedAt);
}
/** Re-evaluate an original intent on the current canonical values. The command,
 * original outbox records, IDs and receipts are never edited or manufactured.
 * A tentative projection never substitutes for genuine receipt coverage.
 */
export async function replayPendingIntent(input:MiseBackup,value:ShopCommand,actorId:string,at:number,original:MiseBackup=input,originalActionAt=at,savedCurrency?:string,stockBoundary?:StockReviewBoundary,customerBoundary?:CustomerReviewBoundary,closingParent:string|null=null,closingBoundary?:ClosingReviewBoundary):Promise<MiseBackup> {
 const backup=parseBackup(input),c=parseShopCommand(value),t=backup.tables,business=t.businesses[0],outlet=t.outlets[0],actor=t.members.find(m=>m.id===actorId);
 if(!business||!outlet||!actor?.active||!['owner','manager'].includes(actor.role)||actor.businessId!==business.id||outlet.businessId!==business.id||'outletId'in c&&c.outletId!==outlet.id||actor.role==='manager'&&!actor.outletIds.includes(outlet.id))throw new ReconciliationError('review',c.id);
 // A matching row/audit never proves receipt inclusion. Without actual coverage
 // it is a conflict, rather than permission to discard or overwrite the action.
 if(t.events.some(e=>e.id===c.id))throw new ReconciliationError('conflict',c.id);
 const row=<K extends BackupTable>(table:K,value:unknown|null)=>value===null?null:sqlRow(table,value,business.id),rows=<K extends BackupTable>(table:K,values:unknown[])=>values.map(v=>row(table,v));
 // This is a deterministic tentative projection time, never a server admission
 // or receipt. A frozen read may predate an action by hours. Live server callers
 // still supply their real clock to the shared calculations and expiry checks.
 const projectionAt=Math.max(at,originalActionAt,'occurredAt'in c?c.occurredAt:0,c.type==='inbox.capture'?c.createdAt:0);
 if(!Number.isSafeInteger(projectionAt)||projectionAt<0||projectionAt>8640000000000000)throw new ReconciliationError('integrity',c.id);
 const context:Record<string,unknown>={businessId:business.id,outletId:outlet.id,actorId,at:projectionAt};let raw:Record<string,unknown>,records:CloudRecord[];
 try{
  if(isMoneyCommand(c)){
   const sale=c.type==='sale.undo'?t.sales.find(s=>s.id===c.saleId)??null:null;
   const entry=c.type==='khata.undo'?t.creditEntries.find(e=>e.id===c.entryId)??null:sale?.method==='credit'?t.creditEntries.find(e=>e.saleId===sale.id&&e.type==='charge'&&!e.reversalOf)??null:null;
   const accountId='accountId'in c?c.accountId:sale?.creditAccountId??entry?.accountId,account=t.creditAccounts.find(a=>a.id===accountId)??null,customer=t.customers.find(customer=>customer.id===account?.customerId)??null;
   if(c.type==='sale.record'||c.type==='sale.credit'){if(t.sales.some(s=>s.id===c.saleId))throw new ReconciliationError('conflict',c.id);}
   raw={business:row('businesses',business),outlet:row('outlets',outlet),sale:row('sales',sale),entry:row('creditEntries',entry),account:row('creditAccounts',account),customer:row('customers',customer),entries:rows('creditEntries',t.creditEntries.filter(e=>e.accountId===accountId)),items:rows('items',t.items)};
   records=replayMoneyRecords({...context,contextJson:JSON.stringify(raw)},c);
   if(!proposedMoneyCurrencyMatches(c,records,savedCurrency))throw new ReconciliationError('conflict',c.id);
  }else if(isStockCommand(c)){
   (stockBoundary??await stockReviewBoundary(t.events,outlet.id)).assert(c);
   if(c.type==='stock.create'&&t.stockItems.some(i=>i.id===c.stockItemId))throw new ReconciliationError('conflict',c.id);
   const plan=stockWritePlan(c),ids=new Set(plan.rows.map(r=>r.itemId));
   raw={business:row('businesses',business),outlet:row('outlets',outlet),items:rows('stockItems',t.stockItems.filter(i=>ids.has(i.id))),moves:rows('stockMoves',t.stockMoves.filter(m=>ids.has(m.stockItemId))),suppliers:rows('suppliers',t.suppliers)};
   records=replayStockRecords({...context,contextJson:JSON.stringify(raw)},c);
  }else{
   if(c.type==='closing.undo'){
    if(!validClosingParent(closingParent))throw new ReconciliationError('integrity',c.id);
    if(t.dayClosings.find(row=>row.id===c.closingId)?.eventId!==closingParent)throw new ReconciliationError('conflict',c.id);
   }
   const projection=await replayOtherPending(backup,c,actor,projectionAt);
   if(isOrderCommand(c)&&!proposedOrderCurrencyMatches(c,projection.records,savedCurrency))throw new ReconciliationError('conflict',c.id);
   if(isPurchaseCommand(c)&&!proposedPurchaseCurrencyMatches(c,projection.records,savedCurrency))throw new ReconciliationError('conflict',c.id);
   if(isCustomerCommand(c)&&!proposedCustomerCurrencyMatches(c,projection.records,savedCurrency))throw new ReconciliationError('conflict',c.id);
   (customerBoundary??await customerReviewBoundary(t.events,outlet.id)).assert(projection.records,backup);
   (closingBoundary??await closingReviewBoundary(t.events,outlet.id)).assert(projection.records,backup);
   return await applyReplayProjection(backup,projection,parseBackup(original));
  }
  (customerBoundary??await customerReviewBoundary(t.events,outlet.id)).assert(records,backup);
  (closingBoundary??await closingReviewBoundary(t.events,outlet.id)).assert(records,backup);
  return applyRecords(backup,records);
 }catch(error){if(error instanceof ReconciliationError)throw error;if(error instanceof PendingReplayError||error instanceof StockReviewBoundaryError||error instanceof CustomerReviewBoundaryError||error instanceof ClosingReviewBoundaryError)throw new ReconciliationError(error.kind,c.id);throw new ReconciliationError('conflict',c.id);}
}
export function materializedRows(base:MiseBackup,working:MiseBackup):MaterializedRow[]{
 parseBackup(base);parseBackup(working);const result:MaterializedRow[]=[];
 for(const table of backupTableNames){const before=new Map(base.tables[table].map(row=>[row.id,row])),after=new Map(working.tables[table].map(row=>[row.id,row]));for(const key of [...new Set([...before.keys(),...after.keys()])].sort())if(syncDownloadToken(before.get(key)??null)!==syncDownloadToken(after.get(key)??null))result.push({table,key,before:structuredClone(before.get(key)??null),after:structuredClone(after.get(key)??null)});}
 return result;
}
/** Exact overlays are saved output, never new outgoing commands or authority. */
export function restoreMaterialization(base:MiseBackup,overlay:readonly MaterializedRow[],at=base.exportedAt):MiseBackup {
 const tables=structuredClone(parseBackup(base).tables),seen=new Set<string>();
 for(const change of overlay){if(!backupTableNames.includes(change.table)||seen.has(change.table+'\0'+change.key))throw new ReconciliationError('integrity');seen.add(change.table+'\0'+change.key);const rows=tables[change.table] as unknown as Record<string,unknown>[],index=rows.findIndex(row=>row.id===change.key);
  if(syncDownloadToken(index<0?null:rows[index])!==syncDownloadToken(change.before)||change.after!==null&&(!(typeof change.after==='object')||(change.after as {id?:unknown}).id!==change.key))throw new ReconciliationError('integrity');
  if(index>=0)rows.splice(index,1);if(change.after!==null)rows.push(structuredClone(change.after) as Record<string,unknown>);
 }
 return createBackup(tables,at);
}
export const workingSnapshotHash=(backup:MiseBackup)=>materializationHash(backupToken(parseBackup(backup)));
