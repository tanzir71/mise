import {parsePortableBackup,paymentArchiveToken} from '@mise/core/payment-archive';
import {readRetainedPaymentOriginals,replaceRetainedPaymentOriginals} from './payment-original-retention';
import Dexie from 'dexie';
import { portableInboxItems,storedInboxItems } from './inbox';
import type { MiseDatabase } from './db';
import type { SetupSnapshot } from '@mise/core/models';
import { backupTableNames, emptyBackupTables, type MiseBackup } from '@mise/core/backup-tables';
import {localSchemaVersion,parseLocalCloudState} from '@mise/core/local-outbox';
import {localTableNames} from '@mise/core/local-schema';
import {readLocalWorkspace} from './operator-state';
import { createBackup, previewBackup, restoreBackupCommand, type BackupPreview, type RestoreReview } from '@mise/core/backup';

async function snapshot(db:MiseDatabase):Promise<MiseBackup> {
  const expected=localTableNames;
  if (db.verno !== localSchemaVersion || db.tables.length !== expected.length || db.tables.some(table => !(expected as readonly string[]).includes(table.name))) throw new Error('This app’s backup schema does not match its database. Reload the latest Mise version.');
  const data = emptyBackupTables();
  await Promise.all(backupTableNames.filter(name=>name!=='inboxItems').map(async name => {Object.assign(data,{[name]:await db.table(name).toArray()});}));
  data.inboxItems=await Dexie.waitFor(portableInboxItems(await db.inboxItems.toArray()));
  return createBackup(data);
}
export async function readDatabaseBackup(db:MiseDatabase):Promise<MiseBackup> {
  return db.transaction('r',db.tables,() => snapshot(db));
}
function bindArchivePreview(preview:BackupPreview,sourceBases:Parameters<typeof paymentArchiveToken>[0],currentBases:Parameters<typeof paymentArchiveToken>[0]):BackupPreview {
 return {...preview,sourceToken:sourceBases.length?JSON.stringify([preview.sourceToken,paymentArchiveToken(sourceBases)]):preview.sourceToken,currentToken:currentBases.length?JSON.stringify([preview.currentToken,paymentArchiveToken(currentBases)]):preview.currentToken};
}
export async function previewDatabaseRestore(db:MiseDatabase,input:unknown):Promise<BackupPreview> {
 const source=parsePortableBackup(input);
 return db.transaction('r',db.tables,async()=>{
  const current=await snapshot(db),archive=await readRetainedPaymentOriginals(db,current);
  return bindArchivePreview(previewBackup(source.current,current),source.bases,archive.bases);
 });
}
export async function restoreDatabaseBackup(db:MiseDatabase,input:unknown,review:RestoreReview):Promise<SetupSnapshot|null> {
 const source=parsePortableBackup(input),images=storedInboxItems(source.current.tables.inboxItems);
 return db.transaction('rw',db.tables,async()=>{
  const binding=await db.cloudState.get('binding');if(binding&&parseLocalCloudState(binding).phase!=='cancelled')throw new Error('Finish or cancel cloud setup before replacing the local shop. Keep a JSON backup.');
  const actor=(await readLocalWorkspace(db)).setup,current=await snapshot(db),archive=await readRetainedPaymentOriginals(db,current),plain=previewBackup(source.current,current),latest=bindArchivePreview(plain,source.bases,archive.bases);
  if(review.sourceToken!==latest.sourceToken)throw Error('The selected backup changed. Preview it again.');
  if(review.currentToken!==latest.currentToken)throw Error('This browser’s data changed after the preview. Review the latest data before restoring.');
  const command=restoreBackupCommand(source.current,current,plain,Date.now(),actor?{id:actor.owner.id,name:actor.owner.name}:null);
  await Promise.all(backupTableNames.map(name=>db.table(name).clear()));
  await Promise.all(backupTableNames.map(name=>db.table(name).bulkAdd(name==='inboxItems'?images:command.tables[name])));
  await replaceRetainedPaymentOriginals(db,source);
  // Restore replaces only an unbound local shop. Its actual invocations remain
  // in the complete domain backup; old delivery envelopes never become new sends.
  await db.nativePaymentActions.clear();
  await db.events.add(command.event);await db.operatorState.clear();
  return (await readLocalWorkspace(db)).setup;
 });
}
