import Dexie from 'dexie';
import { portableInboxItems,storedInboxItems } from './inbox';
import type { MiseDatabase } from './db';
import type { SetupSnapshot } from '@mise/core/models';
import { backupTableNames, emptyBackupTables, type MiseBackup } from '@mise/core/backup-tables';
import {localSchemaVersion,localSyncTableNames,parseLocalCloudState} from '@mise/core/local-outbox';
import { createBackup, parseBackup, previewBackup, restoreBackupCommand, type BackupPreview, type RestoreReview } from '@mise/core/backup';

async function snapshot(db:MiseDatabase):Promise<MiseBackup> {
  const expected=[...backupTableNames,...localSyncTableNames];
  if (db.verno !== localSchemaVersion || db.tables.length !== expected.length || db.tables.some(table => !(expected as readonly string[]).includes(table.name))) throw new Error('This app’s backup schema does not match its database. Reload the latest Mise version.');
  const data = emptyBackupTables();
  await Promise.all(backupTableNames.filter(name=>name!=='inboxItems').map(async name => {Object.assign(data,{[name]:await db.table(name).toArray()});}));
  data.inboxItems=await Dexie.waitFor(portableInboxItems(await db.inboxItems.toArray()));
  return createBackup(data);
}
export async function readDatabaseBackup(db:MiseDatabase):Promise<MiseBackup> {
  return db.transaction('r',db.tables,() => snapshot(db));
}
export async function previewDatabaseRestore(db:MiseDatabase,input:unknown):Promise<BackupPreview> {
  const source = parseBackup(typeof input==='string'?input:structuredClone(input));
  return previewBackup(source,await readDatabaseBackup(db));
}
export async function restoreDatabaseBackup(db:MiseDatabase,input:unknown,review:RestoreReview):Promise<SetupSnapshot> {
  const source = parseBackup(typeof input==='string'?input:structuredClone(input));
  const images=storedInboxItems(source.tables.inboxItems);
  return db.transaction('rw',db.tables,async () => {
    const binding=await db.cloudState.get('binding');if(binding&&parseLocalCloudState(binding).phase!=='cancelled')throw new Error('Finish or cancel cloud setup before replacing the local shop. Keep a JSON backup.');
    const command = restoreBackupCommand(source,await snapshot(db),review);
    await Promise.all(backupTableNames.map(name => db.table(name).clear()));
    await Promise.all(backupTableNames.map(name => db.table(name).bulkAdd(name==='inboxItems'?images:command.tables[name])));
    await db.events.add(command.event);
    const setup = await db.setup();if (!setup) throw new Error('The restored shop is incomplete.');return setup;
  });
}
