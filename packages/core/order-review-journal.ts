import {
  parsePreparedOrderReview,
  parseOrderReviewRequest,
  type PreparedOrderReview,
  type OrderReviewRequest,
} from './order-review';
import {
  parseOrderCommandReceipt,
  type OrderCommandReceipt,
} from './order-commands';
import {
  parseCommandResolutionReceipt,
  type CommandResolutionReceipt,
} from './command-resolution';
export type OrderReviewQuote = Omit<PreparedOrderReview, 'token'>;
export type OrderReviewOutcome = 'withdrawn' | 'replaced';
export interface LocalOrderReview {
  id: string;
  version: 1;
  revision: number;
  uploadId: string;
  entryId: string;
  commandIndex: number;
  identityHash: string;
  commandHash: string;
  packet: OrderReviewRequest;
  phase: 'preparing' | 'review' | 'deciding' | 'unconfirmed' | 'confirmed';
  quote: OrderReviewQuote | null;
  quoteHash: string | null;
  choice: OrderReviewOutcome | null;
  attempts: { outcome: OrderReviewOutcome; quoteHash: string; at: number }[];
  receipt: OrderCommandReceipt | CommandResolutionReceipt | null;
}
export const localOrderReviewTableNames = ['orderReviews'] as const;
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const hash = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
export function orderReviewQuote(value: PreparedOrderReview): OrderReviewQuote {
  const { token, ...quote } = value;
  void token;
  return structuredClone(quote);
}
/** A saved quote is display data, never authority. Its server token is omitted;
 * every decision must obtain a fresh server view and compare the exact values. */
export function parseOrderReviewQuote(
  value: unknown,
  packet: OrderReviewRequest,
  commandHash: string,
): OrderReviewQuote {
  if (
    !object(value) ||
    'token' in value ||
    !['businessId', 'outletId', 'actorId'].every((k) => id(value[k]))
  )
    throw Error('Keep the saved review without connection credentials.');
  // Schema validation only: this placeholder is removed and never sent or saved.
  return orderReviewQuote(
    parsePreparedOrderReview(
      { ...value, token: 'x'.repeat(43) },
      packet,
      commandHash,
      {
        businessId: value.businessId as string,
        outletId: value.outletId as string,
        actorId: value.actorId as string,
      },
    ),
  );
}
export function parseLocalOrderReview(value: unknown): LocalOrderReview {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !==
      'attempts,choice,commandHash,commandIndex,entryId,id,identityHash,packet,phase,quote,quoteHash,receipt,revision,uploadId,version' ||
    value.version !== 1 ||
    !hash(value.id) ||
    !hash(value.identityHash) ||
    !hash(value.commandHash) ||
    !id(value.uploadId) ||
    !id(value.entryId) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Number.isSafeInteger(value.commandIndex) ||
    (value.commandIndex as number) < 0 ||
    !['preparing', 'review', 'deciding', 'unconfirmed', 'confirmed'].includes(
      value.phase as string,
    ) ||
    !(
      value.choice === null ||
      ['withdrawn', 'replaced'].includes(value.choice as string)
    ) ||
    !Array.isArray(value.attempts)
  )
    throw Error('Keep the complete saved order review.');
  const packet = parseOrderReviewRequest(value.packet, false),
    quote =
      value.quote === null
        ? null
        : parseOrderReviewQuote(value.quote, packet, value.commandHash);
  if (
    (quote === null) !== (value.quoteHash === null) ||
    (value.quoteHash !== null && !hash(value.quoteHash)) ||
    (['review', 'deciding', 'unconfirmed'].includes(value.phase as string) &&
      !quote) ||
    (['deciding', 'unconfirmed'].includes(value.phase as string) &&
      value.choice === null)
  )
    throw Error('Keep the exact reviewed values and chosen outcome.');
  for (const a of value.attempts)
    if (
      !object(a) ||
      Object.keys(a).sort().join(',') !== 'at,outcome,quoteHash' ||
      !['withdrawn', 'replaced'].includes(a.outcome as string) ||
      !hash(a.quoteHash) ||
      !Number.isSafeInteger(a.at) ||
      (a.at as number) < 0
    )
      throw Error('Keep every original review choice.');
  const receipt =
    value.receipt === null
      ? null
      : object(value.receipt) && value.receipt.type === 'command.resolved'
        ? parseCommandResolutionReceipt(value.receipt, packet.command)
        : parseOrderCommandReceipt(value.receipt, packet.command);
  if ((value.phase === 'confirmed') !== (receipt !== null))
    throw Error('A local choice is not a confirmed server outcome.');
  return {
    ...structuredClone(value),
    packet,
    quote,
    receipt,
  } as unknown as LocalOrderReview;
}
