import {expect, it, vi} from 'vitest';
import {cloudRecordMaps, encodeCommandRecord} from '../packages/core/cloud-records';
import {newKitchenId, prepareKitchenAction, type KitchenAction, type KitchenReceipt} from '../packages/core/kitchen';
import {changeOrderStatusCommand} from '../packages/core/orders';
import type {StaffDeviceAccess} from '../packages/core/device-access';
import {createKitchenActionsHandler, createKitchenActionsStore, replayKitchenPreparation, KitchenStoreError} from '../supabase/functions/_shared/kitchen-actions-handler';
import {orderFixture, ORDER_AT} from './order-fixture';

const origin = 'https://shop.test', device = 'D'.repeat(43), session = 'S'.repeat(43), privateTicket = 'T'.repeat(43);
function request(body: unknown, headers: Record<string, string> = {}, method = 'POST') {
  return new Request('https://api.test/kitchen-actions', {method, headers: {origin, authorization: 'Bearer ' + device, 'content-type': 'application/json', ...headers},
    ...(method === 'POST' ? {body: typeof body === 'string' ? body : JSON.stringify(body)} : {})});
}
function sqlRow(table: 'businesses' | 'outlets' | 'orders', row: unknown, businessId: string) {
  const encoded = encodeCommandRecord(table, row, businessId), specs = cloudRecordMaps[table].fields as Record<string, string>;
  return Object.fromEntries(Object.entries(encoded.values).map(([key, value]) => [key, specs[key]?.startsWith('j:') && typeof value === 'string' ? JSON.parse(value) : value]));
}
async function fixture() {
  const f = orderFixture('restaurant'), setup = f.context.setup;
  const order = changeOrderStatusCommand(f.order, 'confirmed', setup, f.order.revision, ORDER_AT + 1).order;
  const action = await prepareKitchenAction(order, 'kitchen.acknowledge', null, ORDER_AT + 2), ticketId = newKitchenId();
  const access: StaffDeviceAccess = {v: 1, businessId: setup.business.id, outletId: setup.outlet.id, deviceId: newKitchenId(), memberId: newKitchenId(), sessionId: newKitchenId(), role: 'kitchen', mode: 'kitchen',
    permissions: ['orders.acknowledge','orders.read','orders.ready'], expiresAt: ORDER_AT + 43200000};
  const prepared = {done: false, ticketId, token: privateTicket, at: ORDER_AT + 1000, access, acknowledgement: null,
    contextJson: JSON.stringify({business: sqlRow('businesses', setup.business, setup.business.id), outlet: sqlRow('outlets', setup.outlet, setup.business.id), order: sqlRow('orders', order, setup.business.id)})};
  return {action, ticketId, access, prepared};
}

it('rejects foreign origins, methods and invalid device authentication before a privileged call', async () => {
  const prepare = vi.fn(), finish = vi.fn(), handler = createKitchenActionsHandler({store: {prepare, finish}, origins: new Set([origin])});
  for (const headers of [{authorization: ''}, {authorization: 'Bearer ' + device + '.extra'}]) expect((await handler(request({}, headers))).status).toBe(401);
  expect((await handler(request({}, {origin: 'https://foreign.test'}))).status).toBe(403);
  expect((await handler(request({}, {}, 'GET'))).status).toBe(405);
  const options = await handler(request({}, {}, 'OPTIONS'));
  expect(options.status).toBe(204); expect(options.headers.get('access-control-allow-origin')).toBe(origin);
  expect(options.headers.get('access-control-allow-headers')).toContain('authorization');
  expect(prepare).not.toHaveBeenCalled(); expect(finish).not.toHaveBeenCalled();
});

