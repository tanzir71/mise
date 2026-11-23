import type { CustomerLinkKind } from './customer-links';
export interface CustomerViewerLink {
  v: 1;
  apiUrl: string;
  kind: CustomerLinkKind;
  token: string;
}
/** Messaging apps need a well-formed URL. Keep literal text available to Copy
 * when an imported UTF-16 source cannot be represented in a deep link. */
export function customerWhatsAppUrl(
  phone: string,
  text: string,
): string | null {
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) return null;
  try {
    return (
      'https://wa.me/' + phone.slice(1) + '?text=' + encodeURIComponent(text)
    );
  } catch {
    return null;
  }
}
const invalid = () => Error('Open the complete current link from the shop.');
export function customerApiOrigin(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    value !== value.trim()
  )
    throw invalid();
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw invalid();
  }
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== '/' ||
    (u.protocol !== 'https:' &&
      !(
        u.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(u.hostname)
      ))
  )
    throw invalid();
  return u.origin;
}
function appBase(base: string) {
  if (
    !base.startsWith('/') ||
    base.startsWith('//') ||
    !base.endsWith('/app/') ||
    base.includes('..') ||
    /[?#\\\s]/.test(base)
  )
    throw invalid();
  return base;
}
export function customerViewerUrl(
  origin: string,
  base: string,
  source: { apiUrl: string; kind: CustomerLinkKind; token: string },
  options?:{checkout?:boolean},
): string {
  const site = customerApiOrigin(origin),
    apiUrl = customerApiOrigin(source.apiUrl);
  appBase(base);
  if (
    !['order', 'khata'].includes(source.kind) ||
    typeof source.token !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(source.token)
  )
    throw invalid();
  const url = new URL(
    base + (source.kind === 'order' ? 't/' : 'k/') + source.token,
    site,
  );
  url.searchParams.set('flags', options?.checkout&&source.kind==='order'?'customerLinks,publicOrders':'customerLinks');
  // This installation's public API origin is runtime link data. No publishable
  // key, owner JWT, service credential, private ID or phone enters the link.
  url.hash =
    'mise-customer=' + encodeURIComponent(JSON.stringify({ v: 1, apiUrl }));
  return url.href;
}
export function decodeCustomerViewer(
  pathname: string,
  hash: string,
  base: string,
): CustomerViewerLink {
  appBase(base);
  if (
    !pathname.startsWith(base) ||
    hash.length > 8192 ||
    !hash.startsWith('#mise-customer=')
  )
    throw invalid();
  const match = /^([tk])\/([A-Za-z0-9_-]{43})\/?$/.exec(
    pathname.slice(base.length),
  );
  if (!match) throw invalid();
  let v: unknown;
  try {
    v = JSON.parse(decodeURIComponent(hash.slice('#mise-customer='.length)));
  } catch {
    throw invalid();
  }
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).sort().join(',') !== 'apiUrl,v' ||
    (v as Record<string, unknown>).v !== 1
  )
    throw invalid();
  return {
    v: 1,
    kind: match[1] === 't' ? 'order' : 'khata',
    token: match[2],
    apiUrl: customerApiOrigin((v as Record<string, unknown>).apiUrl),
  };
}
