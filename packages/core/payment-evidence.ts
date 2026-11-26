import { literalSha256 } from './literal-hash';
import type {
  AuditEvent,
  CreditEntry,
  PaymentCheckedFields,
  SetupSnapshot,
} from './models';
import { entryDelta } from './khata';
import { literalToken } from './literal-token';

export const paymentEvidenceCommand = 'source.payment-evidence';
type Scope = { businessId: string; outletId: string };
type Ref = { id: string; digest: string };
type Kind = 'order' | 'credit' | 'counter' | 'sale';
type Stage = 'target' | 'receipt' | 'undo' | 'match';
export interface CompactPaymentSnapshot {
  v: 2;
  scope: Scope;
  stage: Stage;
  target: { kind: Kind; id: string };
  money: Pick<
    PaymentCheckedFields,
    'amount' | 'currency' | 'method' | 'methodName'
  >;
  root: Ref;
}
interface LedgerWitness {
  format: 'mise-payment-ledger';
  v: 1;
  accountId: string;
  throughSequence: number;
  count: number;
  balance: number;
  digest: string;
}
type Evidence = {
  format: 'mise-payment-evidence';
  v: 1;
  scope: Scope;
  digest: string;
  value: unknown;
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const keys = (v: Record<string, unknown>, names: string) =>
  Object.keys(v).sort().join(',') === names.split(',').sort().join(',');
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const hash = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function ensure(ok: unknown): asserts ok {
  if (!ok)
    throw Error(
      'Keep the complete original payment evidence and its verified links.',
    );
}
export const paymentEvidenceDigest = literalSha256;
function digestId(digest: string) {
  let n = BigInt('0x' + digest.slice(0, 32)),
    result = '';
  for (let i = 0; i < 26; i++) {
    result = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Number(n & 31n)] + result;
    n >>= 5n;
  }
  return result;
}
function ref(v: unknown): v is Ref {
  return (
    object(v) &&
    keys(v, 'id,digest') &&
    id(v.id) &&
    hash(v.digest) &&
    v.id === digestId(v.digest)
  );
}
function scope(v: unknown): v is Scope {
  return (
    object(v) &&
    keys(v, 'businessId,outletId') &&
    id(v.businessId) &&
    id(v.outletId)
  );
}
function parsed(fp: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(fp);
  } catch {
    throw Error('Keep the literal original payment snapshot.');
  }
  ensure(object(value));
  return value;
}
export const isCompactPaymentSnapshot = (v: Record<string, unknown>) =>
  v.v === 2;
export function validateCompactPaymentSnapshot(
  v: Record<string, unknown>,
  expected: {
    stage: Stage;
    kind: Kind;
    id: string;
    outletId: string;
    money: PaymentCheckedFields;
  },
): asserts v is Record<string, unknown> & CompactPaymentSnapshot {
  ensure(
    keys(v, 'v,scope,stage,target,money,root') &&
      v.v === 2 &&
      scope(v.scope) &&
      v.scope.outletId === expected.outletId &&
      v.stage === expected.stage &&
      object(v.target) &&
      keys(v.target, 'kind,id') &&
      v.target.kind === expected.kind &&
      v.target.id === expected.id &&
      ref(v.root) &&
      object(v.money) &&
      keys(v.money, 'amount,currency,method,methodName'),
  );
  ensure(
    ['target', 'receipt', 'undo', 'match'].includes(v.stage as string) &&
      ['order', 'credit', 'counter', 'sale'].includes(
        v.target.kind as string,
      ) &&
      id(v.target.id) &&
      Number.isSafeInteger(v.money.amount) &&
      (v.money.amount as number) > 0 &&
      typeof v.money.currency === 'string' &&
      /^[A-Z]{3}$/.test(v.money.currency) &&
      ['cash', 'wallet', 'card'].includes(v.money.method as string) &&
      typeof v.money.methodName === 'string' &&
      v.money.methodName.trim().length > 0 &&
      v.money.methodName.length <= 120,
  );
  ensure(
    literalToken(v.money) ===
      literalToken({
        amount: expected.money.amount,
        currency: expected.money.currency,
        method: expected.money.method,
        methodName: expected.money.methodName,
      }),
  );
}
function witness(
  scope: Scope,
  accountId: string,
  rows: readonly CreditEntry[],
) {
  let digest = paymentEvidenceDigest([
      'mise-payment-ledger-v1',
      scope,
      accountId,
    ]),
    count = 0,
    throughSequence = 0,
    balance = 0n;
  const checkpoints = new Map<number, LedgerWitness>();
  checkpoints.set(0, {
    format: 'mise-payment-ledger',
    v: 1,
    accountId,
    throughSequence: 0,
    count: 0,
    balance: 0,
    digest,
  });
  for (const row of rows) {
    ensure(
      row.accountId === accountId &&
        row.outletId === scope.outletId &&
        Number.isSafeInteger(row.sequence) &&
        row.sequence > throughSequence &&
        Number.isSafeInteger(row.amount),
    );
    digest = paymentEvidenceDigest([digest, row]);
    count++;
    throughSequence = row.sequence;
    balance += BigInt(entryDelta(row));
    ensure(balance >= 0n && balance <= BigInt(Number.MAX_SAFE_INTEGER));
    checkpoints.set(throughSequence, {
      format: 'mise-payment-ledger',
      v: 1,
      accountId,
      throughSequence,
      count,
      balance: Number(balance),
      digest,
    });
  }
  return checkpoints;
}
const ledger = (v: unknown): v is LedgerWitness =>
  object(v) &&
  keys(v, 'format,v,accountId,throughSequence,count,balance,digest') &&
  v.format === 'mise-payment-ledger' &&
  v.v === 1 &&
  id(v.accountId) &&
  [v.throughSequence, v.count, v.balance].every(
    (x) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0,
  ) &&
  hash(v.digest);
