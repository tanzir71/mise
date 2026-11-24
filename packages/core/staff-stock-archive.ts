import { isDeviceId } from './device-access';
import {
  parseScreenJournalRecord,
  type ScreenJournalRecord,
} from './device-screen-state';
import { staffStockHash } from './staff-stock-actions';
import {
  parseStaffStockJournal,
  staffStockJournalId,
  type StaffStockScope,
  type StaffStockOriginal,
  type StaffStockJournal,
} from './staff-stock-journal';

export const staffStockArchiveLimit = 64 * 1024 * 1024;
export interface StaffStockArchive {
  kind: 'mise-staff-stock-archive';
  v: 1;
  scope: StaffStockScope;
  journalRevision: string;
  actions: StaffStockOriginal[];
}
export interface StaffStockArchiveIndex {
  v: 1;
  id: string;
  revision: string;
  files: { sha256: string; count: number }[];
}
export async function staffStockArchiveBinding(source: ScreenJournalRecord) {
  const state = parseScreenJournalRecord(source).state;
  if (state.phase !== 'signed-in') throw bad();
  return staffStockHash({
    connection: state.credential.connection,
    token: state.credential.token,
  });
}
export const staffStockArchiveIndexId = (
  scope: StaffStockScope,
  binding: string,
) => {
  if (!/^[a-f0-9]{64}$/.test(binding)) throw bad();
  return staffStockJournalId(scope) + ':archives:' + binding;
};
export function parseStaffStockArchiveIndex(
  input: unknown,
  scope: StaffStockScope,
  binding: string,
): StaffStockArchiveIndex {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad();
  const v = input as StaffStockArchiveIndex;
  if (
    Object.keys(v).sort().join(',') !== 'files,id,revision,v' ||
    v.v !== 1 ||
    v.id !== staffStockArchiveIndexId(scope, binding) ||
    !isDeviceId(v.revision) ||
    !Array.isArray(v.files)
  )
    throw bad();
  const seen = new Set<string>(),
    files = v.files.map((row) => {
      if (
        !row ||
        typeof row !== 'object' ||
        Object.keys(row).sort().join(',') !== 'count,sha256' ||
        typeof row.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(row.sha256) ||
        seen.has(row.sha256) ||
        !Number.isSafeInteger(row.count) ||
        row.count < 1 ||
        row.count > 200
      )
        throw bad();
      seen.add(row.sha256);
      return { sha256: row.sha256, count: row.count };
    });
  return { v: 1, id: v.id, revision: v.revision, files };
}
export const staffStockArchiveBytes = (text: string) =>
  new TextEncoder().encode(text).byteLength;
const bad = () =>
  Error(
    'Keep the complete stock archive for this member on its original screen.',
  );
export async function parseStaffStockArchive(
  input: unknown,
  scope: StaffStockScope,
): Promise<StaffStockArchive> {
  const wire = JSON.stringify(input);
  if (
    typeof wire !== 'string' ||
    staffStockArchiveBytes(wire) > staffStockArchiveLimit
  )
    throw bad();
  const value = JSON.parse(wire) as StaffStockArchive;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'actions,journalRevision,kind,scope,v' ||
    value.kind !== 'mise-staff-stock-archive' ||
    value.v !== 1 ||
    !isDeviceId(value.journalRevision) ||
    staffStockJournalId(value.scope) !== staffStockJournalId(scope) ||
    Object.entries(scope).some(
      ([key, expected]) =>
        expected !== value.scope[key as keyof StaffStockScope],
    )
  )
    throw bad();
  const journal = await parseStaffStockJournal(
    {
      v: 1,
      id: staffStockJournalId(scope),
      revision: value.journalRevision,
      readStatus: null,
      actions: value.actions,
    },
    scope,
  );
  if (
    !journal.actions.length ||
    journal.actions.some(
      (row) => !row.outcome || row.outcome.state === 'pending',
    )
  )
    throw bad();
  return {
    kind: 'mise-staff-stock-archive',
    v: 1,
    scope: { ...scope },
    journalRevision: journal.revision,
    actions: journal.actions,
  };
}
/** Select complete terminal originals by actual encoded bytes, never a clipped
 * record or a smaller aggregate journal limit. This calculation grants no write. */
export function staffStockArchiveChunk(
  journal: StaffStockJournal,
  scope: StaffStockScope,
) {
  const envelope = {
    kind: 'mise-staff-stock-archive' as const,
    v: 1 as const,
    scope,
    journalRevision: journal.revision,
    actions: [] as StaffStockOriginal[],
  };
  let bytes = staffStockArchiveBytes(JSON.stringify(envelope));
  for (const row of journal.actions) {
    if (!row.outcome || row.outcome.state === 'pending') break;
    const addition =
      staffStockArchiveBytes(JSON.stringify(row)) +
      (envelope.actions.length ? 1 : 0);
    if (bytes + addition > staffStockArchiveLimit) break;
    envelope.actions.push(row);
    bytes += addition;
  }
  if (!envelope.actions.length) throw bad();
  return {
    contents: JSON.stringify(envelope),
    count: envelope.actions.length,
    retained: journal.actions.length - envelope.actions.length,
  };
}
