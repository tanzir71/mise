import {authHttp, AuthBodyError, readAuthBody} from './auth-http.ts';
import {isDeviceId, isDeviceToken, parseStaffDeviceAccess, type StaffDeviceAccess} from '../../../packages/core/device-access.ts';
import {kitchenContentHash, parseKitchenReceipt, type KitchenLine} from '../../../packages/core/kitchen.ts';
import {kitchenLineWire, parseKitchenLines, parseKitchenCursor, parseKitchenTicket, type KitchenCursor, type KitchenTicket} from '../../../packages/core/kitchen-tickets.ts';

export interface KitchenTicketsStore {
  page(device: string, session: string, after: KitchenCursor | null, limit: number): Promise<unknown>;
  changes(device: string, session: string, after: number, until: number | null, limit: number): Promise<unknown>;
  acknowledgements(device: string, session: string, sources: {orderId: string; contentHash: string; revision: number}[]): Promise<unknown>;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, fields: string) => Object.keys(v).sort().join(',') === fields.split(',').sort().join(',');
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 8640000000000000;
const sequence = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const unavailable = () => Error('Preparation tickets are unavailable.');
class Denied extends Error {}

async function projectRow(value: unknown, access: StaffDeviceAccess, at: number): Promise<KitchenTicket> {
  if (!object(value) || !isDeviceId(value.id) || value.outletId !== access.outletId || typeof value.linesJson !== 'string' || typeof value.tableJson !== 'string' ||
      typeof value.priced !== 'boolean' || !sequence(value.revision) || value.revision < 1 || ![value.createdAt,value.updatedAt,value.statusChangedAt].every(time)) throw unavailable();
  const lines: unknown = JSON.parse(value.linesJson), table: unknown = JSON.parse(value.tableJson);
  if (!Array.isArray(lines) || !lines.every(object) || typeof table !== 'string') throw unavailable();
  // Price-bearing raw SQL lines stop here. Build only the closed preparation
  // fields, then validate them; no full customer/order image is ever fetched.
  const safeLines = parseKitchenLines(kitchenLineWire(lines as KitchenLine[]));
  const ticket = {id: value.id, outletId: access.outletId, businessType: value.businessType, number: value.number, type: value.type,
    source: value.source, table, ...(value.scheduledFor === null ? {} : {scheduledFor: value.scheduledFor}), status: value.status,
    lines: safeLines, revision: value.revision, createdAt: value.createdAt, updatedAt: value.updatedAt, statusChangedAt: value.statusChangedAt,
    timezone: value.timezone, contentHash: '', priced: value.priced, acknowledgement: null} as KitchenTicket;
  ticket.contentHash = await kitchenContentHash(ticket);
  return parseKitchenTicket({...ticket, scheduledFor: ticket.scheduledFor ?? null, lines: kitchenLineWire(ticket.lines)}, access, at);
}
function identity(a: StaffDeviceAccess, b: StaffDeviceAccess) {
  return ['businessId','outletId','deviceId','sessionId','memberId','mode','expiresAt'].every(key => a[key as keyof StaffDeviceAccess] === b[key as keyof StaffDeviceAccess]);
}
export async function projectKitchenRead(raw: unknown, device: string, session: string, store: KitchenTicketsStore, limit: number, change: boolean) {
  if (raw === null) throw new Denied();
  if (!object(raw) || raw.v !== 1 || typeof raw.outletNameJson !== 'string' || !time(raw.at) || !sequence(raw.watermark) ||
      typeof raw.warningMinutes !== 'number' || !Number.isInteger(raw.warningMinutes) || raw.warningMinutes < 1 || raw.warningMinutes > 1440 ||
      !Array.isArray(raw.orders) || raw.orders.length > limit) throw unavailable();
  const access = parseStaffDeviceAccess(raw.access), outletName: unknown = JSON.parse(raw.outletNameJson);
  if (!access.permissions.includes('orders.read')) throw new Denied();
  if (typeof outletName !== 'string') throw unavailable();
  const tickets = await Promise.all(raw.orders.map(row => projectRow(row, access, raw.at as number)));
  const sources = tickets.map(ticket => ({orderId: ticket.id, contentHash: ticket.contentHash, revision: ticket.revision}));
  const ackRaw = await store.acknowledgements(device, session, sources);
  if (ackRaw === null) throw new Denied();
  if (!object(ackRaw) || !exact(ackRaw, 'v,access,at,entries') || ackRaw.v !== 1 || !time(ackRaw.at) || !Array.isArray(ackRaw.entries) || ackRaw.entries.length !== sources.length) throw unavailable();
  const current = parseStaffDeviceAccess(ackRaw.access);
  if (!identity(access, current) || !current.permissions.includes('orders.read')) throw new Denied();
  const seen = new Set<string>();
  for (const entry of ackRaw.entries) {
    if (!object(entry) || !exact(entry, 'orderId,contentHash,receipt') || !isDeviceId(entry.orderId) || seen.has(entry.orderId)) throw unavailable();
    seen.add(entry.orderId);
    const ticket = tickets.find(row => row.id === entry.orderId && row.contentHash === entry.contentHash);
    if (!ticket) throw unavailable();
    if (entry.receipt !== null) {
      const receipt = parseKitchenReceipt(entry.receipt);
      if (receipt.type !== 'kitchen.acknowledge' || receipt.businessId !== current.businessId || receipt.outletId !== current.outletId ||
          receipt.orderId !== ticket.id || receipt.contentHash !== ticket.contentHash || receipt.revision > ticket.revision || receipt.acceptedAt > ackRaw.at) throw unavailable();
      ticket.acknowledgement = receipt;
    }
  }
  const base = {v: 1, access: current, outletName, at: Math.max(raw.at, ackRaw.at), warningMinutes: raw.warningMinutes, watermark: raw.watermark,
    tickets: tickets.map(ticket => ({...ticket, scheduledFor: ticket.scheduledFor ?? null, lines: kitchenLineWire(ticket.lines)}))};
  if (!change) return {...base, next: parseKitchenCursor(raw.next)};
  if (!sequence(raw.nextSeq) || raw.nextSeq > raw.watermark || !Array.isArray(raw.removed) || !raw.removed.every(isDeviceId) ||
      raw.removed.length + tickets.length > limit || new Set(raw.removed).size !== raw.removed.length || raw.removed.some(id => tickets.some(ticket => ticket.id === id))) throw unavailable();
  return {...base, nextSeq: raw.nextSeq, removed: [...raw.removed]};
}
export function createKitchenTicketsHandler(deps: {store: KitchenTicketsStore; origins: ReadonlySet<string>}) {
  const origins = new Set(deps.origins);
  return async (request: Request): Promise<Response> => {
    const {reply, blocked} = authHttp(request, origins);
    if (blocked) return blocked;
    const device = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!device) return reply(401, {error: 'Sign in on this screen again.'});
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return reply(415, {error: 'Use JSON.'});
    let input: unknown;
    try {input = await readAuthBody(request);} catch (error) {return reply(error instanceof AuthBodyError ? error.status : 400, {error: 'Check the kitchen request.'});}
    let session: string, limit: number, after: KitchenCursor | null = null, afterSeq = 0, until: number | null = null, changes = false;
    try {
      if (!object(input) || !isDeviceToken(input.sessionToken) || !['page','changes'].includes(input.action as string)) throw Error();
      session = input.sessionToken; limit = input.limit === undefined ? 50 : input.limit as number;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error();
      changes = input.action === 'changes';
      if (!changes) {
        if (Object.keys(input).some(key => !['action','sessionToken','after','limit'].includes(key))) throw Error();
        after = parseKitchenCursor(input.after ?? null);
      } else {
        if (Object.keys(input).some(key => !['action','sessionToken','afterSeq','untilSeq','limit'].includes(key)) || !sequence(input.afterSeq) ||
            input.untilSeq != null && (!sequence(input.untilSeq) || input.untilSeq < input.afterSeq)) throw Error();
        afterSeq = input.afterSeq; until = input.untilSeq as number | null ?? null;
      }
    } catch {return reply(400, {error: 'Check the kitchen request.'});}
    try {
      const value = changes ? await deps.store.changes(device, session, afterSeq, until, limit) : await deps.store.page(device, session, after, limit);
      return reply(200, await projectKitchenRead(value, device, session, deps.store, limit, changes));
    } catch (error) {
      return error instanceof Denied ? reply(401, {error: 'Sign in on this screen again.'}) : reply(503, {error: 'Tickets are unconfirmed. Keep the saved screen and try again.'});
    }
  };
}

