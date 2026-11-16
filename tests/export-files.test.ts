import { expect,test } from 'vitest';
import { unzipSync,strFromU8 } from 'fflate';
import { backupFile,reportFile } from '../apps/web/src/data/export-files';
import { buildExportReport,exportDatasets } from '../packages/core/exports';
import { reportBackupFixture,REPORT_AT } from './report-backup-fixture';

test('multi-list CSV archives contain complete UTF-8 lists and an accounting readme',async()=>{
  const report=buildExportReport(reportBackupFixture(),{datasets:[...exportDatasets],period:{preset:'all'}},REPORT_AT),file=await reportFile(report,'csv'),entries=unzipSync(new Uint8Array(await file.arrayBuffer()));
  expect(file.type).toBe('application/zip');expect(Object.keys(entries)).toEqual([...exportDatasets.map(name=>`${name}.csv`),'readme.txt']);
  for(const name of exportDatasets)expect([...entries[`${name}.csv`].slice(0,3)]).toEqual([239,187,191]);
  expect(strFromU8(entries['customers.csv'])).toContain('দ্বিতীয় লাইন');expect(strFromU8(entries['purchases.csv'])).toContain('300.03');expect(strFromU8(entries['readme.txt'])).toContain('Asia/Dhaka');expect(report.rowCount).toBe(8);
});
test('single CSV, Excel and full JSON backups retain their appropriate file types and data',async()=>{
  const backup=reportBackupFixture(),report=buildExportReport(backup,{datasets:['sales'],period:{preset:'all'}},REPORT_AT),csv=await reportFile(report,'csv'),xlsx=await reportFile(report,'xlsx'),json=backupFile(backup);
  expect(csv.name).toMatch(/sales.*\.csv$/);expect(csv.type).toContain('text/csv');expect(await csv.text()).toContain('100.00');expect(xlsx.type).toContain('spreadsheetml');expect(new Uint8Array(await xlsx.arrayBuffer()).slice(0,2)).toEqual(new Uint8Array([80,75]));
  expect(JSON.parse(await json.text())).toEqual(backup);expect(json.type).toBe('application/json');
});
