import type { CloudConnection, KeyStorage } from '@mise/core/cloud-connection';
import {
  customerLinkId,
  parseCustomerLinkJournal,
  parseCustomerLinkMetadata,
  parseCustomerLinkScope,
  parseCustomerLinkSource,
  type CustomerLinkJournal,
  type CustomerLinkMetadata,
  type CustomerLinkScope,
  type CustomerLinkSource,
} from '@mise/core/customer-link-admin';
import {
  assertLiveCommandReceipt,
  bindCommandReceipt,
  assertCommandReceipt,
  CommandRequestError,
  type CommandAccount,
} from './command-request';
import { createCustomerLinkRemote } from './customer-link-remote';

/** One journal per original account/operator/resource. It never stores the
 * one-time token, a URL, backend connection, Auth fields or financial data. */
export function createCustomerLinkSession(
  config: CloudConnection,
  account: CommandAccount,
  input: CustomerLinkScope,
  deps: {
    storage: KeyStorage;
    assertScope: () => Promise<void>;
    locks?: Pick<LockManager, 'request'>;
    send?: typeof fetch;
  },
) {
  const scope = parseCustomerLinkScope(input),
    key = [
      'mise.customer-links.v1',
      account.targetHash,
      account.accountHash,
      scope.businessId,
      scope.outletId,
      scope.actorId,
      scope.kind,
      scope.resourceId,
    ].join(':'),
    remote = createCustomerLinkRemote(config, account, scope, deps.send);
  let memory: {
    source: CustomerLinkSource;
    token: string;
    link: CustomerLinkMetadata;
    guard: () => void;
  } | null = null;
  const blank = (): CustomerLinkJournal => ({
    v: 1,
    lifecycle: null,
    revoke: null,
  });
  function saved(): CustomerLinkJournal {
    try {
      const raw = deps.storage.getItem(key);
      if (raw === null) return blank();
      if (raw.length > 8192) throw Error();
      return parseCustomerLinkJournal(JSON.parse(raw), scope);
    } catch {
      memory = null;
      throw new CommandRequestError('review');
    }
  }
  const encoded = (record: CustomerLinkJournal) =>
    JSON.stringify(parseCustomerLinkJournal(record, scope));
  function persist(next: CustomerLinkJournal, previous: CustomerLinkJournal) {
    const raw = encoded(next);
    try {
      if (encoded(saved()) !== encoded(previous)) throw Error();
      deps.storage.setItem(key, raw);
      if (deps.storage.getItem(key) !== raw) throw Error();
    } catch {
      memory = null;
      throw new CommandRequestError('review');
    }
  }
  async function checked<T extends object>(value: T) {
    assertLiveCommandReceipt(value);
    await deps.assertScope();
    assertLiveCommandReceipt(value);
    return value;
  }
  async function authority(signal?: AbortSignal) {
    return checked(await remote.page(null, 1, signal));
  }
  async function exclusive<T>(run: () => Promise<T>): Promise<T> {
    const locks = deps.locks ?? globalThis.navigator?.locks;
    if (!locks) throw new CommandRequestError('review');
    return locks.request(
      key,
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        if (!lock) throw new CommandRequestError('retry');
        await deps.assertScope();
        return run();
      },
    );
  }
  function same(record: CustomerLinkJournal, previous: CustomerLinkJournal) {
    if (encoded(record) !== encoded(previous)) {
      memory = null;
      throw new CommandRequestError('review');
    }
  }
  async function inspect(signal?: AbortSignal) {
    return exclusive(async () => {
      const previous = saved(),
        l = previous.lifecycle;
      if (!l) return null;
      await authority(signal);
      const result = await checked(await remote.inspect(l.source, signal));
      same(saved(), previous);
      const lifecycle =
        l.type === 'close'
          ? { ...l, link: result.link, closure: result.closure }
          : { ...l, link: result.link };
      persist({ ...previous, lifecycle }, previous);
      if (result.state !== 'issued') memory = null;
      return result;
    });
  }
  return {
    key,
    saved,
    inspect,
    forget() {
      memory = null;
    },
    async page(after: string | null = null, limit = 50, signal?: AbortSignal) {
      return checked(await remote.page(after, limit, signal));
    },
    async create(value: CustomerLinkSource, signal?: AbortSignal) {
      const source = parseCustomerLinkSource(value, scope);
      return exclusive(async () => {
        const previous = saved();
        if (previous.revoke) throw new CommandRequestError('review');
        await authority(signal);
        if (previous.lifecycle) {
          const actual = await checked(
            await remote.inspect(previous.lifecycle.source, signal),
          );
          same(saved(), previous);
          if (actual.state !== 'closed')
            throw new CommandRequestError('review');
        }
        memory = null;
        const original: CustomerLinkJournal = {
          v: 1,
          lifecycle: { type: 'create', source, link: null },
          revoke: null,
        };
        persist(original, previous);
        const issued = await checked(await remote.create(source, signal));
        same(saved(), original);
        const { token, ...link } = issued;
        persist(
          { ...original, lifecycle: { type: 'create', source, link } },
          original,
        );
        await deps.assertScope();
        assertLiveCommandReceipt(issued);
        memory = {
          source,
          token,
          link,
          guard: () => assertLiveCommandReceipt(issued),
        };
        // Return metadata only. The explicit share() operation rechecks the live
        // original account and journal before releasing the token to this view.
        return bindCommandReceipt({ ...link }, () =>
          assertCommandReceipt(issued),
        );
      });
    },
    async close(eventId: string, signal?: AbortSignal) {
      return exclusive(async () => {
        memory = null;
        let original = saved();
        if (original.revoke || !original.lifecycle || !customerLinkId(eventId))
          throw new CommandRequestError('review');
        await authority(signal);
        const l = original.lifecycle,
          source = l.source;
        if (
          [source.id, source.createEventId].includes(eventId) ||
          (l.type === 'close' && l.eventId !== eventId)
        )
          throw new CommandRequestError('review');
        if (l.type !== 'close') {
          const next: CustomerLinkJournal = {
            ...original,
            lifecycle: {
              type: 'close',
              source,
              eventId,
              link: l.link,
              closure: null,
            },
          };
          persist(next, original);
          original = next;
        }
        const result = await checked(
          await remote.close(source, eventId, signal),
        );
        same(saved(), original);
        persist(
          {
            ...original,
            lifecycle: {
              type: 'close',
              source,
              eventId,
              link: result.link,
              closure: result.closure,
            },
          },
          original,
        );
        return result;
      });
    },
    async revoke(
      value: CustomerLinkMetadata,
      eventId: string,
      signal?: AbortSignal,
    ) {
      const link = parseCustomerLinkMetadata(value, scope);
      if (!customerLinkId(eventId) || eventId === link.id)
        throw new CommandRequestError('review');
      return exclusive(async () => {
        let original = saved();
        const intent = { link, eventId };
        if (
          original.revoke &&
          JSON.stringify(original.revoke) !== JSON.stringify(intent)
        )
          throw new CommandRequestError('review');
        if (original.lifecycle?.source.id === link.id)
          throw new CommandRequestError('review');
        await authority(signal);
        if (!original.revoke) {
          const next = { ...original, revoke: intent };
          persist(next, original);
          original = next;
        }
        const result = await checked(
          await remote.revoke(link.id, eventId, signal),
        );
        same(saved(), original);
        persist({ ...original, revoke: null }, original);
        return result;
      });
    },
    async share(signal?: AbortSignal) {
      return exclusive(async () => {
        const original = saved(),
          l = original.lifecycle,
          current = memory;
        if (
          original.revoke ||
          !l ||
          l.type !== 'create' ||
          !current ||
          JSON.stringify(current.source) !== JSON.stringify(l.source)
        )
          throw new CommandRequestError('review');
        current.guard();
        await authority(signal);
        const actual = await checked(await remote.inspect(l.source, signal));
        same(saved(), original);
        current.guard();
        if (
          actual.state !== 'issued' ||
          !actual.link ||
          JSON.stringify(actual.link) !== JSON.stringify(current.link)
        ) {
          memory = null;
          throw new CommandRequestError('review');
        }
        return bindCommandReceipt(
          { ...actual.link, token: current.token },
          () => {
            current.guard();
            same(saved(), original);
            if (memory !== current) throw new CommandRequestError('review');
          },
        );
      });
    },
  };
}
export type CustomerLinkSession = ReturnType<typeof createCustomerLinkSession>;
