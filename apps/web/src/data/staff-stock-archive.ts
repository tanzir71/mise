import { newInboxId } from '@mise/core/inbox';
import { syncHash } from '@mise/core/sync-read';
import {
  parseStaffStockArchive,
  staffStockArchiveLimit,
  staffStockArchiveChunk,
  staffStockArchiveIndexId,
  type StaffStockArchiveIndex,
  type StaffStockArchive,
} from '@mise/core/staff-stock-archive';
import {
  parseOwnStaffStockOutcome,
  type OwnStaffStockOutcome,
  type StaffStockIntent,
} from '@mise/core/staff-stock-actions';
import {
  staffStockJournalId,
  staffStockOriginalLimit,
  type StaffStockJournal,
  type StaffStockScope,
  type StaffStockOriginal,
} from '@mise/core/staff-stock-journal';
import type { ScreenJournalRecord } from '@mise/core/device-screen-state';
import {
  assertLiveCommandReceipt,
  CommandRequestError,
} from './command-request';

export interface StaffStockArchiveFile {
  readonly filename: string;
  readonly contents: string;
  readonly sha256: string;
  readonly count: number;
  readonly retained: number;
}
export interface OpenedStaffStockArchive {
  readonly actions: readonly StaffStockOriginal[];
  readonly verified: boolean;
}
const writes = new WeakMap<
  object,
  {
    source: string;
    before: string;
    after: string;
    beforeIndex: string;
    afterIndex: string;
    guard: () => void;
  }
>();
const bad = () => new CommandRequestError('review');
const wire = (v: unknown) => JSON.stringify(v);
/** Separate capability: a generic live receipt never authorizes history removal
 * or import. The exact enrolled source and both native records are bound here. */
