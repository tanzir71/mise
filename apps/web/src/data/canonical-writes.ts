import Dexie, { type Transaction } from 'dexie';
import type { DBCoreTransaction } from 'dexie';
import {
  materializationHash,
  ReconciliationError,
} from '@mise/core/sync-materialize';
import { syncDownloadToken } from '@mise/core/sync-download';
export interface CanonicalRowChange {
  table: string;
  key: string;
  before: unknown | null;
  after: unknown | null;
}

interface ExpectedWrite {
  steps: { before: string; after: string }[];
  used: number;
}
export interface CanonicalWritePlan {
  readonly writes: ReadonlyMap<string, ExpectedWrite>;
  readonly bindingToken: string;
}
const issued = new WeakSet<CanonicalWritePlan>(),
  active = new WeakMap<DBCoreTransaction, CanonicalWritePlan>();
const asynchronous = (v: unknown): v is PromiseLike<unknown> =>
  v !== null &&
  typeof v === 'object' &&
  typeof (v as { then?: unknown }).then === 'function';
// JSON values stay synchronous. Wrapping every scalar in a Promise creates
// millions of Dexie zone jobs while checking a large shop inside a transaction.
// Original Blob bytes still require the complete asynchronous SHA-256 check.
function comparable(value: unknown): unknown {
  if (value instanceof Blob)
    return value
      .arrayBuffer()
      .then((bytes) => crypto.subtle.digest('SHA-256', bytes))
      .then((hash) => ({
        type: 'original-blob',
        mime: value.type,
        size: value.size,
        sha256: Array.from(new Uint8Array(hash), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join(''),
      }));
  if (Array.isArray(value)) {
    const rows = value.map((v) => (v === undefined ? null : comparable(v)));
    return rows.some(asynchronous) ? Promise.all(rows) : rows;
  }
  if (value !== null && typeof value === 'object') {
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new ReconciliationError('integrity');
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, comparable(v)] as const);
    return entries.some(([, v]) => asynchronous(v))
      ? Promise.all(entries.map(async ([k, v]) => [k, await v])).then(
          Object.fromEntries,
        )
      : Object.fromEntries(entries);
  }
  if (
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    typeof value === 'bigint' ||
    (typeof value === 'number' && !Number.isFinite(value))
  )
    throw new ReconciliationError('integrity');
  return value;
}
export async function nativeRowHash(value: unknown): Promise<string> {
  return materializationHash(await comparable(value));
}
/** This issues a finite, exact write set, never an unrestricted capture bypass. */
export async function prepareCanonicalWrites(
  changes: readonly CanonicalRowChange[],
  binding: unknown,
): Promise<CanonicalWritePlan> {
  const writes = new Map<string, ExpectedWrite>();
  for (const change of changes) {
    const key = change.table + '\0' + change.key,
      before = await nativeRowHash(change.before),
      after = await nativeRowHash(change.after),
      previous = writes.get(key);
    if (previous) {
      if (previous.steps.at(-1)!.after !== before)
        throw new ReconciliationError('integrity');
      previous.steps.push({ before, after });
    } else writes.set(key, { steps: [{ before, after }], used: 0 });
  }
  const plan = { writes, bindingToken: syncDownloadToken(binding) };
  issued.add(plan);
  return plan;
}
function native(tx: Transaction): DBCoreTransaction {
  return tx.idbtrans as DBCoreTransaction;
}
export function canonicalWritesFor(
  transaction: DBCoreTransaction,
): CanonicalWritePlan | undefined {
  return active.get(transaction);
}
export function hasCanonicalWrites(tx: Transaction): boolean {
  return active.has(native(tx));
}
/** A lost Dexie zone must fail before any write can open an unrelated transaction. */
export function assertCanonicalTransaction(
  db: Dexie,
  plan: CanonicalWritePlan,
  stage = 'write',
): void {
  const tx = Dexie.currentTransaction;
  if (
    !tx ||
    tx.db !== db ||
    !tx.active ||
    tx.mode !== 'readwrite' ||
    active.get(native(tx)) !== plan
  )
    throw Object.assign(new ReconciliationError('integrity'), {
      cause: {
        stage,
        present: !!tx,
        sameDatabase: tx?.db === db,
        active: tx?.active,
        mode: tx?.mode,
        samePlan: tx ? active.get(native(tx)) === plan : false,
      },
    });
}
export async function withCanonicalWrites<T>(
  db: Dexie,
  plan: CanonicalWritePlan,
  write: () => Promise<T>,
): Promise<T> {
  const tx = Dexie.currentTransaction;
  if (
    !tx ||
    tx.db !== db ||
    tx.mode !== 'readwrite' ||
    !issued.has(plan) ||
    active.has(native(tx)) ||
    [...plan.writes.values()].some((p) => p.used)
  )
    throw new ReconciliationError('integrity');
  active.set(native(tx), plan);
  issued.delete(plan);
  try {
    const result = await write();
    assertCanonicalTransaction(db, plan);
    if ([...plan.writes.values()].some((p) => p.used !== p.steps.length))
      throw new ReconciliationError('integrity');
    return result;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* Preserve the original failure. */
    }
    throw error;
  } finally {
    active.delete(native(tx));
  }
}
