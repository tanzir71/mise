import {
  assertNativePaymentOriginalLink,
  parseNativePaymentOriginalLink,
  nativePaymentOriginalRequest,
  nativePaymentOriginalStageRequest,
  type PaymentOriginalRetention,
  type NativePaymentOriginalLink,
} from '@mise/core/native-payment-originals';
import Dexie from 'dexie';
import type { MiseDatabase } from './db';
import {
  parseCloudConnection,
  readCloudConnection,
} from '@mise/core/cloud-connection';
import { literalToken } from '@mise/core/literal-token';
import { syncHash } from '@mise/core/sync-read';
import {
  parseLocalCloudState,
  type LocalOutboxEntry,
} from '@mise/core/local-outbox';
import { isLocalInboxRetention } from '@mise/core/local-inbox';
import {
  parseNativePaymentOutbox,
  nativePaymentOutcomeHash,
  type NativePaymentOutboxEntry,
} from '@mise/core/native-payment-outbox';
import {
  nativePaymentHeader,
  nativePaymentBodyLimit,
  parseNativePaymentBackendReceipt,
  type NativePaymentBackendReceipt,
} from '@mise/core/payment-backend';
import { readNativePaymentInvocation } from '@mise/core/payment-invocations';
import { readPaymentOriginalBasis } from '@mise/core/payment-originals';
import type { OriginalCopyReceipt } from '@mise/core/original-copy';
import type {
  DecodedPortableBackup,
  PortableBackup,
} from '@mise/core/payment-archive';
import {
  createNativePaymentAccess,
  assertNativePaymentAccess,
  assertNativePaymentScope,
} from './native-payment-access';
import { openQueuedPaymentSource } from './payment-capture';
import { sealNativePaymentBatch } from './native-payment-seal';
import {
  composeNativePaymentChanges,
  nativePaymentChangesEqual,
} from './native-payment-outbox';
import {
  createNativePaymentBarriers,
  type NativePaymentBarriers,
  type VerifiedNativePaymentGroup,
} from './native-payment-barriers';
import {
  deliverLocalOutbox,
  deliverLocalInboxImages,
  parseLocalOutboxEntry,
} from './local-outbox';
import { createCloudCommandRemote } from './cloud-command-remote';
import { createCloudInboxImageUploader } from './cloud-inbox-upload';
import { assertDeliverySyncSession, type SessionLease } from './sync-session';
import {
  createNativePaymentRequest,
  nativePaymentReviewProof,
  bindCommandReceipt,
  assertLiveCommandReceipt,
  CommandRequestError,
  type CommandAccount,
} from './command-request';
type Options = Parameters<typeof createNativePaymentAccess>[1] & {
  signal?: AbortSignal;
  deliveryLease?: SessionLease;
  deliveryPaused?: boolean;
};
const fail = () => new CommandRequestError('review');
const sourceToken = (row: NativePaymentOutboxEntry) =>
  literalToken([row.original, row.originalHash, row.seal]);
/** Actual SDK/native integration. No separately labelled account, JWT supplier,
 * remote factory or row-write request can enter this financial delivery path. */
