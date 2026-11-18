import type { MiseDatabase } from './db';
import { exportPreparedCommand,exportAuditDetails,type ExportAuditInput } from '@mise/core/export-audit';
import {withOutboxIntent} from './outbox-capture';
export async function recordPreparedExport(db:MiseDatabase,input:ExportAuditInput):Promise<void> {
  await db.transaction('rw',db.tables,async () => {
    const setup = await db.setup();if (!setup) throw new Error('Set up your shop first.');
    const event=exportPreparedCommand(input,setup);
    await withOutboxIntent(db,{id:event.id,type:'export.prepare',outletId:event.outletId,occurredAt:event.at,input:exportAuditDetails(input,event.at)},()=>db.events.add(event));
  });
}
