import { Card } from '@mise/ui/primitives.tsx';
import { formatMoney } from '@mise/core/money';
import { ownerTaskText } from '@mise/core/owner-tasks';
import type { SavedPaymentSource } from './data/payment-source-journal';
const labels = {
  capture: 'Record observed payment',
  link: 'Match recorded receipt',
  dismiss: 'Dismiss source',
  undo: 'Undo last payment review',
};
export function PaymentRequestSource({
  row,
  index,
}: {
  row: SavedPaymentSource;
  index?: number;
}) {
  const intent = row.intent,
    source = intent.type === 'capture' ? intent : row.source,
    target = intent.type === 'link' ? intent.target : null;
  return (
    <Card className="owner-task-card payment-saved-request">
      <header>
        <span>
          {index === undefined ? 'Original request' : `Original ${index + 1}`} ·{' '}
          {row.receipt?.state ?? 'unconfirmed'}
        </span>
      </header>
      <h3>{labels[intent.type]}</h3>
      <p>
        {row.closeRequested
          ? 'Closure saved on this device'
          : row.receipt?.state === 'applied'
            ? 'Recorded'
            : row.receipt?.state === 'closed'
              ? 'Closed'
              : 'Unconfirmed'}
      </p>
      <details>
        <summary>Complete saved source</summary>
        <dl className="owner-task-saved-source">
          {source ? (
            <>
              <div>
                <dt>Amount observed</dt>
                <dd>
                  {formatMoney(source.amount, source.currency)} ·{' '}
                  {ownerTaskText(source.methodNameJson, 80)}
                </dd>
              </div>
              <div>
                <dt>Original details</dt>
                <dd dir="auto">{ownerTaskText(source.sourceJson, 16000)}</dd>
              </div>
              <div>
                <dt>Reference</dt>
                <dd dir="auto">
                  {ownerTaskText(source.referenceJson, 4000) || 'None recorded'}
                </dd>
              </div>
              {source.fromPhone ? (
                <div>
                  <dt>From</dt>
                  <dd>{source.fromPhone}</dd>
                </div>
              ) : null}
              <div>
                <dt>Received</dt>
                <dd>{new Date(source.receivedAt).toLocaleString()}</dd>
              </div>
            </>
          ) : null}
          {target ? (
            <div>
              <dt>Selected recorded receipt</dt>
              <dd>
                {ownerTaskText(target.labelJson, 4000)} ·{' '}
                {formatMoney(target.amount, target.currency)} ·{' '}
                {new Date(target.at).toLocaleString()} · Receipt{' '}
                {target.financialId.slice(-6)}
              </dd>
            </div>
          ) : null}
          {intent.type === 'dismiss' ? (
            <div>
              <dt>Review reason</dt>
              <dd dir="auto">{ownerTaskText(intent.reasonJson, 4000)}</dd>
            </div>
          ) : null}
          <div>
            <dt>Request saved</dt>
            <dd>{new Date(intent.at).toLocaleString()}</dd>
          </div>
        </dl>
      </details>
    </Card>
  );
}
