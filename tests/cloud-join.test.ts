import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, expect, it } from 'vitest';
import { MiseDatabase } from '../apps/web/src/data/db';
import { lockLocalOperator } from '../apps/web/src/data/operator-state';
import {
  prepareCloudJoin,
  resumeCloudJoin,
  pauseCloudJoin,
  cancelCloudJoin,
  discoverJoinOutlets,
  type JoinOptions,
} from '../apps/web/src/data/cloud-join';
import {
  discoveryAuthScope,
  resolveCloudAuthScope,
} from '../apps/web/src/data/cloud-auth-scope';
import {
  cloudAuthStorageKey,
  cloudConnectionTarget,
} from '../packages/core/cloud-connection';
import {
  operatorAccountHash,
  type OperatorContext,
} from '../packages/core/operators';
import { parseJoinSession } from '../packages/core/join-session';
import { syncDownloadToken } from '../packages/core/sync-download';
import { parseSyncScope } from '../packages/core/sync-read';
import { sealSyncWire } from '../packages/core/sync-wire';
import { localSchemaVersion } from '../packages/core/local-outbox';
import { backupToken } from '../packages/core/backup';
import { newInboxId } from '../packages/core/inbox';
import { syncImagesFixture } from './sync-images-fixture';

const config = {
    apiUrl: 'https://cloud.test',
    publishableKey: 'sb_publishable_test_only',
  },
  base = '/mise/app/',
  uid = '00000000-0000-4000-8000-000000000001';
