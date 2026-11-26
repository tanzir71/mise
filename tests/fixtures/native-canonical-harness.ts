import 'fake-indexeddb/auto';
import { seedPaymentStorage } from './payment-storage';
import { inboxImageFile } from '../inbox-fixture';
import { defaultCreditTerms } from '../../packages/core/khata';
import Dexie from 'dexie';
import { nativePaymentTestServer } from './native-payment-server';
import { createCopySdk, copySdkSubject } from './original-copy-sdk';
import { MiseDatabase } from '../../apps/web/src/data/db';
import { OriginalCopyJournal } from '../../apps/web/src/data/original-copies';
import { createNativePaymentOutboxSession } from '../../apps/web/src/data/native-payment-session';
import { createLinkedPaymentOriginalSession } from '../../apps/web/src/data/original-copy-session';
import { createCloudSyncRemote } from '../../apps/web/src/data/cloud-sync-remote';
import {
  prepareSyncDownload,
  runSyncDownload,
} from '../../apps/web/src/data/cloud-sync-journal';
import { createShopCommandRemote } from '../../apps/web/src/data/shop-command-remote';
import {
  recordSavedPayment,
  compareSavedPaymentMoney,
  recordSavedPaymentMoney,
} from '../../apps/web/src/data/payment-capture';
import { cloudConnectionTarget } from '../../packages/core/cloud-connection';
import { operatorAccountHash } from '../../packages/core/operators';
import { newInboxId } from '../../packages/core/inbox';
import {
  reconstructNativeCanonicalRead,
  type NativeCanonicalRead,
} from '../../packages/core/sync-canonical';
export function nativeCanonicalHarness(
  config: { apiUrl: string; publishableKey: string },
  origin: string,
) {
  let server: Awaited<ReturnType<typeof nativePaymentTestServer>>;
  const stores: Dexie[] = [],
    sdks: Awaited<ReturnType<typeof createCopySdk>>[] = [],
    sessions: { stop(): void }[] = [];
  async function fixture(
    kind: 'counter' | 'credit' | 'order' = 'counter',
    scale = false,
  ) {
    const db = new MiseDatabase('native-canonical-source-' + newInboxId());
    stores.push(db);
    const large = scale ? await seedPaymentStorage(db) : null;
    const setup =
      large?.setup ??
      (await db.saveSetup({
        businessType: 'corner_shop',
        marketCode: 'BD',
        name: 'Canonical originals',
        phone: '01712345482',
      }));
    let accountId: string | undefined = large?.account.id;
    if (kind === 'credit' && !large) {
      const customer = await db.saveCustomer(
        {
          name: 'Original customer',
          nickname: 'Apa',
          phone: '01712345482',
          address: '',
          notes: '',
          tags: [],
        },
        {
          credit: { ...defaultCreditTerms, allowed: true, limit: 200000 },
          opening: { amount: 100000, occurredAt: Date.now() },
        },
      );
      accountId = (await db.creditAccounts
        .where('customerId')
        .equals(customer.id)
        .first())!.id;
    }
    const order =
      kind === 'order'
        ? await db.saveOrder({
            source: 'phone',
            sourceText: 'Original unpaid order',
            name: 'Customer',
            phone: '01712345482',
            type: 'pickup',
            address: '',
            table: '',
            lines: [{ name: 'Rice', unit: 'pc', qty: 1, unitPrice: 1525 }],
            deliveryFee: 0,
            discount: 0,
            payment: { method: 'cash' },
          })
        : null;
    const item = await db.captureInbox({
      text: 'DBBL received Tk 15.25\0\ud800 \u09ac\u09be\u0982\u09b2\u09be',
      ...(large ? { files: [inboxImageFile()] } : {}),
    });
    await server.seed(await db.readBackup());
    const bridge: typeof fetch = async (url, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set('Origin', origin);
      return server.handle(new Request(url, { ...init, headers }));
    };
    const authScope = 'canonical/' + db.name,
      sdk = await createCopySdk(config, authScope, bridge);
    sdks.push(sdk);
    const targetHash = await cloudConnectionTarget(
        config,
        authScope,
        sdk.saved.user.id,
      ),
      uploadId = newInboxId();
    await db.cloudState.put({
      id: 'binding',
      version: 1,
      uploadId,
      businessId: setup.business.id,
      outletId: setup.outlet.id,
      ownerId: setup.owner.id,
      targetHash,
      manifestHash: 'b'.repeat(64),
      phase: 'ready',
      sequence: 0,
      receipt: {
        id: uploadId,
        businessId: setup.business.id,
        outletId: setup.outlet.id,
        snapshotHash: 'c'.repeat(64),
        at: Date.now(),
        records: 3,
        images: 0,
      },
    });
    const journal = new OriginalCopyJournal(
      'native-canonical-copies-' + newInboxId(),
    );
    stores.push(journal);
    const send: typeof fetch = (url, init) =>
      new URL(String(url)).pathname.startsWith('/functions/') ||
      new URL(String(url)).pathname.startsWith('/rest/v1/rpc/')
        ? bridge(url, init)
        : sdk.send(url, init);
    const options = {
        config,
        authScope,
        auth: sdk.auth,
        storage: sdk.storage,
        journal,
        send,
      },
      session = await createNativePaymentOutboxSession(db, options);
    sessions.push(session);
    const remote = createCloudSyncRemote(
      config,
      async () => (await sdk.auth.commandAuthorization()).jwt,
      send,
    );
    const sources = await createLinkedPaymentOriginalSession(options, {
      businessId: setup.business.id,
      outletId: setup.outlet.id,
      actorId: setup.owner.id,
    });
    sessions.push(sources);
    const commands = createShopCommandRemote(
      config.apiUrl,
      config.publishableKey,
      {
        scope: authScope,
        accountHash: await operatorAccountHash(sdk.saved.user.id),
        targetHash,
        getAuth: () => sdk.auth.commandAuthorization(),
        assertCurrent: (v) => sdk.auth.assertCommandAuthorization(v),
      },
      send,
    );
    const review = await session.review(item.id, { sender: 'DBBL' });
    await recordSavedPayment(db, review, {
      checked: true,
      amount: 1525,
      currency: 'BDT',
      method: 'cash',
      methodName: 'Cash',
      reference: 'TESTCANONICAL' + item.id,
      receivedAt: item.createdAt,
    });
    const recorded = await recordSavedPaymentMoney(
      db,
      review,
      await compareSavedPaymentMoney(
        db,
        review,
        order
          ? { kind: 'order', id: order.id }
          : accountId
            ? { kind: 'credit', id: accountId }
            : { kind: 'counter', who: 'Exact original' },
      ),
      true,
    );
    await session.deliver();
    return {
      db,
      setup,
      item,
      sdk,
      session,
      remote,
      sources,
      commands: {
        async apply(...args: Parameters<typeof commands.apply>) {
          try {
            return await commands.apply(
              args[0],
              args[1] ?? setup.outlet.currency,
              args[2],
              args[3],
            );
          } catch (error) {
            throw Error(String(error) + ' ' + server.lastError());
          }
        },
      },
      recorded,
      review,
      targetHash,
      options,
      large,
      bridge,
      accountId,
      order,
    };
  }
  async function download(
    f: Awaited<ReturnType<typeof fixture>>,
    previous: NativeCanonicalRead | null = null,
    existingDb?: MiseDatabase,
  ) {
    const window = await f.remote.begin({
      type: 'begin',
      id: newInboxId(),
      outletId: f.setup.outlet.id,
      cursor: previous?.cursor ?? null,
    });
    const db =
      existingDb ?? new MiseDatabase('native-canonical-target-' + newInboxId());
    if (!existingDb) stores.push(db);
    const target = {
      targetHash: f.targetHash,
      businessId: window.businessId,
      outletId: window.outletId,
      actorId: window.actorId,
      accountHash: window.accountHash,
      role: window.role,
    };
    await prepareSyncDownload(db, {
      id: window.id,
      target,
      previousCursor: previous?.cursor ?? null,
    });
    const state = await runSyncDownload(db, window.id, target, f.remote),
      records = await db.syncRecords.where('readId').equals(state.id).toArray();
    const read = () =>
      reconstructNativeCanonicalRead(
        state,
        records,
        [],
        (link) => f.sources.read(link.id),
        previous,
      );
    return { db, state, records, read };
  }
  async function manager(f: Awaited<ReturnType<typeof fixture>>) {
    const managerId = newInboxId();
    await server.sql.query(
      "insert into public.members(id,business_id,auth_user_id,name,role,created_at,updated_at) values($1,$2,$3,$4,'manager',$5,$5)",
      [
        managerId,
        f.setup.business.id,
        copySdkSubject(2),
        JSON.stringify('Current manager'),
        Date.now(),
      ],
    );
    await server.sql.query(
      'insert into public.member_outlets values($1,$2,$3)',
      [f.setup.business.id, managerId, f.setup.outlet.id],
    );
    const authScope = 'canonical-manager/' + newInboxId(),
      sdk = await createCopySdk(config, authScope, f.bridge, 2);
    sdks.push(sdk);
    const targetHash = await cloudConnectionTarget(
        config,
        authScope,
        sdk.saved.user.id,
      ),
      journal = new OriginalCopyJournal(
        'canonical-manager-journal-' + newInboxId(),
      );
    stores.push(journal);
    const send: typeof fetch = (url, init) =>
      new URL(String(url)).pathname.startsWith('/functions/')
        ? f.bridge(url, init)
        : sdk.send(url, init);
    const sources = await createLinkedPaymentOriginalSession(
      {
        ...f.options,
        authScope,
        auth: sdk.auth,
        storage: sdk.storage,
        journal,
        send,
      },
      {
        businessId: f.setup.business.id,
        outletId: f.setup.outlet.id,
        actorId: managerId,
      },
    );
    sessions.push(sources);
    const remote = createCloudSyncRemote(
      config,
      async () => (await sdk.auth.commandAuthorization()).jwt,
      send,
    );
    return { ...f, sdk, remote, sources, targetHash, managerId };
  }

  return {
    fixture,
    download,
    manager,
    stores,
    sdks,
    sessions,
    async start() {
      server = await nativePaymentTestServer(
        config.apiUrl,
        config.publishableKey,
        origin,
      );
      return server;
    },
    async cleanup() {
      for (const s of sessions.splice(0)) s.stop();
      for (const s of sdks.splice(0)) await s.auth.dispose();
      for (const s of stores.splice(0)) await s.delete();
    },
    async close() {
      await server.close();
    },
  };
}
