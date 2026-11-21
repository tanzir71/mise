import { parseScreenSetupLink, type ScreenSetupLink } from './device-access';

export function screenSetupUrl(
  origin: string,
  base: string,
  input: ScreenSetupLink,
): string {
  const root = new URL(origin);
  if (
    root.username ||
    root.password ||
    root.search ||
    root.hash ||
    root.pathname !== '/' ||
    (root.protocol !== 'https:' &&
      !(
        root.protocol === 'http:' &&
        ['127.0.0.1', 'localhost'].includes(root.hostname)
      )) ||
    !base.startsWith('/') ||
    !base.endsWith('/') ||
    base.includes('..') ||
    /[?#\\\s]/.test(base)
  )
    throw Error('Use this installation’s screen setup address.');
  const value = parseScreenSetupLink(input),
    url = new URL(base + 'screen/setup', root);
  url.searchParams.set('flags', 'deviceAccess');
  url.hash = 'mise-screen=' + encodeURIComponent(JSON.stringify(value));
  return url.href;
}
/** Decode only the explicit credential-free setup schema. The app removes the
 * fragment before loading a route or making a request. */
export function decodeScreenSetupHash(hash: string): ScreenSetupLink | null {
  if (!hash) return null;
  if (hash.length > 8192 || !hash.startsWith('#mise-screen='))
    throw Error('Use the complete screen setup link from the owner.');
  try {
    return parseScreenSetupLink(
      JSON.parse(decodeURIComponent(hash.slice('#mise-screen='.length))),
    );
  } catch {
    throw Error('Use the complete screen setup link from the owner.');
  }
}
