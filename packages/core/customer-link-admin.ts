import type { CustomerLinkKind } from './customer-links';

export interface CustomerLinkScope {
  businessId: string;
  outletId: string;
  actorId: string;
  kind: CustomerLinkKind;
  resourceId: string;
}
export interface CustomerLinkSource {
  id: string;
  createEventId: string;
  kind: CustomerLinkKind;
  resourceId: string;
  expiresAt: number | null;
}
export interface CustomerLinkMetadata {
  id: string;
  kind: CustomerLinkKind;
  resourceId: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}
export interface CustomerLinkClosure {
  eventId: string;
  actorId: string;
  at: number;
}
export interface CustomerLinkAttempt {
  id: string;
  kind: CustomerLinkKind;
  resourceId: string;
  createEventId: string;
  state: 'missing' | 'issued' | 'revoked' | 'expired' | 'closed';
  link: CustomerLinkMetadata | null;
  closure: CustomerLinkClosure | null;
}
export interface CustomerLinkPage extends CustomerLinkScope {
  actorRole: 'owner' | 'manager';
  entries: (CustomerLinkMetadata & { createEventId: string | null })[];
  next: string | null;
}
export type CustomerLinkLifecycle =
  | {
      type: 'create';
      source: CustomerLinkSource;
      link: CustomerLinkMetadata | null;
    }
  | {
      type: 'close';
      source: CustomerLinkSource;
      eventId: string;
      link: CustomerLinkMetadata | null;
      closure: CustomerLinkClosure | null;
    };
export interface CustomerLinkJournal {
  v: 1;
  lifecycle: CustomerLinkLifecycle | null;
  revoke: { link: CustomerLinkMetadata; eventId: string } | null;
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string) =>
  Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
export const customerLinkId = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time = (v: unknown): v is number =>
  typeof v === 'number' &&
  Number.isSafeInteger(v) &&
  v >= 0 &&
  v <= 8640000000000000;
const kind = (v: unknown): v is CustomerLinkKind =>
  v === 'order' || v === 'khata';
const invalid = () =>
  Error('Review the original customer link and selected outlet.');
