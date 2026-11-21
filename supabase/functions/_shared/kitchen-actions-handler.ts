import {authHttp, AuthBodyError, readAuthBody} from './auth-http.ts';
import {decodeCommandRecord} from '../../../packages/core/cloud-records.ts';
import {isDeviceId, isDeviceToken, parseStaffDeviceAccess} from '../../../packages/core/device-access.ts';
import {applyKitchenAction, KitchenActionConflict, KitchenActionDenied, newKitchenId, parseKitchenAction,
  parseKitchenReceipt, type KitchenAction, type KitchenReceipt} from '../../../packages/core/kitchen.ts';
import type {Business, Order, Outlet} from '../../../packages/core/models.ts';

export interface KitchenStep {id: string; status: Order['status']}
export interface KitchenActionsStore {
  prepare(device: string, session: string, ticketId: string, action: KitchenAction): Promise<unknown>;
  finish(device: string, session: string, ticketId: string, token: string, steps: KitchenStep[], receipt: KitchenReceipt): Promise<unknown>;
}
export class KitchenStoreError extends Error {
  constructor(readonly status: 409 | 429 | 503) {super('Kitchen request unavailable.');}
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
function sqlReceipt(value: unknown, action?: KitchenAction) {
  try {return parseKitchenReceipt(value, action ? {action} : undefined);} catch {throw new KitchenStoreError(503);}
}

/** Decode privileged SQL context only inside the server. The returned write
 * contains preparation columns and a safe receipt, no proposed order, full
 * audit images, customer details, money or caller-selected member authority. */
export async function replayKitchenPreparation(value: unknown, action: KitchenAction, ticketId: string) {
  action = parseKitchenAction(action);
  if (!object(value) || !exact(value, 'done,ticketId,token,at,access,contextJson,acknowledgement') || value.done !== false ||
      !isDeviceId(ticketId) || value.ticketId !== ticketId || !isDeviceToken(value.token) || typeof value.at !== 'number' ||
      !Number.isSafeInteger(value.at) || value.at < 0 || value.at > 8640000000000000 || typeof value.contextJson !== 'string') throw new KitchenStoreError(503);
  const access = parseStaffDeviceAccess(value.access), raw: unknown = JSON.parse(value.contextJson);
  if (!object(raw) || !exact(raw, 'business,outlet,order') || !object(raw.business) || !object(raw.outlet) || !object(raw.order)) throw new KitchenStoreError(503);
  const business = decodeCommandRecord('businesses', raw.business) as unknown as Business;
  const outlet = decodeCommandRecord('outlets', raw.outlet) as unknown as Outlet;
  const order = decodeCommandRecord('orders', raw.order) as unknown as Order;
  const acknowledgement = value.acknowledgement === null ? null : sqlReceipt(value.acknowledgement);
  const result = await applyKitchenAction({order, shop: {business, outlet}, access, action, admittedAt: value.at, acknowledgement});
  const steps: KitchenStep[] = result.events.filter(event => event.command === 'order.status')
    .map(event => ({id: event.id, status: (event.after as Order).status}));
  return {token: value.token, steps, receipt: result.receipt};
}

export function createKitchenActionsHandler(deps: {store: KitchenActionsStore; origins: ReadonlySet<string>; newId?: () => string}) {
  const origins = new Set(deps.origins), newId = deps.newId ?? newKitchenId;
  return async (request: Request): Promise<Response> => {
    const {reply, blocked} = authHttp(request, origins);
    if (blocked) return blocked;
    const device = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!device) return reply(401, {error: 'Sign in on this screen again.'});
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return reply(415, {error: 'Use JSON.'});
    let input: unknown;
    try {input = await readAuthBody(request);} catch (error) {
      return reply(error instanceof AuthBodyError ? error.status : 400, {error: 'Keep the original kitchen tap.'});
    }
    let action: KitchenAction, session: string;
    try {
      if (!object(input) || !exact(input, 'sessionToken,action') || !isDeviceToken(input.sessionToken)) throw Error();
      session = input.sessionToken; action = parseKitchenAction(input.action);
    } catch {return reply(400, {error: 'Keep the original kitchen tap.'});}
    try {
      const ticketId = newId();
      if (!isDeviceId(ticketId)) throw new KitchenStoreError(503);
      const prepared = await deps.store.prepare(device, session, ticketId, action);
      if (prepared === null) return reply(401, {error: 'Sign in on this screen again.'});
      if (object(prepared) && exact(prepared, 'done,receipt') && prepared.done === true) {
        return reply(200, sqlReceipt(prepared.receipt, action));
      }
      const write = await replayKitchenPreparation(prepared, action, ticketId);
      const receipt = await deps.store.finish(device, session, ticketId, write.token, write.steps, write.receipt);
      if (receipt === null) return reply(401, {error: 'Sign in on this screen again.'});
      const parsed = sqlReceipt(receipt, action);
      // SQL jsonb field order is immaterial. Compare every field without
      // accepting a changed actor, originating session or receipt clock.
      if (Object.keys(write.receipt).some(key => JSON.stringify(parsed[key as keyof KitchenReceipt]) !== JSON.stringify(write.receipt[key as keyof KitchenReceipt]))) throw new KitchenStoreError(503);
      return reply(200, parsed);
    } catch (error) {
      if (error instanceof KitchenActionDenied) return reply(401, {error: 'Sign in on this screen again.'});
      const status = error instanceof KitchenActionConflict ? 409 : error instanceof KitchenStoreError ? error.status : 503;
      return reply(status, {error: status === 409 ? 'This ticket changed. Keep the original tap and review it.' :
        status === 429 ? 'Wait before trying this tap again.' : 'This tap is unconfirmed. Keep it and try again.'}, status === 429 ? {'Retry-After': '60'} : {});
    }
  };
}