export function createKitchenTicketsStore(apiUrl: string, serviceKey: string, send: typeof fetch = fetch): KitchenTicketsStore {
  const root = new URL(apiUrl);
  if (root.username || root.password || root.search || root.hash || root.pathname !== '/' || root.protocol !== 'https:' &&
      !(root.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(root.hostname)) || !/^sb_secret_[A-Za-z0-9_-]+$/.test(serviceKey)) throw unavailable();
  async function call(route: string, body: Record<string, unknown>) {
    const controller = new AbortController(); let response: Response | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {timer = setTimeout(() => {controller.abort(); reject(unavailable());}, 5000);});
    try {
      response = await Promise.race([send(new URL('rest/v1/rpc/' + route, root), {method: 'POST', redirect: 'error', signal: controller.signal,
        headers: {apikey: serviceKey, 'Content-Type': 'application/json'}, body: JSON.stringify(body)}), deadline]);
      if (!response.ok) throw unavailable();
      const reader = response.body?.getReader(); if (!reader) throw unavailable();
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        for (;;) {const part = await Promise.race([reader.read(), deadline]); if (part.done) break;
          length += part.value.byteLength; if (length > 32 * 1024 * 1024) throw unavailable(); chunks.push(part.value);}
      } catch (error) {void reader.cancel().catch(() => {}); throw error;} finally {reader.releaseLock();}
      const bytes = new Uint8Array(length); let at = 0; for (const chunk of chunks) {bytes.set(chunk, at); at += chunk.length;}
      return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as unknown;
    } finally {clearTimeout(timer); controller.abort(); void response?.body?.cancel().catch(() => {});}
  }
  return {
    page: (device, session, after, limit) => call('read_kitchen_page', {p_device_token: device, p_session_token: session, p_after_time: after?.createdAt ?? null, p_after_id: after?.id ?? null, p_limit: limit}),
    changes: (device, session, after, until, limit) => call('read_kitchen_changes', {p_device_token: device, p_session_token: session, p_after_seq: after, p_until_seq: until, p_limit: limit}),
    acknowledgements: (device, session, sources) => call('read_kitchen_acknowledgements', {p_device_token: device, p_session_token: session, p_sources: sources}),
  };
}
