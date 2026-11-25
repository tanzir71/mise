import { parseLocalCloudState } from '@mise/core/local-outbox';
import type { MiseDatabase } from './db';
import { readDatabaseBackup } from './backup';
import { backupToken, parseBackup } from '@mise/core/backup';
import type { MiseBackup } from '@mise/core/backup-tables';
import { MAX_BACKUP_BYTES } from '@mise/core/backup-tables';
import {
  preparePaymentOriginalBasis,
  readPaymentOriginalBasis,
  readPaymentOriginalAction,
  verifyPaymentOriginalDelta,
  type PaymentOriginalBasis,
  type PaymentOriginalNode,
  type PaymentOriginalActionRef,
} from '@mise/core/payment-originals';
import {
  createPortableBackup,
  verifyPaymentArchive,
  paymentArchiveMaxExpandedBytes,
  type DecodedPortableBackup,
  type StoredPaymentOriginalBasis,
  type StoredPaymentOriginalNode,
} from '@mise/core/payment-archive';
import {
  sharedJsonReader,
  sharedJsonWriter,
  sharedJsonHash,
  type SharedJsonNode,
} from '@mise/core/shared-json';
export async function readRetainedPaymentOriginals(
  db: MiseDatabase,
  current: MiseBackup,
) {
  const [stored, index, values] = await Promise.all([
    db.paymentOriginalBases.toArray(),
    db.paymentOriginalNodes.toArray(),
    db.paymentOriginalValues.toArray(),
  ]);
  const pool = new Map(values.map((n) => [n.digest, n.json])),
    reader = sharedJsonReader(pool),
    nodes: PaymentOriginalNode[] = [];
  for (const entry of index) {
    const json = reader.read(entry.value, MAX_BACKUP_BYTES * 2 + 4098);
    if (typeof json !== 'string' || sharedJsonHash(json) !== entry.digest)
      throw Error('Keep the complete original payment records.');
    nodes.push({ digest: entry.digest, json });
  }
  reader.assertComplete();
  const bases = stored.map((r) => {
    if (r.id !== r.basis.root) throw Error('Keep the original payment root.');
    return r.basis;
  });
  verifyPaymentArchive(
    current,
    bases,
    new Map(nodes.map((n) => [n.digest, n.json])),
  );
  return { bases, nodes, index, values };
}
/** Capture a reviewed complete native source before any future canonical write.
 * This stores evidence, never financial authority, and does not lift sync fences. */
export async function retainPaymentOriginal(
  db: MiseDatabase,
  source: MiseBackup,
): Promise<PaymentOriginalBasis> {
  source = parseBackup(JSON.stringify(source));
  return db.transaction('rw', db.tables, async () => {
    const binding = await db.cloudState.get('binding');
    if (binding && parseLocalCloudState(binding).phase !== 'cancelled')
      throw Error(
        'Native payment archive sync is not enabled yet. Keep the original source.',
      );
    const current = await readDatabaseBackup(db);
    if (backupToken(current) !== backupToken(source))
      throw Error(
        'The original shop changed. Capture its latest complete payment records.',
      );
    const old = await readRetainedPaymentOriginals(db, current),
      raw = new Map(old.nodes.map((n) => [n.digest, n.json]));
    const plan = preparePaymentOriginalBasis(source, raw);
    const previous = old.bases.find((b) => b.root === plan.basis.root);
    if (previous) return previous;
    if (
      old.bases.length >= 512 ||
      old.bases.reduce(
        (n, b) => n + b.snapshotBytes,
        plan.basis.snapshotBytes,
      ) > paymentArchiveMaxExpandedBytes
    )
      throw Error(
        'Keep the retained original archive; this complete archive exceeds the bounded backup budget.',
      );
    verifyPaymentOriginalDelta(plan, (key) => raw.get(key));
    const writer = sharedJsonWriter(
        new Map(old.values.map((n) => [n.digest, n.json])),
      ),
      indices: StoredPaymentOriginalNode[] = [];
    for (const node of plan.added)
      indices.push({ digest: node.digest, value: writer.write(node.json) });
    await db.paymentOriginalValues.bulkAdd(writer.added);
    await db.paymentOriginalNodes.bulkAdd(indices);
    await db.paymentOriginalBases.add({
      id: plan.basis.root,
      basis: plan.basis,
    });
    return plan.basis;
  });
}
export async function readRetainedPaymentAction(
  db: MiseDatabase,
  ref: PaymentOriginalActionRef,
) {
  return db.transaction('r', db.tables, async () => {
    const current = await readDatabaseBackup(db),
      archive = await readRetainedPaymentOriginals(db, current),
      basis = archive.bases.find((b) => b.root === ref.root);
    if (!basis) throw Error('Keep the original payment snapshot.');
    const nodes = new Map(archive.nodes.map((n) => [n.digest, n.json]));
    return readPaymentOriginalAction(basis, (key) => nodes.get(key), ref);
  });
}
export async function readDatabasePortableBackup(db: MiseDatabase) {
  return db.transaction('r', db.tables, async () => {
    const current = await readDatabaseBackup(db),
      archive = await readRetainedPaymentOriginals(db, current);
    return {
      current,
      portable: createPortableBackup(current, archive.bases, archive.nodes),
    };
  });
}
/** The caller holds the same native transaction as the domain restore. */
export async function replaceRetainedPaymentOriginals(
  db: MiseDatabase,
  copy: DecodedPortableBackup,
): Promise<void> {
  const writer = sharedJsonWriter(),
    index: StoredPaymentOriginalNode[] = [],
    bases: StoredPaymentOriginalBasis[] = copy.bases.map((basis) => ({
      id: basis.root,
      basis,
    }));
  for (const node of copy.nodes)
    index.push({ digest: node.digest, value: writer.write(node.json) });
  await Promise.all([
    db.paymentOriginalBases.clear(),
    db.paymentOriginalNodes.clear(),
    db.paymentOriginalValues.clear(),
  ]);
  await db.paymentOriginalValues.bulkAdd(writer.added as SharedJsonNode[]);
  await db.paymentOriginalNodes.bulkAdd(index);
  await db.paymentOriginalBases.bulkAdd(bases);
}
/** Materialize only this complete frozen original; it never replaces current rows. */
export async function readRetainedPaymentSnapshot(
  db: MiseDatabase,
  root: string,
) {
  return db.transaction('r', db.tables, async () => {
    const current = await readDatabaseBackup(db),
      archive = await readRetainedPaymentOriginals(db, current),
      basis = archive.bases.find((b) => b.root === root);
    if (!basis) throw Error('Keep the original payment snapshot.');
    const nodes = new Map(archive.nodes.map((n) => [n.digest, n.json]));
    return readPaymentOriginalBasis(basis, (key) => nodes.get(key));
  });
}
