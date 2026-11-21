import { MiseDatabase } from '../../apps/web/src/data/db';
import {
  cloudAuthStorageKey,
  cloudConnectionStorageKey,
} from '../../packages/core/cloud-connection';
import type { SetupSnapshot } from '../../packages/core/models';
interface Config {
  apiUrl: string;
  publishableKey: string;
  jwt: string;
  user: { id: string; phone: string };
  setup: SetupSnapshot;
}
async function initialize(config: Config) {
  const base = location.pathname.replace(/\/app\/.*$/, '/app/'),
    db = new MiseDatabase('mise-local:' + base);
  try {
    await db.transaction(
      'rw',
      db.businesses,
      db.outlets,
      db.members,
      db.operatorState,
      async () => {
        await db.businesses.put(config.setup.business);
        await db.outlets.put(config.setup.outlet);
        await db.members.put(config.setup.owner);
        if (config.setup.owner.role === 'manager')
          await db.operatorState.put({
            id: 'active',
            version: 1,
            revision: 1,
            phase: 'active',
            businessId: config.setup.business.id,
            outletId: config.setup.outlet.id,
            actorId: config.setup.owner.id,
            role: 'manager',
            connection: null,
          });
      },
    );
    const connection = {
        apiUrl: config.apiUrl,
        publishableKey: config.publishableKey,
      },
      authKey = await cloudAuthStorageKey(
        connection,
        base + config.setup.business.id,
      );
    localStorage.setItem(cloudConnectionStorageKey, JSON.stringify(connection));
    localStorage.setItem(
      authKey,
      JSON.stringify({
        access_token: config.jwt,
        refresh_token: 'synthetic-device-ui-refresh',
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
window.miseDeviceUiTest = { initialize };
declare global {
  interface Window {
    miseDeviceUiTest: { initialize: typeof initialize };
  }
}
