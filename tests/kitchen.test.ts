import {expect, it} from 'vitest';
import {applyKitchenAction, kitchenActionHash, kitchenAlarm, kitchenContent, kitchenContentHash, kitchenReadyPath,
  KitchenActionConflict, KitchenActionDenied, newKitchenId as ulid, parseKitchenAction, parseKitchenReceipt, prepareKitchenAction, type KitchenAction, type KitchenReceipt} from '../packages/core/kitchen';
import {changeOrderStatusCommand, nextOrderStatuses, saveOrderCommand} from '../packages/core/orders';
import type {Order, OrderStatus} from '../packages/core/models';
import type {BusinessType} from '../packages/core/packs';
import type {StaffDeviceAccess} from '../packages/core/device-access';
import {orderFixture, ORDER_AT} from './order-fixture';

const now = ORDER_AT + 180000;
function fixture(pack: BusinessType = 'restaurant', status?: OrderStatus) {
  const base = orderFixture(pack), setup = base.context.setup;
  let order = ['restaurant', 'online_shop'].includes(pack)
    ? saveOrderCommand({...base.input, type: 'delivery', address: 'Door 8'}, base.context, null, 0, ORDER_AT).order : base.order;
  for (let i = 0; status && order.status !== status && i < 12; i++) {
    const choices = nextOrderStatuses(order);
    const next = status === 'cancelled' ? status : choices.includes(status) ? status : status === 'returned' && choices.includes('returning') ? 'returning' : choices[0];
    if (!next) throw Error('Fixture status is unreachable');
    order = changeOrderStatusCommand(order, next, setup, order.revision, ORDER_AT + 1000 + i).order;
  }
  if (status && order.status !== status) throw Error('Fixture did not reach status');
  const access: StaffDeviceAccess = {v: 1, businessId: setup.business.id, outletId: setup.outlet.id, deviceId: ulid(), sessionId: ulid(),
    memberId: ulid(), role: 'kitchen', mode: 'kitchen', permissions: ['orders.acknowledge', 'orders.read', 'orders.ready'], expiresAt: now + 43200000};
  return {shop: {business: setup.business, outlet: setup.outlet}, order, access};
}
async function action(order: Order, type: KitchenAction['type'] = 'kitchen.acknowledge', parentAckId: string | null = null): Promise<KitchenAction> {
  return {v: 1, id: ulid(), type, orderId: order.id, outletId: order.outletId, revision: order.revision,
    contentHash: await kitchenContentHash(order), occurredAt: now - 1000, parentAckId, transitionEventIds: [ulid(), ulid(), ulid()]};
}
async function acknowledge(f = fixture()) {
  const tap = await action(f.order);
  return {f, tap, result: await applyKitchenAction({...f, action: tap, admittedAt: now, acknowledgement: null})};
}

it.each<BusinessType>(['restaurant', 'online_shop', 'food_stall', 'corner_shop'])('acknowledges %s without inventing commercial confirmation', async pack => {
  const f = fixture(pack), original = structuredClone(f.order), a = await action(f.order);
  const result = await applyKitchenAction({...f, action: a, admittedAt: now, acknowledgement: null});
  const expected = pack === 'food_stall' ? 'making' : original.status;
  expect(result.order.status).toBe(expected);
  expect(result.order.payment).toEqual(original.payment);
  expect(result.receipt).toMatchObject({id: a.id, type: 'kitchen.acknowledge', memberId: f.access.memberId, deviceId: f.access.deviceId, acceptedAt: now, occurredAt: a.occurredAt});
  expect(result.events.at(-1)?.command).toBe('kitchen.acknowledge');
  expect(result.events.every(event => event.actor.id === f.access.memberId)).toBe(true);
  expect(f.order).toEqual(original);
});