export async function createNativePaymentOutboxSession(
  db: MiseDatabase,
  input: Options,
) {
  const options = {
    ...input,
    config: parseCloudConnection(input.config),
    deliveryLease: input.deliveryLease ? { ...input.deliveryLease } : undefined,
  };
  const guardDelivery = async () => {
    options.signal?.throwIfAborted();
    if (options.deliveryLease)
      await assertDeliverySyncSession(
        db,
        options.deliveryLease,
        options.deliveryPaused ?? true,
      );
    options.signal?.throwIfAborted();
  };
  const send: typeof fetch = async (input, init) => {
    await guardDelivery();
    const signal = options.signal
      ? init?.signal
        ? AbortSignal.any([options.signal, init.signal])
        : options.signal
      : init?.signal;
    const response = await (options.send ?? fetch)(input, { ...init, signal });
    await guardDelivery();
    return response;
  };
  const { auth, storage, authScope } = options,
    access = await createNativePaymentAccess(db, { ...options, send }),
    identity = access.identity,
    accountIdentity = auth.journalIdentity(),
    controller = new AbortController();
  let active = true,
    busy = false;
  const deliveredOriginals = new Map<
    string,
    { token: string; link: NativePaymentOriginalLink; portable: PortableBackup }
  >();
  const current = () => {
    try {
      if (
        options.signal?.aborted ||
        !active ||
        literalToken(readCloudConnection(storage)) !==
          literalToken(options.config)
      )
        throw Error();
      auth.assertJournalIdentity(accountIdentity);
      assertNativePaymentAccess(access, db);
    } catch {
      stop();
      throw new CommandRequestError('auth');
    }
  };
  function stop() {
    active = false;
    deliveredOriginals.clear();
    controller.abort();
    access.stop();
    options.signal?.removeEventListener('abort', stop);
  }
  options.signal?.addEventListener('abort', stop, { once: true });
  const account: CommandAccount = {
    scope: authScope,
    accountHash: identity.accountHash,
    targetHash: identity.targetHash,
    async getAuth() {
      current();
      const value = await auth.commandAuthorization();
      current();
      if (value.userId !== accountIdentity.userId)
        throw new CommandRequestError('auth');
      return value;
    },
    assertCurrent(value) {
      current();
      if (value.userId !== accountIdentity.userId)
        throw new CommandRequestError('auth');
      auth.assertCommandAuthorization(value);
    },
  };
  const request = createNativePaymentRequest(options.config, account, send),
    legacy = createCloudCommandRemote(options.config, account, send),
    images = createCloudInboxImageUploader(options.config, account, send);
  const scope = async () => {
    current();
    await assertNativePaymentScope(access, db);
    await guardDelivery();
    current();
  };
  async function group(marker: LocalOutboxEntry) {
    return db.transaction('r', db.tables, async () => {
      await scope();
      const binding = parseLocalCloudState(await db.cloudState.get('binding')),
        actual = parseLocalOutboxEntry(
          (await db.outbox.get(marker.id))!,
          binding,
        ),
        rows = (
          await db.nativePaymentActions
            .where('original.marker.entryId')
            .equals(marker.id)
            .toArray()
        )
          .map(parseNativePaymentOutbox)
          .sort((a, b) => a.original.group.index - b.original.group.index);
      if (
        literalToken(actual) !== literalToken(marker) ||
        actual.status !== 'retained' ||
        actual.commands.length ||
        actual.receipts.length ||
        !rows.length ||
        !nativePaymentChangesEqual(
          composeNativePaymentChanges(rows),
          actual.changes,
        )
      )
        throw fail();
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i],
          m = row.original.marker,
          c = row.original.invocation.command;
        if (
          !m ||
          !row.seal ||
          row.original.group.index !== i ||
          row.original.group.id !== rows[0].original.group.id ||
          m.entryId !== marker.id ||
          m.uploadId !== binding.uploadId ||
          m.sequence !== marker.sequence ||
          m.accountHash !== identity.accountHash ||
          m.targetHash !== identity.targetHash ||
          c.businessId !== identity.businessId ||
          c.outletId !== identity.outletId ||
          c.actorId !== identity.actorId
        )
          throw fail();
      }
      return rows;
    });
  }
  async function retain(
    row: NativePaymentOutboxEntry,
    write: (actual: NativePaymentOutboxEntry) => NativePaymentOutboxEntry,
    guard: () => void,
  ) {
    return db.transaction('rw', db.tables, async () => {
      const tx = Dexie.currentTransaction!;
      try {
        await scope();
        guard();
        const actual = parseNativePaymentOutbox(
          await db.nativePaymentActions.get(row.id),
        );
        if (sourceToken(actual) !== sourceToken(row)) throw fail();
        const next = parseNativePaymentOutbox(write(actual));
        await db.nativePaymentActions.put(next);
        guard();
        await scope();
        return next;
      } catch (error) {
        try {
          tx.abort();
        } catch {
          /* Keep the original error after native abort. */
        }
        throw error;
      }
    });
  }
  async function sendNative(row: NativePaymentOutboxEntry) {
    const invocation = row.original.invocation,
      body = JSON.stringify(invocation);
    if (new TextEncoder().encode(body).length > nativePaymentBodyLimit)
      throw fail();
    await scope();
    try {
      const result = await request(
        body,
        {
          'Content-Type': 'application/json',
          [nativePaymentHeader]: invocation.command.outletId,
        },
        20000,
        controller.signal,
      );
      await scope();
      result.guard();
      const receipt = parseNativePaymentBackendReceipt(
        result.value,
        invocation.command,
      );
      if (receipt.paymentHash !== invocation.paymentHash) throw fail();
      const token = literalToken(receipt);
      return bindCommandReceipt(receipt, () => {
        current();
        result.guard();
        if (literalToken(receipt) !== token) throw fail();
      });
    } catch (error) {
      // A configuration/account change can abort an in-flight Auth refresh.
      // Preserve its identity failure instead of relabelling it as a retry.
      await scope();
      const proof = nativePaymentReviewProof(error);
      if (proof?.status === 409) {
        const bodyHash = await syncHash(new TextEncoder().encode(body));
        if (
          proof.bodyHash !== bodyHash ||
          proof.targetHash !== identity.targetHash ||
          proof.accountHash !== identity.accountHash
        )
          throw new CommandRequestError('auth');
        await retain(
          row,
          (actual) => {
            const at = Math.max(Date.now(), actual.review?.lastAt ?? 0),
              review = {
                firstAt: actual.review?.firstAt ?? at,
                lastAt: at,
                observations: (actual.review?.observations ?? 0) + 1,
                status: 409 as const,
              };
            return {
              ...actual,
              state: actual.nativeReceipt ? 'applied' : 'review',
              review,
            };
          },
          proof.assertCurrent,
        );
      }
      throw error;
    }
  }
  type Copied = {
    receipt: OriginalCopyReceipt;
    retention: PaymentOriginalRetention;
    decoded: DecodedPortableBackup;
    portable: PortableBackup;
    snapshots: Map<string, ReturnType<typeof readPaymentOriginalBasis>>;
  };
  async function copy(
    row: NativePaymentOutboxEntry,
    cache: Map<string, Copied>,
  ) {
    if (!row.seal) throw fail();
    let copied = cache.get(row.seal.copyId);
    if (!copied) {
      await scope();
      const manifest = await access.copies.prepare(row.seal.copyId),
        receipt = await access.copies.deliver(row.seal.copyId),
        source = await access.copies.readbackSource(row.seal.copyId);
      await scope();
      if (receipt.id !== manifest.id || receipt.root !== manifest.root)
        throw fail();
      const token = literalToken(receipt);
      bindCommandReceipt(receipt, () => {
        current();
        if (literalToken(receipt) !== token) throw fail();
      });
      const retention = await access.copies.retainPaymentCopy(row.seal.copyId);
      await scope();
      if (literalToken(retention.copy) !== literalToken(receipt)) throw fail();
      const retentionToken = literalToken(retention);
      bindCommandReceipt(retention, () => {
        current();
        if (literalToken(retention) !== retentionToken) throw fail();
      });
      copied = {
        receipt,
        retention,
        decoded: source.decoded,
        portable: source.portable,
        snapshots: new Map(),
      };
      cache.set(row.seal.copyId, copied);
    }
    const basis = copied.decoded.bases.find(
      (b) => b.root === row.seal!.ref.root,
    );
    if (!basis) throw fail();
    let snapshot = copied.snapshots.get(basis.root);
    if (!snapshot) {
      const nodes = new Map(
        copied.decoded.nodes.map((n) => [n.digest, n.json]),
      );
      snapshot = readPaymentOriginalBasis(basis, (key) => nodes.get(key));
      copied.snapshots.set(basis.root, snapshot);
    }
    const c = row.original.invocation.command,
      event = snapshot.tables.events.find((e) => e.id === row.id),
      payment = snapshot.tables.payments.find((p) => p.id === c.paymentId),
      expected = row.original.changes.find(
        (v) => v.table === 'events' && v.key === row.id,
      )?.after;
    if (
      !event ||
      !payment ||
      payment.revision < row.seal.ref.revision ||
      event.paymentId !== c.paymentId ||
      event.paymentRevision !== row.seal.ref.revision ||
      literalToken(event) !== literalToken(expected) ||
      literalToken(
        readNativePaymentInvocation(event, snapshot.tables.events),
      ) !== literalToken(row.original.invocation)
    )
      throw fail();
    assertLiveCommandReceipt(copied.receipt);
    assertLiveCommandReceipt(copied.retention);
    return copied;
  }
  const session = {
    identity,
    /** Local preparation grants no network or financial authority. Large source
     * normalization may finish before a short delivery lease is claimed. */
    async prepare() {
      if (busy) throw new CommandRequestError('retry');
      busy = true;
      try {
        await scope();
        await sealNativePaymentBatch(db, access);
        const rows = (await db.nativePaymentActions.toArray()).map(
            parseNativePaymentOutbox,
          ),
          copies = new Set(
            rows
              .filter((r) => r.original.marker && !r.nativeReceipt && r.seal)
              .map((r) => r.seal!.copyId),
          );
        for (const id of copies) {
          await scope();
          await access.copies.prepare(id);
          await scope();
        }
      } finally {
        busy = false;
      }
    },
    /** Read-only bytes from this drain's real verified copy. This is neither a
     * financial receipt nor authority to install or approve another action. */
    async readDeliveredOriginal(input: NativePaymentOriginalLink) {
      current();
      await assertNativePaymentScope(access, db);
      const link = parseNativePaymentOriginalLink(input),
        known = deliveredOriginals.get(link.id);
      current();
      if (!known || literalToken(link) !== known.token) return null;
      return structuredClone({ link: known.link, portable: known.portable });
    },
    review: (
      itemId: string,
      options?: Parameters<typeof openQueuedPaymentSource>[3],
    ) => openQueuedPaymentSource(db, itemId, access, options),
    async deliver() {
      current();
      if (busy) throw new CommandRequestError('retry');
      busy = true;
      deliveredOriginals.clear();
      // Fresh HTTP evidence is required on each drain, including saved outcomes.
      const verified: VerifiedNativePaymentGroup[] = [],
        copies = new Map<string, Copied>();
      let barriers: NativePaymentBarriers | undefined;
      try {
        await scope();
        await sealNativePaymentBatch(db, access);
        for (let pass = 0; pass < 1024; pass++) {
          const delivered = await deliverLocalOutbox(
            db,
            identity.targetHash,
            legacy,
            undefined,
            barriers,
          );
          await scope();
          const binding = parseLocalCloudState(
              await db.cloudState.get('binding'),
            ),
            rows = (
              await db.outbox
                .where('uploadId')
                .equals(binding.uploadId)
                .toArray()
            ).sort((a, b) => a.sequence - b.sequence),
            known = new Set(verified.map((g) => g.marker.id));
          const front = rows.find(
            (r) =>
              r.status !== 'accepted' &&
              !isLocalInboxRetention(r) &&
              !known.has(r.id),
          );
          if (!front) {
            await deliverLocalInboxImages(
              db,
              identity.targetHash,
              images,
              controller.signal,
            );
            return {
              legacy: delivered,
              nativeGroups: verified.length,
              blockedEntryId: null,
            };
          }
          if (front.status !== 'retained') throw fail();
          if (
            !(await db.nativePaymentActions
              .where('original.marker.entryId')
              .equals(front.id)
              .count())
          )
            return {
              legacy: delivered,
              nativeGroups: verified.length,
              blockedEntryId: front.id,
            };
          const entries = await group(front);
          await deliverLocalInboxImages(
            db,
            identity.targetHash,
            images,
            controller.signal,
            front.sequence,
          );
          const receipts: NativePaymentBackendReceipt[] = [],
            storage: OriginalCopyReceipt[] = [],
            retained: PaymentOriginalRetention[] = [],
            sources: NativePaymentOriginalLink[] = [];
          for (const row of entries) {
            const original = await copy(row, copies),
              copied = original.receipt;
            const ready = await retain(
              row,
              (actual) => {
                if (
                  actual.copyReceipt &&
                  literalToken(actual.copyReceipt) !== literalToken(copied)
                )
                  throw fail();
                return { ...actual, copyReceipt: copied };
              },
              () => assertLiveCommandReceipt(copied),
            );
            await access.copies.stagePaymentOriginal(
              row.id,
              nativePaymentOriginalStageRequest(
                row.original.invocation,
                copied,
                row.seal!.ref,
              ),
            );
            await scope();
            const receipt = await sendNative(ready);
            await retain(
              ready,
              (actual) => {
                if (
                  actual.nativeReceipt &&
                  literalToken(actual.nativeReceipt) !== literalToken(receipt)
                )
                  throw fail();
                const outcome = {
                  ...actual,
                  state: 'applied' as const,
                  nativeReceipt: receipt,
                };
                return {
                  ...outcome,
                  outcomeHash: nativePaymentOutcomeHash(outcome),
                };
              },
              () => {
                assertLiveCommandReceipt(copied);
                assertLiveCommandReceipt(receipt);
              },
            );
            const link = await access.copies.linkPaymentOriginal(
              row.id,
              nativePaymentOriginalRequest(
                row.original.invocation,
                receipt,
                copied,
                row.seal!.ref,
              ),
            );
            await scope();
            assertNativePaymentOriginalLink(
              link,
              row.original.invocation,
              receipt,
              copied,
              row.seal!.ref,
            );
            const linkToken = literalToken(link);
            bindCommandReceipt(link, () => {
              current();
              if (literalToken(link) !== linkToken) throw fail();
            });
            receipts.push(receipt);
            storage.push(copied);
            retained.push(original.retention);
            sources.push(link);
            deliveredOriginals.set(link.id, {
              token: linkToken,
              link: structuredClone(link),
              portable: original.portable,
            });
          }
          verified.push({
            marker: front,
            rows: await group(front),
            receipts,
            copies: storage,
            retained,
            sources,
          });
          barriers = createNativePaymentBarriers(db, access, verified);
        }
        throw new CommandRequestError('retry');
      } finally {
        busy = false;
      }
    },
    stop,
  };
  try {
    await scope();
    return Object.freeze(session);
  } catch (error) {
    stop();
    throw error;
  }
}
export type NativePaymentOutboxSession = Awaited<
  ReturnType<typeof createNativePaymentOutboxSession>
>;
