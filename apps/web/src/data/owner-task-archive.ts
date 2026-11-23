import { syncHash } from '@mise/core/sync-read';
import type { OwnerTaskIntent, OwnerTaskReceipt } from '@mise/core/owner-tasks';
import {
  assertLiveCommandReceipt,
  bindCommandReceipt,
  CommandRequestError,
} from './command-request';
import {
  parseOwnerTaskLocator,
  ownerTaskJournalBytes,
  ownerTaskJournalMaximum,
  type OwnerTaskJournal,
} from './owner-task-journal';

export interface OwnerTaskFile {
  readonly kind: 'copy' | 'archive';
  readonly filename: string;
  readonly contents: string;
  readonly sha256: string;
  readonly count: number;
  readonly pending: number;
}
interface ArchiveState {
  before: OwnerTaskJournal;
  count: number;
  verifiedFile: boolean;
}
const bad = () => new CommandRequestError('review');
export function createOwnerTaskArchives(deps: {
  key: string;
  current: () => void;
  local: () => Promise<unknown>;
  saved: () => OwnerTaskJournal;
  exclusive: <T>(run: () => Promise<T>) => Promise<T>;
  persist: (
    before: OwnerTaskJournal,
    next: OwnerTaskJournal,
    proof?: object,
  ) => Promise<void>;
  inspect: (
    intent: OwnerTaskIntent,
    signal?: AbortSignal,
  ) => Promise<OwnerTaskReceipt>;
}) {
  const locator = parseOwnerTaskLocator(deps.key),
    files = new WeakMap<OwnerTaskFile, () => void>(),
    integrity = new WeakMap<OwnerTaskFile, () => void>(),
    archives = new WeakMap<OwnerTaskFile, ArchiveState>();
  async function file(
    kind: OwnerTaskFile['kind'],
    before: OwnerTaskJournal,
    actions: OwnerTaskJournal['actions'],
    guard: () => void,
  ): Promise<OwnerTaskFile> {
    const compact = JSON.stringify({
      kind: 'mise-owner-task-' + kind,
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
    if (ownerTaskJournalBytes(compact) > ownerTaskJournalMaximum + 4096)
      throw bad();
    const pending = before.actions.filter(
        (row) => !row.receipt || row.receipt.state === 'pending',
      ).length,
      sha256 = await syncHash(new TextEncoder().encode(compact));
    await deps.local();
    guard();
    const result: OwnerTaskFile = Object.freeze({
      kind,
      filename:
        'mise-task-' +
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
  function assertFile(value: OwnerTaskFile) {
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
      const proofs: OwnerTaskReceipt[] = [];
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
  async function verifyArchiveFile(plan: OwnerTaskFile, input: Uint8Array) {
    await deps.local();
    assertFile(plan);
    const state = archives.get(plan);
    if (!state) throw bad();
    state.verifiedFile = false;
    if (
      !(input instanceof Uint8Array) ||
      input.byteLength > ownerTaskJournalMaximum + 4096
    )
      throw bad();
    const digest = await syncHash(input);
    await deps.local();
    assertFile(plan);
    if (digest !== plan.sha256) throw bad();
    state.verifiedFile = true;
  }
  async function finishArchive(plan: OwnerTaskFile, confirmed: true) {
    return deps.exclusive(async () => {
      assertFile(plan);
      const state = archives.get(plan);
      if (!state || !state.verifiedFile || confirmed !== true) throw bad();
      const next: OwnerTaskJournal = {
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
