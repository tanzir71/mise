import {
  parseCloudConnection,
  type CloudConnection,
} from '@mise/core/cloud-connection';
import { isDeviceId } from '@mise/core/device-access';
import {
  parseDeskPushContext,
  parseDeskApplicationKey,
  type DeskPushContext,
} from '@mise/core/desk-push';
import {
  parseUrgentInboxConsent,
  parseUrgentInboxRegistration,
  parseUrgentInboxClosure,
  parseUrgentInboxNotice,
  parseUrgentInboxTarget,
  type UrgentInboxNotice,
} from '@mise/core/urgent-inbox';
import {
  CommandRequestError,
  createUrgentInboxNotificationsRequest,
  type CommandAccount,
} from './command-request';
import { bindDeskReceipt } from './desk-proof';
import {
  urgentObject,
  urgentExact,
  urgentEqual,
} from './urgent-inbox-operation';

/** The end user's saved connection is the sole backend target. No service key,
 * provider setting, endpoint from a notification, or alternate RPC is accepted. */
export function createUrgentInboxRemote(
  input: CloudConnection,
  account: CommandAccount,
  scope: DeskPushContext,
  send: typeof fetch = fetch,
) {
  const config = parseCloudConnection(input),
    expected = parseDeskPushContext(scope),
    request = createUrgentInboxNotificationsRequest(config, account, send),
    identity = {
      accountHash: account.accountHash,
      targetHash: account.targetHash,
      scope: expected,
    };
  const checked = <T extends object>(value: T, guard: () => void) =>
    bindDeskReceipt(value, guard, identity);
  const own = (value: unknown) => {
    const consent = parseUrgentInboxConsent(value);
    if (
      !urgentEqual(
        {
          v: consent.v,
          businessId: consent.businessId,
          outletId: consent.outletId,
          memberId: consent.memberId,
          role: consent.role,
        },
        expected,
      )
    )
      throw new CommandRequestError('review');
    return consent;
  };
  const call = (body: unknown, signal?: AbortSignal) =>
    request(
      JSON.stringify(body),
      { 'Content-Type': 'application/json' },
      10000,
      signal,
    );
  function original(id: string, subscriptionId: string, eventId: string) {
    if (
      ![id, subscriptionId, eventId].every(isDeviceId) ||
      new Set([id, subscriptionId, eventId]).size !== 3
    )
      throw new CommandRequestError('review');
    return { id, subscriptionId, eventId };
  }
  return {
    async configuration(signal?: AbortSignal) {
      const response = await call(
          { action: 'configuration', outletId: expected.outletId },
          signal,
        ),
        value = response.value;
      if (
        !urgentObject(value) ||
        !urgentExact(value, 'v,context,applicationKey') ||
        value.v !== 1 ||
        !urgentEqual(parseDeskPushContext(value.context), expected)
      )
        throw new CommandRequestError('review');
      return checked(
        {
          v: 1 as const,
          context: expected,
          applicationKey: parseDeskApplicationKey(value.applicationKey),
        },
        response.guard,
      );
    },
    async register(
      id: string,
      subscriptionId: string,
      eventId: string,
      signal?: AbortSignal,
    ) {
      const source = original(id, subscriptionId, eventId),
        response = await call({ action: 'register', ...source }, signal),
        consent = own(response.value);
      if (
        consent.id !== source.id ||
        consent.subscriptionId !== source.subscriptionId ||
        consent.revokedAt !== null
      )
        throw new CommandRequestError('review');
      // Register returns current metadata. Only inspect identifies the immutable
      // original event; never manufacture that receipt from the caller's IDs.
      const inspected = await call({ action: 'inspect', ...source }, signal);
      if (inspected.value === null) throw new CommandRequestError('retry');
      const registration = parseUrgentInboxRegistration(
        inspected.value,
        source.id,
        source.subscriptionId,
        source.eventId,
      );
      own(registration.consent);
      if (!urgentEqual(registration.consent, consent))
        throw new CommandRequestError('review');
      return checked({ action: 'register' as const, registration }, () => {
        response.guard();
        inspected.guard();
      });
    },
    async inspect(
      id: string,
      subscriptionId: string,
      eventId: string,
      signal?: AbortSignal,
    ) {
      const source = original(id, subscriptionId, eventId),
        response = await call({ action: 'inspect', ...source }, signal);
      if (response.value === null)
        return checked({ registration: null }, response.guard);
      const registration = parseUrgentInboxRegistration(
        response.value,
        source.id,
        source.subscriptionId,
        source.eventId,
      );
      own(registration.consent);
      return checked(
        { action: 'register' as const, registration },
        response.guard,
      );
    },
    async read(id: string, signal?: AbortSignal) {
      if (!isDeviceId(id)) throw new CommandRequestError('review');
      const response = await call({ action: 'read', id }, signal),
        consent = response.value === null ? null : own(response.value);
      if (consent && consent.id !== id) throw new CommandRequestError('review');
      return checked({ id, consent }, response.guard);
    },
    async withdraw(id: string, eventId: string, signal?: AbortSignal) {
      if (!isDeviceId(id) || !isDeviceId(eventId) || id === eventId)
        throw new CommandRequestError('review');
      const source = { id, eventId },
        response = await call({ action: 'withdraw', ...source }, signal),
        closure = parseUrgentInboxClosure(
          response.value,
          source.id,
          source.eventId,
        );
      if (closure.consent) own(closure.consent);
      return checked({ action: 'withdraw' as const, closure }, response.guard);
    },
    async target(input: UrgentInboxNotice, signal?: AbortSignal) {
      const notice = parseUrgentInboxNotice(input);
      if (
        notice.businessId !== expected.businessId ||
        notice.outletId !== expected.outletId
      )
        throw new CommandRequestError('review');
      const response = await call({ action: 'target', notice }, signal),
        target = parseUrgentInboxTarget(response.value, notice);
      if (!urgentEqual(target.scope, expected))
        throw new CommandRequestError('review');
      return checked(target, response.guard);
    },
  };
}