it('rejects caller authority, malformed actions and oversized bodies without storing or pricing anything', async () => {
  const {action} = await fixture(), prepare = vi.fn(), finish = vi.fn();
  const handler = createKitchenActionsHandler({store: {prepare, finish}, origins: new Set([origin])});
  for (const body of [{sessionToken: session, action, memberId: newKitchenId()}, {sessionToken: session, action: {...action, total: 0}},
    {sessionToken: 'bad', action}, {sessionToken: session, action: {...action, parentAckId: newKitchenId()}}, '{broken']) {
    expect((await handler(request(body))).status).toBe(400);
  }
  expect((await handler(request(' '.repeat(2049)))).status).toBe(413);
  expect((await handler(request({}, {'content-type': 'text/plain'}))).status).toBe(415);
  expect(prepare).not.toHaveBeenCalled(); expect(finish).not.toHaveBeenCalled();
});

it('replays private SQL context internally and returns only the exact scope-bound receipt', async () => {
  const f = await fixture(), prepare = vi.fn(async () => f.prepared), finish = vi.fn(async (...args: unknown[]) => args[5]);
  const handler = createKitchenActionsHandler({store: {prepare, finish}, origins: new Set([origin]), newId: () => f.ticketId});
  const response = await handler(request({sessionToken: session, action: f.action})), receipt = await response.json() as KitchenReceipt;
  expect(response.status).toBe(200);
  expect(prepare).toHaveBeenCalledExactlyOnceWith(device, session, f.ticketId, f.action);
  expect(finish).toHaveBeenCalledExactlyOnceWith(device, session, f.ticketId, privateTicket, [{id: f.action.transitionEventIds[0], status: 'kitchen_seen'}], receipt);
  expect(receipt).toMatchObject({id: f.action.id, sessionId: f.access.sessionId, deviceId: f.access.deviceId, memberId: f.access.memberId});
  expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.get('vary')).toBe('Origin');
  const text = JSON.stringify(receipt);
  for (const value of [privateTicket, device, session, 'Karim', 'contextJson', 'permissions', 'unitPrice', 'payment', 'customer']) expect(text).not.toContain(value);
});

it('reads a completed original receipt without recomputing or repeating any status change', async () => {
  const f = await fixture(), write = await replayKitchenPreparation(f.prepared, f.action, f.ticketId), finish = vi.fn();
  const handler = createKitchenActionsHandler({store: {prepare: async () => ({done: true, receipt: write.receipt}), finish}, origins: new Set([origin])});
  const response = await handler(request({sessionToken: session, action: f.action}));
  expect(response.status).toBe(200); expect(await response.json()).toEqual(write.receipt); expect(finish).not.toHaveBeenCalled();
});

it('does not accept altered final actors, sessions or clocks, nor partial or over-sharing SQL outcomes', async () => {
  const f = await fixture();
  for (const patch of [{memberId: newKitchenId()}, {sessionId: newKitchenId()}, {acceptedAt: f.prepared.at + 1}]) {
    const handler = createKitchenActionsHandler({store: {prepare: async () => f.prepared, finish: async (...args) => ({...args[5], ...patch})}, origins: new Set([origin]), newId: () => f.ticketId});
    expect((await handler(request({sessionToken: session, action: f.action}))).status).toBe(503);
  }
  for (const prepared of [{...f.prepared, extraPrivateDetails: 'private'}, {...f.prepared, ticketId: newKitchenId()}, {done: true, receipt: {id: f.action.id}}]) {
    const finish = vi.fn(), handler = createKitchenActionsHandler({store: {prepare: async () => prepared, finish}, origins: new Set([origin]), newId: () => f.ticketId});
    expect((await handler(request({sessionToken: session, action: f.action}))).status).toBe(503); expect(finish).not.toHaveBeenCalled();
  }
});

