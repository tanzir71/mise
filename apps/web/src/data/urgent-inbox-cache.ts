import { isDeviceId } from '@mise/core/device-access';
import { newKitchenId } from '@mise/core/kitchen';
import {
  parseUrgentInboxConsent,
  type UrgentInboxConsent,
} from '@mise/core/urgent-inbox';
import {
  DeskCacheError,
  parseDeskBinding,
  deskProfileScope,
  type DeskCache,
  type DeskBinding,
  type DeskSnapshot,
} from './desk-cache';
import { assertDeskReceipt } from './desk-proof';
import {
  urgentInboxProfileId,
  parseUrgentInboxOperation,
  parseUrgentInboxReceipt,
  urgentObject,
  urgentExact,
  urgentEqual,
  urgentInvalid,
  type UrgentInboxOperation,
} from './urgent-inbox-operation';

export interface UrgentInboxProfile {
  v: 1;
  id: string;
  revision: string;
  choiceRevision: string;
  binding: DeskBinding;
  selectionRevision: string;
  baseChoiceRevision: string;
  subscriptionId: string;
  enabled: boolean;
  consent: UrgentInboxConsent | null;
}
export interface UrgentInboxSnapshot {
  desk: DeskSnapshot;
  profile: UrgentInboxProfile | null;
}
// Reserve one withdrawal for every admitted original setup. Never evict a
// possibly delivered action to make room for a fresh positive choice.
export const urgentInboxSetupLimit = 500;
const identity = (binding: DeskBinding) => ({
  accountHash: binding.connection.accountHash,
  targetHash: binding.connection.targetHash,
  scope: deskProfileScope(binding),
});
export function urgentInboxGuard(guard: () => void): void {
  const result: unknown = guard();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    throw new DeskCacheError('changed');
  }
}
export function parseUrgentInboxProfile(value: unknown): UrgentInboxProfile {
  if (
    !urgentObject(value) ||
    !urgentExact(
      value,
      'v,id,revision,choiceRevision,binding,selectionRevision,baseChoiceRevision,subscriptionId,enabled,consent',
    ) ||
    value.v !== 1 ||
    ![
      value.revision,
      value.choiceRevision,
      value.selectionRevision,
      value.baseChoiceRevision,
      value.subscriptionId,
    ].every(isDeviceId) ||
    typeof value.enabled !== 'boolean'
  )
    throw urgentInvalid();
  const binding = parseDeskBinding(value.binding),
    id = urgentInboxProfileId(binding),
    consent =
      value.consent === null ? null : parseUrgentInboxConsent(value.consent),
    scope = deskProfileScope(binding);
  if (
    value.id !== id ||
    (consent &&
      (consent.subscriptionId !== value.subscriptionId ||
        !urgentEqual(
          {
            v: consent.v,
            businessId: consent.businessId,
            outletId: consent.outletId,
            memberId: consent.memberId,
            role: consent.role,
          },
          scope,
        ))) ||
    (value.enabled && (!consent || consent.revokedAt !== null))
  )
    throw urgentInvalid();
  return {
    v: 1,
    id,
    revision: value.revision as string,
    choiceRevision: value.choiceRevision as string,
    binding,
    selectionRevision: value.selectionRevision as string,
    baseChoiceRevision: value.baseChoiceRevision as string,
    subscriptionId: value.subscriptionId as string,
    enabled: value.enabled,
    consent,
  };
}
/** Durable base registration provenance, not a fresh permission grant. Each
 * caller also checks native selection and the actual PushManager fingerprint. */
export async function urgentInboxBaseRegistration(
  cache: DeskCache,
  desk: DeskSnapshot,
  now = Date.now(),
) {
  const { profile, pointer } = desk,
    sub = profile.subscription;
  if (
    pointer.profileId !== profile.id ||
    !profile.enabled ||
    !sub ||
    sub.revokedAt !== null ||
    (sub.expiresAt !== null && sub.expiresAt <= now)
  )
    throw new DeskCacheError('changed');
  const rows = await cache.operationHistory(profile.binding),
    row = rows.find((value) => value.id === profile.choiceRevision);
  if (
    !row ||
    !urgentEqual(row.binding, profile.binding) ||
    row.selectionRevision !== pointer.revision ||
    row.request.kind !== 'register' ||
    row.request.subscriptionId !== sub.id ||
    row.receipt?.action !== 'register' ||
    row.receipt.subscription.id !== sub.id ||
    !urgentEqual(row.receipt.subscription, sub) ||
    rows.some(
      (value) =>
        value.request.kind === 'revoke' &&
        value.request.subscriptionId === sub.id,
    )
  )
    throw new DeskCacheError('changed');
  return row as typeof row & {
    request: Extract<typeof row.request, { kind: 'register' }>;
  };
}
export function urgentInboxProfileMatches(
  profile: UrgentInboxProfile,
  desk: DeskSnapshot,
): boolean {
  return (
    urgentEqual(profile.binding, desk.profile.binding) &&
    profile.selectionRevision === desk.pointer.revision &&
    profile.baseChoiceRevision === desk.profile.choiceRevision &&
    profile.subscriptionId === desk.profile.subscription?.id
  );
}

