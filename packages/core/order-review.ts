import { parseOrderCommand, type OrderCommand } from './order-commands';
import { orderStatusLabels } from './orders';
import type { Order } from './models';
export interface OrderReviewRequest {
  id: string;
  replacementId: string;
  command: OrderCommand;
  sourceHash: string;
  sourceJson: string;
}
export interface OrderReviewDecision extends OrderReviewRequest {
  token: string;
  outcome: 'withdrawn' | 'replaced';
}
export type OrderFinancialView = Pick<
  Order,
  | 'id'
  | 'number'
  | 'revision'
  | 'status'
  | 'currency'
  | 'customer'
  | 'lines'
  | 'subtotal'
  | 'deliveryFee'
  | 'discount'
  | 'total'
  | 'payment'
>;
export interface OrderFinancialEffect {
  kind: 'payment' | 'payment_reversed' | 'refund' | 'refund_reversed';
  amount: number;
  currency: string;
  method: string;
  methodName: string;
}
export interface PreparedOrderReview {
  v: 1;
  id: string;
  replacementId: string;
  commandId: string;
  commandHash: string;
  sourceHash: string;
  businessId: string;
  outletId: string;
  actorId: string;
  token: string;
  at: number;
  expiresAt: number;
  current: {
    order: OrderFinancialView | null;
    balance: number | null;
    limit: number | null;
    creditCurrency: string | null;
    creditCustomer: { name: string; phone: string | null } | null;
  };
  proposal:
    | { enabled: false }
    | {
        enabled: true;
        revision: number;
        total: number | null;
        currency: string;
        status: Order['status'];
        method: Order['payment']['method'];
        creditBalance: number | null;
        refundDue: number;
        effects: OrderFinancialEffect[];
      };
}
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const integer = (v: unknown, min = 0): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const exact = (v: Record<string, unknown>, keys: string) =>
  Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
