import 'fake-indexeddb/auto';
import { randomUUID, createECDH, randomBytes } from 'node:crypto';
import { generateVAPIDKeys } from 'web-push';
import Dexie from 'dexie';
import { vi } from 'vitest';
import { MiseDatabase } from '../apps/web/src/data/db';
import {
  DeskCache,
  deskProfileScope,
  type DeskBinding,
} from '../apps/web/src/data/desk-cache';
import { createDeskNativeScope } from '../apps/web/src/data/desk-native';
import { createDeskSession } from '../apps/web/src/data/desk-session';
import { createUrgentInboxSession } from '../apps/web/src/data/urgent-inbox-session';
import { createUrgentInboxRemote } from '../apps/web/src/data/urgent-inbox-remote';
import type {
  UrgentInboxRegistration,
  UrgentInboxClosure,
} from '../packages/core/urgent-inbox';
import { cloudAuthStorageKey } from '../packages/core/cloud-connection';
import { testCommandAccount } from './command-account-fixture';
import { deskPage } from './desk-task-fixture';

export const urgentOpened: Dexie[] = [];
export const urgentConfig = {
  apiUrl: 'https://cloud.test',
  publishableKey: 'sb_publishable_test_only',
};
export async function urgentNativeFixture() {
  const db = new MiseDatabase('urgent-native-' + randomUUID()),
    base = '/fixture-' + randomUUID() + '/app/',
    cache = new DeskCache(base);
  urgentOpened.push(db, cache);
  await db.saveSetup({
    businessType: 'corner_shop',
    marketCode: 'BD',
    name: 'Urgent native shop',
    phone: '01712345482',
  });
  const setup = (await db.setup())!,
    sale = await db.recordSale({ expression: '12', method: 'cash' });
  let alive = true,
    assigned = true,
    ready = true,
    offline = false;
  const check = () => {
      if (!alive) throw Error('Original phone changed');
    },
    account = {
      ...testCommandAccount(urgentConfig, async () => {
        check();
        return 'original.phone.signature';
      }),
      assertCurrent: check,
    };
  const binding: DeskBinding = {
    id: 'active',
    version: 1,
    revision: 1,
    phase: 'active',
    businessId: setup.business.id,
    outletId: setup.outlet.id,
    actorId: setup.owner.id,
    role: 'owner',
    connection: {
      accountHash: account.accountHash,
      targetHash: account.targetHash,
      authKey: await cloudAuthStorageKey(urgentConfig, account.scope),
      epoch: randomUUID(),
      scopeVersion: randomUUID(),
    },
  };
  await db.operatorState.put(binding);
  const point = createECDH('prime256v1');
  point.generateKeys();
  const browser = {
    applicationKey: generateVAPIDKeys().publicKey,
    subscription: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/native-fixture-only',
      expirationTime: null,
      keys: {
        p256dh: point.getPublicKey().toString('base64url'),
        auth: randomBytes(16).toString('base64url'),
      },
    },
  };
  let actual: typeof browser | null = browser;
  const scope = deskProfileScope(binding),
    registrations = new Map<string, UrgentInboxRegistration>(),
    closures = new Map<string, UrgentInboxClosure>(),
    calls: { route: string; action: string; body: Record<string, unknown> }[] =
      [];
  const send = vi.fn<typeof fetch>(async (url, init) => {
    if (Dexie.currentTransaction?.db === db && Dexie.currentTransaction.active)
      throw Error('HTTP held a native transaction');
    if (offline) throw Error('Offline');
    const route = new URL(String(url)).pathname.split('/').at(-1)!,
      body = JSON.parse(String(init?.body)),
      action = body.action ?? route;
    calls.push({ route, action, body });
    if (route === 'read_kitchen_alarm_task_page')
      return Response.json({ ...deskPage([]), access: scope });
    if (action === 'configuration')
      return !assigned
        ? new Response('', { status: 403 })
        : !ready
          ? new Response('', { status: 503 })
          : Response.json({
              v: 1,
              context: scope,
              applicationKey: browser.applicationKey,
            });
    if (route === 'desk-notifications') {
      if (action === 'register')
        return Response.json({
          v: 1,
          id: body.id,
          businessId: binding.businessId,
          outletId: binding.outletId,
          memberId: binding.actorId,
          createdAt: 1000,
          expiresAt: null,
          revokedAt: null,
        });
      if (action === 'revoke') return Response.json(null);
    }
    if (route !== 'urgent-inbox-notifications')
      throw Error('Unexpected fixture endpoint');
    if (action === 'register') {
      if (!ready || !assigned || closures.has(body.id))
        return new Response('', { status: 409 });
      const old = registrations.get(body.id);
      if (
        old &&
        (old.eventId !== body.eventId ||
          old.consent.subscriptionId !== body.subscriptionId)
      )
        return new Response('', { status: 409 });
      const receipt: UrgentInboxRegistration = old ?? {
        v: 1,
        id: body.id,
        eventId: body.eventId,
        at: 2000,
        consent: {
          ...scope,
          id: body.id,
          subscriptionId: body.subscriptionId,
          createdAt: 2000,
          revokedAt: null,
        },
      };
      registrations.set(body.id, receipt);
      return Response.json(receipt.consent);
    }
    if (action === 'inspect') {
      const saved = registrations.get(body.id);
      return Response.json(
        saved &&
          saved.eventId === body.eventId &&
          saved.consent.subscriptionId === body.subscriptionId
          ? saved
          : null,
      );
    }
    if (action === 'withdraw') {
      const old = closures.get(body.id);
      if (old && old.eventId !== body.eventId)
        return new Response('', { status: 409 });
      const registered = registrations.get(body.id),
        receipt: UrgentInboxClosure = old ?? {
          v: 1,
          id: body.id,
          eventId: body.eventId,
          closedAt: 3000,
          consent: registered
            ? { ...registered.consent, revokedAt: 3000 }
            : null,
        };
      closures.set(body.id, receipt);
      return Response.json(receipt);
    }
    if (action === 'read') {
      const registered = registrations.get(body.id);
      return Response.json(
        closures.get(body.id)?.consent ?? registered?.consent ?? null,
      );
    }
    throw Error('Unexpected fixture action');
  });
  const options = {
      cache,
      native: createDeskNativeScope(db, binding, check),
      account,
      config: urgentConfig,
      check,
      subscription: async () => actual,
      send,
    },
    desk = createDeskSession(options),
    urgent = createUrgentInboxSession(options),
    remote = createUrgentInboxRemote(urgentConfig, account, scope, send);
  await desk.refresh();
  await desk.enable((await cache.read(binding))!, Promise.resolve(browser));
  await desk.drain();
  calls.length = 0;
  send.mockClear();
  return {
    db,
    cache,
    base,
    setup,
    sale,
    binding,
    account,
    scope,
    browser,
    send,
    calls,
    registrations,
    closures,
    desk,
    urgent,
    remote,
    options,
    loseAccount: () => {
      alive = false;
    },
    setAssigned: (value: boolean) => {
      assigned = value;
    },
    setReady: (value: boolean) => {
      ready = value;
    },
    setOffline: (value: boolean) => {
      offline = value;
    },
    replaceBrowser: () => {
      actual = {
        ...browser,
        subscription: {
          ...browser.subscription,
          keys: {
            ...browser.subscription.keys,
            auth: randomBytes(16).toString('base64url'),
          },
        },
      };
    },
    snapshot: async () => (await urgent.journal.read(binding))!,
    async enable() {
      const row = await urgent.enable((await urgent.journal.read(binding))!);
      await urgent.drain();
      return row;
    },
  };
}
