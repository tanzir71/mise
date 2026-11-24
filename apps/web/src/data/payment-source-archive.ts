import { syncHash } from '@mise/core/sync-read';
import type {
  PaymentSourceIntent,
  PaymentSourceReceipt,
} from '@mise/core/payment-sources';
import {
  assertLiveCommandReceipt,
  bindCommandReceipt,
  CommandRequestError,
} from './command-request';
import {
  parsePaymentSourceLocator,
  paymentSourceJournalBytes,
  paymentSourceJournalMaximum,
  type PaymentSourceJournal,
} from './payment-source-journal';

export interface PaymentSourceFile {
  readonly kind: 'copy' | 'archive';
  readonly filename: string;
  readonly contents: string;
  readonly sha256: string;
  readonly count: number;
  readonly pending: number;
}
interface ArchiveState {
  before: PaymentSourceJournal;
  count: number;
  verifiedFile: boolean;
}
const bad = () => new CommandRequestError('review');
export function createPaymentSourceArchives(deps: {
  key: string;
  current: () => void;
  local: () => Promise<unknown>;
  saved: () => PaymentSourceJournal;
  exclusive: <T>(run: () => Promise<T>) => Promise<T>;
  persist: (
    before: PaymentSourceJournal,
    next: PaymentSourceJournal,
    proof?: object,
  ) => Promise<void>;
  inspect: (
    intent: PaymentSourceIntent,
    signal?: AbortSignal,
  ) => Promise<PaymentSourceReceipt>;
}) {
  const locator = parsePaymentSourceLocator(deps.key),
    files = new WeakMap<PaymentSourceFile, () => void>(),
    integrity = new WeakMap<PaymentSourceFile, () => void>(),
    archives = new WeakMap<PaymentSourceFile, ArchiveState>();
  async function file(
    kind: PaymentSourceFile['kind'],
    before: PaymentSourceJournal,
    actions: PaymentSourceJournal['actions'],
    guard: () => void,
  ): Promise<PaymentSourceFile> {
    const compact = JSON.stringify({
      kind: 'mise-payment-source-' + kind,
      v: 1,
      ownership: {
        targetHash: locator.targetHash,
        accountHash: locator.accountHash,
        businessId: locator.businessId,
        outletId: locator.outletId,
        memberId: locator.memberId,
      },
      actions,
    });
    if (paymentSourceJournalBytes(compact) > paymentSourceJournalMaximum + 4096)
      throw bad();
    const pending = before.actions.filter(
        (row) => !row.receipt || row.receipt.state === 'pending',
      ).length,
      sha256 = await syncHash(new TextEncoder().encode(compact));
    await deps.local();
    guard();
    const result: PaymentSourceFile = Object.freeze({
      kind,
      filename:
        'mise-payment-' +
        kind +
        '-' +
        locator.outletId.slice(-8) +
        '-' +
        new Date().toISOString().slice(0, 10) +
        '.json',
      contents: compact,
      sha256,
      count: actions.length,
      pending,
    });
    const image = JSON.stringify(result),
      check = () => {
        deps.current();
        guard();
        if (JSON.stringify(result) !== image) throw bad();
      };
    integrity.set(result, check);
    files.set(result, () => {
      check();
      if (JSON.stringify(deps.saved()) !== JSON.stringify(before)) throw bad();
    });
    return result;
  }
  function assertFile(value: PaymentSourceFile) {
    const guard = files.get(value);
    if (!guard) throw bad();
    guard();
  }
  async function copy() {
    return deps.exclusive(async () => {
      const before = deps.saved();
      if (!before.actions.length) throw bad();
      return file('copy', before, before.actions, () => deps.current());
    });
  }
  async function prepareArchive(signal?: AbortSignal) {
    return deps.exclusive(async () => {
      const before = deps.saved(),
        count = before.actions.findIndex(
          (row) => !row.receipt || row.receipt.state === 'pending',
        ),
        completed = count < 0 ? before.actions.length : count;
      if (!completed) throw bad();
      const proofs: PaymentSourceReceipt[] = [];
      for (const row of before.actions.slice(0, completed)) {
        const proof = await deps.inspect(row.intent, signal);
        assertLiveCommandReceipt(proof);
        if (
          proof.state === 'pending' ||
          JSON.stringify(proof) !== JSON.stringify(row.receipt)
        )
          throw bad();
        proofs.push(proof);
      }
      const guard = () => {
        deps.current();
        for (const proof of proofs) assertLiveCommandReceipt(proof);
      };
      guard();
      if (JSON.stringify(deps.saved()) !== JSON.stringify(before)) throw bad();
      const result = await file(
        'archive',
        before,
        before.actions.slice(0, completed),
        guard,
      );
      assertFile(result);
      bindCommandReceipt(result, integrity.get(result)!);
      archives.set(result, { before, count: completed, verifiedFile: false });
      return result;
    });
  }
  async function verifyArchiveFile(plan: PaymentSourceFile, input: Uint8Array) {
    await deps.local();
    assertFile(plan);
    const state = archives.get(plan);
    if (!state) throw bad();
    state.verifiedFile = false;
    if (
      !(input instanceof Uint8Array) ||
      input.byteLength > paymentSourceJournalMaximum + 4096
    )
      throw bad();
    const digest = await syncHash(input);
    await deps.local();
    assertFile(plan);
    if (digest !== plan.sha256) throw bad();
    state.verifiedFile = true;
  }
  async function finishArchive(plan: PaymentSourceFile, confirmed: true) {
    return deps.exclusive(async () => {
      assertFile(plan);
      const state = archives.get(plan);
      if (!state || !state.verifiedFile || confirmed !== true) throw bad();
      const next: PaymentSourceJournal = {
        v: 1,
        actions: state.before.actions.slice(state.count),
      };
      await deps.persist(state.before, next, plan);
      archives.delete(plan);
      files.delete(plan);
      integrity.delete(plan);
      return { removed: state.count, retained: next.actions.length };
    });
  }
  return { copy, prepareArchive, verifyArchiveFile, finishArchive, assertFile };
}
