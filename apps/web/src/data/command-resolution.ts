import type {LocalOutboxEntry} from '@mise/core/local-outbox';
import {parseShopCommand,parseShopCommandReceipt} from '@mise/core/shop-commands';
import {syncHash} from '@mise/core/sync-read';
import {nativeRowHash} from './canonical-writes';
import type {AuditEvent} from '@mise/core/models';
import {syncDownloadToken} from '@mise/core/sync-download';
/** A resolution is authoritative only for this exact original local source.
 * Never let a valid receipt for a different saved copy remove its overlay. */
export async function assertResolutionSources(row:LocalOutboxEntry):Promise<void> {
 const resolved=row.receipts.flatMap((receipt,index)=>receipt.type==='command.resolved'?[{receipt,index}]:[]);
 if(!resolved.length)return;
 const sourceHash=await nativeRowHash({...row,status:'pending',receipts:[]});
 for(const {receipt,index} of resolved){
  const command=parseShopCommand(row.commands[index]),parsed=parseShopCommandReceipt(receipt,command),commandHash=await syncHash(new TextEncoder().encode(JSON.stringify(command)));
  if(parsed.type!=='command.resolved'||parsed.sourceHash!==sourceHash||parsed.commandHash!==commandHash)throw new Error('Keep the exact original resolved action, source and server proof.');
 }
}

/** Coverage proves the original identity is finalized. Its canonical audit must
 * also prove the exact saved outcome before the local projection can retire it. */
export function assertCanonicalResolutions(rows:readonly LocalOutboxEntry[],events:readonly AuditEvent[],covered:ReadonlySet<string>):void {
 const audits=new Map(events.map(event=>[event.id,event]));
 for(const row of rows)for(const receipt of row.receipts){
  if(receipt.type!=='command.resolved'||!covered.has(receipt.commandId))continue;
  const event=audits.get(receipt.commandId),before=event?.before,after=event?.after;
  if(event?.command!=='sync.resolve'||event.outletId!==receipt.outletId||event.at!==receipt.at||
   !before||typeof before!=='object'||!after||typeof after!=='object'||
   syncDownloadToken((before as Record<string,unknown>).resolutionId)!==syncDownloadToken(receipt.id)||
   (before as Record<string,unknown>).commandHash!==receipt.commandHash||
   (before as Record<string,unknown>).sourceHash!==receipt.sourceHash||
   syncDownloadToken((after as Record<string,unknown>).receipt)!==syncDownloadToken(receipt))
    throw new Error('Keep the exact canonical resolution audit before retiring the original action.');
 }
}
