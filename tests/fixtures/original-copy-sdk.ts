// Actual Supabase SDK with a controlled Auth HTTP boundary; never shipped.
import {
  cloudAuthStorageKey,
  saveCloudConnection,
  type CloudConnection,
  type KeyStorage,
} from '../../packages/core/cloud-connection';
import { createPhoneAuth } from '../../apps/web/src/data/phone-auth';
export class CopySdkStorage implements KeyStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
export const copySdkSubject = (n = 1) =>
  '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
export async function createCopySdk(
  config: CloudConnection,
  scope: string,
  copy: typeof fetch,
  n = 1,
  storage: KeyStorage = new CopySdkStorage(),
) {
  const user = {
    id: copySdkSubject(n),
    aud: 'authenticated',
    role: 'authenticated',
    phone: '880171234548' + n,
    phone_confirmed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    app_metadata: { provider: 'phone' },
    user_metadata: { role: 'owner' },
    is_anonymous: false,
  };
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
  const access = [
    encode({ alg: 'HS256', typ: 'JWT' }),
    encode({
      sub: user.id,
      session_id: copySdkSubject(n + 100),
      role: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 3600,
      phone: user.phone,
    }),
    'synthetic-copy-test-signature',
  ].join('.');
  const saved = {
    access_token: access,
    refresh_token: 'synthetic-copy-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user,
  };
  const key = await cloudAuthStorageKey(config, scope);
  saveCloudConnection(storage, config);
  storage.setItem(key, JSON.stringify(saved));
  let online = true,
    confirmed = true;
  const calls: { path: string; authorization: string | null }[] = [];
  let beforeCopy: ((op: string) => Promise<void>) | undefined,
    afterCopy: ((op: string) => Promise<void>) | undefined,
    afterUser: (() => Promise<void>) | undefined;
  const send: typeof fetch = async (url, init = {}) => {
    const target = new URL(String(url)),
      headers = new Headers(init.headers),
      path = target.pathname;
    calls.push({ path, authorization: headers.get('Authorization') });
    if (!online) return new Response('{}', { status: 503 });
    if (target.origin !== config.apiUrl) throw Error('Unexpected test target.');
    if (path === '/auth/v1/user') {
      if (headers.get('Authorization') !== 'Bearer ' + access)
        return new Response('{}', { status: 401 });
      const response = new Response(
        JSON.stringify({
          ...user,
          phone_confirmed_at: confirmed ? user.phone_confirmed_at : null,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
      await afterUser?.();
      return response;
    }
    if (path === '/functions/v1/native-original-copy') {
      const op = headers.get('X-Mise-Original-Action')!;
      await beforeCopy?.(op);
      const response = await copy(url, init);
      await afterCopy?.(op);
      return response;
    }
    if (path === '/auth/v1/logout') return new Response('{}');
    throw Error('Unexpected SDK fixture request: ' + path);
  };
  const auth = await createPhoneAuth(config, scope, { storage, send });
  await auth.check();
  return {
    auth,
    storage,
    send,
    access,
    saved,
    key,
    calls,
    setOnline(value: boolean) {
      online = value;
    },
    setConfirmed(value: boolean) {
      confirmed = value;
    },
    beforeCopy(value?: typeof beforeCopy) {
      beforeCopy = value;
    },
    afterCopy(value?: typeof afterCopy) {
      afterCopy = value;
    },
    afterUser(value?: typeof afterUser) {
      afterUser = value;
    },
  };
}
