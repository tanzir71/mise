import 'fake-indexeddb/auto';
import {expect,it} from 'vitest';
import {createPairingDatabase,deviceId} from './device-pairing-fixture';
import {MiseDatabase} from '../apps/web/src/data/db';
import {prepareSyncDownload,runSyncDownload,readVerifiedSyncRecords} from '../apps/web/src/data/cloud-sync-journal';
import {reconstructCanonicalSnapshot} from '../packages/core/sync-canonical';
import {decodeCommandRecord} from '../packages/core/cloud-records';
import {createBackup} from '../packages/core/backup';
import {emptyBackupTables,backupTableNames} from '../packages/core/backup-tables';
import {setupCommand} from '../packages/core/setup';
import {newInboxId} from '../packages/core/inbox';
import {syncDownloadFixture} from './sync-download-fixture';
import type {AuditEvent} from '../packages/core/models';

it('actual pairing/cancellation/reset SQL audits survive native cursor download and canonical reconstruction without private device tables or secrets',async()=>{
 const f=await createPairingDatabase(),native=new MiseDatabase('device-pairing-sync-'+newInboxId());
 try{
  await f.seed();const cancelled=await f.start();await f.asRole(1,'authenticated','select public.cancel_device_pairing($1,$2) data',[cancelled.pairing.id,newInboxId()]);
  const {pairing}=await f.start(),claim=await f.request(pairing.code);await f.approve(pairing.id,claim);await f.asRole(null,'service_role','select public.reset_device_signins($1,$2,$3) data',[claim.secret,newInboxId(),newInboxId()]);
  const rows=(await f.db.query<Record<string,unknown>>('select * from public.events order by at,id')).rows,events=rows.map(row=>decodeCommandRecord('events',row)) as unknown as AuditEvent[];
  const {snapshot}=setupCommand({name:'Shop',businessType:'corner_shop',marketCode:'BD',phone:'01712345482'},null,1000),tables=emptyBackupTables();
  tables.businesses=[{...snapshot.business,id:deviceId(1)}];tables.outlets=[{...snapshot.outlet,id:deviceId(11),businessId:deviceId(1)}];tables.members=[{...snapshot.owner,id:deviceId(101),businessId:deviceId(1),outletIds:[deviceId(11)]}];tables.events=events;
  const source=createBackup(tables),transport=await syncDownloadFixture({source});await prepareSyncDownload(native,{id:transport.window.id,target:transport.target,previousCursor:null});const received=await runSyncDownload(native,transport.window.id,transport.target,{begin:async()=>transport.window,page:async(_window,index)=>transport.pages[index]}),records=(await readVerifiedSyncRecords(native,transport.window.id,transport.target)).records;
  const canonical=await reconstructCanonicalSnapshot(received,records,[]);expect(canonical.backup.tables.events).toEqual(events);expect(events.map(e=>e.command)).toEqual(expect.arrayContaining(['device.pairing_start','device.pairing_cancel','device.enrol','device.signins_reset']));
  expect(Object.keys(canonical.backup.tables).sort()).toEqual([...backupTableNames].sort());expect(JSON.stringify(canonical.backup)).not.toContain(claim.secret);expect(JSON.stringify(canonical.backup)).not.toContain(claim.tokenHash);expect(await native.businesses.count()).toBe(0);
 }finally{await native.delete();await f.db.close();}
},30_000);
