import type { Payment, SetupSnapshot } from './models';
import type { InboxItem } from './inbox';
import { validateShop } from './shop-access';
import {
  capturePaymentCommand,
  editPaymentCommand,
  associatePaymentCommand,
  unmatchPaymentCommand,
  setPaymentVoidedCommand,
  paymentCandidates,
  type PaymentChange,
} from './payment-records';
import {
  previewPaymentMoney,
  recordPaymentMoneyCommand,
  previewPaymentMoneyUndo,
  undoPaymentMoneyCommand,
  type PaymentFinanceRecords,
  type PaymentMoneyChange,
} from './payment-finance';
import {
  nativePaymentId,
  nativePaymentSourceRef,
  paymentInvocationHash,
  parseNativePaymentCommand,
  nativePaymentInvocationEvent,
  type NativePaymentCommand,
} from './payment-invocations';

export function nativePaymentCommandBase(
  setup: SetupSnapshot,
  source: InboxItem,
  before: Payment | null,
  id: string,
  at = Date.now(),
) {
  return {
    format: 'mise-native-payment-command' as const,
    version: 1 as const,
    id,
    businessId: setup.business.id,
    outletId: setup.outlet.id,
    actorId: setup.owner.id,
    paymentId: nativePaymentId(source.id, 'payment'),
    inboxId: source.id,
    occurredAt: at,
    revision: before?.revision ?? 0,
    beforeHash: paymentInvocationHash(before),
    source: nativePaymentSourceRef(source),
  };
}
export interface NativePaymentMutation extends PaymentMoneyChange {
  invocation: ReturnType<typeof nativePaymentInvocationEvent>;
}
/** The same genuine native command on device and backend. The caller must supply
 * current authorized records and commit every returned row/companion atomically.
 * A serialized comparison or an original graph never supplies authorization. */
export function executeNativePaymentCommand(
  input: NativePaymentCommand,
  records: PaymentFinanceRecords,
  payments: readonly Payment[],
  source: InboxItem,
): NativePaymentMutation {
  const c = parseNativePaymentCommand(input),
    setup = records.setup,
    before = payments.find((p) => p.id === c.paymentId) ?? null;
  validateShop(setup);
  if (
    setup.business.id !== c.businessId ||
    setup.outlet.id !== c.outletId ||
    setup.owner.id !== c.actorId ||
    source.id !== c.inboxId ||
    source.outletId !== c.outletId ||
    paymentInvocationHash(before) !== c.beforeHash ||
    paymentInvocationHash(nativePaymentSourceRef(source)) !==
      paymentInvocationHash(c.source) ||
    (before?.revision ?? 0) !== c.revision
  )
    throw Error(
      'The native payment, source, operator or selected outlet changed. Compare the actual records again.',
    );
  const metadata = (payment: PaymentChange): PaymentMoneyChange => ({
    payment,
    orders: [],
    sales: [],
    entries: [],
    events: [],
  });
  const requireBefore = () => {
    if (!before)
      throw Error('Keep the original saved payment before this action.');
    return before;
  };
  let change: PaymentMoneyChange;
  switch (c.type) {
    case 'payment.capture':
      if (before)
        throw Error(
          'This native payment already exists. Recover its original receipt.',
        );
      change = metadata(
        capturePaymentCommand(
          c.input,
          setup,
          source,
          c.context,
          { paymentId: c.paymentId, eventId: c.id },
          c.kind,
          c.occurredAt,
        ),
      );
      break;
    case 'payment.edit':
      change = metadata(
        editPaymentCommand(
          requireBefore(),
          c.revision,
          c.input,
          setup,
          c.id,
          c.occurredAt,
        ),
      );
      break;
    case 'payment.match': {
      const current = requireBefore(),
        matches = paymentCandidates(current, records, payments, c.options),
        candidate = matches.candidates.find(
          (p) =>
            p.kind === c.selected.kind &&
            p.id === c.selected.id &&
            paymentInvocationHash(JSON.parse(p.fingerprint)) ===
              c.selected.hash,
        );
      if (
        !candidate ||
        (c.mode === 'automatic' &&
          (matches.selection !== 'automatic' ||
            matches.candidates[0] !== candidate))
      )
        throw Error(
          'The selected payment candidate changed, or its automatic choice changed. Compare it again.',
        );
      change = metadata(
        associatePaymentCommand(
          current,
          c.revision,
          candidate,
          setup,
          records,
          payments,
          c.id,
          c.occurredAt,
          c.options,
        ),
      );
      break;
    }
    case 'payment.unmatch':
      change = metadata(
        unmatchPaymentCommand(
          requireBefore(),
          c.revision,
          setup,
          c.id,
          c.occurredAt,
        ),
      );
      break;
    case 'payment.void':
    case 'payment.reopen':
      change = metadata(
        setPaymentVoidedCommand(
          requireBefore(),
          c.revision,
          c.type === 'payment.void',
          setup,
          c.id,
          c.occurredAt,
        ),
      );
      break;
    case 'payment.record': {
      const current = requireBefore(),
        preview = previewPaymentMoney(
          current,
          records,
          payments,
          c.target,
          c.note,
        );
      if (
        paymentInvocationHash(JSON.parse(preview.target.fingerprint)) !==
        c.targetHash
      )
        throw Error('The original financial target changed. Compare it again.');
      change = recordPaymentMoneyCommand(
        current,
        c.revision,
        records,
        payments,
        c.target,
        preview.target.fingerprint,
        c.note,
        c.confirmedNewMoney,
        c.id,
        (kind) => nativePaymentId(c.id, `money-${kind}`),
        c.occurredAt,
      );
      break;
    }
    case 'payment.record-undo': {
      const current = requireBefore(),
        preview = previewPaymentMoneyUndo(current, records, c.occurredAt);
      if (
        paymentInvocationHash(JSON.parse(preview.fingerprint)) !==
        c.comparisonHash
      )
        throw Error('The current financial receipt changed. Review it again.');
      change = undoPaymentMoneyCommand(
        current,
        c.revision,
        records,
        preview.fingerprint,
        c.confirmedUndo,
        c.id,
        (kind) => nativePaymentId(c.id, `money-${kind}`),
        c.occurredAt,
      );
      break;
    }
  }
  return {
    ...change,
    invocation: nativePaymentInvocationEvent(c, change.payment.payment),
  };
}
