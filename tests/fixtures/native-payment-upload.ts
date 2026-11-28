// Actual initial-upload client and production handler/SQL fixture. No seeded
// promotion receipt or manual binding is used by the native reconciliation flow.
import type { MiseDatabase } from '../../apps/web/src/data/db';
import type {
  CloudConnection,
  KeyStorage,
} from '../../packages/core/cloud-connection';
import { cloudConnectionTarget } from '../../packages/core/cloud-connection';
import { operatorAccountHash } from '../../packages/core/operators';
import { newInboxId } from '../../packages/core/inbox';
import {
  CloudUploadJournal,
  uploadWithLocalOutbox,
} from '../../apps/web/src/data/cloud-upload';
import { createCloudUploadRemote } from '../../apps/web/src/data/cloud-upload-remote';
import { createOperatorRemote } from '../../apps/web/src/data/operator-remote';
import { selectCloudOperator } from '../../apps/web/src/data/operator-state';
import {
  ensureSyncSession,
  pauseSyncSession,
} from '../../apps/web/src/data/sync-session';
import { createCopySdk } from './original-copy-sdk';

export async function uploadNativePaymentFixture(
  db: MiseDatabase,
  config: CloudConnection,
  scope: string,
  send: typeof fetch,
  storage?: KeyStorage,
) {
  const sdk = await createCopySdk(config, scope, send, 1, storage),
    targetHash = await cloudConnectionTarget(config, scope, sdk.saved.user.id),
    journal = new CloudUploadJournal(
      'mise-cloud-uploads:' + scope.slice(0, scope.lastIndexOf('/') + 1),
    ),
    plan = await journal.prepare(db, newInboxId()),
    account = {
      scope,
      targetHash,
      accountHash: await operatorAccountHash(sdk.saved.user.id),
      getAuth: () => sdk.auth.commandAuthorization(),
      assertCurrent: (
        a: Awaited<ReturnType<typeof sdk.auth.commandAuthorization>>,
      ) => sdk.auth.assertCommandAuthorization(a),
    },
    remote = createCloudUploadRemote(
      config.apiUrl,
      config.publishableKey,
      account,
      send,
    );
  const receipt = await uploadWithLocalOutbox(
    db,
    journal,
    plan.id,
    targetHash,
    remote,
  );
  const metadata = createOperatorRemote(
      config,
      () => sdk.auth.commandAuthorization(),
      send,
    ),
    context = (await metadata.list()).contexts.find(
      (c) =>
        c.businessId === plan.manifest.businessId &&
        c.outletId === plan.manifest.outletId,
    )!;
  const selected = await selectCloudOperator(
    db,
    context,
    { authKey: sdk.auth.key, targetHash },
    null,
    (c) => metadata.select(c),
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
      operatorRevision: selected.revision,
      epoch: context.epoch,
      scopeVersion: context.scopeVersion,
    },
    newInboxId(),
  );
  await pauseSyncSession(db);
  return { sdk, journal, receipt, plan, targetHash };
}
