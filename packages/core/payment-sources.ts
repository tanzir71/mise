import { isDeviceId } from './device-access';
import { newInboxId } from './inbox';
import { parseDeskPushContext, type DeskPushContext } from './desk-push';
import { ownerTaskText } from './owner-tasks';

export type ObservedPaymentMethod = 'cash' | 'wallet' | 'card';
/** Existing recorded money only. Source matching never creates a sale/payment. */
export interface PaymentMatchTarget {
  kind: 'order' | 'sale' | 'credit';
  id: string;
  financialId: string;
  businessId: string;
  outletId: string;
  amount: number;
  currency: string;
  method: ObservedPaymentMethod;
  methodNameJson: string;
  at: number;
  labelJson: string;
  fingerprint: string;
}
export interface ObservedPayment {
  id: string;
  businessId: string;
  outletId: string;
  taskId: string;
  amount: number;
  currency: string;
  method: ObservedPaymentMethod;
  methodNameJson: string;
  referenceJson: string;
  sourceJson: string;
  origin: 'manual' | 'sms' | 'notification';
  fromPhone: string | null;
  receivedAt: number;
  createdAt: number;
  updatedAt: number;
  authorJson: string;
  revision: number;
  lastActionId: string;
  status: 'unmatched' | 'matched' | 'review' | 'dismissed';
  reasonJson: string | null;
  match: {
    target: PaymentMatchTarget;
    current: PaymentMatchTarget | null;
    valid: boolean;
  } | null;
  fingerprint: string;
}
interface Original {
  v: 1;
  id: string;
  eventId: string;
  scope: DeskPushContext;
  at: number;
}
export interface PaymentSourceCapture extends Original {
  type: 'capture';
  paymentId: string;
  taskId: string;
  amount: number;
  currency: string;
  method: ObservedPaymentMethod;
  methodNameJson: string;
  referenceJson: string;
  sourceJson: string;
  fromPhone: string | null;
  receivedAt: number;
}
interface Change extends Original {
  paymentId: string;
  fingerprint: string;
}
export type PaymentSourceIntent =
  | PaymentSourceCapture
  | (Change & { type: 'link'; target: PaymentMatchTarget; confirmed: true })
  | (Change & { type: 'dismiss'; reasonJson: string })
  | (Change & { type: 'undo'; undoOf: string });
export interface PaymentSourceReceipt {
  v: 1;
  intent: PaymentSourceIntent;
  state: 'pending' | 'applied' | 'closed';
  at: number | null;
  before: ObservedPayment | null;
  after: ObservedPayment | null;
}
export interface PaymentSourcePage {
  v: 1;
  access: DeskPushContext;
  at: number;
  source: ObservedPayment;
}
export interface PaymentMatchPage {
  v: 1;
  access: DeskPushContext;
  at: number;
  source: ObservedPayment;
  target: PaymentMatchTarget | null;
  eligible: boolean;
}
export interface PaymentCandidateCursor {
  at: number;
  kind: PaymentMatchTarget['kind'];
  id: string;
}
export interface PaymentCandidatePage extends PaymentSourcePage {
  targets: PaymentMatchTarget[];
  next: PaymentCandidateCursor | null;
}
export function parsePaymentCandidateCursor(
  value: unknown,
): PaymentCandidateCursor {
  if (
    !object(value) ||
    !exact(value, 'at,kind,id') ||
    !time(value.at) ||
    !['order', 'sale', 'credit'].includes(value.kind as string) ||
    !isDeviceId(value.id)
  )
    throw bad();
  return {
    at: value.at,
    kind: value.kind as PaymentMatchTarget['kind'],
    id: value.id,
  };
}
export function comparePaymentCandidates(
  a: PaymentCandidateCursor,
  b: PaymentCandidateCursor,
) {
  return (
    b.at - a.at || b.kind.localeCompare(a.kind) || b.id.localeCompare(a.id)
  );
}
export function parsePaymentCandidatePage(
  value: unknown,
  scope: DeskPushContext,
  paymentId: string,
  fingerprint: string,
  after: PaymentCandidateCursor | null = null,
  limit = 20,
): PaymentCandidatePage {
  if (
    !object(value) ||
    !exact(value, 'v,access,at,source,targets,next') ||
    !Array.isArray(value.targets) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    value.targets.length > limit
  )
    throw bad();
  const page = parsePaymentSourcePage(
    { v: value.v, access: value.access, at: value.at, source: value.source },
    scope,
    paymentId,
  );
  if (page.source.fingerprint !== fingerprint) throw bad();
  const targets = value.targets.map((t) => parsePaymentMatchTarget(t, scope)),
    cursors = targets.map((t) => ({
      at: t.at,
      kind: t.kind,
      id: t.financialId,
    }));
  if (
    new Set(
      targets.map(
        (t) => (t.kind === 'credit' ? 'credit:' : 'sale:') + t.financialId,
      ),
    ).size !== targets.length ||
    targets.some((t) => !paymentMatchEligible(page.source, t)) ||
    cursors.some((c, n) =>
      n
        ? comparePaymentCandidates(cursors[n - 1], c) >= 0
        : after !== null && comparePaymentCandidates(after, c) >= 0,
    )
  )
    throw bad();
  const next =
    value.next === null ? null : parsePaymentCandidateCursor(value.next);
  if (
    next &&
    (targets.length !== limit ||
      JSON.stringify(next) !== JSON.stringify(cursors.at(-1)))
  )
    throw bad();
  return { ...page, targets, next };
}
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string) =>
  Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const integer = (v: unknown, min = 0): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const time = (v: unknown): v is number => integer(v) && v <= 8640000000000000;
