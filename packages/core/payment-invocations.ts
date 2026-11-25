import { sha256 } from '@noble/hashes/sha2';
import { literalToken } from './literal-token';
import { marketPacks } from './packs';
import { inboxSnapshot, type InboxItem } from './inbox';
import type { AuditEvent, Payment, PaymentCheckedFields } from './models';
import type { PaymentTextContext } from './payments';
import type { PaymentMatchOptions } from './payment-matches';
import type { CheckedPaymentInput } from './payment-records';
import type { PaymentMoneyTarget } from './payment-finance';

export const paymentInvocationCommand = 'source.payment-invocation';
export interface NativePaymentMatchOptions {
  windowMs: number;
  receivedTimeConfirmed: boolean;
  methodNames: { bkash: string[]; nagad: string[]; bank: string[] };
}
interface NativePaymentBase {
  format: 'mise-native-payment-command';
  version: 1;
  id: string;
  businessId: string;
  outletId: string;
  actorId: string;
  paymentId: string;
  inboxId: string;
  occurredAt: number;
  revision: number;
  beforeHash: string;
  source: { revision: number; hash: string };
}
export type NativePaymentCommand = NativePaymentBase &
  (
    | {
        type: 'payment.capture';
        input: CheckedPaymentInput;
        context: PaymentTextContext;
        kind: Payment['source'];
      }
    | { type: 'payment.edit'; input: CheckedPaymentInput }
    | {
        type: 'payment.match';
        selected: {
          kind: 'order' | 'sale' | 'credit';
          id: string;
          hash: string;
        };
        options: NativePaymentMatchOptions;
        mode: 'manual' | 'automatic';
      }
    | { type: 'payment.unmatch' | 'payment.void' | 'payment.reopen' }
    | {
        type: 'payment.record';
        target: PaymentMoneyTarget;
        targetHash: string;
        note: string;
        confirmedNewMoney: true;
      }
    | {
        type: 'payment.record-undo';
        comparisonHash: string;
        confirmedUndo: true;
      }
  );
