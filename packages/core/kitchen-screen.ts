import {isDeviceId, parseStaffDeviceAccess, type StaffDeviceAccess} from './device-access';
import {parseKitchenAction, parseKitchenReceipt, type KitchenAction, type KitchenReceipt} from './kitchen';
import {kitchenTicketWire, parseKitchenCursor, parseKitchenTicket, type KitchenChanges, type KitchenCursor, type KitchenPage, type KitchenTicket} from './kitchen-tickets';

export interface KitchenTap {
  position: number;
  access: StaffDeviceAccess;
  observedAt: number;
  source: KitchenTicket;
  action: KitchenAction;
  receipt: KitchenReceipt | null;
  review: boolean;
}
/** No device/PIN/session secrets, owner Auth, prices or customer records. A
 * profile is retained under its enrolled device even after sign-out/removal. */
export interface KitchenScreenState {
  v: 1;
  id: string;
  revision: string;
  access: StaffDeviceAccess;
  at: number;
  outletName: string;
  warningMinutes: number;
  after: KitchenCursor | null;
  bootstrapWatermark: number | null;
  cursor: number | null;
  until: number | null;
  tickets: KitchenTicket[];
  nextPosition: number;
  taps: KitchenTap[];
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const sequence = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const time = (v: unknown): v is number => sequence(v) && v <= 8640000000000000;
const invalid = () => Error('Keep this screen’s original tickets and saved taps. Reopen its current setup.');
export function sameKitchenSession(a: StaffDeviceAccess, b: StaffDeviceAccess) {
  return ['deviceId','businessId','outletId','sessionId','memberId','mode','expiresAt'].every(key => a[key as keyof StaffDeviceAccess] === b[key as keyof StaffDeviceAccess]);
}
export function kitchenScreenWire(state: KitchenScreenState) {
  return {...state, tickets: state.tickets.map(kitchenTicketWire), taps: state.taps.map(tap => ({...tap, source: kitchenTicketWire(tap.source)}))};
}
export async function parseKitchenScreenState(value: unknown): Promise<KitchenScreenState> {
  if (!object(value) || !exact(value, 'v,id,revision,access,at,outletName,warningMinutes,after,bootstrapWatermark,cursor,until,tickets,nextPosition,taps') ||
      value.v !== 1 || !isDeviceId(value.id) || !isDeviceId(value.revision) || !time(value.at) || typeof value.outletName !== 'string' ||
      typeof value.warningMinutes !== 'number' || !Number.isInteger(value.warningMinutes) || value.warningMinutes < 1 || value.warningMinutes > 1440 ||
      ![value.bootstrapWatermark,value.cursor,value.until].every(v => v === null || sequence(v)) || !Array.isArray(value.tickets) || !Array.isArray(value.taps) ||
      !sequence(value.nextPosition) || value.nextPosition < 1) throw invalid();
  const access = parseStaffDeviceAccess(value.access);
  if (access.deviceId !== value.id || !access.permissions.includes('orders.read') ||
      value.cursor === null && value.until !== null || value.cursor !== null && (value.after !== null || value.bootstrapWatermark !== null) ||
      typeof value.until === 'number' && typeof value.cursor === 'number' && value.until < value.cursor ||
      value.after !== null && value.bootstrapWatermark === null) throw invalid();
  const tickets: KitchenTicket[] = [], taps: KitchenTap[] = [], ids = new Set<string>();
  for (const row of value.tickets) {
    const ticket = await parseKitchenTicket(row, access, value.at);
    if (ids.has(ticket.id)) throw invalid();
    ids.add(ticket.id); tickets.push(ticket);
  }
  let position = 0;
  const actionIds = new Set<string>();
  for (const raw of value.taps) {
    if (!object(raw) || !exact(raw, 'position,access,observedAt,source,action,receipt,review') || !sequence(raw.position) || raw.position <= position ||
        raw.position >= value.nextPosition || !time(raw.observedAt) || typeof raw.review !== 'boolean') throw invalid();
    const actor = parseStaffDeviceAccess(raw.access), action = parseKitchenAction(raw.action);
    if (actor.deviceId !== access.deviceId || actor.businessId !== access.businessId || actor.outletId !== access.outletId ||
        !actor.permissions.includes(action.type === 'kitchen.acknowledge' ? 'orders.acknowledge' : 'orders.ready') || actionIds.has(action.id)) throw invalid();
    const source = await parseKitchenTicket(raw.source, actor, raw.observedAt);
    if (action.orderId !== source.id || action.outletId !== source.outletId || action.revision !== source.revision || action.contentHash !== source.contentHash) throw invalid();
    const receipt = raw.receipt === null ? null : parseKitchenReceipt(raw.receipt, {action, access: actor});
    if (action.type === 'kitchen.ready') {
      const ack = source.acknowledgement;
      const parent = taps.find(tap => tap.action.id === action.parentAckId);
      if (!(ack && ack.id === action.parentAckId && ack.contentHash === action.contentHash) &&
          !(parent && sameKitchenSession(parent.access, actor) && parent.action.type === 'kitchen.acknowledge' && parent.action.orderId === action.orderId && parent.action.contentHash === action.contentHash)) throw invalid();
    }
    position = raw.position; actionIds.add(action.id);
    taps.push({position, access: actor, observedAt: raw.observedAt, source, action, receipt, review: raw.review});
  }
  return {v: 1, id: value.id, revision: value.revision, access, at: value.at, outletName: value.outletName, warningMinutes: value.warningMinutes,
    after: parseKitchenCursor(value.after), bootstrapWatermark: value.bootstrapWatermark as number | null, cursor: value.cursor as number | null,
    until: value.until as number | null, tickets, nextPosition: value.nextPosition, taps};
}
function mergeTickets(state: KitchenScreenState | null, incoming: KitchenTicket[], removed: string[] = []) {
  const rows = new Map(state?.tickets.map(ticket => [ticket.id, ticket]) ?? []);
  for (const id of removed) rows.delete(id);
  for (const ticket of incoming) rows.set(ticket.id, ticket);
  return [...rows.values()].sort((a,b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
export function receiveKitchenPage(state: KitchenScreenState | null, page: KitchenPage, revision: string): KitchenScreenState {
  if (state && (!sameKitchenSession(state.access, page.access) || state.cursor !== null)) throw invalid();
  const first = state?.bootstrapWatermark ?? page.watermark;
  return {v: 1, id: page.access.deviceId, revision, access: page.access, at: page.at, outletName: page.outletName, warningMinutes: page.warningMinutes,
    after: page.next, bootstrapWatermark: page.next ? first : null, cursor: page.next ? null : first, until: null,
    tickets: mergeTickets(state, page.tickets), nextPosition: state?.nextPosition ?? 1, taps: state?.taps ?? []};
}
export function receiveKitchenChanges(state: KitchenScreenState, page: KitchenChanges, revision: string): KitchenScreenState {
  if (!sameKitchenSession(state.access, page.access) || state.cursor === null || page.nextSeq < state.cursor || state.until !== null && state.until !== page.watermark) throw invalid();
  return {...state, revision, access: page.access, at: page.at, outletName: page.outletName, warningMinutes: page.warningMinutes,
    cursor: page.nextSeq, until: page.nextSeq < page.watermark ? page.watermark : null, tickets: mergeTickets(state, page.tickets, page.removed)};
}
export function appendKitchenTap(state: KitchenScreenState, source: KitchenTicket, action: KitchenAction, revision: string): KitchenScreenState {
  const ticket = state.tickets.find(ticket => ticket.id === source.id);
  if (!ticket || JSON.stringify(kitchenTicketWire(ticket)) !== JSON.stringify(kitchenTicketWire(source)) ||
      action.revision !== source.revision || action.contentHash !== source.contentHash || action.orderId !== source.id || action.outletId !== source.outletId ||
      state.taps.some(tap => tap.action.id === action.id || !tap.receipt && !tap.review && sameKitchenSession(tap.access, state.access) &&
        tap.action.orderId === action.orderId && tap.action.contentHash === action.contentHash && tap.action.type === action.type)) throw invalid();
  return {...state, revision, nextPosition: state.nextPosition + 1, taps: [...state.taps, {position: state.nextPosition, access: state.access,
    observedAt: state.at, source: structuredClone(source), action: parseKitchenAction(action), receipt: null, review: false}]};
}
/** Source/position stay unchanged after a lost reply. Only an actual receipt
 * can mark a tap accepted; a cursor or matching status never does. */
export function finishKitchenTap(state: KitchenScreenState, original: KitchenTap, receipt: KitchenReceipt | null, revision: string): KitchenScreenState {
  const saved = state.taps.find(tap => tap.action.id === original.action.id);
  if (!saved || JSON.stringify({...saved,receipt:original.receipt,review:original.review}) !== JSON.stringify(original)) throw invalid();
  const outcome = receipt === null ? null : parseKitchenReceipt(receipt, {action: saved.action, access: saved.access});
  if(saved.receipt){
    // Two live tabs may receive the same genuine outcome. Keep the first
    // native receipt; never replace it or invent another completed action.
    if(!outcome||Object.keys(saved.receipt).some(key=>JSON.stringify(saved.receipt![key as keyof KitchenReceipt])!==JSON.stringify(outcome[key as keyof KitchenReceipt])))throw invalid();
    return state;
  }
  if(saved.review!==original.review||saved.receipt!==original.receipt)throw invalid();
  return {...state, revision, taps: state.taps.map(tap => tap === saved ? {...tap, receipt: outcome, review: outcome === null} : tap)};
}
