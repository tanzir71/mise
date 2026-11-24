import { newKitchenId } from '@mise/core/kitchen';
import { parseCloudConnection } from '@mise/core/cloud-connection';
import {
  parseUrgentInboxNotice,
  type UrgentInboxNotice,
} from '@mise/core/urgent-inbox';
import { deskProfileScope, type DeskBinding } from './desk-cache';
import { deskRegistrationFingerprint } from './desk-operation';
import type { DeskSessionOptions } from './desk-session';
import { CommandRequestError } from './command-request';
import { assertDeskReceipt } from './desk-proof';
import { createUrgentInboxRemote } from './urgent-inbox-remote';
import {
  createUrgentInboxCache,
  urgentInboxBaseRegistration,
  urgentInboxGuard,
  urgentInboxProfileMatches,
  type UrgentInboxSnapshot,
} from './urgent-inbox-cache';
import {
  urgentEqual,
  parseUrgentInboxOperation,
  type UrgentInboxOperation,
} from './urgent-inbox-operation';

/** Uses the original verified phone account. Cleanup deliberately does not need
 * a current outlet assignment; it cannot create a new consent or read a task. */
export function createUrgentInboxSession(options: DeskSessionOptions) {
  const { cache, native, account } = options,
    binding = native.binding,
    config = parseCloudConnection(options.config),
    journal = createUrgentInboxCache(cache),
    check = () => urgentInboxGuard(options.check);
  let draining: Promise<void> | null = null,
    again = false;
  function remoteFor(source: DeskBinding) {
    check();
    if (
      source.connection.accountHash !== account.accountHash ||
      source.connection.targetHash !== account.targetHash
    )
      throw new CommandRequestError('auth');
    return createUrgentInboxRemote(
      config,
      account,
      deskProfileScope(source),
      options.send,
    );
  }
  const remote = remoteFor(binding);
  async function current() {
    check();
    const saved = await journal.read(binding);
    if (!saved) throw new CommandRequestError('review');
    return saved;
  }
  async function source(expected: UrgentInboxSnapshot) {
    await native.assert();
    const saved = await current();
    if (
      !urgentEqual(saved.desk.pointer, expected.desk.pointer) ||
      !urgentEqual(saved.desk.profile.binding, expected.desk.profile.binding) ||
      saved.desk.profile.choiceRevision !==
        expected.desk.profile.choiceRevision ||
      saved.profile?.choiceRevision !== expected.profile?.choiceRevision
    )
      throw new CommandRequestError('review');
    const base = await urgentInboxBaseRegistration(cache, saved.desk),
      browser = await options.subscription();
    check();
    if (!browser) throw new CommandRequestError('review');
    const fingerprint = await deskRegistrationFingerprint(browser);
    if (
      base.request.subscriptionHash !== fingerprint.subscriptionHash ||
      base.request.applicationKeyHash !== fingerprint.applicationKeyHash
    )
      throw new CommandRequestError('review');
    await native.assert();
    return { saved, browser };
  }
  async function withdraw() {
    for (const row of await journal.pendingWithdrawals(
      account.accountHash,
      account.targetHash,
    )) {
      check();
      const proof = await remoteFor(row.binding).withdraw(
        row.request.consentId,
        row.id,
      );
      check();
      await journal.confirm(row, proof, check);
    }
  }
  async function confirmOriginal(row: UrgentInboxOperation, proof: object) {
    check();
    try {
      await native.commit((guard) => journal.confirm(row, proof, guard));
    } catch (problem) {
      check();
      let selected = true;
      try {
        await native.assert();
      } catch {
        check();
        selected = false;
      }
      if (selected) throw problem;
      // An actual original outcome remains recoverable after a native switch.
      // This path stores history only, never activation or a different account.
      await journal.confirm(row, proof);
    }
  }
  async function deliver() {
    // Failed/offline withdrawals stop this pass before any fresh registration.
    await withdraw();
    for (const row of await journal.pendingRegistrations(binding)) {
      check();
      if (!urgentEqual(row.binding, binding)) continue;
      const saved = await current();
      if (
        saved.profile?.choiceRevision !== row.id ||
        !urgentInboxProfileMatches(saved.profile, saved.desk)
      )
        continue;
      const actual = await source(saved),
        configuration = await remote.configuration();
      if (actual.browser.applicationKey !== configuration.applicationKey)
        throw new CommandRequestError('review');
      await source(saved);
      // Recheck the journal after HTTP/PushManager awaits; Disable may have run.
      if (
        !(await journal.pendingRegistrations(binding)).some(
          (value) => value.id === row.id,
        )
      )
        continue;
      const proof = await remote.register(
        row.request.consentId,
        row.request.subscriptionId,
        row.id,
      );
      check();
      await confirmOriginal(row, proof);
    }
  }
  return {
    binding,
    journal,
    async configuration() {
      await native.assert();
      const value = await remote.configuration();
      await native.assert();
      return value;
    },
    async enable(expected: UrgentInboxSnapshot) {
      const original = structuredClone(expected),
        eventId = newKitchenId(),
        consentId = newKitchenId(),
        actual = await source(original),
        configuration = await remote.configuration();
      if (actual.browser.applicationKey !== configuration.applicationKey)
        throw new CommandRequestError('review');
      await source(original);
      return native.commit((guard) =>
        journal.queueRegistration(original, eventId, consentId, guard),
      );
    },
    async disable() {
      const saved = await current();
      return native.commit((guard) => journal.disable(saved, guard));
    },
    cleanup: withdraw,
    drain() {
      if (draining) {
        again = true;
        return draining;
      }
      draining = (async () => {
        do {
          again = false;
          await deliver();
        } while (again);
      })().finally(() => {
        draining = null;
      });
      return draining;
    },
    /** A historical immutable result may be recovered after a lost response. It
     * never starts a new registration or substitutes a different phone account. */
    async inspect(value: UrgentInboxOperation) {
      const row = parseUrgentInboxOperation(value);
      if (row.request.kind !== 'register')
        throw new CommandRequestError('review');
      const proof = await remoteFor(row.binding).inspect(
        row.request.consentId,
        row.request.subscriptionId,
        row.id,
      );
      check();
      if (proof.registration === null) return false;
      let selected = false;
      try {
        await native.assert();
        selected = urgentEqual(row.binding, binding);
      } catch {
        check();
      }
      if (selected) await confirmOriginal(row, proof);
      else await journal.confirm(row, proof);
      return true;
    },
    async target(input: UrgentInboxNotice) {
      const notice = parseUrgentInboxNotice(input),
        saved = await current();
      await source(saved);
      if (
        !saved.profile?.enabled ||
        !saved.profile.consent ||
        saved.profile.consent.id !== notice.consentId ||
        saved.profile.subscriptionId !== notice.subscriptionId ||
        !urgentInboxProfileMatches(saved.profile, saved.desk)
      )
        throw new CommandRequestError('review');
      const target = await remote.target(notice);
      await native.assert();
      const latest = await current();
      if (
        !latest.profile?.enabled ||
        latest.profile.choiceRevision !== saved.profile.choiceRevision ||
        !urgentInboxProfileMatches(latest.profile, latest.desk)
      )
        throw new CommandRequestError('review');
      await source(latest);
      assertDeskReceipt(target, {
        accountHash: account.accountHash,
        targetHash: account.targetHash,
        scope: deskProfileScope(binding),
      });
      return target;
    },
  };
}
export type UrgentInboxSession = ReturnType<typeof createUrgentInboxSession>;
