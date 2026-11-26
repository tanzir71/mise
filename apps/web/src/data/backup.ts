import { parseNativePaymentBackup } from '@mise/core/native-payment-backup';
import {
  readNativePaymentState,
  replaceNativePaymentState,
} from './native-payment-state';
import {
  parsePortableBackup,
  paymentArchiveToken,
} from '@mise/core/payment-archive';
import {
  readRetainedPaymentOriginals,
  replaceRetainedPaymentOriginals,
} from './payment-original-retention';
import Dexie from 'dexie';
import { portableInboxItems, storedInboxItems } from './inbox';
import type { MiseDatabase } from './db';
import type { SetupSnapshot } from '@mise/core/models';
import {
  backupTableNames,
  emptyBackupTables,
  type MiseBackup,
} from '@mise/core/backup-tables';
import {
  localSchemaVersion,
  parseLocalCloudState,
} from '@mise/core/local-outbox';
import { localTableNames } from '@mise/core/local-schema';
import { readLocalWorkspace } from './operator-state';
import {
  createBackup,
  previewBackup,
  restoreBackupCommand,
  type BackupPreview,
  type RestoreReview,
} from '@mise/core/backup';

async function snapshot(db: MiseDatabase): Promise<MiseBackup> {
  const expected = localTableNames;
  if (
    db.verno !== localSchemaVersion ||
    db.tables.length !== expected.length ||
    db.tables.some(
      (table) => !(expected as readonly string[]).includes(table.name),
    )
  )
    throw new Error(
      'This app’s backup schema does not match its database. Reload the latest Mise version.',
    );
  const data = emptyBackupTables();
  await Promise.all(
    backupTableNames
      .filter((name) => name !== 'inboxItems')
      .map(async (name) => {
        Object.assign(data, { [name]: await db.table(name).toArray() });
      }),
  );
  data.inboxItems = await Dexie.waitFor(
    portableInboxItems(await db.inboxItems.toArray()),
  );
  return createBackup(data);
}
export async function readDatabaseBackup(
  db: MiseDatabase,
): Promise<MiseBackup> {
  return db.transaction('r', db.tables, () => snapshot(db));
}
function bindArchivePreview(
  preview: BackupPreview,
  sourceBases: Parameters<typeof paymentArchiveToken>[0],
  currentBases: Parameters<typeof paymentArchiveToken>[0],
): BackupPreview {
  return {
    ...preview,
    sourceToken: sourceBases.length
      ? JSON.stringify([preview.sourceToken, paymentArchiveToken(sourceBases)])
      : preview.sourceToken,
    currentToken: currentBases.length
      ? JSON.stringify([
          preview.currentToken,
          paymentArchiveToken(currentBases),
        ])
      : preview.currentToken,
  };
}

async function completeBackup(input: unknown) {
  const raw = typeof input === 'string' ? input.replace(/^\uFEFF/, '') : input;
  // The existing parsers enforce the complete encoded/expanded bounds.
  if (
    typeof raw === 'string' &&
    new TextEncoder().encode(raw).length > 50 * 1024 * 1024
  )
    throw Error('Use a backup smaller than 50 MB.');
  const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'formatVersion' in value &&
    value.formatVersion === 3
  ) {
    const native = await parseNativePaymentBackup(value);
    return { ...native, native: native.wire };
  }
  return { ...parsePortableBackup(value), native: null };
}
function bindNativePreview(
  preview: BackupPreview,
  source: string | null,
  current: string | null,
  sourcePayments = 0,
): BackupPreview {
  return {
    ...preview,
    counts: {
      ...preview.counts,
      payments: preview.counts.payments + sourcePayments,
    },
    records: preview.records + sourcePayments,
    sourceToken: source
      ? JSON.stringify([preview.sourceToken, source])
      : preview.sourceToken,
    currentToken: current
      ? JSON.stringify([preview.currentToken, current])
      : preview.currentToken,
  };
}

export async function previewDatabaseRestore(
  db: MiseDatabase,
  input: unknown,
): Promise<BackupPreview> {
  const source = await completeBackup(input);
  return db.transaction('r', db.tables, async () => {
    const current = await snapshot(db),
      archive = await readRetainedPaymentOriginals(db, current);
    const native = await readNativePaymentState(db);
    return bindNativePreview(
      bindArchivePreview(
        previewBackup(source.current, current),
        source.bases,
        archive.bases,
      ),
      source.native?.root ?? null,
      native?.token ?? null,
      'projection' in source ? source.projection.payments.length : 0,
    );
  });
}
export async function restoreDatabaseBackup(
  db: MiseDatabase,
  input: unknown,
  review: RestoreReview,
): Promise<SetupSnapshot | null> {
  const source = await completeBackup(input),
    images = storedInboxItems(source.current.tables.inboxItems);
  return db.transaction('rw', db.tables, async () => {
    const binding = await db.cloudState.get('binding');
    if (binding && parseLocalCloudState(binding).phase !== 'cancelled')
      throw new Error(
        'Finish or cancel cloud setup before replacing the local shop. Keep a JSON backup.',
      );
    const actor = (await readLocalWorkspace(db)).setup,
      current = await snapshot(db),
      archive = await readRetainedPaymentOriginals(db, current),
      plain = previewBackup(source.current, current),
      native = await readNativePaymentState(db),
      latest = bindNativePreview(
        bindArchivePreview(plain, source.bases, archive.bases),
        source.native?.root ?? null,
        native?.token ?? null,
        'projection' in source ? source.projection.payments.length : 0,
      );
    if (review.sourceToken !== latest.sourceToken)
      throw Error('The selected backup changed. Preview it again.');
    if (review.currentToken !== latest.currentToken)
      throw Error(
        'This browser’s data changed after the preview. Review the latest data before restoring.',
      );
    const command = restoreBackupCommand(
      source.current,
      current,
      plain,
      Date.now(),
      actor ? { id: actor.owner.id, name: actor.owner.name } : null,
    );
    await Promise.all(backupTableNames.map((name) => db.table(name).clear()));
    await Promise.all(
      backupTableNames.map((name) =>
        db
          .table(name)
          .bulkAdd(name === 'inboxItems' ? images : command.tables[name]),
      ),
    );
    await replaceRetainedPaymentOriginals(db, source);
    await replaceNativePaymentState(db, source.native, {
      mode: 'restored',
      baseHash: null,
    });
    // Restore replaces only an unbound local shop. Its actual invocations remain
    // in the complete domain backup; old delivery envelopes never become new sends.
    await db.nativePaymentActions.clear();
    await db.events.add(command.event);
    await db.operatorState.clear();
    return (await readLocalWorkspace(db)).setup;
  });
}
