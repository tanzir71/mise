import { expect,test } from 'vitest';
import { exportPeriod,inExportPeriod } from '../packages/core/export-period';

test('today follows the outlet civil date across a UTC midnight',() => {
  const p = exportPeriod({preset:'today'},'Asia/Dhaka','BD',Date.UTC(2026,10,15,19));
  expect(p).toMatchObject({from:'2026-11-16',to:'2026-11-16'});
  expect(inExportPeriod(Date.UTC(2026,10,15,17,59,59),p)).toBe(false);
  expect(inExportPeriod(Date.UTC(2026,10,15,18),p)).toBe(true);
  expect(inExportPeriod(Date.UTC(2026,10,16,18),p)).toBe(false);
});
test('week starts after the market weekend; month spans the actual leap-year calendar',() => {
  const at = Date.UTC(2026,10,16,6);
  expect(exportPeriod({preset:'week'},'Asia/Dhaka','BD',at)).toMatchObject({from:'2026-11-15',to:'2026-11-21'});
  expect(exportPeriod({preset:'week'},'Africa/Nairobi','KE',at)).toMatchObject({from:'2026-11-16',to:'2026-11-22'});
  expect(exportPeriod({preset:'month'},'UTC','OTHER',Date.UTC(2024,1,15))).toMatchObject({from:'2024-02-01',to:'2024-02-29'});
  expect(exportPeriod({preset:'month'},'UTC','OTHER',Date.UTC(2026,11,31))).toMatchObject({from:'2026-12-01',to:'2026-12-31'});
});
test('custom ranges include an entire daylight-saving day and reject impossible or reversed dates',() => {
  const period = exportPeriod({preset:'custom',from:'2026-11-01',to:'2026-11-01'},'America/New_York','OTHER');
  expect(inExportPeriod(Date.UTC(2026,10,1,4),period)).toBe(true);
  expect(inExportPeriod(Date.UTC(2026,10,2,4,59,59),period)).toBe(true);
  expect(inExportPeriod(Date.UTC(2026,10,2,5),period)).toBe(false);
  for (const [from,to] of [['2026-02-29','2026-03-01'],['2026-11-31','2026-12-01'],['2026-11-17','2026-11-16'],['2026-1-1','2026-12-31']]) expect(() => exportPeriod({preset:'custom',from,to},'UTC','OTHER')).toThrow(/valid start/);
});