/** Values are ordinary immutable audit data, not replay/write authority. The
 * reader checks complete content and scope before expanding a compact link. */
export class PaymentEvidenceReader {
  protected readonly events = new Map<string, AuditEvent>();
  private readonly nodes = new Map<string, unknown>();
  private readonly used = new Set<string>();
  private readonly snapshots = new Map<
    string,
    { value: Record<string, unknown>; maxAt: number }
  >();
  private readonly ledgers = new Map<
    string,
    { rows: CreditEntry[]; checkpoints: Map<number, LedgerWitness> }
  >();
  constructor(
    events: readonly AuditEvent[],
    private readonly entries: readonly CreditEntry[],
  ) {
    for (const event of events) {
      ensure(!this.events.has(event.id));
      this.events.set(event.id, event);
    }
  }
  private node(r: Ref, s: Scope, at = Number.MAX_SAFE_INTEGER): unknown {
    ensure(ref(r));
    const key = literalToken([s, r.id]);
    this.used.add(r.id);
    const original = this.events.get(r.id);
    ensure(original && original.at <= at);
    if (this.nodes.has(key)) return this.nodes.get(key);
    const event = this.events.get(r.id);
    ensure(
      event &&
        event.command === paymentEvidenceCommand &&
        event.outletId === s.outletId &&
        event.before === null &&
        event.actor.type === 'member' &&
        id(event.actor.id) &&
        object(event.after),
    );
    const value = event.after;
    ensure(
      keys(value, 'format,v,scope,digest,value') &&
        value.format === 'mise-payment-evidence' &&
        value.v === 1 &&
        scope(value.scope) &&
        literalToken(value.scope) === literalToken(s) &&
        value.digest === r.digest &&
        paymentEvidenceDigest({
          format: value.format,
          v: value.v,
          scope: value.scope,
          value: value.value,
        }) === r.digest,
    );
    this.nodes.set(key, value.value);
    return value.value;
  }
  private prefix(value: LedgerWitness, s: Scope) {
    const key = literalToken([s, value.accountId]);
    let cached = this.ledgers.get(key);
    if (!cached) {
      const rows = this.entries
        .filter(
          (e) => e.accountId === value.accountId && e.outletId === s.outletId,
        )
        .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
      cached = { rows, checkpoints: witness(s, value.accountId, rows) };
      this.ledgers.set(key, cached);
    }
    ensure(
      literalToken(cached.checkpoints.get(value.throughSequence)) ===
        literalToken(value),
    );
    return cached.rows.slice(0, value.count);
  }
  expand(fp: string, at = Number.MAX_SAFE_INTEGER): Record<string, unknown> {
    const saved = this.snapshots.get(fp);
    if (saved) {
      ensure(saved.maxAt <= at);
      return saved.value;
    }
    const v = parsed(fp);
    if (!isCompactPaymentSnapshot(v)) return v;
    ensure(scope(v.scope) && ref(v.root));
    const root = this.node(v.root, v.scope, at);
    ensure(
      object(root) &&
        keys(root, 'format,v,parts') &&
        root.format === 'mise-payment-snapshot' &&
        root.v === 1 &&
        object(root.parts),
    );
    ensure(
      object(v.target) &&
        ['target', 'receipt', 'undo', 'match'].includes(v.stage as string),
    );
    const expected =
      v.stage === 'undo'
        ? 'receipt,reversal,events'
        : v.stage === 'target' ||
            (v.stage === 'match' && v.target.kind === 'order')
          ? v.target.kind === 'order'
            ? 'order'
            : v.target.kind === 'credit'
              ? 'account,customer,entries'
              : 'business,outlet,who'
          : v.target.kind === 'sale'
            ? 'sale,order,customer'
            : 'entry,account,customer';
    ensure(keys(root.parts, expected));
    let maxAt = this.events.get(v.root.id)!.at;
    const read = (r: Ref) => {
      maxAt = Math.max(maxAt, this.events.get(r.id)?.at ?? Infinity);
      return this.node(r, v.scope as Scope, at);
    };
    const value: Record<string, unknown> = { scope: v.scope };
    for (const [key, part] of Object.entries(root.parts)) {
      ensure(key !== 'scope');
      if (ref(part)) value[key] = read(part);
      else if (key === 'entries' && ledger(part))
        value[key] = this.prefix(part, v.scope);
      else if (key === 'events' && Array.isArray(part)) {
        ensure(part.every(ref));
        value[key] = part.map(read);
      } else {
        ensure(part === null || typeof part === 'string');
        value[key] = part;
      }
    }
    this.snapshots.set(fp, { value, maxAt });
    return value;
  }
  ledger(fp: string): LedgerWitness | undefined {
    const v = parsed(fp);
    if (!isCompactPaymentSnapshot(v)) return;
    ensure(scope(v.scope) && ref(v.root));
    const root = this.node(v.root, v.scope);
    ensure(object(root) && object(root.parts));
    if (ledger(root.parts.entries)) {
      this.prefix(root.parts.entries, v.scope);
      return root.parts.entries;
    }
  }
  usedEventIds(): readonly string[] {
    return [...this.used];
  }
  assertComplete() {
    for (const event of this.events.values())
      if (event.command === paymentEvidenceCommand)
        ensure(this.used.has(event.id));
  }
}

