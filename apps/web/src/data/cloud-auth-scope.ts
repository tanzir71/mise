import {
  cloudAuthStorageKey,
  type CloudConnection,
} from '@mise/core/cloud-connection';
import { operatorAuthKey, operatorId } from '@mise/core/operators';

/** A new device signs in before it knows a business. Tokens stay in Auth storage. */
export const discoveryAuthScope = (base: string) => base + 'join';
/** Accept only the existing owner namespace or this installation's discovery namespace. */
export async function resolveCloudAuthScope(
  config: CloudConnection,
  base: string,
  businessId: string,
  expectedKey?: string | null,
): Promise<string> {
  if (
    !operatorId(businessId) ||
    (expectedKey != null && !operatorAuthKey(expectedKey))
  )
    throw new Error('Review the original device sign-in.');
  const business = base + businessId;
  if (
    expectedKey == null ||
    expectedKey === (await cloudAuthStorageKey(config, business))
  )
    return business;
  const discovery = discoveryAuthScope(base);
  if (expectedKey === (await cloudAuthStorageKey(config, discovery)))
    return discovery;
  throw new Error('Review the original connection and device sign-in.');
}
