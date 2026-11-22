import { MiseDatabase } from '../../apps/web/src/data/db';
import { DeskCache } from '../../apps/web/src/data/desk-cache';
import {
  cloudAuthStorageKey,
  cloudConnectionTarget,
  saveCloudConnection,
  type CloudConnection,
} from '../../packages/core/cloud-connection';
import { operatorAccountHash } from '../../packages/core/operators';
import type { Order, SetupSnapshot } from '../../packages/core/models';
const base = () => location.pathname.replace(/\/app\/.*$/, '/app/');
const db = new MiseDatabase('mise-local:' + base());
async function initialize(input: {
  config: CloudConnection;
  setup: SetupSnapshot;
  order: Order;
  session: { user: { id: string } };
}) {
  await db.transaction(
    'rw',
    db.businesses,
    db.outlets,
    db.members,
    db.orders,
    db.operatorState,
    async () => {
      await db.businesses.put(input.setup.business);
      await db.outlets.put(input.setup.outlet);
      await db.members.put(input.setup.owner);
      await db.orders.put(input.order);
    },
  );
  const scope = base() + input.setup.business.id,
    key = await cloudAuthStorageKey(input.config, scope),
    accountHash = await operatorAccountHash(input.session.user.id),
    targetHash = await cloudConnectionTarget(
      input.config,
      scope,
      input.session.user.id,
    );
  saveCloudConnection(localStorage, input.config);
  localStorage.setItem(key, JSON.stringify(input.session));
  localStorage.setItem(
    'mise.flags',
    JSON.stringify({ kitchenAlarms: true, cloudSetup: true, pwa: true }),
  );
  await db.operatorState.put({
    id: 'active',
    version: 1,
    revision: 1,
    phase: 'active',
    businessId: input.setup.business.id,
    outletId: input.setup.outlet.id,
    actorId: input.setup.owner.id,
    role: 'owner',
    connection: {
      accountHash,
      targetHash,
      authKey: key,
      epoch: '00000000-0000-4000-8000-000000000009',
      scopeVersion: '00000000-0000-4000-8000-000000000010',
    },
  });
}
async function inspect() {
  const cache = new DeskCache(base());
  try {
    const binding = await db.operatorState.get('active'),
      setups = await cache.savedSetups();
    return {
      binding,
      setups,
      profiles: await cache.profiles.toArray(),
      operations: await cache.operations.toArray(),
      orders: await db.orders.toArray(),
      sales: await db.sales.toArray(),
      creditEntries: await db.creditEntries.toArray(),
    };
  } finally {
    cache.close();
  }
}
async function lock() {
  const current = await db.operatorState.get('active');
  if (!current) throw Error('No native selection');
  await db.operatorState.put({
    ...current,
    revision: current.revision + 1,
    phase: 'locked',
  });
}
async function removeLocalOrder(id:string){await db.orders.delete(id);}
window.miseDeskUiTest = { initialize, inspect, lock,removeLocalOrder };
declare global {
  interface Window {
    miseDeskUiTest: {
      initialize: typeof initialize;
      inspect: typeof inspect;
      lock: typeof lock;
      removeLocalOrder:typeof removeLocalOrder;
    };
  }
}