const databases: Dexie[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.delete();
});
async function boot() {
  const fixture = await syncImagesFixture(),
    db = new MiseDatabase('join-flow-' + newInboxId());
  databases.push(db);
  await db.open();
  const accountHash = await operatorAccountHash(uid),
    targetHash = await cloudConnectionTarget(
      config,
      base + fixture.target.businessId,
      uid,
    );
  fixture.target = { ...fixture.target, accountHash, targetHash };
  fixture.window.accountHash = accountHash;
  for (const page of fixture.pages) page.accountHash = accountHash;
  const context: OperatorContext = {
    ...parseSyncScope(fixture.window),
    version: 1,
    businessName: 'Original shop',
    outletName: 'Main outlet',
    actorName: 'Original operator',
  };
  const key = await cloudAuthStorageKey(config, discoveryAuthScope(base));
  let generation = 1,
    connected = true,
    losePage = false;
  const calls = { begin: 0, pages: 0, images: 0, select: 0 };
  const auth = {
    key,
    commandAuthorization: async () => ({
      jwt: 'fixture.token.only',
      userId: uid,
      generation,
    }),
    assertCommandAuthorization: (value: { generation: number }) => {
      if (value.generation !== generation)
        throw Object.assign(new Error('Synthetic account changed'), {
          kind: 'auth',
        });
    },
  } satisfies JoinOptions['auth'];
  const send: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname,
      body = init?.body ? JSON.parse(String(init.body)) : null;
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        headers: { 'Content-Type': 'application/json' },
      });
    if (path.endsWith('/operator_contexts'))
      return json({ version: 1, accountHash, contexts: [context], next: null });
    if (path.endsWith('/operator_context')) {
      calls.select++;
      return json(context);
    }
    if (path.endsWith('/sync-read')) {
      if (body.type === 'begin') {
        calls.begin++;
        return json(await sealSyncWire({ ...fixture.window, id: body.id }));
      }
      calls.pages++;
      if (losePage) {
        losePage = false;
        throw new TypeError('Synthetic lost page');
      }
      return json(
        await sealSyncWire({ ...fixture.pages[body.index], id: body.id }),
      );
    }
    if (path.endsWith('/inbox-image')) {
      calls.images++;
      return new Response(new Uint8Array(fixture.imageBytes), {
        headers: { 'Content-Type': 'image/png' },
      });
    }
    throw new Error('Unexpected fixture request');
  };
  const options: JoinOptions = {
    config,
    base,
    auth,
    send,
    connectionCurrent: () => connected,
  };
  return {
    fixture,
    db,
    context,
    options,
    calls,
    swap: () => {
      generation++;
    },
    changeConnection: () => {
      connected = false;
    },
    losePage: () => {
      losePage = true;
    },
  };
}
it('retains one original discovery session while business target fingerprints stay distinct', async () => {
  const f = await boot(),
    legacy = await cloudAuthStorageKey(config, base + f.context.businessId),
    discovery = f.options.auth.key;
  expect(
    await resolveCloudAuthScope(config, base, f.context.businessId, legacy),
  ).toBe(base + f.context.businessId);
  expect(
    await resolveCloudAuthScope(config, base, f.context.businessId, discovery),
  ).toBe(discoveryAuthScope(base));
  const other = newInboxId();
  expect(await resolveCloudAuthScope(config, base, other, discovery)).toBe(
    discoveryAuthScope(base),
  );
  expect(await cloudConnectionTarget(config, base + other, uid)).not.toBe(
    f.fixture.target.targetHash,
  );
  for (const [nextConfig, nextBase, nextBusiness, key] of [
    [
      { ...config, apiUrl: 'https://other.test' },
      base,
      f.context.businessId,
      discovery,
    ],
    [config, '/other/app/', f.context.businessId, discovery],
    [config, base, other, legacy],
    [config, base, f.context.businessId, 'mise.cloud.auth.' + 'e'.repeat(64)],
  ] as const)
    await expect(
      resolveCloudAuthScope(nextConfig, nextBase, nextBusiness, key),
    ).rejects.toThrow(/original/);
});
it('requires fresh explicit selection and saves its fixed read before any snapshot traffic', async () => {
  const f = await boot(),
    page = await discoverJoinOutlets(f.options);
  expect(page.contexts).toEqual([f.context]);
  expect(await f.db.operatorState.count()).toBe(0);
  const session = await prepareCloudJoin(f.db, f.options, page.contexts[0]);
  expect(session).toMatchObject({
    phase: 'pending',
    target: f.fixture.target,
    operatorRevision: 1,
    problem: null,
  });
  expect(f.calls.begin).toBe(0);
  expect(await f.db.businesses.count()).toBe(0);
  expect((await f.db.operatorState.get('active'))?.phase).toBe('pending');
  expect(await prepareCloudJoin(f.db, f.options, f.context)).toEqual(session);
  const serialized = JSON.stringify(session);
  for (const value of [
    config.apiUrl,
    config.publishableKey,
    uid,
    'fixture.token.only',
  ])
    expect(serialized).not.toContain(value);
  expect(() =>
    parseJoinSession({ ...session, jwt: 'fixture.token.only' }),
  ).toThrow();
});
it('downloads and verifies original images, atomically admits a real v2 join and starts sync with no upload receipt', async () => {
  const f = await boot(),
    session = await prepareCloudJoin(f.db, f.options, f.context),
    result = await resumeCloudJoin(f.db, f.options);
  expect(result).toMatchObject({ readId: session.readId, phase: 'ready' });
  expect(await f.db.cloudState.get('binding')).toMatchObject({
    version: 2,
    phase: 'ready',
    receipt: null,
    join: { readId: session.readId, kind: 'join' },
  });
  expect(await f.db.syncSessions.get('active')).toMatchObject({
    paused: false,
    target: f.fixture.target,
    operatorRevision: 2,
    authKey: f.options.auth.key,
    problem: null,
  });
  expect(backupToken(await f.db.readBackup())).toBe(
    backupToken(f.fixture.backup),
  );
  expect(await f.db.syncImages.count()).toBe(2);
  expect(await f.db.outbox.count()).toBe(0);
  expect(f.calls.images).toBe(2);
  await f.db.recordSale({ expression: '47', method: 'cash' });
  expect(await f.db.outbox.count()).toBe(1);
  const original = await f.db.readBackup();
  expect(await resumeCloudJoin(f.db, f.options)).toEqual(result);
  expect(backupToken(await f.db.readBackup())).toBe(backupToken(original));
});
it('reopens after a lost page and resumes the same read and source without resetting saved evidence', async () => {
  const f = await boot(),
    session = await prepareCloudJoin(f.db, f.options, f.context);
  f.losePage();
  await expect(resumeCloudJoin(f.db, f.options)).rejects.toMatchObject({
    kind: 'retry',
  });
  const source = (await f.db.syncReads.get(session.readId))!.source;
  expect(await f.db.joinSessions.get('active')).toMatchObject({
    readId: session.readId,
    phase: 'paused',
    problem: 'retry',
  });
  f.db.close();
  await f.db.open();
  const result = await resumeCloudJoin(f.db, f.options);
  expect(result.readId).toBe(session.readId);
  expect((await f.db.syncReads.get(session.readId))!.source).toEqual(source);
  expect(f.calls.begin).toBe(1);
});
it('stops before admission, keeps the original download and resumes explicitly', async () => {
  const f = await boot(),
    session = await prepareCloudJoin(f.db, f.options, f.context);
  await pauseCloudJoin(f.db, session.readId);
  expect(await f.db.joinSessions.get('active')).toMatchObject({
    phase: 'paused',
    readId: session.readId,
  });
  expect(await f.db.businesses.count()).toBe(0);
  expect((await resumeCloudJoin(f.db, f.options)).readId).toBe(session.readId);
});
it('refuses an existing local shop without replacing its working copy or recording a cloud operator', async () => {
  const f = await boot();
  await f.db.saveSetup({
    name: 'Keep this shop',
    phone: '+8801712345678',
    businessType: 'corner_shop',
    marketCode: 'BD',
  });
  const before = backupToken(await f.db.readBackup());
  await expect(prepareCloudJoin(f.db, f.options, f.context)).rejects.toThrow();
  expect(backupToken(await f.db.readBackup())).toBe(before);
  expect(await f.db.joinSessions.count()).toBe(0);
  expect(await f.db.operatorState.count()).toBe(0);
});
it('blocks local onboarding after selection while retaining the pending join and all local records', async () => {
  const f = await boot(),
    session = await prepareCloudJoin(f.db, f.options, f.context),
    before = backupToken(await f.db.readBackup());
  await expect(
    f.db.saveSetup({
      name: 'Concurrent shop',
      phone: '+8801712345678',
      businessType: 'corner_shop',
      marketCode: 'BD',
    }),
  ).rejects.toThrow();
  expect(backupToken(await f.db.readBackup())).toBe(before);
  expect(await f.db.cloudState.count()).toBe(0);
  expect(await f.db.joinSessions.get('active')).toEqual(session);
});
it('rolls back all domain admission when the original account changes inside the native writer', async () => {
  const f = await boot();
  await prepareCloudJoin(f.db, f.options, f.context);
  const hook = () => {
    f.swap();
  };
  f.db.items.hook('creating', hook);
  try {
    await expect(resumeCloudJoin(f.db, f.options)).rejects.toMatchObject({
      kind: 'auth',
    });
  } finally {
    f.db.items.hook('creating').unsubscribe(hook);
  }
  expect(await f.db.businesses.count()).toBe(0);
  expect(await f.db.items.count()).toBe(0);
  expect(await f.db.cloudState.count()).toBe(0);
  expect(await f.db.syncCanonical.count()).toBe(0);
  expect(await f.db.syncSessions.count()).toBe(0);
  expect(await f.db.syncImages.count()).toBe(2);
  expect(await f.db.joinSessions.get('active')).toMatchObject({
    phase: 'paused',
    problem: 'auth',
  });
});
it('retains the original admission after an account change inside final status and finishes it on fresh original verification', async () => {
  const f = await boot(),
    session = await prepareCloudJoin(f.db, f.options, f.context);
  const hook = () => {
    f.swap();
  };
  f.db.syncSessions.hook('creating', hook);
  try {
    await expect(resumeCloudJoin(f.db, f.options)).rejects.toMatchObject({
      kind: 'auth',
    });
  } finally {
    f.db.syncSessions.hook('creating').unsubscribe(hook);
  }
  expect(await f.db.cloudState.get('binding')).toMatchObject({
    version: 2,
    receipt: null,
    join: { readId: session.readId },
  });
  expect(await f.db.syncSessions.count()).toBe(0);
  expect(await f.db.joinSessions.get('active')).toMatchObject({
    phase: 'paused',
    problem: 'auth',
    operatorRevision: 1,
  });
  const before = backupToken(await f.db.readBackup()),
    requests = { ...f.calls };
  expect((await resumeCloudJoin(f.db, f.options)).phase).toBe('ready');
  expect(backupToken(await f.db.readBackup())).toBe(before);
  expect(f.calls.begin).toBe(requests.begin);
  expect(f.calls.pages).toBe(requests.pages);
  expect(f.calls.images).toBe(requests.images);
});
it('rejects a changed connection during admission without persisting any shop', async () => {
  const f = await boot();
  await prepareCloudJoin(f.db, f.options, f.context);
  const hook = () => f.changeConnection();
  f.db.items.hook('creating', hook);
  try {
    await expect(resumeCloudJoin(f.db, f.options)).rejects.toMatchObject({
      kind: 'auth',
    });
  } finally {
    f.db.items.hook('creating').unsubscribe(hook);
  }
  expect(await f.db.businesses.count()).toBe(0);
  expect(await f.db.cloudState.count()).toBe(0);
});
it('cancels only its own pending selection and retains prior evidence for a fresh explicit choice', async () => {
  const f = await boot(),
    session = await prepareCloudJoin(f.db, f.options, f.context);
  f.losePage();
  await expect(resumeCloudJoin(f.db, f.options)).rejects.toThrow();
  const reads = await f.db.syncReads.toArray();
  await cancelCloudJoin(f.db, session.readId);
  expect(await f.db.operatorState.count()).toBe(0);
  expect(await f.db.syncReads.toArray()).toEqual(reads);
  expect(await f.db.joinSessions.get('active')).toMatchObject({
    phase: 'cancelled',
  });
  const next = await prepareCloudJoin(f.db, f.options, f.context);
  expect(next.readId).not.toBe(session.readId);
  expect(await f.db.joinSessions.get('saved:' + session.readId)).toMatchObject({
    readId: session.readId,
    phase: 'cancelled',
  });
});
it('two tabs share the original read and only one atomic domain admission', async () => {
  const f = await boot(),
    session = await prepareCloudJoin(f.db, f.options, f.context),
    other = new MiseDatabase(f.db.name);
  databases.push(other);
  await other.open();
  const results = await Promise.allSettled([
    resumeCloudJoin(f.db, f.options),
    resumeCloudJoin(other, f.options),
  ]);
  expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
  expect(await f.db.joinSessions.get('active')).toMatchObject({
    readId: session.readId,
    phase: 'ready',
  });
  expect(await f.db.syncCanonical.count()).toBe(1);
  expect(await f.db.cloudState.count()).toBe(1);
  expect(await f.db.syncSessions.count()).toBe(1);
  expect(backupToken(await f.db.readBackup())).toBe(
    backupToken(f.fixture.backup),
  );
  other.close();
});
it('upgrades schema 19 without changing its original queued sale, image or sync session', async () => {
  const f = await boot();
  await prepareCloudJoin(f.db, f.options, f.context);
  await resumeCloudJoin(f.db, f.options);
  await f.db.recordSale({ expression: '49', method: 'cash' });
  const data = await Promise.all(
      f.db.tables
        .filter((t) => t.name !== 'joinSessions')
        .map(async (t) => ({
          name: t.name,
          rows: await t.toArray(),
          schema: [
            t.schema.primKey.src,
            ...t.schema.indexes.map((i) => i.src),
          ].join(','),
        })),
    ),
    name = 'join-upgrade-' + newInboxId(),
    legacy = new Dexie(name);
  databases.push(legacy);
  legacy
    .version(19)
    .stores(Object.fromEntries(data.map((t) => [t.name, t.schema])));
  for (const t of data)
    if (t.rows.length) await legacy.table(t.name).bulkAdd(t.rows);
  legacy.close();
  const upgraded = new MiseDatabase(name);
  databases.push(upgraded);
  await upgraded.open();
  expect(upgraded.verno).toBe(localSchemaVersion);
  expect(await upgraded.joinSessions.count()).toBe(0);
  for (const t of data)
    expect(syncDownloadToken(await upgraded.table(t.name).toArray())).toBe(
      syncDownloadToken(t.rows),
    );
  upgraded.close();
});
it('explicit original-phone verification resumes a locked pending operator with the same read', async () => {
  const f = await boot(),
    session = await prepareCloudJoin(f.db, f.options, f.context);
  await lockLocalOperator(f.db, session.operatorRevision);
  await pauseCloudJoin(f.db, session.readId, 'auth');
  const result = await resumeCloudJoin(f.db, f.options);
  expect(result).toMatchObject({
    readId: session.readId,
    phase: 'ready',
    operatorRevision: 3,
  });
  expect(await f.db.operatorState.get('active')).toMatchObject({
    revision: 4,
    phase: 'active',
  });
  expect(await f.db.syncSessions.get('active')).toMatchObject({
    operatorRevision: 4,
  });
});
it('an account change inside fresh locked-operator selection rolls back that activation before any download', async () => {
  const f = await boot(),
    session = await prepareCloudJoin(f.db, f.options, f.context);
  await lockLocalOperator(f.db, session.operatorRevision);
  const original = await f.db.operatorState.get('active'),
    hook = () => {
      f.swap();
    };
  f.db.operatorState.hook('updating', hook);
  try {
    await expect(resumeCloudJoin(f.db, f.options)).rejects.toMatchObject({
      kind: 'auth',
    });
  } finally {
    f.db.operatorState.hook('updating').unsubscribe(hook);
  }
  expect(await f.db.operatorState.get('active')).toEqual(original);
  expect(f.calls.begin).toBe(0);
  expect(await f.db.businesses.count()).toBe(0);
  expect(await f.db.joinSessions.get('active')).toMatchObject({
    phase: 'paused',
    problem: 'auth',
  });
});
it('a pause arriving during fresh locked-operator verification prevents the older selection from activating it', async () => {
  const f = await boot(),
    session = await prepareCloudJoin(f.db, f.options, f.context);
  await lockLocalOperator(f.db, session.operatorRevision);
  const locked = await f.db.operatorState.get('active'),
    send = f.options.send!;
  let selects = 0;
  f.options.send = async (input, init) => {
    const response = await send(input, init);
    if (
      new URL(String(input)).pathname.endsWith('/operator_context') &&
      ++selects === 2
    )
      await pauseCloudJoin(f.db, session.readId);
    return response;
  };
  await expect(resumeCloudJoin(f.db, f.options)).rejects.toMatchObject({
    kind: 'review',
  });
  expect(await f.db.operatorState.get('active')).toEqual(locked);
  expect(await f.db.joinSessions.get('active')).toMatchObject({
    phase: 'paused',
    readId: session.readId,
  });
  expect(f.calls.begin).toBe(0);
  expect(await f.db.businesses.count()).toBe(0);
});
it('an admitted join reselects a locked original member without changing the original pending revision or shop', async () => {
  const f = await boot(),
    session = await prepareCloudJoin(f.db, f.options, f.context),
    hook = () => {
      f.swap();
    };
  f.db.syncSessions.hook('creating', hook);
  try {
    await expect(resumeCloudJoin(f.db, f.options)).rejects.toThrow();
  } finally {
    f.db.syncSessions.hook('creating').unsubscribe(hook);
  }
  const before = backupToken(await f.db.readBackup()),
    operator = (await f.db.operatorState.get('active'))!;
  await lockLocalOperator(f.db, operator.revision);
  const joined = await resumeCloudJoin(f.db, f.options);
  expect(joined).toMatchObject({
    readId: session.readId,
    phase: 'ready',
    operatorRevision: session.operatorRevision,
  });
  expect(backupToken(await f.db.readBackup())).toBe(before);
  expect(await f.db.operatorState.get('active')).toMatchObject({
    revision: 4,
    phase: 'active',
  });
  expect(f.calls.begin).toBe(1);
});
it('changed server permissions require a fresh explicit choice and preserve the original staged source', async () => {
  const f = await boot(),
    session = await prepareCloudJoin(f.db, f.options, f.context);
  f.losePage();
  await expect(resumeCloudJoin(f.db, f.options)).rejects.toThrow();
  const originalReads = await f.db.syncReads.toArray();
  f.context.scopeVersion = '00000000-0000-4000-8000-000000000009';
  await expect(resumeCloudJoin(f.db, f.options)).rejects.toMatchObject({
    kind: 'review',
  });
  expect(await f.db.joinSessions.get('active')).toMatchObject({
    phase: 'paused',
    problem: 'review',
  });
  expect(await f.db.syncReads.toArray()).toEqual(originalReads);
  const selected = await prepareCloudJoin(f.db, f.options, f.context);
  expect(selected.readId).not.toBe(session.readId);
  expect(selected.scopeVersion).toBe(f.context.scopeVersion);
  expect(await f.db.joinSessions.get('saved:' + session.readId)).toMatchObject({
    readId: session.readId,
    problem: 'review',
  });
  expect(await f.db.syncReads.toArray()).toEqual(originalReads);
});
