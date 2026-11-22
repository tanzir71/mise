import { MiseDatabase } from '../../apps/web/src/data/db';
import {
  cloudAuthStorageKey,
  cloudConnectionStorageKey,
} from '../../packages/core/cloud-connection';
import type { CustomerLinkFixtureConfig } from './customer-link-service';
async function initialize(config: CustomerLinkFixtureConfig) {
  const base = location.pathname.replace(/\/app\/.*$/, '/app/'),
    db = new MiseDatabase('mise-local:' + base),
    r = config.records;
  try {
    await db.transaction(
      'rw',
      [
        db.businesses,
        db.outlets,
        db.members,
        db.operatorState,
        db.orders,
        db.customers,
        db.creditAccounts,
        db.creditEntries,
        db.events,
      ],
      async () => {
        await db.businesses.put(r.setup.business);
        await db.outlets.put(r.setup.outlet);
        await db.members.bulkPut(r.members);
        await db.orders.put(r.order);
        await db.customers.put(r.customer);
        await db.creditAccounts.put(r.account);
        await db.creditEntries.bulkPut(r.entries);
        await db.events.bulkPut(r.events);
        await db.operatorState.put({
          id: 'active',
          version: 1,
          revision: 1,
          phase: 'active',
          businessId: r.setup.business.id,
          outletId: r.setup.outlet.id,
          actorId: r.setup.owner.id,
          role: r.setup.owner.role === 'manager' ? 'manager' : 'owner',
          connection: null,
        });
      },
    );
    const connection = {
        apiUrl: config.apiUrl,
        publishableKey: config.publishableKey,
      },
      key = await cloudAuthStorageKey(connection, base + r.setup.business.id);
    localStorage.setItem(cloudConnectionStorageKey, JSON.stringify(connection));
    localStorage.setItem(
      key,
      JSON.stringify({
        access_token: config.jwt,
        refresh_token: 'synthetic-customer-link-refresh',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        expires_in: 3600,
        token_type: 'bearer',
        user: config.user,
      }),
    );
  } finally {
    db.close();
  }
}
window.miseCustomerLinkTest = { initialize };
declare global {
  interface Window {
    miseCustomerLinkTest: { initialize: typeof initialize };
  }
}
