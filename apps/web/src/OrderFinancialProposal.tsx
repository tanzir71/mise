import { formatMoney } from '@mise/core/money';
import type { OrderReviewQuote } from '@mise/core/order-review-journal';
const labels = {
  payment: 'Record payment',
  payment_reversed: 'Reverse payment record',
  refund: 'Record refund',
  refund_reversed: 'Undo refund',
};
/** These amounts come from the same proposed records as the guarded SQL write. */
export function OrderFinancialProposal({ quote }: { quote: OrderReviewQuote }) {
  const proposal = quote.proposal;
  if (!proposal.enabled) return null;
  return (
    <section aria-label="Reviewed financial changes">
      <h4>Changes if applied</h4>
      {proposal.effects.length ? (
        <ul className="order-review-effects">
          {proposal.effects.map((effect, index) => (
            <li key={effect.kind + index}>
              {labels[effect.kind]}:{' '}
              <span className="money">
                {formatMoney(effect.amount, effect.currency)}
              </span>{' '}
              · {effect.methodName || effect.method}
            </li>
          ))}
        </ul>
      ) : null}
      <dl className="order-review-after">
        {proposal.creditBalance !== null ? (
          <div>
            <dt>
              Khata balance after this action ({quote.current.creditCurrency})
            </dt>
            <dd className="money">
              {formatMoney(
                proposal.creditBalance,
                quote.current.creditCurrency!,
              )}
            </dd>
          </div>
        ) : null}
        {proposal.refundDue > 0 || quote.current.order?.payment.cancellation ? (
          <div>
            <dt>Refund still owed after this action ({proposal.currency})</dt>
            <dd className="money">
              {formatMoney(proposal.refundDue, proposal.currency)}
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