export function assertStaffStockArchiveWrite(
  proof: object,
  source: ScreenJournalRecord,
  before: StaffStockJournal | null,
  after: StaffStockJournal,
  beforeIndex: StaffStockArchiveIndex | null,
  afterIndex: StaffStockArchiveIndex,
) {
  const state = writes.get(proof);
  if (
    !state ||
    state.source !== wire(source) ||
    state.before !== wire(before) ||
    state.after !== wire(after) ||
    state.beforeIndex !== wire(beforeIndex) ||
    state.afterIndex !== wire(afterIndex)
  )
    throw bad();
  state.guard();
}
export function createStaffStockArchives(deps: {
  source: ScreenJournalRecord;
  scope: StaffStockScope;
  binding: string;
  current: () => void;
  local: () => Promise<unknown>;
  saved: () => StaffStockJournal | null;
  index: () => StaffStockArchiveIndex | null;
  exclusive: <T>(run: () => Promise<T>) => Promise<T>;
  inspect: (
    intent: StaffStockIntent,
    signal?: AbortSignal,
  ) => Promise<OwnStaffStockOutcome>;
  persist: (
    before: StaffStockJournal | null,
    after: StaffStockJournal,
    beforeIndex: StaffStockArchiveIndex | null,
    afterIndex: StaffStockArchiveIndex,
    proof: object,
  ) => Promise<void>;
}) {
  const source = wire(deps.source),
    scope = { ...deps.scope },
    files = new WeakMap<
      StaffStockArchiveFile,
      {
        before: StaffStockJournal;
        beforeIndex: StaffStockArchiveIndex | null;
        count: number;
        verified: boolean;
        verification: number;
        guard: () => void;
      }
    >(),
    opened = new WeakMap<
      OpenedStaffStockArchive,
      { wire: string; value: StaffStockArchive; sha256: string }
    >();
  const current = () => {
    deps.current();
    if (wire(deps.source) !== source) throw bad();
  };
  function assertFile(file: StaffStockArchiveFile) {
    const state = files.get(file);
    if (!state) throw bad();
    current();
    state.guard();
    if (
      wire(deps.saved()) !== wire(state.before) ||
      wire(deps.index()) !== wire(state.beforeIndex)
    )
      throw bad();
    return state;
  }
  async function persist(
    before: StaffStockJournal | null,
    after: StaffStockJournal,
    beforeIndex: StaffStockArchiveIndex | null,
    afterIndex: StaffStockArchiveIndex,
    guard: () => void,
  ) {
    const proof = Object.freeze({});
    writes.set(proof, {
      source,
      before: wire(before),
      after: wire(after),
      beforeIndex: wire(beforeIndex),
      afterIndex: wire(afterIndex),
      guard: () => {
        current();
        guard();
      },
    });
    try {
      await deps.persist(before, after, beforeIndex, afterIndex, proof);
    } finally {
      writes.delete(proof);
    }
  }
  async function prepare(signal?: AbortSignal) {
    return deps.exclusive(async () => {
      await deps.local();
      current();
      const before = structuredClone(deps.saved());
      const beforeIndex = structuredClone(deps.index());
      if (!before?.actions.length) throw bad();
      const chunk = staffStockArchiveChunk(before, scope),
        proofs: OwnStaffStockOutcome[] = [];
      for (const row of before.actions.slice(0, chunk.count)) {
        const actual = await deps.inspect(row.intent, signal);
        current();
        assertLiveCommandReceipt(actual);
        const checked = parseOwnStaffStockOutcome(
          actual,
          row.intent,
          row.intentHash,
        );
        if (checked.state === 'pending' || wire(checked) !== wire(row.outcome))
          throw bad();
        proofs.push(actual);
      }
      const sha256 = await syncHash(new TextEncoder().encode(chunk.contents));
      await deps.local();
      current();
      const guard = () => {
        current();
        if (signal?.aborted) throw bad();
        for (const proof of proofs) assertLiveCommandReceipt(proof);
      };
      guard();
      if (
        wire(deps.saved()) !== wire(before) ||
        wire(deps.index()) !== wire(beforeIndex)
      )
        throw bad();
      const file: StaffStockArchiveFile = Object.freeze({
        filename:
          'mise-stock-archive-' +
          scope.outletId.slice(-8) +
          '-' +
          newInboxId() +
          '.json',
        contents: chunk.contents,
        sha256,
        count: chunk.count,
        retained: chunk.retained,
      });
      files.set(file, {
        before,
        beforeIndex,
        count: chunk.count,
        verified: false,
        verification: 0,
        guard,
      });
      return file;
    });
  }
  async function verifyFile(file: StaffStockArchiveFile, input: Uint8Array) {
    const state = assertFile(file);
    state.verified = false;
    const attempt = ++state.verification;
    if (
      !(input instanceof Uint8Array) ||
      input.byteLength > staffStockArchiveLimit
    )
      throw bad();
    const bytes = input.slice();
    await deps.local();
    assertFile(file);
    const digest = await syncHash(bytes);
    await deps.local();
    assertFile(file);
    if (digest !== file.sha256 || attempt !== state.verification) throw bad();
    state.verified = true;
  }
  async function finish(file: StaffStockArchiveFile, confirmed: true) {
    return deps.exclusive(async () => {
      await deps.local();
      const state = assertFile(file);
      if (confirmed !== true || !state.verified) throw bad();
      const after = {
        ...state.before,
        revision: newInboxId(),
        actions: state.before.actions.slice(state.count),
      };
      const afterIndex: StaffStockArchiveIndex = {
        v: 1,
        id: staffStockArchiveIndexId(scope, deps.binding),
        revision: newInboxId(),
        files: [
          ...(state.beforeIndex?.files ?? []),
          { sha256: file.sha256, count: file.count },
        ],
      };
      await persist(state.before, after, state.beforeIndex, afterIndex, () => {
        const latest = assertFile(file);
        if (!latest.verified) throw bad();
      });
      files.delete(file);
      return { removed: state.count, retained: after.actions.length };
    });
  }
  async function open(input: Uint8Array) {
    current();
    if (
      !(input instanceof Uint8Array) ||
      input.byteLength > staffStockArchiveLimit
    )
      throw bad();
    const bytes = input.slice();
    const value = await parseStaffStockArchive(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      scope,
    );
    const sha256 = await syncHash(bytes);
    await deps.local();
    current();
    const result: OpenedStaffStockArchive = Object.freeze({
      actions: structuredClone(value.actions),
      verified: Boolean(
        deps
          .index()
          ?.files.some(
            (f) => f.sha256 === sha256 && f.count === value.actions.length,
          ),
      ),
    });
    opened.set(result, { wire: wire(result), value, sha256 });
    return result;
  }
  async function restore(
    file: OpenedStaffStockArchive,
    id: string,
    signal?: AbortSignal,
  ) {
    return deps.exclusive(async () => {
      const known = opened.get(file);
      if (!known || known.wire !== wire(file)) throw bad();
      await deps.local();
      current();
      const beforeIndex = structuredClone(deps.index());
      if (
        !file.verified ||
        !beforeIndex?.files.some(
          (f) =>
            f.sha256 === known.sha256 && f.count === known.value.actions.length,
        )
      )
        throw bad();
      const row = known.value.actions.find((a) => a.intent.command.id === id);
      if (!row?.outcome) throw bad();
      const before = structuredClone(deps.saved()),
        existing = before?.actions.find((a) => a.intent.command.id === id);
      if (existing) {
        if (wire(existing) !== wire(row)) throw bad();
        return { restored: false };
      }
      if ((before?.actions.length ?? 0) >= staffStockOriginalLimit) throw bad();
      const actual = await deps.inspect(row.intent, signal);
      current();
      assertLiveCommandReceipt(actual);
      if (
        wire(parseOwnStaffStockOutcome(actual, row.intent, row.intentHash)) !==
        wire(row.outcome)
      )
        throw bad();
      await deps.local();
      current();
      if (
        wire(deps.saved()) !== wire(before) ||
        known.wire !== wire(file) ||
        wire(deps.index()) !== wire(beforeIndex)
      )
        throw bad();
      const after: StaffStockJournal = {
        v: 1,
        id: staffStockJournalId(scope),
        revision: newInboxId(),
        readStatus: before?.readStatus ?? null,
        actions: [structuredClone(row), ...(before?.actions ?? [])],
      };
      await persist(before, after, beforeIndex, beforeIndex, () => {
        if (signal?.aborted || known.wire !== wire(file)) throw bad();
        assertLiveCommandReceipt(actual);
      });
      return { restored: true };
    });
  }
  return {
    prepare,
    verifyFile,
    finish,
    open,
    restore,
    assertFile: (file: StaffStockArchiveFile) => {
      assertFile(file);
    },
  };
}