export function parseCustomerLinkScope(
  v: CustomerLinkScope,
): CustomerLinkScope {
  if (
    !record(v) ||
    !exact(v, 'businessId,outletId,actorId,kind,resourceId') ||
    !kind(v.kind) ||
    ![v.businessId, v.outletId, v.actorId, v.resourceId].every(customerLinkId)
  )
    throw invalid();
  return {
    businessId: v.businessId,
    outletId: v.outletId,
    actorId: v.actorId,
    kind: v.kind,
    resourceId: v.resourceId,
  };
}
export function parseCustomerLinkSource(
  v: unknown,
  scope: Pick<CustomerLinkScope, 'kind' | 'resourceId'>,
): CustomerLinkSource {
  if (
    !record(v) ||
    !exact(v, 'id,createEventId,kind,resourceId,expiresAt') ||
    !customerLinkId(v.id) ||
    !customerLinkId(v.createEventId) ||
    v.id === v.createEventId ||
    v.kind !== scope.kind ||
    v.resourceId !== scope.resourceId ||
    (v.expiresAt !== null && !time(v.expiresAt))
  )
    throw invalid();
  return {
    id: v.id,
    createEventId: v.createEventId,
    kind: scope.kind,
    resourceId: scope.resourceId,
    expiresAt: v.expiresAt as number | null,
  };
}
export function parseCustomerLinkMetadata(
  v: unknown,
  scope: Pick<CustomerLinkScope, 'kind' | 'resourceId'>,
): CustomerLinkMetadata {
  if (
    !record(v) ||
    !exact(v, 'id,kind,resourceId,createdAt,expiresAt,revokedAt') ||
    !customerLinkId(v.id) ||
    v.kind !== scope.kind ||
    v.resourceId !== scope.resourceId ||
    !time(v.createdAt) ||
    !time(v.expiresAt) ||
    v.expiresAt <= v.createdAt ||
    v.expiresAt - v.createdAt > 7776000000 ||
    (v.revokedAt !== null && (!time(v.revokedAt) || v.revokedAt < v.createdAt))
  )
    throw invalid();
  return {
    id: v.id,
    kind: scope.kind,
    resourceId: scope.resourceId,
    createdAt: v.createdAt,
    expiresAt: v.expiresAt,
    revokedAt: v.revokedAt as number | null,
  };
}
function closure(v: unknown): CustomerLinkClosure {
  if (
    !record(v) ||
    !exact(v, 'eventId,actorId,at') ||
    !customerLinkId(v.eventId) ||
    !customerLinkId(v.actorId) ||
    !time(v.at)
  )
    throw invalid();
  return { eventId: v.eventId, actorId: v.actorId, at: v.at };
}
function sourceMetadata(
  value: unknown,
  source: CustomerLinkSource,
): CustomerLinkMetadata | null {
  if (value === null) return null;
  const link = parseCustomerLinkMetadata(value, source);
  if (
    link.id !== source.id ||
    (source.expiresAt !== null && link.expiresAt !== source.expiresAt) ||
    (source.expiresAt === null &&
      link.expiresAt - link.createdAt !==
        (source.kind === 'order' ? 604800000 : 2592000000))
  )
    throw invalid();
  return link;
}
export function parseCustomerLinkIssued(
  v: unknown,
  source: CustomerLinkSource,
): CustomerLinkMetadata & { token: string } {
  if (
    !record(v) ||
    !exact(v, 'id,kind,resourceId,createdAt,expiresAt,revokedAt,token') ||
    typeof v.token !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(v.token)
  )
    throw invalid();
  const { token, ...raw } = v,
    link = sourceMetadata(raw, source);
  if (!link || link.revokedAt !== null) throw invalid();
  return { ...link, token };
}
export function parseCustomerLinkAttempt(
  v: unknown,
  source: CustomerLinkSource,
): CustomerLinkAttempt {
  if (
    !record(v) ||
    !exact(v, 'id,kind,resourceId,createEventId,state,link,closure') ||
    v.id !== source.id ||
    v.kind !== source.kind ||
    v.resourceId !== source.resourceId ||
    v.createEventId !== source.createEventId ||
    !['missing', 'issued', 'revoked', 'expired', 'closed'].includes(
      v.state as string,
    )
  )
    throw invalid();
  const link = sourceMetadata(v.link, source),
    closed = v.closure === null ? null : closure(v.closure),
    state = v.state as CustomerLinkAttempt['state'];
  if (
    (state === 'missing' && (link || closed)) ||
    (state === 'closed' && (!closed || link?.revokedAt === null)) ||
    (state !== 'closed' && closed) ||
    (state !== 'missing' && state !== 'closed' && !link) ||
    (state === 'revoked' && link?.revokedAt === null) ||
    (['issued', 'expired'].includes(state) && link?.revokedAt !== null) ||
    (closed &&
      (closed.eventId === source.id ||
        closed.eventId === source.createEventId ||
        (link && closed.at < link.createdAt)))
  )
    throw invalid();
  return {
    id: source.id,
    kind: source.kind,
    resourceId: source.resourceId,
    createEventId: source.createEventId,
    state,
    link,
    closure: closed,
  };
}
export function parseCustomerLinkPage(
  v: unknown,
  scope: CustomerLinkScope,
  after: string | null = null,
  limit = 50,
): CustomerLinkPage {
  const expected = parseCustomerLinkScope(scope);
  if (
    (after !== null && !customerLinkId(after)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !record(v) ||
    !exact(
      v,
      'businessId,outletId,actorId,actorRole,kind,resourceId,entries,next',
    ) ||
    Object.entries(expected).some(([k, value]) => v[k] !== value) ||
    !['owner', 'manager'].includes(v.actorRole as string) ||
    !Array.isArray(v.entries) ||
    v.entries.length > limit ||
    (v.next !== null && !customerLinkId(v.next))
  )
    throw invalid();
  let previous = after;
  const entries = v.entries.map((raw) => {
    if (
      !record(raw) ||
      !exact(
        raw,
        'id,kind,resourceId,createdAt,expiresAt,revokedAt,createEventId',
      ) ||
      (raw.createEventId !== null && !customerLinkId(raw.createEventId))
    )
      throw invalid();
    const { createEventId, ...data } = raw,
      link = parseCustomerLinkMetadata(data, scope);
    if ((previous !== null && link.id <= previous) || createEventId === link.id)
      throw invalid();
    previous = link.id;
    return { ...link, createEventId: createEventId as string | null };
  });
  if (v.next !== null && (entries.length !== limit || v.next !== previous))
    throw invalid();
  return {
    ...expected,
    actorRole: v.actorRole as 'owner' | 'manager',
    entries,
    next: v.next as string | null,
  };
}
/** Local retry evidence contains IDs and metadata only. Never allow a response
 * token, hash, connection, Auth credential or nested extra property into it. */
export function parseCustomerLinkJournal(
  v: unknown,
  scope: CustomerLinkScope,
): CustomerLinkJournal {
  if (!record(v) || !exact(v, 'v,lifecycle,revoke') || v.v !== 1)
    throw invalid();
  let lifecycle: CustomerLinkLifecycle | null = null;
  if (v.lifecycle !== null) {
    const l = v.lifecycle;
    if (
      !record(l) ||
      !['create', 'close'].includes(l.type as string) ||
      !exact(
        l,
        l.type === 'create'
          ? 'type,source,link'
          : 'type,source,eventId,link,closure',
      )
    )
      throw invalid();
    const source = parseCustomerLinkSource(l.source, scope),
      link = sourceMetadata(l.link, source);
    if (l.type === 'create') lifecycle = { type: 'create', source, link };
    else {
      if (
        !customerLinkId(l.eventId) ||
        [source.id, source.createEventId].includes(l.eventId)
      )
        throw invalid();
      const closed = l.closure === null ? null : closure(l.closure);
      if (closed)
        parseCustomerLinkAttempt(
          {
            id: source.id,
            kind: source.kind,
            resourceId: source.resourceId,
            createEventId: source.createEventId,
            state: 'closed',
            link,
            closure: closed,
          },
          source,
        );
      lifecycle = {
        type: 'close',
        source,
        eventId: l.eventId,
        link,
        closure: closed,
      };
    }
  }
  let revoke: CustomerLinkJournal['revoke'] = null;
  if (v.revoke !== null) {
    const r = v.revoke;
    if (!record(r) || !exact(r, 'link,eventId') || !customerLinkId(r.eventId))
      throw invalid();
    const link = parseCustomerLinkMetadata(r.link, scope);
    if (r.eventId === link.id) throw invalid();
    revoke = { link, eventId: r.eventId };
  }
  return { v: 1, lifecycle, revoke };
}
