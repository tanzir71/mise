import {parseStaffDeviceAccess, isDeviceId, type StaffDeviceAccess} from './device-access';
import {ulid} from 'ulid';
import {orderPricing} from './order-lines';
import {changeOrderStatusCommand, nextOrderStatuses, validateOrder, type OrderFlowSource} from './orders';
import {isKitchenPreparation,kitchenAlarmStart} from './kitchen-preparation';
import type {AuditEvent, Order, OrderLine, OrderStatus} from './models';
import type {ShopSetup} from './shop-access';

export type KitchenActionKind = 'kitchen.acknowledge' | 'kitchen.ready';
export type KitchenLine = Pick<OrderLine, 'id'|'itemId'|'name'|'unit'|'qty'|'note'|'unavailable'> & {
  substitution?: OrderLine['substitution'] | null;
};
/** A shared screen has preparation data, never a fabricated full Order with
 * made-up prices, customer details or payments. Full Orders remain compatible. */
export type KitchenSource = Pick<Order, 'id'|'outletId'|'businessType'|'number'|'table'|'scheduledFor'|'status'> & {
  type: OrderFlowSource['type'];
  source: Order['source'] | 'counter'|'link'|'whatsapp'|'messenger'|'foodpanda'|'pathao';
  lines: KitchenLine[];
};
export type KitchenActionSource = KitchenSource & Pick<Order, 'revision'>;
export type KitchenClockSource = KitchenActionSource & Pick<Order, 'createdAt'>;
export interface KitchenAction {
  v: 1;
  id: string;
  type: KitchenActionKind;
  outletId: string;
  orderId: string;
  revision: number;
  contentHash: string;
  occurredAt: number;
  parentAckId: string | null;
  transitionEventIds: [string, string, string];
}
/** A receipt contains identities and preparation metadata, never credentials,
 * customer/contact fields, source messages, prices or full order images. */
export interface KitchenReceipt {
  v: 1;
  id: string;
  type: KitchenActionKind;
  businessId: string;
  outletId: string;
  orderId: string;
  deviceId: string;
  sessionId: string;
  memberId: string;
  sourceRevision: number;
  revision: number;
  contentHash: string;
  parentAckId: string | null;
  occurredAt: number;
  acceptedAt: number;
  status: OrderStatus;
  transitionEventIds: string[];
}
export class KitchenActionConflict extends Error {}
export class KitchenActionDenied extends Error {}

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 8640000000000000;
const revision = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v < Number.MAX_SAFE_INTEGER;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const invalid = () => new KitchenActionConflict('Keep the original ticket and tap. Refresh before continuing.');

export function newKitchenId(at = Date.now()) {if (!time(at)) throw invalid(); return ulid(at);}

/** Normalize once before storing or sending. In particular, a caller cannot
 * attach a member, permission, status, financial mutation or new order image. */
export function parseKitchenAction(value: unknown): KitchenAction {
  if (!object(value) || !exact(value, 'v,id,type,outletId,orderId,revision,contentHash,occurredAt,parentAckId,transitionEventIds') || value.v !== 1 ||
      ![value.id, value.outletId, value.orderId].every(isDeviceId) || !['kitchen.acknowledge', 'kitchen.ready'].includes(value.type as string) ||
      !revision(value.revision) || !hash(value.contentHash) || !time(value.occurredAt) ||
      (value.type === 'kitchen.acknowledge' ? value.parentAckId !== null : !isDeviceId(value.parentAckId)) ||
      !Array.isArray(value.transitionEventIds) || value.transitionEventIds.length !== 3 || !value.transitionEventIds.every(isDeviceId)) throw invalid();
  const ids = [value.id, value.outletId, value.orderId, ...value.transitionEventIds, ...(value.parentAckId === null ? [] : [value.parentAckId])];
  if (new Set(ids).size !== ids.length) throw invalid();
  return {v: 1, id: value.id as string, type: value.type as KitchenActionKind, outletId: value.outletId as string,
    orderId: value.orderId as string, revision: value.revision, contentHash: value.contentHash, occurredAt: value.occurredAt,
    parentAckId: value.parentAckId as string | null, transitionEventIds: [...value.transitionEventIds] as [string, string, string]};
}

function kitchenLine(line: KitchenLine) {
  return {id: line.id, itemId: line.itemId ?? null, name: line.name, unit: line.unit, qty: line.qty, note: line.note,
    unavailable: line.unavailable, substitution: line.substitution ? {
      from: line.substitution.from, accepted: line.substitution.accepted, acceptedAt: line.substitution.acceptedAt ?? null,
    } : null};
}
/** The same visible preparation content can survive a price, contact, payment
 * or ordinary status edit. Changes to items, swaps, schedule or table cannot.
 * JSON escaping preserves NUL and lone UTF-16 code units before UTF-8 hashing. */
