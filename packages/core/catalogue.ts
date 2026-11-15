import { ulid } from 'ulid';
import type { AuditEvent, Item } from './models';
export function removeSampleCommand(item: Item, actorId: string, at = Date.now()): AuditEvent {
  if (!item.isSample) throw new Error('Only sample items can be removed during setup.');
  return { id: ulid(at), outletId: item.outletId, actor: { type: 'member', id: actorId }, command: 'catalogue.remove-sample', before: item, after: null, at };
}
