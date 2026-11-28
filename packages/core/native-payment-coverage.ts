import type { AuditEvent } from './models';
import type { LocalOutboxEntry, LocalRowChange } from './local-outbox';
import type { SyncDownloadTarget } from './sync-download';
import type { NativePaymentCanonicalProjection } from './native-payment-canonical';
import {
  parseNativePaymentOutbox,
  type NativePaymentOutboxEntry,
} from './native-payment-outbox';
import { paymentOriginalReader } from './payment-originals';
import {
  PaymentEvidenceReader,
  paymentEvidenceCommand,
} from './payment-evidence';
import { assertNativePaymentOriginalLink } from './native-payment-originals';
import { literalToken } from './literal-token';
import { ReconciliationError } from './sync-materialize';

const same = (a: unknown, b: unknown) => literalToken(a) === literalToken(b);
const fail = () => new ReconciliationError('retained');
const key = (c: Pick<LocalRowChange, 'table' | 'key'>) => c.table + ':' + c.key;
function composed(rows: readonly NativePaymentOutboxEntry[]) {
  const changes = new Map<string, LocalRowChange>();
  for (const row of rows)
    for (const c of row.original.changes) {
      const prior = changes.get(key(c));
      if (prior && !same(prior.after, c.before)) throw fail();
      changes.set(key(c), { ...c, before: prior ? prior.before : c.before });
    }
  return [...changes.values()].sort((a, b) => key(a).localeCompare(key(b)));
}
/** Structural queue correspondence only. No receipt, cursor, send permission or
 * server acknowledgement is created by recognizing a retained native marker. */
export function nativePaymentQueueGroups(
  input: readonly NativePaymentOutboxEntry[],
  queue: readonly LocalOutboxEntry[],
  target: SyncDownloadTarget,
  uploadId: string,
) {
  const rows = input.map(parseNativePaymentOutbox),
    groups = new Map<string, NativePaymentOutboxEntry[]>();
  for (const row of rows) {
    const m = row.original.marker,
      c = row.original.invocation.command;
    if (
      !m ||
      row.state !== 'applied' ||
      !row.seal ||
      !row.nativeReceipt ||
      !row.copyReceipt ||
      !row.outcomeHash ||
      m.uploadId !== uploadId ||
      m.targetHash !== target.targetHash ||
      m.accountHash !== target.accountHash ||
      c.businessId !== target.businessId ||
      c.outletId !== target.outletId ||
      c.actorId !== target.actorId
    )
      throw fail();
    const group = groups.get(m.entryId) ?? [];
    group.push(row);
    groups.set(m.entryId, group);
  }
  for (const [id, values] of groups) {
    values.sort((a, b) => a.original.group.index - b.original.group.index);
    const marker = queue.find((q) => q.id === id);
    if (
      !marker ||
      marker.uploadId !== uploadId ||
      marker.status !== 'retained' ||
      marker.commands.length ||
      marker.receipts.length ||
      values.some(
        (r, i) =>
          r.original.group.index !== i ||
          r.original.group.id !== values[0].original.group.id ||
          r.original.marker!.sequence !== marker.sequence ||
          !same(r.original.marker, values[0].original.marker),
      )
    )
      throw fail();
    const changes = marker.changes
      .slice()
      .sort((a, b) => key(a).localeCompare(key(b)));
    if (!same(composed(values), changes)) throw fail();
  }
  return groups;
}

/** Match original outgoing approvals to an independently verified canonical
 * projection and its complete original graphs. Financial rows must be the exact
 * children of that original action; an unrelated retained change cannot ride
 * through a native marker. Callers still own live scope and canonical writes. */
