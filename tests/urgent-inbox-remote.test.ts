import { generateVAPIDKeys } from 'web-push';
import { expect, it, vi } from 'vitest';
import { createUrgentInboxRemote } from '../apps/web/src/data/urgent-inbox-remote';
import { assertDeskReceipt } from '../apps/web/src/data/desk-proof';
import type { CommandAuthorization } from '../apps/web/src/data/command-request';
import {
  createUrgentInboxNotificationsHandler,
  type UrgentInboxNotificationsStore,
} from '../supabase/functions/_shared/urgent-inbox-notifications-handler';
import { newKitchenId } from '../packages/core/kitchen';
import { testCommandAccount } from './command-account-fixture';
import { deskScope as scope, deskId as id } from './desk-task-fixture';
const config = {
    apiUrl: 'https://cloud.test',
    publishableKey: 'sb_publishable_test_only',
  },
  key = generateVAPIDKeys().publicKey;
const consent = {
    ...scope,
    id: id(5),
    subscriptionId: id(6),
    createdAt: 1000,
    revokedAt: null,
  },
  registration = {
    v: 1 as const,
    id: consent.id,
    eventId: id(7),
    at: 1000,
    consent,
  },
  closure = {
    v: 1 as const,
    id: consent.id,
    eventId: id(8),
    closedAt: 2000,
    consent: { ...consent, revokedAt: 2000 },
  };
