import { ulid } from 'ulid';
import type { AuditEvent } from './models';
import { BACKUP_FORMAT_VERSION, BACKUP_SCHEMA_VERSION, MAX_BACKUP_BYTES, backupTableNames, type BackupTable, type BackupTables, type MiseBackup } from './backup-tables';
import { backupRecord, backupTime, validateBackupRow } from './backup-schema';
import { validateBackupLinks } from './backup-links';

export type BackupCounts = Record<BackupTable,number>;
export interface RestoreReview {sourceToken:string;currentToken:string}
export interface BackupPreview extends RestoreReview {
  shopName:string;outletName:string;currency:string;timezone:string;exportedAt:number;
  counts:BackupCounts;records:number;replacesShopName:string|null;
}
export function parseBackup(input:unknown):MiseBackup {
  let value:unknown = input;
  if (typeof input === 'string') {
    if (input.length > MAX_BACKUP_BYTES || new TextEncoder().encode(input).byteLength > MAX_BACKUP_BYTES) throw new Error('Use a backup smaller than 50 MB.');
    try {value = JSON.parse(input.replace(/^\uFEFF/,''));} catch {throw new Error('This file is not valid JSON. Choose a Mise JSON backup.');}
  }
  const backup = backupRecord(value,'file');
  if (backup.format !== 'mise-backup' || backup.formatVersion !== BACKUP_FORMAT_VERSION) throw new Error('Choose a supported Mise JSON backup.');
  if ([7,8,9].includes(backup.schemaVersion as number)) {
    const version=backup.schemaVersion,oldTables=backupRecord(backup.tables,'tables');
    const expected=backupTableNames.filter(name=>name!=='inboxItems'&&(version!==7||name!=='purchases'));
    if(Object.keys(oldTables).length!==expected.length||Object.keys(oldTables).some(name=>!(expected as readonly string[]).includes(name)))throw new Error(`The schema-${String(version)} backup has unsupported tables.`);
    return parseBackup({...backup,schemaVersion:BACKUP_SCHEMA_VERSION,tables:{...oldTables,...(version===7?{purchases:[]}:{}),inboxItems:[]}});
  }
  if (backup.schemaVersion !== BACKUP_SCHEMA_VERSION) throw new Error(`This backup uses schema ${String(backup.schemaVersion)}. This version supports schemas 7, 8, 9 and ${BACKUP_SCHEMA_VERSION}; open it with the matching Mise version.`);
  if (Object.keys(backup).some(k => !['format','formatVersion','schemaVersion','exportedAt','tables'].includes(k))) throw new Error('The backup has unsupported metadata.');
  backupTime(backup.exportedAt,'exportedAt');
  const tables = backupRecord(backup.tables,'tables');
  if (Object.keys(tables).length !== backupTableNames.length || Object.keys(tables).some(name => !(backupTableNames as readonly string[]).includes(name))) throw new Error('The backup must contain every supported table exactly once.');
  for (const name of backupTableNames) {
    const rows = tables[name];if (!Array.isArray(rows)) throw new Error(`Invalid backup: ${name} must be a list.`);
    const ids = new Set<string>();
    for (let index = 0;index < rows.length;index++) {
      validateBackupRow(name,rows[index],`${name}[${index}]`);
      if (ids.has(rows[index].id)) throw new Error(`Invalid backup: ${name} contains duplicate record IDs.`);ids.add(rows[index].id);
    }
  }
  const result = value as MiseBackup;validateBackupLinks(result.tables);return result;
}
/** Snapshot exactly JSON-storable data; undefined optional object properties are omitted. */
export function createBackup(tables:BackupTables,at = Date.now()):MiseBackup {
  return parseBackup(JSON.stringify({format:'mise-backup',formatVersion:BACKUP_FORMAT_VERSION,schemaVersion:BACKUP_SCHEMA_VERSION,exportedAt:at,tables}));
}
export function backupCounts(backup:MiseBackup):BackupCounts {
  return Object.fromEntries(backupTableNames.map(name => [name,backup.tables[name].length])) as BackupCounts;
}
function canonical(value:unknown):unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,v]) => [key,canonical(v)]));
  return value;
}
/** Exact comparison, not a lossy hash. Capture time and IndexedDB iteration order are irrelevant. */
export function backupToken(backup:MiseBackup):string {
  return JSON.stringify(canonical(Object.fromEntries(backupTableNames.map(name => [name,[...backup.tables[name]].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)]))));
}
export function previewBackup(source:MiseBackup,current:MiseBackup):BackupPreview {
  parseBackup(source);parseBackup(current);
  const shop = source.tables.businesses[0], outlet = source.tables.outlets[0];
  if (!shop || !outlet) throw new Error('This backup has no shop to restore.');
  const counts = backupCounts(source);
  return {shopName:shop.name,outletName:outlet.name,currency:outlet.currency,timezone:outlet.timezone,exportedAt:source.exportedAt,counts,records:Object.values(counts).reduce((a,b) => a+b,0),replacesShopName:current.tables.businesses[0]?.name || null,sourceToken:JSON.stringify([source.schemaVersion,source.exportedAt,backupToken(source)]),currentToken:backupToken(current)};
}
export function restoreBackupCommand(source:MiseBackup,current:MiseBackup,review:RestoreReview,at = Date.now()):{tables:BackupTables;event:AuditEvent} {
  const latest = previewBackup(source,current);backupTime(at,'restore time');
  if (latest.sourceToken !== review.sourceToken) throw new Error('The selected backup changed. Preview it again.');
  if (latest.currentToken !== review.currentToken) throw new Error('This browser’s data changed after the preview. Review the latest data before restoring.');
  const tables = structuredClone(source.tables), owner = current.tables.members.find(m => m.active);
  const event:AuditEvent = {id:ulid(at),outletId:source.tables.outlets[0].id,actor:{type:'system',id:'local-backup-restore'},command:'backup.restore',
    before:{shopName:current.tables.businesses[0]?.name || null,counts:backupCounts(current),requestedBy:owner ? {id:owner.id,name:owner.name} : null},
    after:{shopName:latest.shopName,counts:latest.counts,sourceExportedAt:source.exportedAt,schemaVersion:source.schemaVersion},at};
  return {tables,event};
}
