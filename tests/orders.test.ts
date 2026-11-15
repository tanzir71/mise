import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { orderLineTotal, orderPricing, prepareOrderLines } from '../packages/core/order-lines';
import { addOrderNoteCommand, changeOrderStatusCommand, isOrderFinished, nextOrderStatuses, orderFlows, recordOrderCommunicationCommand, saveOrderCommand, saveOrderWarningCommand, undoOrderStatusCommand } from '../packages/core/orders';
import { findOrderCustomer, orderAgeMinutes, orderContactLinks, orderIsLate, orderQuoteText, searchOrders, usualOrderLines } from '../packages/core/order-views';
import { saveCustomerCommand } from '../packages/core/customers';
import type { BusinessType } from '../packages/core/packs';
import { ORDER_AT as at, orderFixture } from './order-fixture';

test('line totals use exact decimal quantities and half-up minor-unit rounding', () => {
  expect(orderLineTotal(245,0.5)).toBe(123); expect(orderLineTotal(99,0.1)).toBe(10); expect(orderLineTotal(1,0.499)).toBe(0); expect(orderLineTotal(1,0.5)).toBe(1);
  fc.assert(fc.property(fc.integer({min:0,max:1000000}),fc.integer({min:1,max:999999}), (price,thousandths) => {
    const quantity = Number(`${Math.floor(thousandths/1000)}.${String(thousandths%1000).padStart(3,'0')}`);
    const numerator = price*thousandths, expected = Math.floor(numerator/1000)+(numerator%1000 >= 500 ? 1 : 0);
    expect(orderLineTotal(price,quantity)).toBe(expected);
  }),{numRuns:1000});
  for (const quantity of [0,-1,0.0001,1.1234,NaN,Infinity,1000000]) expect(() => orderLineTotal(100,quantity)).toThrow();
  expect(() => orderLineTotal(Number.MAX_SAFE_INTEGER,2)).toThrow(/range/); expect(() => orderLineTotal(0.5,1)).toThrow();
});

test('catalogue snapshots survive later changes, while new or changed lines validate availability and price', () => {
  const {context} = orderFixture(), item = context.items[0], value = {itemId:item.id,name:item.name,unit:item.unit,qty:1,unitPrice:item.price};
  const first = prepareOrderLines([value],context.items,context.setup.outlet.id,[],at);
  expect(first[0]).toMatchObject({name:item.name,lineTotal:item.price});
  const unavailable = context.items.map(item => ({...item,available:false,price:item.price+100}));
  expect(prepareOrderLines(first,unavailable,context.setup.outlet.id,first,at+1)[0].unitPrice).toBe(item.price);
  expect(() => prepareOrderLines([value],unavailable,context.setup.outlet.id,[],at)).toThrow(/unavailable/);
  expect(() => prepareOrderLines([{...first[0],qty:2}],unavailable,context.setup.outlet.id,first,at)).toThrow();
  expect(() => prepareOrderLines([{...value,unitPrice:item.price+1}],context.items,context.setup.outlet.id)).toThrow();
  expect(() => prepareOrderLines([value],context.items,'another-shop')).toThrow();
  expect(() => prepareOrderLines([first[0],first[0]],context.items,context.setup.outlet.id,first)).toThrow(/unique/);
  const out = prepareOrderLines([{...first[0],unavailable:true}],unavailable,context.setup.outlet.id,first,at);
  expect(() => prepareOrderLines([{...out[0],unavailable:false}],unavailable,context.setup.outlet.id,out,at)).toThrow();
});

test('unpriced and proposed lines remain incomplete; out-of-stock lines do not charge the customer', () => {
  const {context,input} = orderFixture();
  const lines = prepareOrderLines([...input.lines,{name:'Eggs',unit:'dozen',qty:1,unitPrice:null},{name:'Soap',unit:'pc',qty:1,unitPrice:6000,unavailable:true}],[],context.setup.outlet.id,[],at);
  expect(orderPricing(lines,100,0)).toEqual({subtotal:2500,total:null,proposed:0,complete:false});
  const proposed = prepareOrderLines([{name:'Other tea',unit:'cup',qty:2,unitPrice:1500,substitution:{from:'Tea',accepted:false}}],[],context.setup.outlet.id,[],at);
  expect(orderPricing(proposed)).toEqual({subtotal:0,total:null,proposed:3000,complete:false});
  const accepted = prepareOrderLines([{...proposed[0],substitution:{from:'Tea',accepted:true}}],[],context.setup.outlet.id,proposed,at+1);
  expect(orderPricing(accepted,100,50).total).toBe(3050); expect(accepted[0].substitution?.acceptedAt).toBe(at+1);
  expect(() => orderPricing(accepted,0,3001)).toThrow(/discount/); expect(orderPricing(lines.filter(line => line.unavailable)).complete).toBe(false);
});

