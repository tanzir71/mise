import {isDeviceId, parseStaffDeviceAccess, type StaffDeviceAccess} from './device-access';
import {isKitchenPreparation} from './kitchen-preparation';
import {parseKitchenAction, parseKitchenReceipt, type KitchenAction, type KitchenReceipt} from './kitchen';
import {kitchenTicketWire, parseKitchenCursor, parseKitchenTicket, type KitchenChanges, type KitchenCursor, type KitchenPage, type KitchenTicket} from './kitchen-tickets';
import {parseKitchenCloseIntent,parseKitchenTapClosure,retainedKitchenTap,type KitchenCloseIntent,type KitchenTapClosure} from './kitchen-recovery';

export interface KitchenTap {
  position: number;
  access: StaffDeviceAccess;
  observedAt: number;
  source: KitchenTicket;
  action: KitchenAction;
  receipt: KitchenReceipt | null;
  review: boolean;
  closeIntents?: KitchenCloseIntent[];
  closure?: KitchenTapClosure | null;
}
/** No device/PIN/session secrets, owner Auth, prices or customer records. A
 * profile is retained under its enrolled device even after sign-out/removal. */
export interface KitchenScreenState {
  v: 1 | 2;
  id: string;
  revision: string;
  access: StaffDeviceAccess;
  at: number;
  outletName: string;
  warningMinutes: number | null;
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
/** A derived view only: keep cached fulfilment history and original taps. */
export function visibleKitchenTickets(state:KitchenScreenState):KitchenTicket[] {
 return state.tickets.filter(ticket=>ticket.status==='cancelled'?!kitchenCancellationAcknowledged(state,ticket):isKitchenPreparation(ticket));
}
export async function parseKitchenScreenState(value: unknown): Promise<KitchenScreenState> {
  if (!object(value) || !exact(value, 'v,id,revision,access,at,outletName,warningMinutes,after,bootstrapWatermark,cursor,until,tickets,nextPosition,taps') ||
      ![1,2].includes(value.v as number) || !isDeviceId(value.id) || !isDeviceId(value.revision) || !time(value.at) || typeof value.outletName !== 'string' ||
      value.warningMinutes !== null && (typeof value.warningMinutes !== 'number' || !Number.isInteger(value.warningMinutes) || value.warningMinutes < 1 || value.warningMinutes > 1440) ||
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
  const actionIds = new Set<string>(),closeIds=new Set<string>();
  for (const raw of value.taps) {
    if (!object(raw) || !exact(raw, value.v===1?'position,access,observedAt,source,action,receipt,review':'position,access,observedAt,source,action,receipt,review,closeIntents,closure') || !sequence(raw.position) || raw.position <= position ||
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
          !(parent && (parent.receipt?.type==='kitchen.acknowledge'||sameKitchenSession(parent.access, actor)) && parent.action.type === 'kitchen.acknowledge' && parent.action.orderId === action.orderId && parent.action.contentHash === action.contentHash)) throw invalid();
    }
    const tap:KitchenTap={position:raw.position,access:actor,observedAt:raw.observedAt,source,action,receipt,review:raw.review};
    if(value.v===2){
      if(!Array.isArray(raw.closeIntents))throw invalid();
      tap.closeIntents=raw.closeIntents.map(value=>{
        const intent=parseKitchenCloseIntent(value,action,access,actor.memberId);if(closeIds.has(intent.id))throw invalid();closeIds.add(intent.id);return intent;
      });
      tap.closure=raw.closure===null?null:parseKitchenTapClosure(raw.closure,retainedKitchenTap(tap),access);
      if(receipt&&tap.closure)throw invalid();
    }
    position = raw.position; actionIds.add(action.id);taps.push(tap);
  }
  return {v: value.v as 1|2, id: value.id, revision: value.revision, access, at: value.at, outletName: value.outletName, warningMinutes: value.warningMinutes,
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
  return {v: state?.v??1, id: page.access.deviceId, revision, access: page.access, at: page.at, outletName: page.outletName, warningMinutes: page.warningMinutes,
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
  const wire = JSON.stringify(kitchenTicketWire(source)),ack=ticket?.acknowledgement;
  // A current read can install this screen's real Got it while Ready is being
  // saved from the displayed pre-ACK ticket. Retain that exact source/action;
  // only the known acknowledgement's status/clock metadata may have advanced.
  const ownAcknowledgement = ticket && action.type==='kitchen.ready' && ack?.id===action.parentAckId &&
    ack.sourceRevision===source.revision && ack.revision===ticket.revision && ack.status===ticket.status &&
    state.taps.some(parent=>parent.action.id===ack.id&&parent.action.type==='kitchen.acknowledge'&&JSON.stringify(kitchenTicketWire(parent.source))===wire) &&
    JSON.stringify(kitchenTicketWire({...source,revision:ticket.revision,status:ticket.status,updatedAt:ticket.updatedAt,
      statusChangedAt:ticket.statusChangedAt,acknowledgement:ack}))===JSON.stringify(kitchenTicketWire(ticket));
  if (!ticket || JSON.stringify(kitchenTicketWire(ticket)) !== wire && !ownAcknowledgement ||
      action.revision !== source.revision || action.contentHash !== source.contentHash || action.orderId !== source.id || action.outletId !== source.outletId ||
      state.taps.some(tap=>!tap.receipt&&!tap.closure&&tap.closeIntents?.length&&tap.action.orderId===action.orderId)||
      state.taps.some(tap => tap.action.id === action.id || !tap.receipt && !tap.review && !tap.closure && !tap.closeIntents?.length && sameKitchenSession(tap.access, state.access) &&
        tap.action.orderId === action.orderId && tap.action.contentHash === action.contentHash && tap.action.type === action.type &&
        (source.status!=='cancelled'||tap.action.revision===action.revision))) throw invalid();
  return {...state, revision, nextPosition: state.nextPosition + 1, taps: [...state.taps, {position: state.nextPosition, access: state.access,
    observedAt: state.at, source: structuredClone(source), action: parseKitchenAction(action), receipt: null, review: false,
    ...(state.v===2?{closeIntents:[],closure:null}:{})}]};
}
/** Historical acceptance remains proof, but a newer ticket may have explicitly
 * undone that preparation effect. A fresh scoped acknowledgement is decisive. */
export function kitchenTapAcknowledges(state:KitchenScreenState,ticket:KitchenTicket,tap:KitchenTap):boolean {
  if(tap.closure||tap.action.type!=='kitchen.acknowledge'||tap.action.orderId!==ticket.id||tap.action.contentHash!==ticket.contentHash)return false;
  if(tap.receipt)return tap.receipt.type==='kitchen.acknowledge'&&(tap.receipt.revision>=ticket.revision||ticket.acknowledgement?.id===tap.receipt.id);
  return !tap.review&&!tap.closeIntents?.length&&sameKitchenSession(tap.access,state.access)&&tap.action.revision>=ticket.revision;
}
/** A saved offline gesture is retained, but only an actual current receipt may
 * dismiss a cancellation notice. An older cancellation never dismisses a new one. */
export function kitchenCancellationAcknowledged(state:KitchenScreenState,ticket:KitchenTicket):boolean {
  if(ticket.status!=='cancelled')return false;
  const ack=ticket.acknowledgement;
  return Boolean(ack?.type==='kitchen.acknowledge'&&ack.status==='cancelled')||
    state.taps.some(tap=>Boolean(tap.receipt)&&kitchenTapAcknowledges(state,ticket,tap));
}
function sameTapSource(a:KitchenTap,b:KitchenTap){
  const source=(tap:KitchenTap)=>({position:tap.position,access:tap.access,observedAt:tap.observedAt,source:kitchenTicketWire(tap.source),action:parseKitchenAction(tap.action)});
  return JSON.stringify(source(a))===JSON.stringify(source(b));
}
function upgradeReviews(state:KitchenScreenState):KitchenScreenState {
  return state.v===2?state:{...state,v:2,taps:state.taps.map(tap=>({...tap,closeIntents:[],closure:null}))};
}
/** Source/position stay unchanged after a lost reply. Only an actual receipt
 * can mark a tap accepted; a cursor or matching status never does. */
export function finishKitchenTap(state: KitchenScreenState, original: KitchenTap, receipt: KitchenReceipt | null, revision: string): KitchenScreenState {
  const saved = state.taps.find(tap => tap.action.id === original.action.id);
  if (!saved || !sameTapSource(saved,original)) throw invalid();
  const outcome = receipt === null ? null : parseKitchenReceipt(receipt, {action: saved.action, access: saved.access});
  if(saved.receipt){
    // Two live tabs may receive the same genuine outcome. Keep the first
    // native receipt; never replace it or invent another completed action.
    if(!outcome||Object.keys(saved.receipt).some(key=>JSON.stringify(saved.receipt![key as keyof KitchenReceipt])!==JSON.stringify(outcome[key as keyof KitchenReceipt])))throw invalid();
    return state;
  }
  if(saved.closure){if(outcome)throw invalid();return state;}
  return {...state, revision, taps: state.taps.map(tap => tap === saved ? {...tap, receipt: outcome, review: outcome === null} : tap)};
}
/** Persist the exact explicit close request before HTTP. Reopening with a new
 * PIN retains earlier requests rather than changing their actor or time. */
export function beginKitchenTapClose(state:KitchenScreenState,original:KitchenTap,intent:KitchenCloseIntent,revision:string):KitchenScreenState {
  if(!sameKitchenSession(intent.access,state.access))throw invalid();
  return saveKitchenTapClose(state,original,intent,revision);
}
/** Personal history can be closed from a later PIN session without promoting
 * the historical board's permissions into the current member's authority. */
export function beginOwnKitchenTapClose(state:KitchenScreenState,original:KitchenTap,intent:KitchenCloseIntent,revision:string):KitchenScreenState {
  if(intent.access.memberId!==original.access.memberId)throw invalid();
  return saveKitchenTapClose(state,original,intent,revision);
}
function saveKitchenTapClose(state:KitchenScreenState,original:KitchenTap,intent:KitchenCloseIntent,revision:string):KitchenScreenState {
  const saved=state.taps.find(tap=>tap.action.id===original.action.id);
  if(!saved||!sameTapSource(saved,original))throw invalid();
  if(saved.receipt||saved.closure)return state;
  intent=parseKitchenCloseIntent(intent,saved.action,state.access,saved.access.memberId);
  if(saved.closeIntents?.some(value=>sameKitchenSession(value.access,intent.access)))return state;
  const next=upgradeReviews(state);
  return {...next,revision,taps:next.taps.map(tap=>tap.action.id===saved.action.id?{...tap,closeIntents:[...tap.closeIntents!,intent]}:tap)};
}
export function finishKitchenTapClose(state:KitchenScreenState,original:KitchenTap,closure:KitchenTapClosure,revision:string):KitchenScreenState {
  const saved=state.taps.find(tap=>tap.action.id===original.action.id);
  if(!saved||!sameTapSource(saved,original)||saved.receipt)throw invalid();
  const actual=parseKitchenTapClosure(closure,retainedKitchenTap(saved),state.access);
  if(saved.closure){if(JSON.stringify(saved.closure)!==JSON.stringify(actual))throw invalid();return state;}
  const next=upgradeReviews(state);
  return {...next,revision,taps:next.taps.map(tap=>tap.action.id===saved.action.id?{...tap,closure:actual,review:false}:tap)};
}