export function kitchenContent(order: KitchenSource) {
  return {v: 1, orderId: order.id, outletId: order.outletId, businessType: order.businessType, number: order.number,
    type: order.type, source: order.source, table: order.table, scheduledFor: order.scheduledFor ?? null,
    cancelled: order.status === 'cancelled', lines: order.lines.map(kitchenLine)};
}
async function fingerprint(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export const kitchenContentHash = (order: KitchenSource) => fingerprint(kitchenContent(order));
export const kitchenActionHash = (action: KitchenAction) => fingerprint(parseKitchenAction(action));

/** Capture fields, full visible content and all identities before the hash can
 * yield. These are retained unchanged when a tap waits offline or is retried. */
export async function prepareKitchenAction(order: KitchenActionSource, type: KitchenActionKind, parentAckId: string | null = null,
  occurredAt = Date.now(), newId: () => string = () => newKitchenId(occurredAt)): Promise<KitchenAction> {
  const content = kitchenContent(order);
  const original = {v: 1, id: newId(), type, outletId: order.outletId, orderId: order.id, revision: order.revision,
    occurredAt, parentAckId, transitionEventIds: [newId(), newId(), newId()]};
  return parseKitchenAction({...original, contentHash: await fingerprint(content)});
}

const readyStages = {
  restaurant: ['confirmed', 'kitchen_seen', 'cooking', 'ready'],
  online_shop: ['confirmed', 'packed'],
  food_stall: ['ordered', 'making', 'ready_called'],
  corner_shop: ['accepted', 'packing', 'ready'],
} as const;
/** Never infer commercial confirmation from a kitchen tap. Every returned step
 * must also be the actual next step of the existing business order flow. */
export function kitchenReadyPath(order: OrderFlowSource): OrderStatus[] | null {
  const stages: readonly OrderStatus[] = readyStages[order.businessType] ?? [];
  const at = stages.indexOf(order.status);
  if (at < 0) return null;
  const result = stages.slice(at + 1);
  let current = order;
  for (const status of result) {
    if (!nextOrderStatuses(current).includes(status)) return null;
    current = {...current, status};
  }
  return result;
}

/** A receipt may acknowledge an unpriced or pre-confirmation ticket. A status
 * advance is optional and must not prevent recording that it was seen. */
function acknowledgementPath(order: Order): OrderStatus[] {
  if (!orderPricing(order.lines, order.deliveryFee, order.discount).complete) return [];
  if (order.businessType === 'restaurant' && order.status === 'confirmed') return ['kitchen_seen'];
  if (order.businessType === 'food_stall' && order.status === 'ordered') return ['making'];
  if (order.businessType === 'corner_shop' && order.status === 'accepted') return ['packing'];
  return [];
}

/** A server or cached-screen hint only; live authority and state are rechecked
 * on admission. Scheduled work starts its acknowledgement clock when due. */
export async function kitchenAlarm(order: KitchenClockSource, acknowledgement: KitchenReceipt | null, now: number, warningMinutes: number | null = null) {
  const minutes = warningMinutes ?? 2;
  if (!time(now) || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440 || !time(order.createdAt) ||
      order.scheduledFor !== undefined && !time(order.scheduledFor)) throw invalid();
  const start = kitchenAlarmStart(order);
  const dueAt = start + minutes * 60000;
  if (!time(dueAt)) throw invalid();
  const ack = acknowledgement === null ? null : parseKitchenReceipt(acknowledgement);
  const matchingAck = ack?.type === 'kitchen.acknowledge' && ack.orderId === order.id &&
    ack.outletId === order.outletId && ack.revision <= order.revision && ack.acceptedAt <= now &&
    ack.contentHash === await kitchenContentHash(order);
  return {dueAt, active: isKitchenPreparation(order) && !matchingAck && now >= dueAt};
}

export function parseKitchenReceipt(value: unknown, expected?: {action: KitchenAction; access?: StaffDeviceAccess}): KitchenReceipt {
  if (!object(value) || !exact(value, 'v,id,type,businessId,outletId,orderId,deviceId,sessionId,memberId,sourceRevision,revision,contentHash,parentAckId,occurredAt,acceptedAt,status,transitionEventIds') || value.v !== 1 ||
      ![value.id, value.businessId, value.outletId, value.orderId, value.deviceId, value.sessionId, value.memberId].every(isDeviceId) ||
      !['kitchen.acknowledge', 'kitchen.ready'].includes(value.type as string) || !revision(value.sourceRevision) || !revision(value.revision) || value.revision < value.sourceRevision ||
      !hash(value.contentHash) || !time(value.occurredAt) || !time(value.acceptedAt) || value.occurredAt > value.acceptedAt + 300000 ||
      (value.type === 'kitchen.acknowledge' ? value.parentAckId !== null : !isDeviceId(value.parentAckId)) ||
      typeof value.status !== 'string' || !['new','confirmed','kitchen_seen','cooking','ready','out','delivered','to_confirm','packed','booked','with_courier','returning','returned','ordered','making','ready_called','collected','requested','priced','accepted','packing','delivering','done','cancelled'].includes(value.status) ||
      !Array.isArray(value.transitionEventIds) || value.transitionEventIds.length > 3 || !value.transitionEventIds.every(isDeviceId) ||
      new Set([value.id, ...value.transitionEventIds]).size !== value.transitionEventIds.length + 1) throw invalid();
  const result = {...value, transitionEventIds: [...value.transitionEventIds]} as unknown as KitchenReceipt;
  if (expected) {
    const a = parseKitchenAction(expected.action), access = expected.access === undefined ? null : parseStaffDeviceAccess(expected.access);
    if (result.id !== a.id || result.type !== a.type || result.orderId !== a.orderId || result.outletId !== a.outletId ||
        access && (result.businessId !== access.businessId || result.outletId !== access.outletId || result.deviceId !== access.deviceId ||
        result.sessionId !== access.sessionId || result.memberId !== access.memberId) || result.sourceRevision !== a.revision ||
        result.contentHash !== a.contentHash || result.parentAckId !== a.parentAckId || result.occurredAt !== a.occurredAt ||
        result.transitionEventIds.some((id, i) => a.transitionEventIds[i] !== id)) throw invalid();
  }
  return result;
}

/** Pure replay after the server derives current access from BOTH device/session
 * secrets. Structural access validation is not authentication. Neither the HTTP
 * caller's role nor a cached session can supply this authority.
 *
 * Full order/audit images are server-internal. Only receipt is safe to return to
 * a shared screen. Durable deduplication and the final snapshot/access recheck
 * belong to the database transaction, not this calculation. */
export async function applyKitchenAction(input: {
  order: Order; shop: Pick<ShopSetup, 'business' | 'outlet'>; access: StaffDeviceAccess;
  action: KitchenAction; admittedAt: number; acknowledgement: KitchenReceipt | null;
}): Promise<{order: Order; events: AuditEvent[]; receipt: KitchenReceipt}> {
  const action = parseKitchenAction(input.action), access = parseStaffDeviceAccess(input.access), before = input.order;
  if (!time(input.admittedAt) || access.expiresAt <= input.admittedAt || !access.permissions.includes('orders.read') ||
      !access.permissions.includes(action.type === 'kitchen.acknowledge' ? 'orders.acknowledge' : 'orders.ready') ||
      access.businessId !== input.shop.business.id || access.outletId !== input.shop.outlet.id ||
      input.shop.outlet.businessId !== access.businessId || action.outletId !== access.outletId || before.outletId !== access.outletId) {
    throw new KitchenActionDenied('Sign in on the original screen with current preparation access.');
  }
  // The legacy domain setup's owner field attributes commands to the verified
  // member. It carries no owner role or Auth identity and grants no HTTP access.
  const setup: ShopSetup = {...input.shop, owner: {id: access.memberId, businessId: access.businessId, active: true, outletIds: [access.outletId]}};
  validateOrder(before, setup, before.revision);
  if(before.status!=='cancelled'&&!isKitchenPreparation(before))throw invalid();
  if (before.id !== action.orderId || before.businessType !== input.shop.business.businessType || before.revision < action.revision || action.occurredAt > input.admittedAt + 300000 ||
      action.contentHash !== await kitchenContentHash(before)) throw invalid();
  let path: OrderStatus[];
  if (action.type === 'kitchen.acknowledge') {
    path = acknowledgementPath(before);
  } else {
    const ack = input.acknowledgement === null ? null : parseKitchenReceipt(input.acknowledgement);
    if (!ack || ack.id !== action.parentAckId || ack.type !== 'kitchen.acknowledge' || ack.businessId !== access.businessId ||
        ack.outletId !== action.outletId || ack.orderId !== action.orderId || ack.contentHash !== action.contentHash ||
        ack.revision > before.revision || ack.acceptedAt > input.admittedAt) throw invalid();
    const ready = kitchenReadyPath(before);
    if (ready === null || !orderPricing(before.lines, before.deliveryFee, before.discount).complete) throw invalid();
    path = ready;
  }
  let order = before;
  const events: AuditEvent[] = [];
  path.forEach((status, index) => {
    const result = changeOrderStatusCommand(order, status, setup, order.revision,
      Math.max(input.admittedAt, order.createdAt, order.updatedAt, order.statusChangedAt), () => action.transitionEventIds[index]);
    order = result.order;
    result.event.at = input.admittedAt;
    events.push(result.event);
  });
  const receipt: KitchenReceipt = {v: 1, id: action.id, type: action.type, businessId: access.businessId,
    outletId: action.outletId, orderId: action.orderId, deviceId: access.deviceId, sessionId: access.sessionId, memberId: access.memberId,
    sourceRevision: action.revision, revision: order.revision, contentHash: action.contentHash, parentAckId: action.parentAckId,
    occurredAt: action.occurredAt, acceptedAt: input.admittedAt, status: order.status, transitionEventIds: events.map(event => event.id)};
  parseKitchenReceipt(receipt, {action, access});
  events.push({id: action.id, outletId: action.outletId, orderId: action.orderId, orderRevision: order.revision,
    actor: {type: 'member', id: access.memberId}, command: action.type, before: null, after: receipt, at: input.admittedAt});
  return {order, events, receipt};
}