it.each<BusinessType>(['restaurant','online_shop','food_stall','corner_shop'])('%s Understood acknowledges the original cancellation without a preparation or financial change',async pack=>{
 const f=fixture(pack,'cancelled'),before=structuredClone(f.order),tap=await action(before);
 const result=await applyKitchenAction({...f,action:tap,admittedAt:now,acknowledgement:null});
 expect(result.order).toEqual(before);expect(result.receipt.status).toBe('cancelled');expect(result.receipt.transitionEventIds).toEqual([]);
 expect(result.events).toHaveLength(1);expect(result.events[0].command).toBe('kitchen.acknowledge');
 const metadata={...before,revision:before.revision+2};
 expect((await applyKitchenAction({...f,order:metadata,action:tap,admittedAt:now,acknowledgement:null})).order).toEqual(metadata);
 await expect(applyKitchenAction({...f,action:await action(before,'kitchen.ready',result.receipt.id),admittedAt:now,acknowledgement:result.receipt})).rejects.toBeInstanceOf(KitchenActionConflict);
});

it.each<[BusinessType, OrderStatus, OrderStatus, OrderStatus]>([
  ['restaurant', 'confirmed', 'kitchen_seen', 'ready'],
  ['online_shop', 'confirmed', 'confirmed', 'packed'],
  ['food_stall', 'ordered', 'making', 'ready_called'],
  ['corner_shop', 'accepted', 'packing', 'ready'],
])('%s Got it and Ready follow the existing preparation flow', async (pack, start, seen, ready) => {
  const {f, result} = await acknowledge(fixture(pack, start));
  expect(result.order.status).toBe(seen);
  const tap = await action(result.order, 'kitchen.ready', result.receipt.id);
  const completed = await applyKitchenAction({...f, order: result.order, action: tap, admittedAt: now + 2000, acknowledgement: result.receipt});
  expect(completed.order.status).toBe(ready);
  expect(completed.order.revision).toBe(result.order.revision + completed.receipt.transitionEventIds.length);
  expect(completed.order.lines).toEqual(f.order.lines);
  expect(completed.order.customer).toEqual(f.order.customer);
  expect(completed.order.payment).toEqual(f.order.payment);
  expect(completed.events.filter(event => event.command === 'order.status').map(event => (event.after as Order).status))
    .toEqual(kitchenReadyPath(result.order));
  expect(completed.events.every(event => event.actor.id === f.access.memberId && event.at === now + 2000)).toBe(true);
  expect(parseKitchenReceipt(completed.receipt, {action: tap, access: f.access})).toEqual(completed.receipt);
});

it.each<[BusinessType, OrderStatus]>([
  ['restaurant','new'], ['online_shop','new'], ['online_shop','to_confirm'], ['corner_shop','requested'], ['corner_shop','priced'],
  ['restaurant','out'], ['restaurant','delivered'], ['online_shop','booked'], ['online_shop','with_courier'],
  ['online_shop','returning'], ['online_shop','returned'], ['food_stall','collected'], ['corner_shop','done'],
])('does not use Ready to bypass or reverse %s / %s', async (pack, status) => {
  const {f, result} = await acknowledge(fixture(pack, status));
  expect(kitchenReadyPath(result.order)).toBeNull();
  await expect(applyKitchenAction({...f, order: result.order, action: await action(result.order, 'kitchen.ready', result.receipt.id), admittedAt: now + 1, acknowledgement: result.receipt}))
    .rejects.toBeInstanceOf(KitchenActionConflict);
});

it('retains an old acknowledgement through confirmation and plans three legitimate steps to Ready', async () => {
  const {f, result} = await acknowledge();
  const setup = {...f.shop, owner: {id: f.access.memberId, businessId: f.access.businessId, active: true, outletIds: [f.access.outletId]}};
  const confirmed = changeOrderStatusCommand(result.order, 'confirmed', setup, result.order.revision, now + 1).order;
  const done = await applyKitchenAction({...f, order: confirmed, action: await action(confirmed, 'kitchen.ready', result.receipt.id), admittedAt: now + 2, acknowledgement: result.receipt});
  expect(done.receipt.transitionEventIds).toHaveLength(3);
  expect(done.events.slice(0, 3).map(e => (e.after as Order).status)).toEqual(['kitchen_seen', 'cooking', 'ready']);
});

