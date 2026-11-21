import {isDeviceId, parseStaffDeviceAccess, type SharedDevice, type StaffDeviceSession, type StaffDeviceAccess} from './device-access';
import {kitchenContentHash, parseKitchenReceipt, type KitchenActionSource, type KitchenLine, type KitchenReceipt} from './kitchen';
import {orderFlows} from './orders';
import type {Order} from './models';

export interface KitchenTicket extends KitchenActionSource {
  createdAt: number;
  updatedAt: number;
  statusChangedAt: number;
  timezone: string;
  contentHash: string;
  priced: boolean;
  acknowledgement: KitchenReceipt | null;
}
export interface KitchenCursor {createdAt: number; id: string}
export interface KitchenPage {
  v: 1;
  access: StaffDeviceAccess;
  outletName: string;
  at: number;
  warningMinutes: number;
  watermark: number;
  tickets: KitchenTicket[];
  next: KitchenCursor | null;
}
export interface KitchenChanges extends Omit<KitchenPage, 'next'> {nextSeq: number; removed: string[]}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 8640000000000000;
const ordinal = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const invalid = () => Error('Keep the complete preparation ticket in its original screen and outlet.');
export function parseKitchenCursor(value: unknown): KitchenCursor | null {
  if (value === null) return null;
  if (!object(value) || !exact(value, 'createdAt,id') || !time(value.createdAt) || !isDeviceId(value.id)) throw invalid();
  return {createdAt: value.createdAt, id: value.id};
}
/** Strict client/cache parser: no customer, source-message, price or payment
 * field is accepted, including an extra field hidden inside an order line. */
export function parseKitchenLines(value: unknown): KitchenLine[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) throw invalid();
  const seen = new Set<string>();
  return value.map(line => {
    if (!object(line) || !exact(line, 'id,itemId,name,unit,qty,note,unavailable,substitution') || !isDeviceId(line.id) ||
        seen.has(line.id) || line.itemId !== null && !isDeviceId(line.itemId) || typeof line.name !== 'string' || typeof line.unit !== 'string' ||
        typeof line.note !== 'string' || typeof line.unavailable !== 'boolean' || typeof line.qty !== 'number' || !Number.isFinite(line.qty) || line.qty <= 0 || line.qty > 999999) throw invalid();
    seen.add(line.id);
    let substitution: KitchenLine['substitution'] = null;
    if (line.substitution !== null) {
      const s = line.substitution;
      if (!object(s) || !exact(s, 'from,accepted,acceptedAt') || typeof s.from !== 'string' || typeof s.accepted !== 'boolean' || s.acceptedAt !== null && !time(s.acceptedAt)) throw invalid();
      substitution = {from: s.from, accepted: s.accepted, ...(s.acceptedAt === null ? {} : {acceptedAt: s.acceptedAt})};
    }
    return {id: line.id, ...(line.itemId === null ? {} : {itemId: line.itemId as string}), name: line.name, unit: line.unit, qty: line.qty, note: line.note, unavailable: line.unavailable, substitution};
  });
}
/** The transport has explicit nulls so native copies cannot silently change the
 * visible-content hash by dropping optional keys. */
