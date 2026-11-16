import type { MiseDatabase } from './db';
import { exportPreparedCommand,type ExportAuditInput } from '@mise/core/export-audit';
export async function recordPreparedExport(db:MiseDatabase,input:ExportAuditInput):Promise<void> {
  await db.transaction('rw',db.tables,async () => {
    const setup = await db.setup();if (!setup) throw new Error('Set up your shop first.');
    await db.events.add(exportPreparedCommand(input,setup));
  });
}