it.each(['unknown-price', 'unaccepted-swap', 'all-unavailable'] as const)('Got it remains possible for %s while Ready is blocked', async kind => {
  const f = fixture('restaurant', 'confirmed');
  if (kind === 'unknown-price') Object.assign(f.order.lines[0], {unitPrice: null, lineTotal: null});
  if (kind === 'unaccepted-swap') f.order.lines[0].substitution = {from: 'Original tea', accepted: false};
  if (kind === 'all-unavailable') f.order.lines[0].unavailable = true;
  const {result} = await acknowledge(f);
  expect(result.order).toEqual(f.order);
  expect(result.receipt.transitionEventIds).toEqual([]);
  await expect(applyKitchenAction({...f, action: await action(f.order, 'kitchen.ready', result.receipt.id), admittedAt: now + 1, acknowledgement: result.receipt})).rejects.toBeInstanceOf(KitchenActionConflict);
});

it('preserves current financial/contact edits when replaying the original visible-ticket intent', async () => {
  const {f, result} = await acknowledge(fixture('restaurant', 'confirmed'));
  const tap = await action(result.order, 'kitchen.ready', result.receipt.id);
  const current = structuredClone(result.order);
  Object.assign(current, {revision: current.revision + 5, customer: {name: 'Private renamed customer', phone: '+14155550100'}, address: 'Private address', sourceText: 'Private chat', discount: 100, total: current.total! - 100,
    payment: {method: 'cash', status: 'paid', saleId: ulid(), at: now}});
  const done = await applyKitchenAction({...f, order: current, action: tap, admittedAt: now + 1, acknowledgement: result.receipt});
  for (const field of ['customer','address','sourceText','discount','total','payment','createdAt','createdBy','handledBy','sequence'] as const) expect(done.order[field]).toEqual(current[field]);
  expect(done.receipt.sourceRevision).toBe(tap.revision);
  expect(done.receipt.revision).toBe(current.revision + 2);
});

it.each(['qty','note','name','unit','unavailable','swap','table','schedule','cancelled'] as const)('an offline Ready cannot retarget changed %s content', async field => {
  const {f, result} = await acknowledge(fixture('restaurant', 'confirmed'));
  const tap = await action(result.order, 'kitchen.ready', result.receipt.id), changed = structuredClone(result.order);
  changed.revision++;
  if (field === 'qty') changed.lines[0].qty++;
  else if (field === 'note') changed.lines[0].note = 'No sugar';
  else if (field === 'name') changed.lines[0].name = 'Coffee';
  else if (field === 'unit') changed.lines[0].unit = 'pot';
  else if (field === 'unavailable') changed.lines[0].unavailable = true;
  else if (field === 'swap') changed.lines[0].substitution = {from: 'Milk tea', accepted: true, acceptedAt: now};
  else if (field === 'table') changed.table = 'Table 8';
  else if (field === 'schedule') changed.scheduledFor = now + 100000;
  else changed.status = 'cancelled';
  await expect(applyKitchenAction({...f, order: changed, action: tap, admittedAt: now + 1, acknowledgement: result.receipt})).rejects.toBeInstanceOf(KitchenActionConflict);
  expect((await kitchenAlarm(changed, result.receipt, now + 120000)).active).toBe(field !== 'cancelled' && field !== 'schedule');
});

it('hashes complete literal preparation text without leaking contact, money or source messages', async () => {
  const {order} = fixture();
  order.lines[0].name = 'বাংলা\0' + String.fromCharCode(0xd800);
  const before = await kitchenContentHash(order), payload = JSON.stringify(kitchenContent(order));
  for (const field of ['unitPrice','lineTotal','payment','customer','address','sourceText','subtotal','total']) expect(payload).not.toContain('"' + field + '"');
  const replaced = structuredClone(order); replaced.lines[0].name = replaced.lines[0].name.replace(String.fromCharCode(0xd800), '\ufffd');
  expect(await kitchenContentHash(replaced)).not.toBe(before);
  const encoded = JSON.parse(JSON.stringify(order)) as Order;
  expect(await kitchenContentHash(encoded)).toBe(before);
  expect(encoded.lines[0].name).toBe(order.lines[0].name);
});

it.each(['expired','no-read','no-ack','outlet','business'] as const)('denies %s live access before mutation', async kind => {
  const f = fixture();
  if (kind === 'expired') f.access.expiresAt = now;
  else if (kind === 'no-read') f.access.permissions = ['orders.acknowledge'];
  else if (kind === 'no-ack') f.access.permissions = ['orders.read'];
  else if (kind === 'outlet') f.access.outletId = ulid();
  else f.access.businessId = ulid();
  await expect(applyKitchenAction({...f, action: await action(f.order), admittedAt: now, acknowledgement: null})).rejects.toBeInstanceOf(KitchenActionDenied);
});