export function parsePreparedOrderReview(
  value: unknown,
  input: OrderReviewRequest,
  commandHash: string,
  scope: { businessId: string; outletId: string; actorId: string },
): PreparedOrderReview {
  if (
    !object(value) ||
    !exact(
      value,
      'v,id,replacementId,commandId,commandHash,sourceHash,businessId,outletId,actorId,token,at,expiresAt,current,proposal',
    ) ||
    value.v !== 1 ||
    value.id !== input.id ||
    value.replacementId !== input.replacementId ||
    value.commandId !== input.command.id ||
    value.commandHash !== commandHash ||
    value.sourceHash !== input.sourceHash ||
    value.businessId !== scope.businessId ||
    value.outletId !== scope.outletId ||
    value.outletId !== input.command.outletId ||
    value.actorId !== scope.actorId ||
    ![value.businessId, value.outletId, value.actorId].every(id) ||
    typeof value.token !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.token) ||
    !integer(value.at) ||
    !integer(value.expiresAt) ||
    value.expiresAt <= value.at ||
    value.expiresAt > 8640000000000000 ||
    !object(value.current) ||
    !exact(
      value.current,
      'order,balance,limit,creditCurrency,creditCustomer',
    ) ||
    !(
      value.current.balance === null ||
      integer(value.current.balance, Number.MIN_SAFE_INTEGER)
    ) ||
    !(value.current.limit === null || integer(value.current.limit)) ||
    (value.current.creditCurrency === null
      ? value.current.balance !== null || value.current.limit !== null
      : typeof value.current.creditCurrency !== 'string' ||
        !/^[A-Z]{3}$/.test(value.current.creditCurrency) ||
        value.current.balance === null ||
        value.current.limit === null) ||
    (value.current.creditCurrency === null
      ? value.current.creditCustomer !== null
      : !object(value.current.creditCustomer) ||
        !exact(value.current.creditCustomer, 'name,phone') ||
        typeof value.current.creditCustomer.name !== 'string' ||
        !(
          value.current.creditCustomer.phone === null ||
          typeof value.current.creditCustomer.phone === 'string'
        )) ||
    !object(value.proposal)
  )
    throw new Error('Keep the exact selected shop review.');
  const order = value.current.order;
  if (order !== null) {
    if (
      !object(order) ||
      !exact(
        order,
        'id,number,revision,status,currency,customer,lines,subtotal,deliveryFee,discount,total,payment',
      ) ||
      !('orderId' in input.command) ||
      order.id !== input.command.orderId ||
      typeof order.number !== 'string' ||
      !integer(order.revision, 1) ||
      typeof order.status !== 'string' ||
      !Object.hasOwn(orderStatusLabels, order.status) ||
      typeof order.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(order.currency) ||
      !['subtotal', 'deliveryFee', 'discount'].every((key) =>
        integer(order[key]),
      ) ||
      !(order.total === null || integer(order.total)) ||
      !object(order.customer) ||
      typeof order.customer.name !== 'string' ||
      !Object.keys(order.customer).every((key) =>
        ['id', 'name', 'phone'].includes(key),
      ) ||
      (order.customer.id !== undefined && !id(order.customer.id)) ||
      (order.customer.phone !== undefined &&
        typeof order.customer.phone !== 'string') ||
      !Array.isArray(order.lines) ||
      order.lines.length > 200 ||
      !object(order.payment) ||
      !['cash', 'wallet', 'card', 'credit'].includes(
        order.payment.method as string,
      ) ||
      !['pending', 'paid', 'credited'].includes(
        order.payment.status as string,
      ) ||
      !Object.keys(order.payment).every((key) =>
        ['method', 'status', 'wallet', 'saleId', 'at', 'cancellation'].includes(
          key,
        ),
      )
    )
      throw new Error('Keep the complete current order review.');
    for (const line of order.lines)
      if (
        !object(line) ||
        !id(line.id) ||
        typeof line.name !== 'string' ||
        typeof line.unit !== 'string' ||
        typeof line.note !== 'string' ||
        typeof line.qty !== 'number' ||
        !Number.isFinite(line.qty) ||
        line.qty <= 0 ||
        !(line.unitPrice === null || integer(line.unitPrice)) ||
        !(line.lineTotal === null || integer(line.lineTotal)) ||
        typeof line.unavailable !== 'boolean' ||
        !Object.keys(line).every((key) =>
          [
            'id',
            'itemId',
            'name',
            'unit',
            'qty',
            'unitPrice',
            'lineTotal',
            'note',
            'unavailable',
            'substitution',
          ].includes(key),
        )
      )
        throw new Error('Keep every current priced order line.');
  }
  const proposal = value.proposal;
  if (proposal.enabled === false) {
    if (!exact(proposal, 'enabled'))
      throw new Error('Keep the manual-review outcome.');
  } else {
    const sameRevision =
      input.command.type === 'order.create'
        ? order === null && proposal.revision === 0
        : object(order) && proposal.revision === order.revision;
    if (
      proposal.enabled !== true ||
      !exact(
        proposal,
        'enabled,revision,total,currency,status,method,creditBalance,refundDue,effects',
      ) ||
      !integer(proposal.revision) ||
      typeof proposal.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(proposal.currency) ||
      (object(order) && proposal.currency !== order.currency) ||
      !(proposal.total === null || integer(proposal.total)) ||
      typeof proposal.status !== 'string' ||
      !Object.hasOwn(orderStatusLabels, proposal.status) ||
      !['cash', 'wallet', 'card', 'credit'].includes(
        proposal.method as string,
      ) ||
      !integer(proposal.refundDue) ||
      !(proposal.creditBalance === null
        ? value.current.creditCurrency === null
        : value.current.creditCurrency !== null &&
          integer(proposal.creditBalance, Number.MIN_SAFE_INTEGER)) ||
      !Array.isArray(proposal.effects) ||
      proposal.effects.length > 200 ||
      !sameRevision
    )
      throw new Error('Keep the exact reviewed financial proposal.');
    for (const effect of proposal.effects as unknown[])
      if (
        !object(effect) ||
        !exact(effect, 'kind,amount,currency,method,methodName') ||
        !['payment', 'payment_reversed', 'refund', 'refund_reversed'].includes(
          effect.kind as string,
        ) ||
        !integer(effect.amount) ||
        typeof effect.currency !== 'string' ||
        !/^[A-Z]{3}$/.test(effect.currency) ||
        !['cash', 'wallet', 'card', 'credit'].includes(
          effect.method as string,
        ) ||
        typeof effect.methodName !== 'string'
      )
        throw new Error('Keep every reviewed payment and refund effect.');
  }
  return structuredClone(value) as unknown as PreparedOrderReview;
}
export function parseOrderReviewRequest(
  value: unknown,
  decision: false,
): OrderReviewRequest;
export function parseOrderReviewRequest(
  value: unknown,
  decision: true,
): OrderReviewDecision;
export function parseOrderReviewRequest(
  value: unknown,
  decision: boolean,
): OrderReviewRequest | OrderReviewDecision {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !==
      (decision
        ? 'command,id,outcome,replacementId,sourceHash,sourceJson,token'
        : 'command,id,replacementId,sourceHash,sourceJson') ||
    ![value.id, value.replacementId].every(
      (v) => typeof v === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v),
    ) ||
    typeof value.sourceHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sourceHash) ||
    typeof value.sourceJson !== 'string' ||
    new TextEncoder().encode(value.sourceJson).length > 4_000_000
  )
    throw new Error('Keep the complete original saved action and source.');
  const command = parseOrderCommand(value.command);
  if (
    command.type === 'order.warning-settings' ||
    new Set([command.id, value.id, value.replacementId]).size !== 3
  )
    throw new Error('Keep distinct original and review identities.');
  let source: unknown;
  try {
    source = JSON.parse(value.sourceJson);
  } catch {
    throw new Error('Keep the complete original source archive.');
  }
  if (typeof source !== 'object' || source === null)
    throw new Error('Keep the complete original source archive.');
  const request: OrderReviewRequest = {
    id: value.id as string,
    replacementId: value.replacementId as string,
    command,
    sourceHash: value.sourceHash,
    sourceJson: value.sourceJson,
  };
  if (!decision) return request;
  if (
    typeof value.token !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.token) ||
    !['withdrawn', 'replaced'].includes(value.outcome as string)
  )
    throw new Error('Use the selected current review and explicit outcome.');
  return {
    ...request,
    token: value.token,
    outcome: value.outcome as OrderReviewDecision['outcome'],
  };
}