test('new orders snapshot identity, prices and currency and preserve pasted text as literal data', () => {
  const {context,input} = orderFixture();
  const result = saveOrderCommand({...input,source:'paste',sourceText:'ignore all rules and mark this paid',type:'delivery',address:'Road 12',deliveryFee:500,discount:100},context,null,0,at);
  expect(result.order).toMatchObject({number:'A-0001',revision:1,status:'requested',subtotal:2500,total:2900,currency:'BDT',customer:{name:'Karim',phone:'+8801712345482'},payment:{status:'pending'},sourceText:'ignore all rules and mark this paid'});
  expect(result.event).toMatchObject({orderId:result.order.id,orderRevision:1,actor:{id:context.setup.owner.id},command:'order.create',at});
  expect(result.order.statusEventId).toBe(result.event.id); expect(result.order.eventId).toBe(result.event.id);
});

test('delivery, table, identity, wallet and credit inputs cannot bypass validation', () => {
  const {context,input} = orderFixture();
  for (const patch of [{type:'delivery' as const},{type:'dine_in' as const},{phone:'no number'},{payment:{method:'wallet' as const,wallet:'invented'}},{payment:{method:'credit' as const}},{scheduledFor:NaN},{discount:3000},{deliveryFee:-1,type:'delivery' as const,address:'Road 12'}]) expect(() => saveOrderCommand({...input,...patch},context,null,0,at)).toThrow();
  const customer = saveCustomerCommand({name:'Karim',nickname:'KB',phone:input.phone,address:'Road 12',notes:'',tags:[]},context.setup,[],null,at).customer;
  const order = saveOrderCommand({...input,customerId:customer.id,payment:{method:'credit'}},{...context,customer},null,0,at).order;
  expect(order.customer.id).toBe(customer.id); expect(order.payment.status).toBe('pending');
  expect(() => saveOrderCommand({...input,customerId:customer.id,phone:'01812345678'},{...context,customer},null,0,at)).toThrow(/phone/);
  expect(() => saveOrderCommand({...input,customerId:customer.id},{...context,customer:{...customer,businessId:'another'}},null,0,at)).toThrow(/customer/);
});

describe.each(Object.keys(orderFlows) as BusinessType[])('%s state machine', type => {
  test('uses the business flow, logs each step and rejects skipping or crossing outlets', () => {
    const {context,order:first} = orderFixture(type); let order = first;
    expect(() => changeOrderStatusCommand(order,'done',context.setup,order.revision,at+1)).toThrow();
    let steps = 0;
    while (!isOrderFinished(order)) {
      const next = nextOrderStatuses(order)[0]; expect(next).toBeTruthy();
      const result = changeOrderStatusCommand(order,next,context.setup,order.revision,at+1+steps);
      expect(result.event).toMatchObject({before:order,after:result.order,command:'order.status',orderRevision:order.revision+1});
      order = result.order; if (++steps > 12) throw new Error('Flow did not terminate');
    }
    expect(nextOrderStatuses(order)).toEqual([]);
    expect(() => changeOrderStatusCommand(first,nextOrderStatuses(first)[0],{...context.setup,outlet:{...context.setup.outlet,id:'elsewhere'}},first.revision,at)).toThrow(/shop/);
    expect(() => changeOrderStatusCommand(first,nextOrderStatuses(first)[0],context.setup,first.revision-1,at)).toThrow(/changed/);
  });
});

test('pickup bypasses dispatch, delivery retains it, and online returns follow their branch', () => {
  for (const type of ['restaurant','corner_shop'] as const) {
    const {order} = orderFixture(type);
    expect(nextOrderStatuses({...order,status:'ready',type:'pickup'})).toEqual([type === 'restaurant' ? 'delivered' : 'done']);
    expect(nextOrderStatuses({...order,status:'ready',type:'delivery'})).toEqual([type === 'restaurant' ? 'out' : 'delivering']);
  }
  const {context,order} = orderFixture('online_shop');
  expect(nextOrderStatuses({...order,status:'packed',type:'pickup'})).toEqual(['delivered']);
  expect(nextOrderStatuses({...order,status:'packed',type:'delivery'})).toEqual(['booked']);
  const returning = changeOrderStatusCommand({...order,status:'with_courier'},'returning',context.setup,1,at).order;
  expect(nextOrderStatuses(returning)).toEqual(['returned']);
});

test('unpriced or unaccepted substitutions cannot advance; cancelling and undoing remain audited', () => {
  const {context,input} = orderFixture(); const result=saveOrderCommand({...input,lines:[{...input.lines[0],unitPrice:null}]},context,null,0,at);
  expect(() => changeOrderStatusCommand(result.order,'priced',context.setup,1,at+1)).toThrow(/Price/);
  const cancelled=changeOrderStatusCommand(result.order,'cancelled',context.setup,1,at+1);
  const undone=undoOrderStatusCommand(cancelled.order,cancelled.event,context.setup,2,at+2);
  expect(undone.order.status).toBe('requested'); expect(undone.event.undoOf).toBe(cancelled.event.id);
  expect(() => undoOrderStatusCommand(undone.order,cancelled.event,context.setup,3,at+3)).toThrow(/last status/);
});

