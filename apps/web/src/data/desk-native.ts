import Dexie from 'dexie';
import { CommandRequestError } from './command-request';
import { parseDeskBinding, type DeskBinding } from './desk-cache';
import type { LocalStore } from './local-store';

function current(check: () => void) {
  const result: unknown = check();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    throw new CommandRequestError('review');
  }
}
/** HTTP happens outside this boundary. A brief native read lock prevents an
 * operator switch from interleaving with a private-cache commit in another DB. */
export function createDeskNativeScope(
  db: LocalStore,
  value: DeskBinding,
  check: () => void,
) {
  const binding = parseDeskBinding(value),
    source = JSON.stringify(binding),
    tables = [db.operatorState, db.businesses, db.outlets, db.members];
  async function inspect() {
    current(check);
    const [raw, setup] = await Promise.all([
      db.operatorState.get('active'),
      db.setup(),
    ]);
    if (
      JSON.stringify(parseDeskBinding(raw)) !== source ||
      !setup ||
      setup.business.id !== binding.businessId ||
      setup.outlet.id !== binding.outletId ||
      setup.owner.id !== binding.actorId ||
      setup.owner.role !== binding.role
    )
      throw new CommandRequestError('review');
    current(check);
  }
  return {
    binding,
    async assert() {
      await Dexie.ignoreTransaction(() => db.transaction('r', tables, inspect));
    },
    async commit<T>(work: (guard: () => void) => Promise<T>): Promise<T> {
      return Dexie.ignoreTransaction(() =>
        db.transaction('r', tables, async () => {
          await inspect();
          const result = await Dexie.waitFor(
            Dexie.ignoreTransaction(() => work(() => current(check))),
          );
          await inspect();
          return result;
        }),
      );
    },
  };
}
export type DeskNativeScope = ReturnType<typeof createDeskNativeScope>;
