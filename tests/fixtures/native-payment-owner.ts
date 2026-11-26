// Test-only setup through actual SDK, metadata and native queue controllers.
import type { SetupSnapshot } from '../../packages/core/models';
import type { InboxItem } from '../../packages/core/inbox';
import type {
  CloudConnection,
  KeyStorage,
} from '../../packages/core/cloud-connection';
import { cloudConnectionTarget } from '../../packages/core/cloud-connection';
import { newInboxId } from '../../packages/core/inbox';
import { MiseDatabase } from '../../apps/web/src/data/db';
import { createCopySdk } from './original-copy-sdk';
import { OriginalCopyJournal } from '../../apps/web/src/data/original-copies';
import { nativePaymentCopyJournalName } from '../../apps/web/src/data/native-payment-review-session';
import { createNativePaymentOutboxSession } from '../../apps/web/src/data/native-payment-session';
import { createOperatorRemote } from '../../apps/web/src/data/operator-remote';
import { selectCloudOperator } from '../../apps/web/src/data/operator-state';
import {
  ensureSyncSession,
  pauseSyncSession,
} from '../../apps/web/src/data/sync-session';
import {
  recordSavedPayment,
  compareSavedPaymentMoney,
  recordSavedPaymentMoney,
} from '../../apps/web/src/data/payment-capture';

export async function prepareNativeOwnerQueue(
  db: MiseDatabase,
  setup: SetupSnapshot,
  item: InboxItem,
  config: CloudConnection,
  authScope: string,
  send: typeof fetch,
  storage?: KeyStorage,
) {
  const sdk = await createCopySdk(config, authScope, send, 1, storage),
    targetHash = await cloudConnectionTarget(
      config,
      authScope,
      sdk.saved.user.id,
    ),
    id = newInboxId(),
    journal = new OriginalCopyJournal(nativePaymentCopyJournalName(db));
  await db.cloudState.put({
    id: 'binding',
    version: 1,
    uploadId: id,
    businessId: setup.business.id,
    outletId: setup.outlet.id,
    ownerId: setup.owner.id,
    targetHash,
    manifestHash: 'b'.repeat(64),
    phase: 'ready',
    sequence: 0,
    receipt: {
      id,
      businessId: setup.business.id,
      outletId: setup.outlet.id,
      snapshotHash: 'c'.repeat(64),
      at: Date.now(),
      records: 3,
      images: 0,
    },
  });
  const remote = createOperatorRemote(
      config,
      () => sdk.auth.commandAuthorization(),
      send,
    ),
    context = (await remote.list()).contexts.find(
      (c) =>
        c.businessId === setup.business.id && c.outletId === setup.outlet.id,
    )!;
  if (!context) throw Error('Actual SQL owner context missing');
  const operator = await selectCloudOperator(
    db,
    context,
    { authKey: sdk.auth.key, targetHash },
    null,
    (c) => remote.select(c),
  );
  await ensureSyncSession(
    db,
    {
      target: {
        businessId: context.businessId,
        outletId: context.outletId,
        actorId: context.actorId,
        role: context.role,
        accountHash: context.accountHash,
        targetHash,
      },
      authKey: sdk.auth.key,
      operatorRevision: operator.revision,
      epoch: context.epoch,
      scopeVersion: context.scopeVersion,
    },
    newInboxId(),
  );
  await pauseSyncSession(db);
  const options = {
      config,
      authScope,
      auth: sdk.auth,
      storage: sdk.storage,
      journal,
      send,
    },
    session = await createNativePaymentOutboxSession(db, options),
    review = await session.review(item.id);
  await recordSavedPayment(db, review, {
    checked: true,
    amount: 1525,
    currency: 'BDT',
    method: 'cash',
    methodName: 'Cash',
    reference: 'Owner checked receipt',
    receivedAt: item.createdAt,
  });
  await recordSavedPaymentMoney(
    db,
    review,
    await compareSavedPaymentMoney(db, review, {
      kind: 'counter',
      who: 'Actual owner receipt',
    }),
    true,
  );
  return { sdk, journal, session, options, review };
}
