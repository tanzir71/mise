import { isDeviceId } from '@mise/core/device-access';
import {
  parseUrgentInboxRegistration,
  parseUrgentInboxClosure,
  type UrgentInboxRegistration,
  type UrgentInboxClosure,
} from '@mise/core/urgent-inbox';
import {
  parseDeskBinding,
  deskProfileScope,
  type DeskBinding,
} from './desk-cache';

export type UrgentInboxRequest = {
  kind: 'register' | 'withdraw';
  consentId: string;
  subscriptionId: string;
};
export type UrgentInboxReceipt =
  | { action: 'register'; registration: UrgentInboxRegistration }
  | { action: 'withdraw'; closure: UrgentInboxClosure };
export interface UrgentInboxOperation {
  v: 1;
  id: string;
  profileId: string;
  binding: DeskBinding;
  selectionRevision: string;
  baseChoiceRevision: string;
  sequence: number;
  request: UrgentInboxRequest;
  receipt: UrgentInboxReceipt | null;
}
export const urgentObject = (
  value: unknown,
): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const urgentExact = (value: Record<string, unknown>, keys: string) =>
  Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
export const urgentEqual = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export const urgentInvalid = () =>
  Error(
    'Keep the original urgent alert choice and open its notification settings.',
  );
export function urgentInboxProfileId(value: DeskBinding): string {
  const binding = parseDeskBinding(value);
  return (
    'urgent:' +
    binding.connection.targetHash +
    ':' +
    binding.connection.accountHash +
    ':' +
    binding.outletId +
    ':' +
    binding.actorId
  );
}
export function parseUrgentInboxRequest(value: unknown): UrgentInboxRequest {
  if (
    !urgentObject(value) ||
    !urgentExact(value, 'kind,consentId,subscriptionId') ||
    !['register', 'withdraw'].includes(String(value.kind)) ||
    !isDeviceId(value.consentId) ||
    !isDeviceId(value.subscriptionId) ||
    value.consentId === value.subscriptionId
  )
    throw urgentInvalid();
  return {
    kind: value.kind as UrgentInboxRequest['kind'],
    consentId: value.consentId,
    subscriptionId: value.subscriptionId,
  };
}
export function parseUrgentInboxReceipt(
  value: unknown,
  operation: Pick<UrgentInboxOperation, 'id' | 'binding' | 'request'>,
): UrgentInboxReceipt {
  const { request, binding, id } = operation;
  if (!urgentObject(value) || value.action !== request.kind)
    throw urgentInvalid();
  let result: UrgentInboxReceipt;
  if (value.action === 'register' && urgentExact(value, 'action,registration'))
    result = {
      action: 'register',
      registration: parseUrgentInboxRegistration(
        value.registration,
        request.consentId,
        request.subscriptionId,
        id,
      ),
    };
  else if (value.action === 'withdraw' && urgentExact(value, 'action,closure'))
    result = {
      action: 'withdraw',
      closure: parseUrgentInboxClosure(value.closure, request.consentId, id),
    };
  else throw urgentInvalid();
  const consent =
      result.action === 'register'
        ? result.registration.consent
        : result.closure.consent,
    scope = deskProfileScope(binding);
  if (
    consent &&
    (consent.subscriptionId !== request.subscriptionId ||
      !urgentEqual(
        {
          v: consent.v,
          businessId: consent.businessId,
          outletId: consent.outletId,
          memberId: consent.memberId,
          role: consent.role,
        },
        scope,
      ))
  )
    throw urgentInvalid();
  return result;
}
export function parseUrgentInboxOperation(
  value: unknown,
): UrgentInboxOperation {
  if (
    !urgentObject(value) ||
    !urgentExact(
      value,
      'v,id,profileId,binding,selectionRevision,baseChoiceRevision,sequence,request,receipt',
    ) ||
    value.v !== 1 ||
    !isDeviceId(value.id) ||
    !isDeviceId(value.selectionRevision) ||
    !isDeviceId(value.baseChoiceRevision) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1
  )
    throw urgentInvalid();
  const binding = parseDeskBinding(value.binding),
    profileId = urgentInboxProfileId(binding),
    request = parseUrgentInboxRequest(value.request);
  if (
    value.profileId !== profileId ||
    value.id === request.consentId ||
    value.id === request.subscriptionId
  )
    throw urgentInvalid();
  const original = {
    v: 1 as const,
    id: value.id,
    profileId,
    binding,
    selectionRevision: value.selectionRevision,
    baseChoiceRevision: value.baseChoiceRevision,
    sequence: value.sequence as number,
    request,
  };
  return {
    ...original,
    receipt:
      value.receipt === null
        ? null
        : parseUrgentInboxReceipt(value.receipt, original),
  };
}