const hash = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const currency = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Z]{3}$/.test(v);
const method = (v: unknown): v is ObservedPaymentMethod =>
  ['cash', 'wallet', 'card'].includes(v as string);
const phone = (v: unknown): v is string | null =>
  v === null || (typeof v === 'string' && /^\+[1-9][0-9]{6,14}$/.test(v));
const bad = () =>
  Error(
    'Keep the complete payment source and original choice with its phone account and outlet.',
  );
function literal(value: unknown, max: number, required = false) {
  const text = ownerTaskText(value, max);
  if (required && !text.trim()) throw bad();
  return text;
}
function inScope(
  row: { businessId: string; outletId: string },
  scope?: Pick<DeskPushContext, 'businessId' | 'outletId'>,
) {
  if (
    scope &&
    (row.businessId !== scope.businessId || row.outletId !== scope.outletId)
  )
    throw bad();
}
export function parsePaymentMatchTarget(
  value: unknown,
  scope?: Pick<DeskPushContext, 'businessId' | 'outletId'>,
): PaymentMatchTarget {
  if (
    !object(value) ||
    !exact(
      value,
      'kind,id,financialId,businessId,outletId,amount,currency,method,methodNameJson,at,labelJson,fingerprint',
    ) ||
    !['order', 'sale', 'credit'].includes(value.kind as string) ||
    ![value.id, value.financialId, value.businessId, value.outletId].every(
      isDeviceId,
    ) ||
    !integer(value.amount, 1) ||
    !currency(value.currency) ||
    !method(value.method) ||
    !time(value.at) ||
    !hash(value.fingerprint)
  )
    throw bad();
  literal(value.methodNameJson, 80, true);
  literal(value.labelJson, 4000);
  const target = structuredClone(value) as unknown as PaymentMatchTarget;
  inScope(target, scope);
  if (target.kind !== 'order' && target.id !== target.financialId) throw bad();
  return target;
}
export function paymentMatchEligible(
  source: Pick<
    ObservedPayment,
    | 'businessId'
    | 'outletId'
    | 'amount'
    | 'currency'
    | 'method'
    | 'methodNameJson'
  >,
  target: PaymentMatchTarget,
): boolean {
  return (
    source.businessId === target.businessId &&
    source.outletId === target.outletId &&
    source.amount === target.amount &&
    source.currency === target.currency &&
    source.method === target.method &&
    ownerTaskText(source.methodNameJson) ===
      ownerTaskText(target.methodNameJson)
  );
}
export function parseObservedPayment(
  value: unknown,
  scope?: Pick<DeskPushContext, 'businessId' | 'outletId'>,
): ObservedPayment {
  if (
    !object(value) ||
    !exact(
      value,
      'id,businessId,outletId,taskId,amount,currency,method,methodNameJson,referenceJson,sourceJson,origin,fromPhone,receivedAt,createdAt,updatedAt,authorJson,revision,lastActionId,status,reasonJson,match,fingerprint',
    ) ||
    ![
      value.id,
      value.businessId,
      value.outletId,
      value.taskId,
      value.lastActionId,
    ].every(isDeviceId) ||
    !integer(value.amount, 1) ||
    !currency(value.currency) ||
    !method(value.method) ||
    !['manual', 'sms', 'notification'].includes(value.origin as string) ||
    !phone(value.fromPhone) ||
    !time(value.receivedAt) ||
    !time(value.createdAt) ||
    !time(value.updatedAt) ||
    value.updatedAt < value.createdAt ||
    !integer(value.revision) ||
    !hash(value.fingerprint) ||
    !['unmatched', 'matched', 'review', 'dismissed'].includes(
      value.status as string,
    )
  )
    throw bad();
  literal(value.methodNameJson, 80, true);
  literal(value.referenceJson, 4000);
  literal(value.sourceJson, 16000, true);
  literal(value.authorJson, 200);
  if (value.reasonJson !== null) literal(value.reasonJson, 4000, true);
  const source = structuredClone(value) as unknown as ObservedPayment;
  inScope(source, scope);
  if (source.match !== null) {
    if (
      !object(source.match) ||
      !exact(source.match, 'target,current,valid') ||
      typeof source.match.valid !== 'boolean'
    )
      throw bad();
    const target = parsePaymentMatchTarget(source.match.target, source),
      current =
        source.match.current === null
          ? null
          : parsePaymentMatchTarget(source.match.current, source);
    if (
      !paymentMatchEligible(source, target) ||
      (current &&
        (current.kind !== target.kind ||
          current.id !== target.id ||
          current.financialId !== target.financialId)) ||
      source.match.valid !==
        (current !== null &&
          current.fingerprint === target.fingerprint &&
          paymentMatchEligible(source, current))
    )
      throw bad();
  }
  const expected =
    source.reasonJson !== null
      ? 'dismissed'
      : source.match === null
        ? 'unmatched'
        : source.match.valid
          ? 'matched'
          : 'review';
  if (
    source.status !== expected ||
    (source.reasonJson !== null && source.match !== null)
  )
    throw bad();
  return source;
}
export function parsePaymentSourceIntent(value: unknown): PaymentSourceIntent {
  if (
    !object(value) ||
    value.v !== 1 ||
    ![value.id, value.eventId].every(isDeviceId) ||
    value.id === value.eventId ||
    !time(value.at) ||
    !isDeviceId(value.paymentId)
  )
    throw bad();
  const scope = parseDeskPushContext(value.scope);
  if ([value.id, value.eventId].includes(value.paymentId)) throw bad();
  if (value.type === 'capture') {
    if (
      !exact(
        value,
        'v,id,eventId,scope,at,type,paymentId,taskId,amount,currency,method,methodNameJson,referenceJson,sourceJson,fromPhone,receivedAt',
      ) ||
      !isDeviceId(value.taskId) ||
      new Set([value.id, value.eventId, value.paymentId, value.taskId]).size !==
        4 ||
      !integer(value.amount, 1) ||
      !currency(value.currency) ||
      !method(value.method) ||
      !phone(value.fromPhone) ||
      !time(value.receivedAt)
    )
      throw bad();
    literal(value.methodNameJson, 80, true);
    literal(value.referenceJson, 4000);
    literal(value.sourceJson, 16000, true);
  } else {
    if (!hash(value.fingerprint)) throw bad();
    if (value.type === 'link') {
      if (
        !exact(
          value,
          'v,id,eventId,scope,at,type,paymentId,fingerprint,target,confirmed',
        ) ||
        value.confirmed !== true
      )
        throw bad();
      parsePaymentMatchTarget(value.target, scope);
    } else if (value.type === 'dismiss') {
      if (
        !exact(
          value,
          'v,id,eventId,scope,at,type,paymentId,fingerprint,reasonJson',
        )
      )
        throw bad();
      literal(value.reasonJson, 4000, true);
    } else if (value.type === 'undo') {
      if (
        !exact(
          value,
          'v,id,eventId,scope,at,type,paymentId,fingerprint,undoOf',
        ) ||
        !isDeviceId(value.undoOf) ||
        [value.id, value.eventId].includes(value.undoOf)
      )
        throw bad();
    } else throw bad();
  }
  return structuredClone(value) as unknown as PaymentSourceIntent;
}
export function capturePaymentSource(
  scope: DeskPushContext,
  draft: {
    amount: number;
    currency: string;
    method: ObservedPaymentMethod;
    methodName: string;
    reference: string;
    source: string;
    fromPhone?: string | null;
    receivedAt: number;
  },
  at = Date.now(),
): PaymentSourceCapture {
  return parsePaymentSourceIntent({
    v: 1,
    id: newInboxId(),
    eventId: newInboxId(),
    scope,
    at,
    type: 'capture',
    paymentId: newInboxId(),
    taskId: newInboxId(),
    amount: draft.amount,
    currency: draft.currency,
    method: draft.method,
    methodNameJson: JSON.stringify(draft.methodName),
    referenceJson: JSON.stringify(draft.reference),
    sourceJson: JSON.stringify(draft.source),
    fromPhone: draft.fromPhone ?? null,
    receivedAt: draft.receivedAt,
  }) as PaymentSourceCapture;
}
export function changePaymentSource(
  scope: DeskPushContext,
  source: ObservedPayment,
  change:
    | { type: 'link'; target: PaymentMatchTarget; confirmed: true }
    | { type: 'dismiss'; reason: string }
    | { type: 'undo' },
  at = Date.now(),
): PaymentSourceIntent {
  parseObservedPayment(source, scope);
  const fields =
    change.type === 'link'
      ? {
          type: change.type,
          target: change.target,
          confirmed: change.confirmed,
        }
      : change.type === 'dismiss'
        ? { type: change.type, reasonJson: JSON.stringify(change.reason) }
        : { type: change.type, undoOf: source.lastActionId };
  if (change.type === 'link' && !paymentMatchEligible(source, change.target))
    throw bad();
  return parsePaymentSourceIntent({
    v: 1,
    id: newInboxId(),
    eventId: newInboxId(),
    scope,
    at,
    paymentId: source.id,
    fingerprint: source.fingerprint,
    ...fields,
  });
}
export function parsePaymentSourceReceipt(
  value: unknown,
  intent: PaymentSourceIntent,
): PaymentSourceReceipt {
  const original = parsePaymentSourceIntent(intent);
  if (
    !object(value) ||
    !exact(value, 'v,intent,state,at,before,after') ||
    value.v !== 1 ||
    !['pending', 'applied', 'closed'].includes(value.state as string) ||
    JSON.stringify(parsePaymentSourceIntent(value.intent)) !==
      JSON.stringify(original) ||
    (value.state === 'pending' ? value.at !== null : !time(value.at))
  )
    throw bad();
  const before =
      value.before === null
        ? null
        : parseObservedPayment(value.before, original.scope),
    after =
      value.after === null
        ? null
        : parseObservedPayment(value.after, original.scope);
  if (value.state !== 'applied') {
    if (before !== null || after !== null) throw bad();
  } else {
    if (
      after === null ||
      after.id !== original.paymentId ||
      after.lastActionId !== original.id ||
      after.updatedAt !== value.at
    )
      throw bad();
    if (original.type === 'capture') {
      if (
        before !== null ||
        after.revision !== 0 ||
        after.origin !== 'manual' ||
        after.status !== 'unmatched' ||
        after.taskId !== original.taskId ||
        after.createdAt !== value.at ||
        [
          'amount',
          'currency',
          'method',
          'methodNameJson',
          'referenceJson',
          'sourceJson',
          'fromPhone',
          'receivedAt',
        ].some(
          (k) =>
            after[k as keyof ObservedPayment] !==
            original[k as keyof PaymentSourceCapture],
        )
      )
        throw bad();
    } else {
      if (
        before === null ||
        before.id !== original.paymentId ||
        before.fingerprint !== original.fingerprint ||
        after.revision !== before.revision + 1 ||
        [
          'taskId',
          'amount',
          'currency',
          'method',
          'methodNameJson',
          'referenceJson',
          'sourceJson',
          'origin',
          'fromPhone',
          'receivedAt',
          'createdAt',
          'authorJson',
        ].some(
          (k) =>
            after[k as keyof ObservedPayment] !==
            before[k as keyof ObservedPayment],
        )
      )
        throw bad();
      if (
        original.type === 'link' &&
        (after.status !== 'matched' ||
          after.match === null ||
          Object.keys(original.target).some(
            (key) =>
              after.match!.target[key as keyof PaymentMatchTarget] !==
              original.target[key as keyof PaymentMatchTarget],
          ))
      )
        throw bad();
      if (
        original.type === 'dismiss' &&
        (after.status !== 'dismissed' ||
          after.reasonJson !== original.reasonJson)
      )
        throw bad();
    }
  }
  return {
    v: 1,
    intent: original,
    state: value.state as PaymentSourceReceipt['state'],
    at: value.at as number | null,
    before,
    after,
  };
}
export function parsePaymentSourcePage(
  value: unknown,
  scope: DeskPushContext,
  paymentId: string,
): PaymentSourcePage {
  if (
    !object(value) ||
    !exact(value, 'v,access,at,source') ||
    value.v !== 1 ||
    !time(value.at) ||
    JSON.stringify(parseDeskPushContext(value.access)) !==
      JSON.stringify(parseDeskPushContext(scope))
  )
    throw bad();
  const source = parseObservedPayment(value.source, scope);
  if (source.id !== paymentId) throw bad();
  return {
    v: 1,
    access: parseDeskPushContext(value.access),
    at: value.at,
    source,
  };
}
export function parsePaymentMatchPage(
  value: unknown,
  scope: DeskPushContext,
  paymentId: string,
  kind: PaymentMatchTarget['kind'],
  targetId: string,
): PaymentMatchPage {
  if (
    !object(value) ||
    !exact(value, 'v,access,at,source,target,eligible') ||
    typeof value.eligible !== 'boolean'
  )
    throw bad();
  const page = parsePaymentSourcePage(
      { v: value.v, access: value.access, at: value.at, source: value.source },
      scope,
      paymentId,
    ),
    target =
      value.target === null
        ? null
        : parsePaymentMatchTarget(value.target, scope);
  if (
    (target && (target.kind !== kind || target.id !== targetId)) ||
    value.eligible !==
      (target !== null && paymentMatchEligible(page.source, target))
  )
    throw bad();
  return { ...page, target, eligible: value.eligible };
}