it.each(['missing','wrong-id','wrong-order','wrong-content','future','ready-receipt'] as const)('requires the actual original acknowledgement parent: %s', async kind => {
  const {f, result} = await acknowledge(fixture('restaurant', 'confirmed'));
  const tap = await action(result.order, 'kitchen.ready', result.receipt.id);
  let ack: KitchenReceipt | null = structuredClone(result.receipt);
  if (kind === 'missing') ack = null;
  else if (kind === 'wrong-id') ack!.id = ulid();
  else if (kind === 'wrong-order') ack!.orderId = ulid();
  else if (kind === 'wrong-content') ack!.contentHash = '0'.repeat(64);
  else if (kind === 'future') ack!.acceptedAt = now + 1000;
  else {ack!.type = 'kitchen.ready'; ack!.parentAckId = ulid();}
  await expect(applyKitchenAction({...f, order: result.order, action: tap, admittedAt: now + 1, acknowledgement: ack})).rejects.toBeInstanceOf(KitchenActionConflict);
});

it('uses the two-minute default and scheduled time, and stops only for the same acknowledged content', async () => {
  const {f, result} = await acknowledge();
  expect(await kitchenAlarm(f.order, null, ORDER_AT + 119999)).toEqual({dueAt: ORDER_AT + 120000, active: false});
  expect((await kitchenAlarm(f.order, null, ORDER_AT + 120000)).active).toBe(true);
  expect((await kitchenAlarm(f.order, result.receipt, now)).active).toBe(false);
  const scheduled = {...f.order, scheduledFor: now + 100000};
  expect(await kitchenAlarm(scheduled, null, now + 159999, 1)).toEqual({dueAt: now + 160000, active: false});
  expect((await kitchenAlarm(scheduled, null, now + 160000, 1)).active).toBe(true);
});

it('rejects client authority, altered or reused identities, broken parentage and far-future clocks', async () => {
  const f = fixture(), tap = await action(f.order), saved = JSON.stringify(tap);
  for (const patch of [{memberId: f.access.memberId}, {status: 'ready'}, {v: 2}, {contentHash: 'not-a-hash'}, {parentAckId: ulid()}, {transitionEventIds: tap.transitionEventIds.slice(1)}, {transitionEventIds: [tap.id, ulid(), ulid()]}, {revision: 0}]) {
    expect(() => parseKitchenAction({...tap, ...patch})).toThrow(KitchenActionConflict);
  }
  expect(await kitchenActionHash(tap)).toBe(await kitchenActionHash(JSON.parse(saved)));
  const parsed = parseKitchenAction(tap); parsed.transitionEventIds[0] = ulid();
  expect(JSON.stringify(tap)).toBe(saved);
  await expect(applyKitchenAction({...f, action: {...tap, occurredAt: now + 300001}, admittedAt: now, acknowledgement: null})).rejects.toBeInstanceOf(KitchenActionConflict);
});

it('never returns private fields in a receipt and rejects extra fields or a different originating session', async () => {
  const {f, tap, result} = await acknowledge();
  expect(() => parseKitchenReceipt({...result.receipt, token: 'private'})).toThrow();
  expect(() => parseKitchenReceipt({...result.receipt, sessionId: ulid()}, {action: tap, access: f.access})).toThrow();
  const text = JSON.stringify(result.receipt);
  for (const field of ['customer','phone','address','sourceText','unitPrice','total','token','permissions','role']) expect(text).not.toContain('"' + field + '"');
  expect(result.events.at(-1)?.after).toEqual(result.receipt);
});

it('captures the original complete ticket and identities before asynchronous hashing yields', async () => {
  const {order} = fixture(), original = structuredClone(order);
  const preparing = prepareKitchenAction(order, 'kitchen.acknowledge', null, now);
  order.lines[0].name = 'Changed during hash'; order.revision++;
  const prepared = await preparing;
  expect(prepared.contentHash).toBe(await kitchenContentHash(original));
  expect(prepared.revision).toBe(original.revision);
  expect(prepared.occurredAt).toBe(now);
  expect(new Set([prepared.id, ...prepared.transitionEventIds]).size).toBe(4);
});