export interface NativePaymentInvocation {
  command: NativePaymentCommand;
  paymentHash: string;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const exact = (v: Record<string, unknown>, required: string, optional = '') =>
  required.split(',').every((k) => Object.hasOwn(v, k)) &&
  Object.keys(v).every((k) =>
    (required + ',' + optional).split(',').includes(k),
  );
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const integer = (
  v: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const time = (v: unknown): v is number => integer(v, 0, 253402300799999);
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length <= max;
const hash = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
function ensure(ok: unknown): asserts ok {
  if (!ok)
    throw Error(
      'Keep the complete original payment invocation, choices and confirmation.',
    );
}
/** Canonical literal bytes preserve NUL and lone surrogates through JSON escapes.
 * These hashes establish equality, never membership, consent or write authority. */
export function paymentInvocationHash(value: unknown): string {
  return Array.from(
    sha256(new TextEncoder().encode(literalToken(value))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
/** The existing native financial identities, shared by device and server replay. */
export function nativePaymentId(source: string, slot: string): string {
  ensure(id(source) && text(slot, 80) && slot.length > 0);
  const bytes = sha256(
    new TextEncoder().encode(`mise-payment-capture-v1\0${source}\0${slot}`),
  );
  let value = BigInt(
      '0x' +
        Array.from(bytes.slice(0, 10), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join(''),
    ),
    suffix = '';
  for (let n = 0; n < 16; n++) {
    suffix = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Number(value & 31n)] + suffix;
    value >>= 5n;
  }
  return source.slice(0, 10) + suffix;
}
export const nativePaymentSourceRef = (source: InboxItem) => ({
  revision: source.revision,
  hash: paymentInvocationHash(inboxSnapshot(source)),
});
export function nativePaymentMatchOptions(
  options: PaymentMatchOptions = {},
): NativePaymentMatchOptions {
  const result = {
    windowMs: options.windowMs ?? 30 * 60000,
    receivedTimeConfirmed: options.receivedTimeConfirmed ?? false,
    methodNames: {
      bkash: [...(options.methodNames?.bkash ?? ['bKash'])],
      nagad: [...(options.methodNames?.nagad ?? ['Nagad'])],
      bank: [...(options.methodNames?.bank ?? ['Bank transfer'])],
    },
  };
  validateOptions(result);
  return result;
}
function validateOptions(v: unknown): asserts v is NativePaymentMatchOptions {
  ensure(
    object(v) &&
      exact(v, 'windowMs,receivedTimeConfirmed,methodNames') &&
      integer(v.windowMs, 1, 86400000) &&
      typeof v.receivedTimeConfirmed === 'boolean' &&
      object(v.methodNames) &&
      exact(v.methodNames, 'bkash,nagad,bank'),
  );
  for (const values of Object.values(v.methodNames))
    ensure(
      Array.isArray(values) &&
        values.length <= 100 &&
        values.every((value) => text(value, 120)),
    );
}
function checked(v: unknown): asserts v is CheckedPaymentInput {
  ensure(
    object(v) &&
      exact(
        v,
        'checked,amount,currency,method,methodName,reference,receivedAt',
        'referenceScope,fromPhone',
      ) &&
      v.checked === true &&
      integer(v.amount, 1) &&
      typeof v.currency === 'string' &&
      /^[A-Z]{3}$/.test(v.currency) &&
      ['cash', 'wallet', 'card'].includes(v.method as string) &&
      text(v.methodName, 120) &&
      v.methodName.trim() &&
      text(v.reference, 120) &&
      time(v.receivedAt),
  );
  ensure(
    v.fromPhone === undefined ||
      (typeof v.fromPhone === 'string' &&
        /^\+[1-9]\d{6,14}$/.test(v.fromPhone)),
  );
  ensure(
    v.referenceScope === undefined ||
      (text(v.referenceScope, 120) &&
        !!v.referenceScope.trim() &&
        v.method === 'wallet' &&
        v.methodName === 'Bank transfer'),
  );
}
const baseKeys =
  'format,version,id,businessId,outletId,actorId,paymentId,inboxId,occurredAt,revision,beforeHash,source,type';
export function parseNativePaymentCommand(
  value: unknown,
): NativePaymentCommand {
  ensure(
    object(value) &&
      value.format === 'mise-native-payment-command' &&
      value.version === 1 &&
      [
        value.id,
        value.businessId,
        value.outletId,
        value.actorId,
        value.paymentId,
        value.inboxId,
      ].every(id) &&
      new Set([value.id, value.paymentId, value.inboxId]).size === 3 &&
      time(value.occurredAt) &&
      integer(value.revision, 0, Number.MAX_SAFE_INTEGER - 1) &&
      hash(value.beforeHash) &&
      object(value.source) &&
      exact(value.source, 'revision,hash') &&
      integer(value.source.revision, 1) &&
      hash(value.source.hash),
  );
  ensure(
    value.paymentId === nativePaymentId(value.inboxId as string, 'payment'),
  );
  switch (value.type) {
    case 'payment.capture': {
      ensure(
        exact(value, baseKeys + ',input,context,kind') &&
          value.revision === 0 &&
          value.id === nativePaymentId(value.inboxId as string, 'capture') &&
          value.beforeHash === paymentInvocationHash(null) &&
          ['manual', 'sms', 'notification'].includes(value.kind as string),
      );
      checked(value.input);
      const c = value.context;
      ensure(
        object(c) &&
          exact(c, 'receivedAt,timeZone,currency', 'market,sender,dateOrder') &&
          time(c.receivedAt) &&
          text(c.timeZone, 128) &&
          c.timeZone.length > 0 &&
          text(c.currency, 3) &&
          /^[A-Z]{3}$/.test(c.currency) &&
          typeof c.market === 'string' &&
          Object.hasOwn(marketPacks, c.market) &&
          (c.sender === undefined || text(c.sender, 200)) &&
          (c.dateOrder === undefined ||
            c.dateOrder === 'DMY' ||
            c.dateOrder === 'MDY'),
      );
      break;
    }
    case 'payment.edit':
      ensure(exact(value, baseKeys + ',input') && value.revision !== 0);
      checked(value.input);
      break;
    case 'payment.match': {
      ensure(
        exact(value, baseKeys + ',selected,options,mode') &&
          value.revision !== 0 &&
          ['manual', 'automatic'].includes(value.mode as string),
      );
      const s = value.selected;
      ensure(
        object(s) &&
          exact(s, 'kind,id,hash') &&
          ['order', 'sale', 'credit'].includes(s.kind as string) &&
          id(s.id) &&
          hash(s.hash),
      );
      validateOptions(value.options);
      break;
    }
    case 'payment.unmatch':
    case 'payment.void':
    case 'payment.reopen':
      ensure(exact(value, baseKeys) && value.revision !== 0);
      break;
    case 'payment.record': {
      ensure(
        exact(value, baseKeys + ',target,targetHash,note,confirmedNewMoney') &&
          value.revision !== 0 &&
          value.confirmedNewMoney === true &&
          hash(value.targetHash) &&
          text(value.note, 4000),
      );
      const t = value.target;
      ensure(
        object(t) &&
          (t.kind === 'counter'
            ? exact(t, 'kind,who') &&
              typeof t.who === 'string' &&
              t.who.trim().length <= 80
            : ['order', 'credit'].includes(t.kind as string) &&
              exact(t, 'kind,id') &&
              id(t.id)),
      );
      break;
    }
    case 'payment.record-undo':
      ensure(
        exact(value, baseKeys + ',comparisonHash,confirmedUndo') &&
          value.revision !== 0 &&
          hash(value.comparisonHash) &&
          value.confirmedUndo === true,
      );
      break;
    default:
      ensure(false);
  }
  return structuredClone(value) as unknown as NativePaymentCommand;
}
function money(p: PaymentCheckedFields): PaymentCheckedFields {
  return {
    amount: p.amount,
    currency: p.currency,
    method: p.method,
    methodName: p.methodName,
    reference: p.reference,
    receivedAt: p.receivedAt,
    ...(p.fromPhone !== undefined ? { fromPhone: p.fromPhone } : {}),
    ...(p.referenceScope !== undefined
      ? { referenceScope: p.referenceScope }
      : {}),
  };
}
export function nativePaymentInvocationEvent(
  input: NativePaymentCommand,
  payment: Payment,
): AuditEvent {
  const c = parseNativePaymentCommand(input);
  ensure(
    payment.id === c.paymentId &&
      payment.eventId === c.id &&
      payment.revision === c.revision + 1,
  );
  return {
    id: nativePaymentId(c.id, 'invocation'),
    outletId: c.outletId,
    actor: { type: 'member', id: c.actorId },
    command: paymentInvocationCommand,
    before: null,
    after: {
      command: c,
      paymentHash: paymentInvocationHash(payment),
    } satisfies NativePaymentInvocation,
    at: c.occurredAt,
  };
}
/** Legacy histories have no invocation. They remain historical facts and must
 * never be upgraded into new command consent or an inferred matching window. */
export function readNativePaymentInvocation(
  event: AuditEvent,
  events: readonly AuditEvent[],
): NativePaymentInvocation | null {
  const receipt = events.find(
    (e) => e.id === nativePaymentId(event.id, 'invocation'),
  );
  if (!receipt) return null;
  ensure(
    receipt.command === paymentInvocationCommand &&
      receipt.before === null &&
      object(receipt.after) &&
      exact(receipt.after, 'command,paymentHash') &&
      hash(receipt.after.paymentHash),
  );
  ensure(object(event.after));
  const c = parseNativePaymentCommand(receipt.after.command),
    after = event.after as unknown as Payment;
  ensure(
    c.id === event.id &&
      c.type === event.command &&
      c.actorId === event.actor.id &&
      event.actor.type === 'member' &&
      receipt.actor.type === 'member' &&
      receipt.actor.id === c.actorId &&
      receipt.outletId === c.outletId &&
      event.outletId === c.outletId &&
      receipt.at === c.occurredAt &&
      event.at === c.occurredAt &&
      event.paymentId === c.paymentId &&
      event.paymentRevision === c.revision + 1 &&
      after.id === c.paymentId &&
      after.inboxId === c.inboxId &&
      after.revision === c.revision + 1 &&
      after.eventId === c.id &&
      paymentInvocationHash(event.before) === c.beforeHash &&
      paymentInvocationHash(after) === receipt.after.paymentHash,
  );
  if (c.type === 'payment.capture' || c.type === 'payment.edit')
    ensure(
      paymentInvocationHash({ ...money(after), checked: true }) ===
        paymentInvocationHash(c.input),
    );
  if (c.type === 'payment.capture')
    ensure(
      c.kind === after.source &&
        paymentInvocationHash(c.context) ===
          paymentInvocationHash(after.parsed.sourceContext),
    );
  if (c.type === 'payment.match')
    ensure(
      after.association?.id === c.selected.id &&
        after.association?.kind === c.selected.kind,
    );
  if (c.type === 'payment.record') {
    const p = after.postings?.at(-1);
    ensure(
      p &&
        p.eventId === c.id &&
        p.note === c.note &&
        p.target.kind === c.target.kind &&
        (c.target.kind === 'counter' || p.target.id === c.target.id),
    );
    ensure(
      p.receipt.id ===
        nativePaymentId(
          c.id,
          p.receipt.kind === 'sale' ? 'money-sale' : 'money-entry',
        ),
    );
  }
  return { command: c, paymentHash: receipt.after.paymentHash };
}
export function validateNativePaymentInvocations(
  events: readonly AuditEvent[],
  expand?: (fingerprint: string, at: number) => Record<string, unknown>,
  businessForOutlet?: (outletId: string) => string | undefined,
): void {
  const byId = new Map(events.map((e) => [e.id, e])),
    sources = new Map<string, InboxItem>();
  for (const event of events)
    if (
      event.inboxId &&
      event.inboxRevision &&
      event.command.startsWith('inbox.') &&
      event.command !== 'inbox.image.upload'
    )
      sources.set(
        JSON.stringify([event.inboxId, event.inboxRevision]),
        event.after as InboxItem,
      );
  for (const receipt of events) {
    if (receipt.command !== paymentInvocationCommand) continue;
    ensure(object(receipt.after) && object(receipt.after.command));
    const c = parseNativePaymentCommand(receipt.after.command),
      event = byId.get(c.id);
    ensure(event && receipt.id === nativePaymentId(c.id, 'invocation'));
    const read = readNativePaymentInvocation(event, events);
    ensure(read);
    if (businessForOutlet)
      ensure(businessForOutlet(c.outletId) === c.businessId);
    const source = sources.get(JSON.stringify([c.inboxId, c.source.revision]));
    ensure(
      source &&
        source.outletId === c.outletId &&
        paymentInvocationHash(inboxSnapshot(source)) === c.source.hash,
    );
    if (c.type === 'payment.capture' || c.type === 'payment.record')
      ensure(!source.archived);
    if (expand && c.type === 'payment.match') {
      const a = (event.after as Payment).association!;
      ensure(
        paymentInvocationHash(expand(a.fingerprint, a.at)) === c.selected.hash,
      );
    }
    if (expand && c.type === 'payment.record') {
      const p = (event.after as Payment).postings!.at(-1)!;
      ensure(
        paymentInvocationHash(expand(p.target.fingerprint, p.at)) ===
          c.targetHash,
      );
    }
  }
}
