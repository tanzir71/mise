import { isDeviceId } from '@mise/core/device-access';
import {
  parseDeskPushContext,
  type DeskPushContext,
} from '@mise/core/desk-push';
import {
  parsePaymentSourceIntent,
  parsePaymentSourceReceipt,
  type PaymentSourceIntent,
  type PaymentSourceReceipt,
  parseObservedPayment,
  type ObservedPayment,
} from '@mise/core/payment-sources';
import { CommandRequestError } from './command-request';

export interface SavedPaymentSource {
  intent: PaymentSourceIntent;
  source: ObservedPayment | null;
  closeRequested: boolean;
  receipt: PaymentSourceReceipt | null;
}
export interface PaymentSourceJournal {
  v: 1;
  actions: SavedPaymentSource[];
}
export interface PaymentSourceLocator {
  key: string;
  targetHash: string;
  accountHash: string;
  businessId: string;
  outletId: string;
  memberId: string;
}
export const paymentSourceJournalMaximum = 8 * 1024 * 1024;
export const paymentSourceJournalBytes = (raw: string) =>
  new TextEncoder().encode(raw).byteLength;
const prefix = 'mise.payment-sources.v1',
  hash = (v: string) => /^[a-f0-9]{64}$/.test(v),
  bad = () => new CommandRequestError('review');
export function parsePaymentSourceLocator(key: string): PaymentSourceLocator {
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
export function paymentSourceJournalKey(
  account: Pick<PaymentSourceLocator, 'targetHash' | 'accountHash'>,
  context: DeskPushContext,
): string {
  const scope = parseDeskPushContext(context);
  return parsePaymentSourceLocator(
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
export function parsePaymentSourceJournal(
  raw: string | null,
  scope: Pick<DeskPushContext, 'businessId' | 'outletId' | 'memberId'>,
): PaymentSourceJournal {
  if (raw === null) return { v: 1, actions: [] };
  if (paymentSourceJournalBytes(raw) > paymentSourceJournalMaximum) throw bad();
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
      Object.keys(raw).sort().join(',') !==
        'closeRequested,intent,receipt,source'
    )
      throw bad();
    const row = raw as Record<string, unknown>,
      intent = parsePaymentSourceIntent(row.intent);
    if (
      intent.scope.businessId !== scope.businessId ||
      intent.scope.outletId !== scope.outletId ||
      intent.scope.memberId !== scope.memberId ||
      typeof row.closeRequested !== 'boolean'
    )
      throw bad();
    const source =
      row.source === null ? null : parseObservedPayment(row.source, scope);
    if (
      intent.type === 'capture'
        ? source !== null
        : source === null ||
          source.id !== intent.paymentId ||
          source.fingerprint !== intent.fingerprint
    )
      throw bad();
    const receipt =
      row.receipt === null
        ? null
        : parsePaymentSourceReceipt(row.receipt, intent);
    if (
      receipt?.state === 'applied' &&
      source &&
      JSON.stringify(source) !== JSON.stringify(receipt.before)
    )
      throw bad();
    return {
      intent,
      source,
      closeRequested: row.closeRequested,
      receipt,
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
export function listPaymentSourceLocators(
  storage: Pick<Storage, 'length' | 'key'>,
): { groups: PaymentSourceLocator[]; unreadable: number } {
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
  const groups: PaymentSourceLocator[] = [];
  let unreadable = 0;
  for (const key of first)
    try {
      groups.push(parsePaymentSourceLocator(key));
    } catch {
      unreadable++;
    }
  return { groups, unreadable };
}