/** Secrets stay in server headers or POST bodies at a fixed RPC authority. The
 * large internal context budget preserves the existing million-character
 * source limit, including escaped NUL, without sending that source to staff. */
export function createKitchenActionsStore(apiUrl: string, serviceKey: string, send: typeof fetch = fetch): KitchenActionsStore {
  const root = new URL(apiUrl);
  if (root.username || root.password || root.search || root.hash || root.pathname !== '/' ||
      root.protocol !== 'https:' && !(root.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(root.hostname)) ||
      !/^sb_secret_[A-Za-z0-9_-]+$/.test(serviceKey)) throw new KitchenStoreError(503);
  async function call(route: 'prepare_kitchen_action' | 'finish_kitchen_action', body: Record<string, unknown>) {
    const controller = new AbortController();
    let response: Response | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {timer = setTimeout(() => {controller.abort(); reject(new KitchenStoreError(503));}, 5000);});
    try {
      response = await Promise.race([send(new URL('rest/v1/rpc/' + route, root), {method: 'POST', redirect: 'error', signal: controller.signal,
        headers: {apikey: serviceKey, 'Content-Type': 'application/json'}, body: JSON.stringify(body)}), deadline]);
      if (!response.ok) throw new KitchenStoreError(response.status === 409 || response.status === 400 ? 409 : response.status === 429 ? 429 : 503);
      const limit = 32 * 1024 * 1024, declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new KitchenStoreError(503);
      const reader = response.body?.getReader();
      if (!reader) throw new KitchenStoreError(503);
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const part = await Promise.race([reader.read(), deadline]);
          if (part.done) break;
          size += part.value.byteLength;
          if (size > limit) throw new KitchenStoreError(503);
          chunks.push(part.value);
        }
      } catch (error) {void reader.cancel().catch(() => {}); throw error;} finally {reader.releaseLock();}
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
      return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as unknown;
    } catch (error) {if (error instanceof KitchenStoreError) throw error; throw new KitchenStoreError(503);}
    finally {clearTimeout(timer); controller.abort(); void response?.body?.cancel().catch(() => {});}
  }
  return {
    prepare: (device, session, ticketId, action) => call('prepare_kitchen_action', {p_device_token: device, p_session_token: session, p_ticket_id: ticketId, p_action: parseKitchenAction(action)}),
    finish: (device, session, ticketId, token, steps, receipt) => call('finish_kitchen_action', {p_device_token: device, p_session_token: session, p_ticket_id: ticketId, p_token: token, p_steps: steps, p_receipt: receipt}),
  };
}
