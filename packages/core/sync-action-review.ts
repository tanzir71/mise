/** A local observation of a rejected request, never a receipt or permission to
 * replace, discard or replay its original financial action. */
export interface SyncActionReview {
  id: string;
  version: 1;
  uploadId: string;
  entryId: string;
  commandId: string;
  businessId: string;
  outletId: string;
  actorId: string;
  targetHash: string;
  accountHash: string;
  identityHash: string;
  sourceHash: string;
  commandHash: string;
  receiptsHash: string;
  commandIndex: number;
  sequence: number;
  status: 400 | 409 | 413 | 415;
  firstObservedAt: number;
  lastObservedAt: number;
  observations: number;
  confirmedAt: number | null;
  receiptHash: string | null;
}
export const localActionReviewTableNames = ['syncActionReviews'] as const;
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const hash = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const count = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const time = (v: unknown): v is number => count(v) && v <= 8640000000000000;
export function parseSyncActionReview(value: unknown): SyncActionReview {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !==
      'accountHash,actorId,businessId,commandHash,commandId,commandIndex,confirmedAt,entryId,firstObservedAt,id,identityHash,lastObservedAt,observations,outletId,receiptHash,receiptsHash,sequence,sourceHash,status,targetHash,uploadId,version' ||
    value.version !== 1 ||
    ![
      'id',
      'targetHash',
      'accountHash',
      'identityHash',
      'sourceHash',
      'commandHash',
      'receiptsHash',
    ].every((k) => hash(value[k])) ||
    ![
      'uploadId',
      'entryId',
      'commandId',
      'businessId',
      'outletId',
      'actorId',
    ].every((k) => id(value[k])) ||
    !count(value.commandIndex) ||
    !count(value.sequence) ||
    !value.sequence ||
    ![400, 409, 413, 415].includes(value.status as number) ||
    !time(value.firstObservedAt) ||
    !time(value.lastObservedAt) ||
    value.lastObservedAt < value.firstObservedAt ||
    !count(value.observations) ||
    !value.observations ||
    !(value.confirmedAt === null
      ? value.receiptHash === null
      : time(value.confirmedAt) &&
        value.confirmedAt >= value.lastObservedAt &&
        hash(value.receiptHash))
  )
    throw new Error('Keep the original saved action review and its source.');
  return structuredClone(value) as unknown as SyncActionReview;
}
