import { isDeviceId } from '@mise/core/device-access';
import {
  parseDeskPushContext,
  type DeskPushContext,
} from '@mise/core/desk-push';
import {
  parseOwnerTaskIntent,
  parseOwnerTaskReceipt,
  type OwnerTaskIntent,
  type OwnerTaskReceipt,
} from '@mise/core/owner-tasks';
import { CommandRequestError } from './command-request';

export interface SavedOwnerTask {
  intent: OwnerTaskIntent;
  closeRequested: boolean;
  receipt: OwnerTaskReceipt | null;
}
export interface OwnerTaskJournal {
  v: 1;
  actions: SavedOwnerTask[];
}
export interface OwnerTaskLocator {
  key: string;
  targetHash: string;
  accountHash: string;
  businessId: string;
  outletId: string;
  memberId: string;
}
export const ownerTaskJournalMaximum = 8 * 1024 * 1024;
export const ownerTaskJournalBytes = (raw: string) =>
  new TextEncoder().encode(raw).byteLength;
const prefix = 'mise.owner-tasks.v1',
  hash = (v: string) => /^[a-f0-9]{64}$/.test(v),
  bad = () => new CommandRequestError('review');
export function parseOwnerTaskLocator(key: string): OwnerTaskLocator {
  const parts = key.split(':');
  if (
    parts.length !== 6 ||
    parts[0] !== prefix ||
    !hash(parts[1]) ||
    !hash(parts[2]) ||
    !parts.slice(3).every(isDeviceId)
  )
    throw bad();
  return {
    key,
    targetHash: parts[1],
    accountHash: parts[2],
    businessId: parts[3],
    outletId: parts[4],
    memberId: parts[5],
  };
}
export function ownerTaskJournalKey(
  account: Pick<OwnerTaskLocator, 'targetHash' | 'accountHash'>,
  context: DeskPushContext,
): string {
  const scope = parseDeskPushContext(context);
  return parseOwnerTaskLocator(
    [
      prefix,
      account.targetHash,
      account.accountHash,
      scope.businessId,
      scope.outletId,
      scope.memberId,
    ].join(':'),
  ).key;
}
export function parseOwnerTaskJournal(
  raw: string | null,
  scope: Pick<DeskPushContext, 'businessId' | 'outletId' | 'memberId'>,
): OwnerTaskJournal {
  if (raw === null) return { v: 1, actions: [] };
  if (ownerTaskJournalBytes(raw) > ownerTaskJournalMaximum) throw bad();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw bad();
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).sort().join(',') !== 'actions,v' ||
    !('v' in value) ||
    value.v !== 1 ||
    !('actions' in value) ||
    !Array.isArray(value.actions) ||
    value.actions.length > 200
  )
    throw bad();
  const actions = value.actions.map((raw: unknown) => {
    if (
      !raw ||
      typeof raw !== 'object' ||
      Object.keys(raw).sort().join(',') !== 'closeRequested,intent,receipt'
    )
      throw bad();
    const row = raw as Record<string, unknown>,
      intent = parseOwnerTaskIntent(row.intent);
    if (
      intent.scope.businessId !== scope.businessId ||
      intent.scope.outletId !== scope.outletId ||
      intent.scope.memberId !== scope.memberId ||
      typeof row.closeRequested !== 'boolean'
    )
      throw bad();
    return {
      intent,
      closeRequested: row.closeRequested,
      receipt:
        row.receipt === null
          ? null
          : parseOwnerTaskReceipt(row.receipt, intent),
    };
  });
  if (
    new Set(actions.map((a) => a.intent.id)).size !== actions.length ||
    actions
      .slice(0, -1)
      .some((a) => !a.receipt || a.receipt.state === 'pending')
  )
    throw bad();
  return { v: 1, actions };
}
/** Only hashed ownership and native IDs are enumerated before the original
 * account is opened. No source, reply, SDK session or credential is returned. */
export function listOwnerTaskLocators(
  storage: Pick<Storage, 'length' | 'key'>,
): { groups: OwnerTaskLocator[]; unreadable: number } {
  const read = () => {
    if (storage.length > 10000) throw bad();
    const keys: string[] = [];
    for (let n = 0; n < storage.length; n++) {
      const key = storage.key(n);
      if (key?.startsWith(prefix + ':')) keys.push(key);
    }
    return keys.sort();
  };
  const first = read(),
    second = read();
  if (
    JSON.stringify(first) !== JSON.stringify(second) ||
    new Set(first).size !== first.length
  )
    throw new CommandRequestError('retry');
  const groups: OwnerTaskLocator[] = [];
  let unreadable = 0;
  for (const key of first)
    try {
      groups.push(parseOwnerTaskLocator(key));
    } catch {
      unreadable++;
    }
  return { groups, unreadable };
}