export function kitchenLineWire(lines: KitchenLine[]) {
  return lines.map(line => ({id: line.id, itemId: line.itemId ?? null, name: line.name, unit: line.unit, qty: line.qty,
    note: line.note, unavailable: line.unavailable, substitution: line.substitution ? {
      from: line.substitution.from, accepted: line.substitution.accepted, acceptedAt: line.substitution.acceptedAt ?? null,
    } : null}));
}
export function kitchenTicketWire(ticket: KitchenTicket) {
  return {id:ticket.id,outletId:ticket.outletId,businessType:ticket.businessType,number:ticket.number,type:ticket.type,source:ticket.source,
    table:ticket.table,scheduledFor:ticket.scheduledFor??null,status:ticket.status,lines:kitchenLineWire(ticket.lines),revision:ticket.revision,
    createdAt:ticket.createdAt,updatedAt:ticket.updatedAt,statusChangedAt:ticket.statusChangedAt,timezone:ticket.timezone,
    contentHash:ticket.contentHash,priced:ticket.priced,acknowledgement:ticket.acknowledgement};
}
export async function parseKitchenTicket(value: unknown, access: StaffDeviceAccess, at: number): Promise<KitchenTicket> {
  if (!object(value) || !exact(value, 'id,outletId,businessType,number,type,source,table,scheduledFor,status,lines,revision,createdAt,updatedAt,statusChangedAt,timezone,contentHash,priced,acknowledgement') ||
      !isDeviceId(value.id) || value.outletId !== access.outletId || !Object.hasOwn(orderFlows, value.businessType as string) ||
      typeof value.number !== 'string' || !['delivery','pickup','dine_in','counter'].includes(value.type as string) ||
      !['phone','walk_in','table','paste','other','counter','link','whatsapp','messenger','foodpanda','pathao'].includes(value.source as string) ||
      typeof value.table !== 'string' || value.scheduledFor !== null && !time(value.scheduledFor) ||
      !ordinal(value.revision) || !time(value.createdAt) || !time(value.updatedAt) || !time(value.statusChangedAt) ||
      typeof value.timezone !== 'string' || !value.timezone || typeof value.priced !== 'boolean' || typeof value.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.contentHash)) throw invalid();
  const businessType = value.businessType as Order['businessType'], status = value.status as Order['status'];
  if (status !== 'cancelled' && !orderFlows[businessType].includes(status)) throw invalid();
  const ticket: KitchenTicket = {id: value.id, outletId: access.outletId, businessType, number: value.number, type: value.type as KitchenTicket['type'],
    source: value.source as KitchenTicket['source'], table: value.table, ...(value.scheduledFor === null ? {} : {scheduledFor: value.scheduledFor as number}),
    status, lines: parseKitchenLines(value.lines), revision: value.revision, createdAt: value.createdAt, updatedAt: value.updatedAt,
    statusChangedAt: value.statusChangedAt, timezone: value.timezone, contentHash: value.contentHash, priced: value.priced, acknowledgement: null};
  if (await kitchenContentHash(ticket) !== ticket.contentHash) throw invalid();
  if (value.acknowledgement !== null) {
    const ack = parseKitchenReceipt(value.acknowledgement);
    if (ack.type !== 'kitchen.acknowledge' || ack.businessId !== access.businessId || ack.outletId !== access.outletId || ack.orderId !== ticket.id ||
        ack.contentHash !== ticket.contentHash || ack.revision > ticket.revision || ack.acceptedAt > at) throw invalid();
    ticket.acknowledgement = ack;
  }
  return ticket;
}
export async function parseKitchenPage(value: unknown, expected: {device: SharedDevice; session: StaffDeviceSession}, after: KitchenCursor | null = null, limit = 50): Promise<KitchenPage> {
  if (!object(value) || !exact(value, 'v,access,outletName,at,warningMinutes,watermark,tickets,next') || value.v !== 1 ||
      typeof value.outletName !== 'string' || !time(value.at) || typeof value.warningMinutes !== 'number' || !Number.isInteger(value.warningMinutes) ||
      value.warningMinutes < 1 || value.warningMinutes > 1440 || typeof value.watermark !== 'number' || !Number.isSafeInteger(value.watermark) || value.watermark < 0 ||
      !Array.isArray(value.tickets) || !Number.isInteger(limit) || limit < 1 || limit > 100 || value.tickets.length > limit) throw invalid();
  const access = parseStaffDeviceAccess(value.access, expected), cursor = parseKitchenCursor(after), next = parseKitchenCursor(value.next);
  if (!access.permissions.includes('orders.read') || access.expiresAt <= value.at) throw invalid();
  const tickets: KitchenTicket[] = [];
  let previous = cursor;
  for (const row of value.tickets) {
    const ticket = await parseKitchenTicket(row, access, value.at);
    if (previous && (ticket.createdAt < previous.createdAt || ticket.createdAt === previous.createdAt && ticket.id <= previous.id)) throw invalid();
    tickets.push(ticket); previous = {createdAt: ticket.createdAt, id: ticket.id};
  }
  if (next && (!previous || !tickets.length || next.id !== previous.id || next.createdAt !== previous.createdAt)) throw invalid();
  return {v: 1, access, outletName: value.outletName, at: value.at, warningMinutes: value.warningMinutes, watermark: value.watermark, tickets, next};
}
export async function parseKitchenChanges(value: unknown, expected: {device: SharedDevice; session: StaffDeviceSession}, after: number, until: number | null = null, limit = 50): Promise<KitchenChanges> {
  if (!object(value) || !exact(value, 'v,access,outletName,at,warningMinutes,watermark,tickets,nextSeq,removed') ||
      !Number.isSafeInteger(after) || after < 0 || typeof value.nextSeq !== 'number' || !Number.isSafeInteger(value.nextSeq) ||
      value.nextSeq < after || typeof value.watermark !== 'number' || value.nextSeq > value.watermark || value.watermark > after && value.nextSeq === after ||
      until !== null && value.watermark !== until || !Array.isArray(value.removed) || !value.removed.every(isDeviceId) ||
      new Set(value.removed).size !== value.removed.length) throw invalid();
  const page = await parseKitchenPage({v: value.v, access: value.access, outletName: value.outletName, at: value.at, warningMinutes: value.warningMinutes,
    watermark: value.watermark, tickets: value.tickets, next: null}, expected, null, limit);
  if (page.tickets.length + value.removed.length > limit || value.removed.some(id => page.tickets.some(ticket => ticket.id === id))) throw invalid();
  return {v: 1, access: page.access, outletName: page.outletName, at: page.at, warningMinutes: page.warningMinutes, watermark: page.watermark,
    tickets: page.tickets, nextSeq: value.nextSeq, removed: [...value.removed]};
}
