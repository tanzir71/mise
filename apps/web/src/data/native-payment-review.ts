import type { Payment, SetupSnapshot } from '@mise/core/models';
import { literalToken } from '@mise/core/literal-token';
import { sharedJsonHash } from '@mise/core/shared-json';
import { parseNativePaymentOutbox } from '@mise/core/native-payment-outbox';
import { parseLocalCloudState } from '@mise/core/local-outbox';
import { parseLocalOperatorState } from '@mise/core/operators';
import { parseSyncSession } from '@mise/core/sync-session';
import type { MiseDatabase } from './db';
import { parseLocalOutboxEntry } from './local-outbox';
import {
  composeNativePaymentChanges,
  nativePaymentChangesEqual,
} from './native-payment-outbox';

const labels: Record<string, string> = {
  'payment.capture': 'Save checked payment',
  'payment.edit': 'Update checked details',
  'payment.match': 'Link an existing receipt',
  'payment.unmatch': 'Remove a receipt link',
  'payment.record': 'Record confirmed money',
  'payment.record-undo': 'Undo original recording',
  'payment.void': 'Void an observation',
  'payment.reopen': 'Reopen an observation',
};
const fail = () =>
  Error('Keep the original payment queue and review this outlet again.');

/** Read-only presentation of actual journal rows. The token grants no SDK,
 * delivery or financial capability; the foreground controller rereads it. */
export async function readNativePaymentQueue(
  db: MiseDatabase,
  expected: SetupSnapshot,
) {
  return db.transaction('r', db.tables, async () => {
    const setup = await db.setup();
    if (
      !setup ||
      setup.business.id !== expected.business.id ||
      setup.outlet.id !== expected.outlet.id ||
      setup.owner.id !== expected.owner.id
    )
      throw fail();
    const rawBinding = await db.cloudState.get('binding'),
      binding = rawBinding ? parseLocalCloudState(rawBinding) : null,
      rawOperator = await db.operatorState.get('active'),
      operator = rawOperator ? parseLocalOperatorState(rawOperator) : null,
      rawSession = await db.syncSessions.get('active'),
      session = rawSession ? parseSyncSession(rawSession) : null,
      installed =
        (await db.nativePaymentState.count()) > 0 ||
        (await db.nativePaymentValues.count()) > 0,
      rows = (await db.nativePaymentActions.toArray())
        .map(parseNativePaymentOutbox)
        .filter(
          (row) =>
            row.original.invocation.command.businessId === setup.business.id &&
            row.original.invocation.command.outletId === setup.outlet.id,
        )
        .sort(
          (a, b) =>
            (a.original.marker?.sequence ?? 0) -
              (b.original.marker?.sequence ?? 0) ||
            a.original.group.index - b.original.group.index ||
            a.id.localeCompare(b.id),
        );
    const markers = [];
    for (const markerId of new Set(
      rows.flatMap((r) =>
        r.original.marker ? [r.original.marker.entryId] : [],
      ),
    )) {
      if (!binding) throw fail();
      const marker = parseLocalOutboxEntry(
          (await db.outbox.get(markerId))!,
          binding,
        ),
        group = rows.filter((r) => r.original.marker?.entryId === markerId);
      if (
        marker.status !== 'retained' ||
        marker.commands.length ||
        marker.receipts.length ||
        !nativePaymentChangesEqual(
          composeNativePaymentChanges(group),
          marker.changes,
        )
      )
        throw fail();
      for (let index = 0; index < group.length; index++) {
        const row = group[index],
          m = row.original.marker!;
        if (
          row.original.group.id !== group[0].original.group.id ||
          row.original.group.index !== index ||
          m.uploadId !== marker.uploadId ||
          m.sequence !== marker.sequence
        )
          throw fail();
      }
      markers.push(marker);
    }
    const localOnly = rows.filter((r) => !r.original.marker).length;
    const ownsQueue =
      !!binding &&
      binding.phase === 'ready' &&
      !!operator &&
      operator.phase === 'active' &&
      !!session &&
      session.operatorRevision === operator.revision &&
      session.target.businessId === setup.business.id &&
      session.target.outletId === setup.outlet.id &&
      session.target.actorId === setup.owner.id &&
      binding.ownerId === setup.owner.id &&
      operator.actorId === setup.owner.id &&
      rows.every((r) => {
        const m = r.original.marker;
        return (
          !!m &&
          m.uploadId === binding.uploadId &&
          m.targetHash === session.target.targetHash &&
          m.accountHash === session.target.accountHash &&
          r.original.invocation.command.actorId === setup.owner.id
        );
      });
    const token = sharedJsonHash(
      literalToken({
        setup,
        binding,
        operator,
        session: session
          ? {
              id: session.sessionId,
              generation: session.generation,
              authKey: session.authKey,
              target: session.target,
              operatorRevision: session.operatorRevision,
              bindingHash: session.bindingHash,
            }
          : null,
        installed,
        rows: rows.map((r) => [
          r.id,
          r.originalHash,
          r.state,
          r.seal,
          r.copyReceipt,
          r.nativeReceipt,
          r.outcomeHash,
          r.review,
        ]),
        markers,
      }),
    );
    return {
      token,
      canContinue:
        rows.length > 0 && !installed && localOnly === 0 && ownsQueue,
      installed,
      localOnly,
      rows: rows.map((row) => {
        // parseNativePaymentOutbox validates this complete after-image and its
        // invocation hash. Labels are data only, never a new action request.
        const after = row.original.changes.find(
          (c) =>
            c.table === 'payments' &&
            c.key === row.original.invocation.command.paymentId,
        )?.after;
        if (!after) throw fail();
        const payment = after as unknown as Payment;
        return {
          id: row.id,
          paymentId: payment.id,
          itemId: payment.inboxId,
          label: labels[row.original.invocation.command.type],
          reference: payment.reference,
          amount: payment.amount,
          currency: payment.currency,
          state: row.state,
          status:
            row.state === 'applied'
              ? 'Original result saved'
              : row.state === 'review'
                ? 'Needs original review'
                : row.state === 'local'
                  ? 'On this device'
                  : 'Awaiting connected result',
          originalHash: row.originalHash,
        };
      }),
    };
  });
}
export type NativePaymentQueueView = Awaited<
  ReturnType<typeof readNativePaymentQueue>
>;
