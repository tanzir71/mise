import 'fake-indexeddb/auto';
import { afterEach,expect,test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MiseDatabase } from '../apps/web/src/data/db';
import { exportPreparedCommand,type ExportAuditInput } from '../packages/core/export-audit';
import { reportBackupFixture,REPORT_AT } from './report-backup-fixture';

const databases:MiseDatabase[]=[];
afterEach(async()=>{await Promise.all(databases.splice(0).map(db=>db.delete()));});
function fixture(){const backup=reportBackupFixture(),setup={business:backup.tables.businesses[0],outlet:backup.tables.outlets[0],owner:backup.tables.members[0]},input:ExportAuditInput={outletId:setup.outlet.id,actorId:setup.owner.id,format:'csv',datasets:['sales'],rows:2,filename:'sales.csv',capturedAt:REPORT_AT,from:null,to:null,includePhones:false};return {backup,setup,input};}
test('preparation logs the source owner and selected data without claiming a download or send',()=>{
  const {setup,input}=fixture(),event=exportPreparedCommand(input,setup,REPORT_AT);expect(event).toMatchObject({command:'export.prepare',actor:{type:'member',id:setup.owner.id},after:{format:'csv',rows:2,includePhones:false}});
  expect(()=>exportPreparedCommand({...input,outletId:'other'},setup,REPORT_AT)).toThrow(/shop or owner changed/);expect(()=>exportPreparedCommand({...input,capturedAt:REPORT_AT+1},setup,REPORT_AT)).toThrow(/invalid file/);expect(()=>exportPreparedCommand({...input,filename:'../file.csv'},setup,REPORT_AT)).toThrow(/invalid file/);expect(()=>exportPreparedCommand({...input,datasets:[]},setup,REPORT_AT)).toThrow(/export data/);
});
test('a failed preparation audit preserves all business data and does not leave a partial record',async()=>{
  const {backup,input}=fixture(),db=new MiseDatabase(`mise-export-audit-${randomUUID()}`);databases.push(db);await db.open();await db.restoreBackup(backup,await db.previewRestore(backup));
  const before=await db.events.count();db.events.hook('creating',(_key,event)=>{if(event.command==='export.prepare')throw new Error('Audit failed');});
  await expect(db.recordPreparedExport({...input,capturedAt:Date.now()})).rejects.toThrow('Audit failed');expect(await db.events.count()).toBe(before);expect(await db.sales.toArray()).toEqual([...backup.tables.sales].sort((a,b)=>a.id.localeCompare(b.id)));
});