export function nativePaymentCanonicalCoverage(
  input: readonly NativePaymentOutboxEntry[],
  queue: readonly LocalOutboxEntry[],
  target: SyncDownloadTarget,
  uploadId: string,
  projection: NativePaymentCanonicalProjection,
) {
  const groups = nativePaymentQueueGroups(input, queue, target, uploadId);
  if (
    projection.businessId !== target.businessId ||
    projection.outletId !== target.outletId
  )
    throw fail();
  const actions = new Map(
      projection.actions.map((a) => [a.invocation.command.id, a]),
    ),
    nativeEvents = new Map(projection.events.map((e) => [e.id, e])),
    nodes = new Map(projection.originals.nodes.map((n) => [n.digest, n.json]));
  const readers = new Map<string, ReturnType<typeof paymentOriginalReader>>();
  for (const rows of groups.values())
    for (const row of rows) {
      const accepted = actions.get(row.id),
        seal = row.seal!;
      if (
        !accepted ||
        !same(accepted.invocation, row.original.invocation) ||
        !same(accepted.receipt, row.nativeReceipt) ||
        !same(accepted.source.ref, seal.ref) ||
        !same(accepted.source.retention.copy, row.copyReceipt)
      )
        throw fail();
      assertNativePaymentOriginalLink(
        accepted.source,
        row.original.invocation,
        accepted.receipt,
        row.copyReceipt!,
        seal.ref,
      );
      let reader = readers.get(seal.ref.root);
      if (!reader) {
        const basis = projection.originals.bases.find(
          (b) => b.root === seal.ref.root,
        );
        if (!basis) throw fail();
        const read = (digest: string) => nodes.get(digest);
        reader = paymentOriginalReader(basis, read);
        readers.set(seal.ref.root, reader);
      }
      const original = reader.read(seal.ref),
        expected = new Map<string, LocalRowChange>();
      const add = (
        table: LocalRowChange['table'],
        id: string,
        before: unknown,
        after: unknown,
      ) => {
        const change = { table, key: id, before, after } as LocalRowChange,
          prior = expected.get(key(change));
        if (prior && !same(prior.after, before)) throw fail();
        expected.set(key(change), {
          ...change,
          before: prior ? prior.before : before,
        });
      };
      if (!same(original.invocation, row.original.invocation)) throw fail();
      add('payments', original.after.id, original.before, original.after);
      add('events', original.event.id, null, original.event);
      const invocation = nativeEvents.get(accepted.receipt.invocationId);
      if (!invocation) throw fail();
      add('events', invocation.id, null, invocation);
      const financial = accepted.receipt.financial,
        events = !financial
          ? []
          : financial.kind === 'record'
            ? original.financial?.events
            : financial.mode === 'performed'
              ? original.financial?.undo?.events
              : [];
      if (!events) throw fail();
      for (const event of events) {
        if (!financial!.eventIds.includes(event.id)) throw fail();
        add('events', event.id, null, event);
        const after = event.after as { id?: string } | null;
        if (!after?.id) throw fail();
        if (['order.payment', 'order.payment-undo'].includes(event.command))
          add('orders', after.id, event.before, event.after);
        else if (['sale.record', 'sale.undo'].includes(event.command))
          add('sales', after.id, event.before, event.after);
        else if (['khata.payment', 'khata.undo'].includes(event.command))
          add('creditEntries', after.id, null, event.after);
        else throw fail();
      }
      // Compact evidence can be shared with an earlier action. Only genuine
      // referenced nodes created in this action may appear as new audit writes.
      const evidence = new PaymentEvidenceReader(
          reader.snapshot.tables.events,
          reader.snapshot.tables.creditEntries,
        ),
        p = original.after;
      if (p.association)
        evidence.expand(p.association.fingerprint, p.association.at);
      for (const posting of p.postings ?? []) {
        evidence.expand(posting.target.fingerprint, posting.at);
        evidence.expand(posting.receipt.fingerprint, posting.at);
        if (posting.undo)
          evidence.expand(posting.undo.fingerprint, posting.undo.at);
      }
      const used = new Set(evidence.usedEventIds());
      for (const change of row.original.changes) {
        if (change.table !== 'events') continue;
        const e = change.after as AuditEvent;
        if (e.command !== paymentEvidenceCommand) continue;
        if (
          !used.has(e.id) ||
          !same(e, nativeEvents.get(e.id)) ||
          e.at !== original.event.at ||
          !same(e.actor, original.event.actor)
        )
          throw fail();
        add('events', e.id, null, e);
      }
      const actual = row.original.changes
          .slice()
          .sort((a, b) => key(a).localeCompare(key(b))),
        wanted = [...expected.values()].sort((a, b) =>
          key(a).localeCompare(key(b)),
        );
      if (!same(actual, wanted)) throw fail();
    }
  return new Set(groups.keys());
}
