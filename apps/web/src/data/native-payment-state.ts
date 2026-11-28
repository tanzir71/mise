import type { LocalStore } from './local-store';
import Dexie from 'dexie';
import { literalToken } from '@mise/core/literal-token';
import { backupToken, parseBackup } from '@mise/core/backup';
import { sharedJsonHash } from '@mise/core/shared-json';
import {
  copyNativePaymentBackup,
  parseNativePaymentBackup,
  createNativePaymentBackup,
  type NativePaymentBackup,
  type StoredNativePaymentState,
} from '@mise/core/native-payment-backup';
import type { MiseBackup } from '@mise/core/backup-tables';
import type { MiseDatabase } from './db';
import type { CanonicalRowChange } from './canonical-writes';

type Decoded = Awaited<ReturnType<typeof parseNativePaymentBackup>>;
function legacyToken(value: {
  bases: Decoded['bases'];
  nodes: Decoded['nodes'];
}) {
  return literalToken({
    bases: [...value.bases].sort((a, b) => a.root.localeCompare(b.root)),
    nodes: [...value.nodes].sort((a, b) => a.digest.localeCompare(b.digest)),
  });
}
const checked = new WeakMap<LocalStore, { token: string; decoded: Decoded }>();
const fail = () =>
  Error('Keep the complete saved payment originals and current shop.');
function parseState(input: unknown): StoredNativePaymentState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail();
  const v = input as StoredNativePaymentState,
    { hash, ...value } = v;
  if (
    Object.keys(v).sort().join(',') !==
      'baseHash,exportedAt,hash,id,mode,root,version' ||
    v.id !== 'active' ||
    v.version !== 1 ||
    !['canonical', 'restored'].includes(v.mode) ||
    (v.mode === 'restored'
      ? v.baseHash !== null
      : typeof v.baseHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.baseHash)) ||
    typeof v.root !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.root) ||
    !Number.isSafeInteger(v.exportedAt) ||
    v.exportedAt < 0 ||
    hash !== sharedJsonHash(literalToken(value))
  )
    throw fail();
  return structuredClone(v);
}
/** Cached validation is keyed by all actual rows, never merely a mutable root.
 * Callers receive copies; cached evidence grants no live server authority. */
export async function readNativePaymentState(db: LocalStore) {
  return db.transaction(
    'r',
    db.nativePaymentState,
    db.nativePaymentValues,
    async () => {
      const raw = await db.nativePaymentState.get('active'),
        values = await db.nativePaymentValues.toArray();
      if (raw === undefined) {
        if (values.length) throw fail();
        return null;
      }
      if ((await db.nativePaymentState.count()) !== 1) throw fail();
      const state = parseState(raw),
        token = sharedJsonHash(
          literalToken([
            state,
            values.sort((a, b) => a.digest.localeCompare(b.digest)),
          ]),
        );
      let cached = checked.get(db);
      if (!cached || cached.token !== token) {
        const decoded = await Dexie.waitFor(
          parseNativePaymentBackup({
            format: 'mise-backup',
            formatVersion: 3,
            schemaVersion: 13,
            encoding: 'mise-native-shared-json-v1',
            exportedAt: state.exportedAt,
            root: state.root,
            values,
          }),
        );
        cached = { token, decoded };
        checked.set(db, cached);
      }
      return Object.assign(copyNativePaymentBackup(cached.decoded), {
        state,
        token,
      });
    },
  );
}
/** The caller owns the same writer as the ordinary install or unbound restore.
 * Any quota, hook or later postcondition failure rolls both planes back. */
export async function replaceNativePaymentState(
  db: MiseDatabase,
  input: NativePaymentBackup | null,
  origin:
    | { mode: 'canonical'; baseHash: string }
    | { mode: 'restored'; baseHash: null },
) {
  const tx = Dexie.currentTransaction;
  if (!tx || tx.db !== db || tx.mode !== 'readwrite' || !tx.active)
    throw fail();
  try {
    const decoded = input
      ? await Dexie.waitFor(parseNativePaymentBackup(input))
      : null;
    await db.nativePaymentState.clear();
    await db.nativePaymentValues.clear();
    if (decoded) {
      for (let at = 0; at < decoded.wire.values.length; at += 512)
        await db.nativePaymentValues.bulkAdd(
          decoded.wire.values.slice(at, at + 512),
        );
      const value = {
          id: 'active' as const,
          version: 1 as const,
          ...origin,
          root: decoded.wire.root,
          exportedAt: decoded.wire.exportedAt,
        },
        state = parseState({
          ...value,
          hash: sharedJsonHash(literalToken(value)),
        });
      await db.nativePaymentState.add(state);
      const saved = await readNativePaymentState(db);
      if (
        !saved ||
        literalToken(saved.state) !== literalToken(state) ||
        literalToken(saved.wire) !== literalToken(decoded.wire)
      )
        throw fail();
    }
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* Preserve the actual failure. */
    }
    throw error;
  }
}
/** Export current ordinary records and all complete original source graphs.
 * The connected cursor, account and delivery machinery are deliberately absent. */
export async function currentNativePaymentBackup(
  db: MiseDatabase,
  current: MiseBackup,
  legacy?: { bases: Decoded['bases']; nodes: Decoded['nodes'] },
) {
  const saved = await readNativePaymentState(db);
  if (!saved) return null;
  const checkedCurrent = parseBackup(current);
  // An identical shop already has a complete checked snapshot. Retain its
  // actual capture time and all original bytes rather than re-create history.
  if (
    backupToken(checkedCurrent) === backupToken(saved.current) &&
    (!legacy ||
      legacyToken(legacy) ===
        legacyToken({ bases: saved.bases, nodes: saved.nodes }))
  )
    return saved.wire;
  return createNativePaymentBackup(
    checkedCurrent,
    saved.records,
    saved.loadOriginal,
    legacy ?? { bases: saved.bases, nodes: saved.nodes },
  );
}

/** Finite exact writes for the established canonical writer. Unchanged source
 * nodes stay untouched; no deleteRange or general capture bypass is required. */
export async function nativePaymentStateChanges(
  db: MiseDatabase,
  input: NativePaymentBackup | null,
  baseHash: string,
) {
  const before = await readNativePaymentState(db);
  if (!input) {
    if (before) throw fail();
    return { changes: [] as CanonicalRowChange[], state: null, projection: null };
  }
  const decoded = await parseNativePaymentBackup(input),
    value = {
      id: 'active' as const,
      version: 1 as const,
      mode: 'canonical' as const,
      baseHash,
      root: decoded.wire.root,
      exportedAt: decoded.wire.exportedAt,
    },
    state = parseState({ ...value, hash: sharedJsonHash(literalToken(value)) }),
    old = new Map((before?.wire.values ?? []).map((n) => [n.digest, n])),
    next = new Map(decoded.wire.values.map((n) => [n.digest, n])),
    changes: CanonicalRowChange[] = [];
  for (const key of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    const a = old.get(key) ?? null,
      b = next.get(key) ?? null;
    if (literalToken(a) !== literalToken(b))
      changes.push({ table: 'nativePaymentValues', key, before: a, after: b });
  }
  changes.push({
    table: 'nativePaymentState',
    key: 'active',
    before: before?.state ?? null,
    after: state,
  });
  return { changes, state, projection: decoded.projection };
}
