import { useId, useState } from 'react';
import { Button } from '@mise/ui/primitives.tsx';
import type { Payment, SetupSnapshot } from '@mise/core/models';
import type { ParsedPaymentText } from '@mise/core/payments';
import { paymentWallTime, parsePaymentWallTime } from '@mise/core/payments';
import { moneyInputValue, parseMoney } from '@mise/core/money';
import { normalisePhone } from '@mise/core/phone';
import { marketPacks } from '@mise/core/packs';
import type { CheckedPaymentInput } from '@mise/core/payment-records';
import { errorText } from './khata-data';

// Preserve a known original instant when native inputs normalize its unchanged
// local fields. Changed wall times still use the strict gap/fold parser.
function canonicalWallFields(value: string): string | null {
  const m =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
      value,
    );
  return m
    ? m[1] + ':' + (m[2] ?? '00') + '.' + (m[3] ?? '').padEnd(3, '0')
    : null;
}

export function PaymentCheckedForm({
  setup,
  parsed,
  payment,
  disabled,
  onSave,
  onCancel,
}: {
  setup: SetupSnapshot;
  parsed: ParsedPaymentText;
  payment?: Payment;
  disabled: boolean;
  onSave: (input: CheckedPaymentInput) => Promise<void>;
  onCancel?: () => void;
}) {
  const bankHint = useId(),
    phoneHint = useId();
  const currency = payment?.currency ?? parsed.currency,
    zone = parsed.sourceContext.timeZone,
    originalReceivedAt = payment?.receivedAt ?? parsed.receivedAt,
    originalWall = paymentWallTime(originalReceivedAt, zone);
  const [amount, setAmount] = useState(() => {
    const n = payment?.amount ?? parsed.amount;
    return n === null ? '' : moneyInputValue(n, currency);
  });
  const [method, setMethod] = useState(
    payment?.methodName ??
      (parsed.channel === 'bkash'
        ? 'bKash'
        : parsed.channel === 'nagad'
          ? 'Nagad'
          : parsed.channel === 'bank'
            ? 'Bank transfer'
            : 'Cash'),
  );
  const [reference, setReference] = useState(
      payment?.reference ?? parsed.reference ?? '',
    ),
    [scope, setScope] = useState(payment?.referenceScope ?? ''),
    [phone, setPhone] = useState(payment?.fromPhone ?? parsed.fromPhone ?? ''),
    [received, setReceived] = useState(() => originalWall),
    [checked, setChecked] = useState(false),
    [error, setError] = useState('');
  const wallets = [
    ...new Set([
      ...marketPacks[setup.business.marketCode]['pay/wallets'],
      ...(parsed.sourceContext.market
        ? marketPacks[parsed.sourceContext.market]['pay/wallets']
        : []),
      'Cash',
      'Card',
      'Bank transfer',
      ...(payment ? [payment.methodName] : []),
    ]),
  ];
  async function save() {
    setError('');
    try {
      const value = parseMoney(amount, currency);
      if (value === null || value <= 0)
        throw Error('Enter the positive amount received.');
      const fromPhone = phone.trim()
        ? normalisePhone(phone, setup.business.marketCode)
        : undefined;
      if (fromPhone === null)
        throw Error(
          'Enter a complete phone number, or leave it blank. Never expand a masked number.',
        );
      if (!checked)
        throw Error('Check the details against the original source.');
      await onSave({
        checked: true,
        amount: value,
        currency,
        method:
          method === 'Cash' ? 'cash' : method === 'Card' ? 'card' : 'wallet',
        methodName: method,
        reference,
        receivedAt:
          canonicalWallFields(received) === originalWall
            ? originalReceivedAt
            : parsePaymentWallTime(received, zone),
        ...(method === 'Bank transfer' && scope.trim()
          ? { referenceScope: scope }
          : {}),
        ...(fromPhone ? { fromPhone } : {}),
      });
    } catch (problem) {
      setError(errorText(problem));
    }
  }
  return (
    <form
      className="payment-checked"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset disabled={disabled}>
        <legend>
          {payment ? 'Edit checked details' : 'Check the payment details'}
        </legend>
        <p>
          {parsed.status === 'manual'
            ? 'This format needs manual entry. Any amount found is only a starting point.'
            : 'Mise found payment details. Check them against the original.'}{' '}
          Saving these details records no money.
        </p>
        {parsed.warnings.length ? (
          <ul className="payment-warnings">
            {parsed.warnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        ) : null}
        <label className="inbox-field">
          Amount received ({currency})
          <input
            inputMode="decimal"
            required
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              setChecked(false);
            }}
          />
        </label>
        <label className="inbox-field">
          Payment method
          <select
            value={method}
            onChange={(event) => {
              setMethod(event.target.value);
              setChecked(false);
            }}
          >
            {wallets.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        {method === 'Bank transfer' ? (
          <>
            <label className="inbox-field">
              Bank or source label
              <input
                maxLength={120}
                aria-describedby={bankHint}
                value={scope}
                onChange={(event) => {
                  setScope(event.target.value);
                  setChecked(false);
                }}
              />
            </label>
            <small id={bankHint}>
              Your installation's label for this bank. It does not verify a
              transfer.
            </small>
          </>
        ) : null}
        <label className="inbox-field">
          Transaction reference (optional)
          <input
            maxLength={120}
            autoComplete="off"
            value={reference}
            onChange={(event) => {
              setReference(event.target.value);
              setChecked(false);
            }}
          />
        </label>
        <label className="inbox-field">
          Sender phone (optional)
          <input
            type="tel"
            aria-describedby={phoneHint}
            value={phone}
            onChange={(event) => {
              setPhone(event.target.value);
              setChecked(false);
            }}
          />
        </label>
        <small id={phoneHint}>Leave masked numbers blank.</small>
        <label className="inbox-field">
          Received time ({zone})
          <input
            type="datetime-local"
            step="0.001"
            required
            value={received}
            onChange={(event) => {
              setReceived(event.target.value);
              setChecked(false);
            }}
          />
        </label>
        {parsed.timeSource === 'capture' ? (
          <p>
            The original had no unambiguous received time. The saved-source time
            is prefilled; check and correct it.
          </p>
        ) : null}
        <label className="payment-check">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
          />
          I checked the amount, method and received time against the original
          source
        </label>
      </fieldset>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      <div className="payment-actions">
        <Button type="submit" disabled={disabled || !checked}>
          {payment ? 'Save checked changes' : 'Save checked details'}
        </Button>
        {onCancel ? (
          <Button
            kind="secondary"
            type="button"
            disabled={disabled}
            onClick={onCancel}
          >
            Keep saved details
          </Button>
        ) : null}
      </div>
    </form>
  );
}
