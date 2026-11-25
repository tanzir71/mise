import { Link } from 'react-router-dom';
import type { OriginalPaymentTarget } from './data/payment-inspection';

export function PaymentOriginalTarget({
  target,
}: {
  target: OriginalPaymentTarget;
}) {
  return (
    <div className="payment-original-target">
      {target.kind === 'order' ? (
        <>
          <p dir="auto">
            Order {target.number} · {target.customerName}
          </p>
          <Link to={'/orders/' + target.id}>Open actual order</Link>
        </>
      ) : target.kind === 'credit' ? (
        <>
          <p dir="auto">
            {target.name}
            {target.nickname && target.nickname !== target.name
              ? ' · ' + target.nickname
              : ''}
          </p>
          <Link
            to={
              '/khata/' +
              target.id +
              '?currency=' +
              encodeURIComponent(target.currency)
            }
          >
            Open actual customer account
          </Link>
        </>
      ) : (
        <>
          <p dir="auto">{target.who || 'No customer name recorded'}</p>
          <p dir="auto">
            {target.shopName}
            {target.outletName ? ' · ' + target.outletName : ''}
          </p>
          <Link to="/counter">Open counter receipts</Link>
        </>
      )}
    </div>
  );
}
