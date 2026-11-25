import {createBackup} from './backup';
import type {BackupTable, MiseBackup} from './backup-tables';
import {cloudRecordMaps,cloudRecordMap, decodeCommandRecord, encodeCommandRecord, type CloudRecord} from './cloud-records';
import {inboxImageBytes, type InboxBackupImage} from './inbox';
import {syncHash} from './sync-read';

export interface ReplayProjection {records:CloudRecord[];deleted?:{table:BackupTable;id:string}[]}
export class PendingReplayError extends Error {
  constructor(readonly kind:'conflict'|'retained'='conflict'){super('Keep the original pending action and review its current source.');}
}
const immutableTables:readonly BackupTable[]=['events','creditEntries','stockMoves','orderNotes','orderCommunications'];
/** Domain facts only: this envelope contains no server admission or credential. */
export function replaySqlRow(table:BackupTable,row:unknown|null,businessId:string):Record<string,unknown>|null {
  if(row===null)return null;
  const values=encodeCommandRecord(table,row,businessId).values,fields=cloudRecordMap(table).fields as Record<string,string>;
  return Object.fromEntries(Object.entries(values).map(([key,value])=>[key,value!==null&&fields[key]?.startsWith('j:')?JSON.parse(value as string):value]));
}
/** Rebuild an exact tentative projection, preserving fields outside scalar SQL maps. */
export async function applyReplayProjection(backup:MiseBackup,projection:ReplayProjection,original:MiseBackup):Promise<MiseBackup> {
  const tables=structuredClone(backup.tables),imageRows=projection.records.filter(record=>record.table==='inbox_images');
  const usedImages=new Set<string>();
  for(const change of projection.deleted??[]){
    if(immutableTables.includes(change.table))throw new PendingReplayError();
    const rows=tables[change.table] as {id:string}[],at=rows.findIndex(row=>row.id===change.id);
    if(at<0)throw new PendingReplayError();rows.splice(at,1);
  }
  for(const record of projection.records){
    if(record.table==='inbox_images')continue;
    const table=Object.entries(cloudRecordMaps).find(([,map])=>map.table===record.table)?.[0] as BackupTable|undefined;
    if(!table)throw new PendingReplayError();
    const fields=cloudRecordMap(table).fields as Record<string,string>,raw=Object.fromEntries(Object.entries(record.values).map(([key,value])=>[key,value!==null&&fields[key]?.startsWith('j:')?JSON.parse(value as string):value])),row=decodeCommandRecord(table,raw);
    if(typeof row.id!=='string')throw new PendingReplayError();
    const rows=tables[table] as unknown as Record<string,unknown>[],at=rows.findIndex(before=>before.id===row.id);
    if(at>=0&&immutableTables.includes(table))throw new PendingReplayError();
    if(table==='members'){
      const member=tables.members.find(member=>member.id===row.id);
      if(!member)throw new PendingReplayError('retained');
      row.outletIds=[...member.outletIds];
    }
    if(table==='inboxItems'){
      const descriptors=imageRows.filter(image=>image.values.inbox_item_id===row.id).sort((a,b)=>Number(a.values.position)-Number(b.values.position));
      const before=tables.inboxItems.find(item=>item.id===row.id),source=original.tables.inboxItems.find(item=>item.id===row.id);
      if(!descriptors.length)row.images=structuredClone(before?.images??[]);
      else {
        if(before||!source||source.outletId!==row.outletId||source.images.length!==descriptors.length)throw new PendingReplayError('retained');
        const images:InboxBackupImage[]=[];
        for(const [position,descriptor] of descriptors.entries()){
          const value=descriptor.values,image=source.images[position];
          if(value.position!==position||value.business_id!==backup.tables.businesses[0]?.id||value.outlet_id!==row.outletId||image.id!==value.id||JSON.stringify(image.name)!==value.name||image.type!==value.type||image.size!==value.size||usedImages.has(image.id))throw new PendingReplayError('retained');
          if(await syncHash(inboxImageBytes(image))!==value.sha256)throw new PendingReplayError('retained');
          usedImages.add(image.id);images.push(structuredClone(image));
        }
        row.images=images;
      }
    }
    if(at<0)rows.push(row);else rows[at]=row;
  }
  if(usedImages.size!==imageRows.length)throw new PendingReplayError('retained');
  return createBackup(tables,backup.exportedAt);
}
