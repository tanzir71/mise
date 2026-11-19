import {
  cloudConnectionTarget,
  parseCloudConnection,
  type CloudConnection,
} from '@mise/core/cloud-connection';
import {
  operatorAccountHash,
  parseLocalOperatorState,
  parseOperatorContext,
} from '@mise/core/operators';
import { newInboxId } from '@mise/core/inbox';
import { SyncSessionError } from '@mise/core/sync-session';
import type { SetupSnapshot } from '@mise/core/models';
import { parseLocalCloudState } from '@mise/core/local-outbox';
import { syncDownloadToken } from '@mise/core/sync-download';
import type { MiseDatabase } from './db';
import type { PhoneAuth } from './phone-auth';
import { CloudUploadJournal, uploadWithLocalOutbox } from './cloud-upload';
import { createCloudUploadRemote } from './cloud-upload-remote';
import { createOperatorRemote } from './operator-remote';
import { selectCloudOperator } from './operator-state';
import { ensureSyncSession, requestSync } from './sync-session';
import { cycleAccount } from './sync-cycle';

/** Explicit opt-in uses the saved review or existing real join, never a replacement snapshot. */
export async function enableSync(
  db: MiseDatabase,
  input: {
    setup: SetupSnapshot;
    config: CloudConnection;
    scope: string;
    auth: PhoneAuth;
    journal: CloudUploadJournal;
    send?: typeof fetch;
    connectionCurrent?: () => boolean;
  },
  signal?: AbortSignal,
) {
  const config = parseCloudConnection(input.config),
    authorization = await input.auth.commandAuthorization();
  input.auth.assertCommandAuthorization(authorization);
  signal?.throwIfAborted();
  const setup = input.setup,
    target = {
      businessId: setup.business.id,
      outletId: setup.outlet.id,
      actorId: setup.owner.id,
      role: setup.owner.role as 'owner' | 'manager',
      accountHash: await operatorAccountHash(authorization.userId),
      targetHash: await cloudConnectionTarget(
        config,
        input.scope,
        authorization.userId,
      ),
    },
    account = cycleAccount(
      { ...input, config },
      { target, authKey: input.auth.key },
    ),
    metadata = createOperatorRemote(config, account.getAuth, input.send);
  const check = () => {
    signal?.throwIfAborted();
    account.assertCurrent(authorization);
  };
  check();
  const raw = await db.cloudState.get('binding'),
    binding = raw ? parseLocalCloudState(raw) : null;
  if (!binding || binding.phase !== 'ready') {
    if (setup.owner.role !== 'owner') throw new SyncSessionError('review');
    const review = await input.journal.review(db);
    if (!review.snapshot) throw new SyncSessionError('review');
    const remote = createCloudUploadRemote(
      config.apiUrl,
      config.publishableKey,
      account,
      input.send,
    );
    await uploadWithLocalOutbox(
      db,
      input.journal,
      review.snapshot.id,
      target.targetHash,
      remote,
      {
        signal,
        assertCurrent: () => {
          check();
          remote.assertCurrent();
        },
      },
    );
  } else if (
    binding.targetHash !== target.targetHash ||
    binding.businessId !== target.businessId ||
    binding.outletId !== target.outletId ||
    binding.ownerId !== target.actorId
  )
    throw new SyncSessionError('auth');
  let selected = await db.operatorState.get('active'),
    context;
  if (selected?.connection) {
    const state = parseLocalOperatorState(selected);
    context = await metadata.select(
      parseOperatorContext({
        version: 1,
        businessId: state.businessId,
        outletId: state.outletId,
        actorId: state.actorId,
        role: state.role,
        accountHash: state.connection!.accountHash,
        epoch: state.connection!.epoch,
        scopeVersion: state.connection!.scopeVersion,
        businessName: null,
        outletName: null,
        actorName: null,
      }),
      signal,
    );
  } else {
    let after = null;
    do {
      const page = await metadata.list(after, 50, signal);
      context = page.contexts.find(
        (c) =>
          c.businessId === target.businessId &&
          c.outletId === target.outletId &&
          c.actorId === target.actorId,
      );
      after = page.next;
      if (context) break;
    } while (after);
  }
  if (
    !context ||
    context.accountHash !== target.accountHash ||
    context.role !== target.role
  )
    throw new SyncSessionError('auth');
  check();
  const previous = selected ? parseLocalOperatorState(selected) : null;
  if (
    !previous ||
    previous.phase !== 'active' ||
    !previous.connection ||
    syncDownloadToken(previous.connection) !==
      syncDownloadToken({
        targetHash: target.targetHash,
        authKey: input.auth.key,
        accountHash: context.accountHash,
        epoch: context.epoch,
        scopeVersion: context.scopeVersion,
      })
  )
    selected = await selectCloudOperator(
      db,
      context,
      { targetHash: target.targetHash, authKey: input.auth.key },
      previous?.revision ?? null,
      async (value) => {
        const result = await metadata.select(value, signal);
        check();
        return result;
      },
    );
  check();
  const operator = parseLocalOperatorState(selected);
  await ensureSyncSession(
    db,
    {
      target,
      authKey: input.auth.key,
      operatorRevision: operator.revision,
      epoch: context.epoch,
      scopeVersion: context.scopeVersion,
    },
    newInboxId(),
  );
  await requestSync(db, true);
}