/** Shares the base cache's IDB transaction. Switching the operator, replacing a
 * browser registration and a competing Disable all serialize against a choice. */
export function createUrgentInboxCache(cache: DeskCache) {
  const tables = [
    cache.active,
    cache.profiles,
    cache.operations,
    cache.urgentProfiles,
    cache.urgentOperations,
  ];
  async function profile(binding: DeskBinding) {
    const raw = await cache.urgentProfiles.get(urgentInboxProfileId(binding));
    return raw === undefined ? null : parseUrgentInboxProfile(raw);
  }
  async function history(binding: DeskBinding) {
    return (
      await cache.urgentOperations
        .where('profileId')
        .equals(urgentInboxProfileId(binding))
        .toArray()
    )
      .map(parseUrgentInboxOperation)
      .sort((a, b) => a.sequence - b.sequence);
  }
  async function current(expected: UrgentInboxSnapshot) {
    const desk = await cache.read(expected.desk.profile.binding),
      saved = await profile(expected.desk.profile.binding);
    if (
      !desk ||
      !urgentEqual(desk.pointer, expected.desk.pointer) ||
      !urgentEqual(desk.profile.binding, expected.desk.profile.binding) ||
      desk.profile.choiceRevision !== expected.desk.profile.choiceRevision ||
      saved?.choiceRevision !== expected.profile?.choiceRevision
    )
      throw new DeskCacheError('changed');
    return { desk, profile: saved };
  }
  async function withdrawAll(binding: DeskBinding, guard: () => void) {
    const all = await history(binding),
      withdrawals: UrgentInboxOperation[] = [];
    let sequence = all.at(-1)?.sequence ?? 0;
    for (const row of all) {
      if (row.request.kind !== 'register') continue;
      const earlier = all.find(
        (value) =>
          value.request.kind === 'withdraw' &&
          value.request.consentId === row.request.consentId,
      );
      if (earlier) {
        if (!earlier.receipt) withdrawals.push(earlier);
        continue;
      }
      let id = newKitchenId();
      while (id === row.request.consentId || id === row.request.subscriptionId)
        id = newKitchenId();
      const next = parseUrgentInboxOperation({
        ...row,
        id,
        sequence: ++sequence,
        request: { ...row.request, kind: 'withdraw' },
        receipt: null,
      });
      urgentInboxGuard(guard);
      await cache.urgentOperations.add(next);
      withdrawals.push(next);
    }
    urgentInboxGuard(guard);
    return withdrawals;
  }
  async function mute(saved: UrgentInboxProfile, guard: () => void) {
    const withdrawals = await withdrawAll(saved.binding, guard);
    urgentInboxGuard(guard);
    await cache.urgentProfiles.put({
      ...saved,
      revision: newKitchenId(),
      choiceRevision: newKitchenId(),
      enabled: false,
    });
    urgentInboxGuard(guard);
    return withdrawals;
  }
  return {
    async read(value: DeskBinding): Promise<UrgentInboxSnapshot | null> {
      const binding = parseDeskBinding(value);
      return cache.transaction('r', tables, async () => {
        const desk = await cache.read(binding);
        return desk ? { desk, profile: await profile(binding) } : null;
      });
    },
    history,
    async pendingWithdrawals(accountHash: string, targetHash: string) {
      if (
        !/^[a-f0-9]{64}$/.test(accountHash) ||
        !/^[a-f0-9]{64}$/.test(targetHash)
      )
        throw urgentInvalid();
      return (await cache.urgentOperations.toArray())
        .map(parseUrgentInboxOperation)
        .filter(
          (row) =>
            row.request.kind === 'withdraw' &&
            !row.receipt &&
            row.binding.connection.accountHash === accountHash &&
            row.binding.connection.targetHash === targetHash,
        )
        .sort(
          (a, b) =>
            a.profileId.localeCompare(b.profileId) || a.sequence - b.sequence,
        );
    },
    async pendingRegistrations(binding: DeskBinding) {
      const all = await history(binding),
        closed = new Set(
          all
            .filter((row) => row.request.kind === 'withdraw')
            .map((row) => row.request.consentId),
        );
      return all.filter(
        (row) =>
          row.request.kind === 'register' &&
          !row.receipt &&
          !closed.has(row.request.consentId),
      );
    },
    async savedSetups() {
      return cache.transaction(
        'r',
        cache.urgentProfiles,
        cache.urgentOperations,
        async () => {
          const profiles = (await cache.urgentProfiles.toArray()).map(
            parseUrgentInboxProfile,
          );
          return Promise.all(
            profiles.map(async (saved) => {
              const all = await history(saved.binding),
                closed = new Set(
                  all
                    .filter((row) => row.request.kind === 'withdraw')
                    .map((row) => row.request.consentId),
                );
              return {
                profile: saved,
                openSetups: all.filter(
                  (row) =>
                    row.request.kind === 'register' &&
                    !closed.has(row.request.consentId),
                ).length,
                pendingWithdrawals: all.filter(
                  (row) => row.request.kind === 'withdraw' && !row.receipt,
                ).length,
              };
            }),
          );
        },
      );
    },
    async queueRegistration(
      expected: UrgentInboxSnapshot,
      eventId: string,
      consentId: string,
      guard: () => void,
    ): Promise<UrgentInboxOperation> {
      // Snapshot before awaiting IDB; callers cannot change original request IDs.
      const original = structuredClone(expected),
        binding = original.desk.profile.binding;
      if (
        !isDeviceId(eventId) ||
        !isDeviceId(consentId) ||
        eventId === consentId
      )
        throw urgentInvalid();
      urgentInboxGuard(guard);
      return cache.transaction('rw', tables, async () => {
        const existing = await cache.urgentOperations.get(eventId);
        if (existing !== undefined) {
          const saved = parseUrgentInboxOperation(existing);
          if (
            !urgentEqual(saved.binding, binding) ||
            saved.selectionRevision !== original.desk.pointer.revision ||
            saved.baseChoiceRevision !== original.desk.profile.choiceRevision ||
            !urgentEqual(saved.request, {
              kind: 'register',
              consentId,
              subscriptionId: original.desk.profile.subscription?.id,
            })
          )
            throw urgentInvalid();
          urgentInboxGuard(guard);
          return saved;
        }
        const { desk } = await current(original),
          base = await urgentInboxBaseRegistration(cache, desk),
          all = await history(binding),
          request = {
            kind: 'register' as const,
            consentId,
            subscriptionId: base.request.subscriptionId,
          };
        if (
          eventId === request.subscriptionId ||
          consentId === request.subscriptionId
        )
          throw urgentInvalid();
        if (all.some((row) => row.request.consentId === consentId))
          throw urgentInvalid();
        if (
          all.filter((row) => row.request.kind === 'register').length >=
          urgentInboxSetupLimit
        )
          throw Error(
            'This browser has reached its urgent alert setup limit. Existing withdrawals are still available. Keep its original notification history.',
          );
        await withdrawAll(binding, guard);
        const sequence = (await history(binding)).at(-1)?.sequence ?? 0;
        const saved = parseUrgentInboxOperation({
          v: 1,
          id: eventId,
          profileId: urgentInboxProfileId(binding),
          binding,
          selectionRevision: desk.pointer.revision,
          baseChoiceRevision: desk.profile.choiceRevision,
          sequence: sequence + 1,
          request,
          receipt: null,
        });
        urgentInboxGuard(guard);
        await cache.urgentOperations.add(saved);
        const next: UrgentInboxProfile = {
          v: 1,
          id: saved.profileId,
          revision: newKitchenId(),
          choiceRevision: saved.id,
          binding,
          selectionRevision: saved.selectionRevision,
          baseChoiceRevision: saved.baseChoiceRevision,
          subscriptionId: request.subscriptionId,
          enabled: false,
          consent: null,
        };
        urgentInboxGuard(guard);
        await cache.urgentProfiles.put(next);
        urgentInboxGuard(guard);
        return saved;
      });
    },
    async disable(expected: UrgentInboxSnapshot, guard: () => void) {
      const original = structuredClone(expected);
      urgentInboxGuard(guard);
      return cache.transaction('rw', tables, async () => {
        const saved = await current(original);
        if (saved.profile) return mute(saved.profile, guard);
        const binding = saved.desk.profile.binding,
          withdrawals = await withdrawAll(binding, guard),
          subscriptionId = saved.desk.profile.subscription?.id;
        // No must also fence an Enable still awaiting configuration, before
        // that first positive intent has reached the journal. A missing base
        // capability already prevents that original base choice from enabling.
        if (subscriptionId) {
          const off: UrgentInboxProfile = {
            v: 1,
            id: urgentInboxProfileId(binding),
            revision: newKitchenId(),
            choiceRevision: newKitchenId(),
            binding,
            selectionRevision: saved.desk.pointer.revision,
            baseChoiceRevision: saved.desk.profile.choiceRevision,
            subscriptionId,
            enabled: false,
            consent: null,
          };
          urgentInboxGuard(guard);
          await cache.urgentProfiles.put(off);
        }
        urgentInboxGuard(guard);
        return withdrawals;
      });
    },
    /** Personal cleanup never selects an earlier outlet or grants fresh access. */
    async withdrawProfile(value: UrgentInboxProfile, guard: () => void) {
      const original = parseUrgentInboxProfile(value);
      urgentInboxGuard(guard);
      return cache.transaction(
        'rw',
        cache.urgentProfiles,
        cache.urgentOperations,
        async () => {
          const saved = await profile(original.binding);
          if (
            !saved ||
            saved.choiceRevision !== original.choiceRevision ||
            !urgentEqual(saved.binding, original.binding)
          )
            throw new DeskCacheError('changed');
          return mute(saved, guard);
        },
      );
    },
    async confirm(
      value: UrgentInboxOperation,
      proof: object,
      guard?: () => void,
    ): Promise<UrgentInboxOperation> {
      const original = parseUrgentInboxOperation(value),
        receipt = parseUrgentInboxReceipt(proof, original),
        check = () => {
          if (guard) urgentInboxGuard(guard);
          assertDeskReceipt(proof, identity(original.binding));
        };
      check();
      return cache.transaction('rw', tables, async () => {
        const saved = parseUrgentInboxOperation(
          await cache.urgentOperations.get(original.id),
        );
        if (
          !urgentEqual(
            { ...saved, receipt: null },
            { ...original, receipt: null },
          ) ||
          (saved.receipt && !urgentEqual(saved.receipt, receipt))
        )
          throw new DeskCacheError('changed');
        if (saved.receipt) {
          check();
          return saved;
        }
        const currentProfile = await profile(original.binding),
          desk = await cache.read(original.binding);
        let next: UrgentInboxProfile | null = null;
        if (
          currentProfile &&
          receipt.action === 'withdraw' &&
          currentProfile.consent?.id === receipt.closure.id
        )
          next = {
            ...currentProfile,
            revision: newKitchenId(),
            enabled: false,
            consent: receipt.closure.consent,
          };
        if (
          currentProfile &&
          guard &&
          receipt.action === 'register' &&
          currentProfile.choiceRevision === original.id &&
          desk &&
          urgentInboxProfileMatches(currentProfile, desk) &&
          urgentEqual(currentProfile.binding, original.binding)
        ) {
          let validBase = true;
          try {
            await urgentInboxBaseRegistration(cache, desk);
          } catch (problem) {
            if (problem instanceof DeskCacheError && problem.kind === 'changed')
              validBase = false;
            else throw problem;
          }
          const all = await history(original.binding);
          if (
            validBase &&
            !all.some(
              (row) =>
                row.request.kind === 'withdraw' &&
                (row.request.consentId === original.request.consentId ||
                  !row.receipt),
            )
          )
            next = {
              ...currentProfile,
              revision: newKitchenId(),
              enabled: true,
              consent: receipt.registration.consent,
            };
        }
        if (next) {
          check();
          await cache.urgentProfiles.put(next);
        }
        const confirmed = { ...saved, receipt };
        check();
        await cache.urgentOperations.put(confirmed);
        check();
        return confirmed;
      });
    },
  };
}
export type UrgentInboxCache = ReturnType<typeof createUrgentInboxCache>;