function boot() {
  let auth: CommandAuthorization = {
    jwt: 'original.phone.signature',
    userId: '00000000-0000-4000-8000-000000000001',
    generation: 1,
  };
  const original = { ...auth },
    account = {
      ...testCommandAccount(config, async () => auth.jwt),
      getAuth: vi.fn(async () => ({ ...auth })),
      assertCurrent: (value: CommandAuthorization) => {
        if (
          value.userId !== original.userId ||
          value.generation !== original.generation ||
          auth.generation !== original.generation
        )
          throw Error('Original phone changed');
      },
    },
    send = vi.fn<typeof fetch>(async (_url, init) => {
      const action = JSON.parse(String(init?.body)).action;
      return Response.json(
        action === 'register' || action === 'read'
          ? consent
          : action === 'inspect'
            ? registration
            : action === 'withdraw'
              ? closure
              : { v: 1, context: scope, applicationKey: key },
      );
    });
  return {
    account,
    send,
    remote: createUrgentInboxRemote(config, account, scope, send),
    change: () => {
      auth = { ...auth, generation: 2 };
    },
  };
}
it('uses only the installation selected fixed owner endpoint and sends the original JWT with its publishable key', async () => {
  const f = boot();
  await f.remote.configuration();
  const [url, init] = f.send.mock.calls[0];
  expect(String(url)).toBe(
    'https://cloud.test/functions/v1/urgent-inbox-notifications',
  );
  expect(JSON.parse(String(init?.body))).toEqual({
    action: 'configuration',
    outletId: scope.outletId,
  });
  expect(init?.headers).toMatchObject({
    apikey: config.publishableKey,
    Authorization: 'Bearer original.phone.signature',
  });
});
it('does not manufacture a registration event from current metadata and obtains the immutable original receipt', async () => {
  const f = boot(),
    proof = await f.remote.register(
      consent.id,
      consent.subscriptionId,
      registration.eventId,
    );
  expect(proof).toEqual({ action: 'register', registration });
  expect(
    f.send.mock.calls.map(([, init]) => JSON.parse(String(init?.body))),
  ).toEqual([
    {
      action: 'register',
      id: consent.id,
      subscriptionId: consent.subscriptionId,
      eventId: registration.eventId,
    },
    {
      action: 'inspect',
      id: consent.id,
      subscriptionId: consent.subscriptionId,
      eventId: registration.eventId,
    },
  ]);
});
it('interoperates with the actual production Edge handler returning consent from register and original event from inspect', async () => {
  const f = boot(),
    store: UrgentInboxNotificationsStore = {
      context: async () => scope,
      register: async () => consent,
      inspect: async () => registration,
      read: async () => consent,
      withdraw: async () => closure,
      target: async () => null,
    },
    handler = createUrgentInboxNotificationsHandler({
      store,
      origins: new Set(['https://mise.test']),
      enabled: true,
      applicationKey: key,
    });
  const remote = createUrgentInboxRemote(
    config,
    f.account,
    scope,
    async (url, init) =>
      handler(
        new Request(String(url), {
          ...init,
          headers: { ...init?.headers, Origin: 'https://mise.test' },
        }),
      ),
  );
  expect(
    await remote.register(
      consent.id,
      consent.subscriptionId,
      registration.eventId,
    ),
  ).toEqual({ action: 'register', registration });
  expect(await remote.withdraw(consent.id, closure.eventId)).toEqual({
    action: 'withdraw',
    closure,
  });
});
it('keeps cleanup and original inspection usable against a default off production Edge handler', async () => {
  const f = boot(),
    store: UrgentInboxNotificationsStore = {
      context: async () => scope,
      register: async () => consent,
      inspect: async () => registration,
      read: async () => consent,
      withdraw: async () => closure,
      target: async () => null,
    },
    handler = createUrgentInboxNotificationsHandler({
      store,
      origins: new Set(['https://mise.test']),
      enabled: false,
    });
  const remote = createUrgentInboxRemote(
    config,
    f.account,
    scope,
    async (url, init) =>
      handler(
        new Request(String(url), {
          ...init,
          headers: { ...init?.headers, Origin: 'https://mise.test' },
        }),
      ),
  );
  await expect(remote.configuration()).rejects.toMatchObject({ kind: 'retry' });
  await expect(
    remote.register(consent.id, consent.subscriptionId, registration.eventId),
  ).rejects.toMatchObject({ kind: 'retry' });
  expect(
    await remote.inspect(
      consent.id,
      consent.subscriptionId,
      registration.eventId,
    ),
  ).toEqual({ action: 'register', registration });
  expect(await remote.withdraw(consent.id, closure.eventId)).toEqual({
    action: 'withdraw',
    closure,
  });
});
it.each(['id', 'subscriptionId', 'eventId', 'at'] as const)(
  'rejects a different original registration %s',
  async (field) => {
    const f = boot();
    f.send.mockImplementation(async (_url, init) =>
      Response.json(
        JSON.parse(String(init?.body)).action === 'register'
          ? consent
          : { ...registration, [field]: field === 'at' ? 2000 : id(99) },
      ),
    );
    await expect(
      f.remote.register(
        consent.id,
        consent.subscriptionId,
        registration.eventId,
      ),
    ).rejects.toThrow();
  },
);
it.each(['outletId', 'memberId', 'role', 'businessId'] as const)(
  'rejects another authoritative consent %s',
  async (field) => {
    const f = boot();
    f.send.mockResolvedValue(
      Response.json({
        ...consent,
        [field]: field === 'role' ? 'manager' : id(99),
      }),
    );
    await expect(
      f.remote.register(
        consent.id,
        consent.subscriptionId,
        registration.eventId,
      ),
    ).rejects.toThrow();
    expect(f.send).toHaveBeenCalledTimes(1);
  },
);
it('does not confuse absent inspection or current consent metadata with a withdrawal receipt', async () => {
  const f = boot();
  f.send.mockResolvedValue(Response.json(null));
  expect(
    await f.remote.inspect(
      consent.id,
      consent.subscriptionId,
      registration.eventId,
    ),
  ).toEqual({ registration: null });
  await expect(
    f.remote.withdraw(consent.id, closure.eventId),
  ).rejects.toThrow();
  f.send.mockResolvedValue(Response.json(consent));
  await expect(
    f.remote.withdraw(consent.id, closure.eventId),
  ).rejects.toThrow();
});
it('keeps an absent immutable inspection after registration unconfirmed', async () => {
  const f = boot();
  f.send.mockImplementation(async (_url, init) =>
    Response.json(
      JSON.parse(String(init?.body)).action === 'register' ? consent : null,
    ),
  );
  await expect(
    f.remote.register(consent.id, consent.subscriptionId, registration.eventId),
  ).rejects.toMatchObject({ kind: 'retry' });
});
it('rejects expired phone continuity between metadata and the original event receipt', async () => {
  const f = boot();
  let calls = 0;
  f.send.mockImplementation(async () => {
    if (++calls === 2) f.change();
    return Response.json(calls === 1 ? consent : registration);
  });
  await expect(
    f.remote.register(consent.id, consent.subscriptionId, registration.eventId),
  ).rejects.toMatchObject({ kind: 'auth' });
});
it('retains a live account-bound proof without serializing its token or authority into saved metadata', async () => {
  const f = boot(),
    proof = await f.remote.inspect(
      consent.id,
      consent.subscriptionId,
      registration.eventId,
    ),
    identity = {
      accountHash: f.account.accountHash,
      targetHash: f.account.targetHash,
      scope,
    };
  expect(JSON.stringify(proof)).not.toMatch(/signature|publishable|apiUrl/);
  assertDeskReceipt(proof, identity);
  expect(() => assertDeskReceipt(structuredClone(proof), identity)).toThrow();
  f.change();
  expect(() => assertDeskReceipt(proof, identity)).toThrow();
});
it('refuses malformed IDs or an arbitrary URL before requesting phone authorization', async () => {
  const f = boot();
  await expect(
    f.remote.register(consent.id, consent.id, registration.eventId),
  ).rejects.toThrow();
  await expect(
    f.remote.withdraw('https://other.test', closure.eventId),
  ).rejects.toThrow();
  await expect(
    f.remote.target({
      v: 1,
      type: 'urgent-inbox',
      consentId: consent.id,
      subscriptionId: consent.subscriptionId,
      businessId: scope.businessId,
      outletId: scope.outletId,
      taskId: newKitchenId(),
      generation: 1,
      url: 'https://other.test',
    } as never),
  ).rejects.toThrow();
  expect(f.send).not.toHaveBeenCalled();
  expect(f.account.getAuth).not.toHaveBeenCalled();
});