/** A single transaction saves each complete shared value once, plus compact
 * roots/prefix witnesses. Existing snapshots are never rewritten or truncated. */
export class PaymentEvidenceWriter {
  readonly added: AuditEvent[] = [];
  private readonly existing = new Map<string, AuditEvent>();
  private readonly s: Scope;
  constructor(
    private readonly setup: SetupSnapshot,
    events: readonly AuditEvent[],
    private readonly at: number,
  ) {
    this.s = { businessId: setup.business.id, outletId: setup.outlet.id };
    for (const e of events) this.existing.set(e.id, e);
  }
  private intern(value: unknown): Ref {
    const body = {
        format: 'mise-payment-evidence' as const,
        v: 1 as const,
        scope: this.s,
        value,
      },
      digest = paymentEvidenceDigest(body),
      reference = { id: digestId(digest), digest },
      old = this.existing.get(reference.id);
    if (old) {
      ensure(
        object(old.after) && old.actor.type === 'member' && id(old.actor.id),
      );
      const a = old.after as unknown as Evidence;
      ensure(
        old.at <= this.at &&
          old.command === paymentEvidenceCommand &&
          old.outletId === this.s.outletId &&
          old.before === null &&
          a.digest === digest &&
          literalToken(a) === literalToken({ ...body, digest }),
      );
      return reference;
    }
    const event: AuditEvent = {
      id: reference.id,
      outletId: this.s.outletId,
      actor: { type: 'member', id: this.setup.owner.id },
      command: paymentEvidenceCommand,
      before: null,
      after: JSON.parse(literalToken({ ...body, digest })),
      at: this.at,
    };
    this.existing.set(event.id, event);
    this.added.push(event);
    return reference;
  }
  pack(
    fp: string,
    stage: Stage,
    kind: Kind,
    id: string,
    money: PaymentCheckedFields,
  ): string {
    const snapshot = parsed(fp);
    ensure(literalToken(snapshot.scope) === literalToken(this.s));
    const parts: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(snapshot))
      if (key !== 'scope') {
        if (key === 'entries') {
          ensure(
            Array.isArray(value) &&
              object(snapshot.account) &&
              typeof snapshot.account.id === 'string',
          );
          const rows = value as CreditEntry[];
          const points = witness(this.s, snapshot.account.id, rows);
          parts[key] = points.get(rows.at(-1)?.sequence ?? 0);
        } else if (key === 'events') {
          ensure(Array.isArray(value));
          parts[key] = value.map((e) => this.intern(e));
        } else
          parts[key] =
            value === null || typeof value === 'string'
              ? value
              : this.intern(value);
      }
    return literalToken({
      v: 2,
      scope: this.s,
      stage,
      target: { kind, id },
      money: {
        amount: money.amount,
        currency: money.currency,
        method: money.method,
        methodName: money.methodName,
      },
      root: this.intern({ format: 'mise-payment-snapshot', v: 1, parts }),
    } satisfies CompactPaymentSnapshot);
  }
}