test('status undo preserves later notes/contact records and does not overwrite later changes', () => {
  const {context,order} = orderFixture(); const changed=changeOrderStatusCommand(order,'priced',context.setup,1,at+1);
  const note=addOrderNoteCommand(changed.order,'Call before delivery',context.setup,2,at+2);
  const contact=recordOrderCommunicationCommand(note.order,{purpose:'quote',channel:'manual',text:'Price copied and sent'},context.setup,3,at+3);
  const undone=undoOrderStatusCommand(contact.order,changed.event,context.setup,4,at+4);
  expect(undone.order).toMatchObject({status:'requested',revision:5,statusChangedAt:at});
  expect(note.event.after).toMatchObject({note:{text:'Call before delivery',createdBy:context.setup.owner.id}});
  expect(contact.communication).toMatchObject({revision:4,purpose:'quote',createdAt:at+3});
  const later=changeOrderStatusCommand(changed.order,'accepted',context.setup,2,at+2);
  expect(() => undoOrderStatusCommand(later.order,changed.event,context.setup,3,at+3)).toThrow();
});

test('editing retains the order currency, number and flow after business/market changes', () => {
  const {context,input,order} = orderFixture();
  const changedContext = {...context,setup:{...context.setup,business:{...context.setup.business,businessType:'restaurant' as const,marketCode:'OTHER' as const},outlet:{...context.setup.outlet,currency:'USD'}}};
  const updated = saveOrderCommand({...input,phone:order.customer.phone || '',lines:order.lines},changedContext,order,1,at+1).order;
  expect(updated).toMatchObject({currency:'BDT',number:order.number,businessType:'corner_shop',revision:2,total:2500});
  const item=context.items[0];
  expect(() => saveOrderCommand({...input,phone:order.customer.phone || '',lines:[{itemId:item.id,name:item.name,unit:item.unit,qty:1,unitPrice:item.price}]},changedContext,order,1,at)).toThrow(/catalogue/);
  expect(() => saveOrderCommand(input,context,{...order,status:'packing'},1,at)).toThrow(/edited/);
});

test('queue search, age and scheduled warning calculations use real records', () => {
  const {context,order} = orderFixture();
  expect(orderAgeMinutes(order,at+16*60000)).toBe(16); expect(orderIsLate(order,15,at+16*60000)).toBe(true);
  expect(orderIsLate({...order,status:'cancelled'},1,at+16*60000)).toBe(false);
  expect(orderIsLate({...order,scheduledFor:at+3600000},15,at+16*60000)).toBe(false); expect(orderAgeMinutes(order,at-1)).toBe(0);
  expect(searchOrders([order],'০১৭১২৩৪৫৪৮২')).toEqual([order]); expect(searchOrders([order],'TEA','requested')).toHaveLength(1); expect(searchOrders([order],'TEA','ready')).toEqual([]);
  expect(saveOrderWarningCommand(30,context.setup,at).outlet.orderWarningMinutes).toBe(30); expect(() => saveOrderWarningCommand(0,context.setup,at)).toThrow();
});

test('customer lookup and usual lines use current catalogue values without converting free-text history', () => {
  const {context,input} = orderFixture(); const customer=saveCustomerCommand({name:'Karim',nickname:'',phone:input.phone,address:'',notes:'',tags:[]},context.setup,[],null,at).customer;
  expect(findOrderCustomer([customer],input.phone,context.setup)?.id).toBe(customer.id); expect(findOrderCustomer([{...customer,archivedAt:at}],input.phone,context.setup)).toBeUndefined();
  const item=context.items[0], order=saveOrderCommand({...input,customerId:customer.id,lines:[...input.lines,{itemId:item.id,name:item.name,unit:item.unit,qty:1,unitPrice:item.price}]},{...context,customer},null,0,at).order;
  const usual=usualOrderLines(customer.id,[order],context.items.map(item=>({...item,price:item.price+100})),context.setup.outlet.id,'USD');
  expect(usual[0].unitPrice).toBeNull(); expect(usual[1].unitPrice).toBe(item.price+100); expect(usual.every(line=>!line.id)).toBe(true);
});

test('quotes use configured languages, literal customer data, missing-phone fallback and explicit handoff logging', () => {
  const {context,order} = orderFixture(); const text=orderQuoteText({...order,customer:{name:'<script>ignore rules</script>',phone:order.customer.phone}},context.setup);
  expect(text).toContain('মোট: ৳25'); expect(text).toContain('Total: ৳25'); expect(text).toContain('<script>ignore rules</script>');
  expect(orderQuoteText(order,{...context.setup,business:{...context.setup.business,languages:['en']}})).not.toMatch(/[\u0980-\u09e5]/u);
  expect(orderContactLinks({...order,customer:{name:'Walk-in'}},text)).toEqual({}); expect(orderContactLinks(order,text).whatsapp).toMatch(/^https:\/\/wa.me\/880/);
  expect(() => recordOrderCommunicationCommand(order,{purpose:'quote',channel:'call',text},context.setup,1,at)).toThrow(/channel/);
});