it('maps denied or unconfirmed requests to generic uncached responses without exposing private exceptions', async () => {
  const {action} = await fixture();
  for (const [prepare, status] of [[async () => null, 401], [async () => {throw new KitchenStoreError(409);}, 409],
    [async () => {throw new KitchenStoreError(429);}, 429], [async () => {throw Error('PRIVATE database key, session, customer');}, 503]] as const) {
    const handler = createKitchenActionsHandler({store: {prepare, finish: vi.fn()}, origins: new Set([origin])});
    const response = await handler(request({sessionToken: session, action}));
    expect(response.status).toBe(status); expect(response.headers.get('cache-control')).toBe('no-store'); expect(await response.text()).not.toContain('PRIVATE');
    if (status === 429) expect(response.headers.get('retry-after')).toBe('60');
  }
});

it('puts credentials only in server headers and fixed POST bodies with exact named RPC arguments', async () => {
  const {action, ticketId} = await fixture(), send = vi.fn<typeof fetch>(async () => new Response('null'));
  const store = createKitchenActionsStore('https://api.test', 'sb_secret_test_only', send);
  expect(await store.prepare(device, session, ticketId, action)).toBeNull();
  const [url, options] = send.mock.calls[0];
  expect(String(url)).toBe('https://api.test/rest/v1/rpc/prepare_kitchen_action');
  expect(options).toMatchObject({method: 'POST', redirect: 'error', headers: {apikey: 'sb_secret_test_only', 'Content-Type': 'application/json'}});
  expect(options?.signal).toBeInstanceOf(AbortSignal); expect(options?.headers).not.toHaveProperty('Authorization');
  expect(JSON.parse(String(options?.body))).toEqual({p_device_token: device, p_session_token: session, p_ticket_id: ticketId, p_action: action});
  expect(String(url)).not.toContain(device); expect(String(url)).not.toContain(session);
});

it('rejects unsafe RPC authorities and client keys before a privileged request', () => {
  for (const url of ['http://api.test','https://user:pass@api.test','https://api.test/path','https://api.test/?redirect=foreign','https://api.test/#fragment']) {
    expect(() => createKitchenActionsStore(url, 'sb_secret_test_only')).toThrow();
  }
  for (const key of ['', 'legacy-jwt', 'sb_publishable_public']) expect(() => createKitchenActionsStore('https://api.test', key)).toThrow();
});

it('bounds response declarations and malformed/internal error bodies without leaking them', async () => {
  const {action, ticketId} = await fixture();
  for (const response of [new Response('PRIVATE backend detail', {status: 500}), new Response('{broken'),
    new Response('null', {headers: {'Content-Length': String(32 * 1024 * 1024 + 1)}})]) {
    const store = createKitchenActionsStore('https://api.test', 'sb_secret_test_only', async () => response);
    await expect(store.prepare(device, session, ticketId, action)).rejects.toMatchObject({status: 503, message: 'Kitchen request unavailable.'});
  }
});

it('enforces the RPC deadline even when the transport never observes abort', async () => {
  const {action, ticketId} = await fixture();
  vi.useFakeTimers();
  try {
    const store = createKitchenActionsStore('https://api.test', 'sb_secret_test_only', () => new Promise<Response>(() => {}));
    const rejected = expect(store.prepare(device, session, ticketId, action)).rejects.toMatchObject({status: 503});
    await vi.advanceTimersByTimeAsync(5001); await rejected;
    expect(vi.getTimerCount()).toBe(0);
  } finally {vi.useRealTimers();}
});

it('retains the exact immutable original action in request bodies', async () => {
  const f = await fixture(), send = vi.fn<typeof fetch>(async () => new Response('null'));
  const store = createKitchenActionsStore('https://api.test', 'sb_secret_test_only', send);
  const pending = store.prepare(device, session, f.ticketId, f.action);
  const original = JSON.parse(String(send.mock.calls[0][1]?.body)).p_action as KitchenAction;
  f.action.transitionEventIds[0] = newKitchenId(); f.action.revision++;
  await pending;
  expect(original.revision).toBe(f.action.revision - 1); expect(original.transitionEventIds[0]).not.toBe(f.action.transitionEventIds[0]);
});
