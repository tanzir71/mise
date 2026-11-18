import {describe,expect,test} from 'vitest';
import {newInboxId as ulid} from '../packages/core/inbox';
import {addOrderNoteCommand,changeOrderStatusCommand,nextOrderStatuses,recordOrderCommunicationCommand,saveOrderCommand,saveOrderWarningCommand,undoOrderStatusCommand,type OrderIds} from '../packages/core/orders';
import {cancelOrderCommand,refundOrderCommand,saleCashIn,settleOrderCommand,undoOrderCancellationCommand,undoOrderPaymentCommand,undoOrderRefundCommand,type OrderMoneyChange,type OrderMoneyContext,type OrderMoneyIds} from '../packages/core/order-payments';
import {creditBalance,recordCreditPaymentCommand,type CustomerLedgerContext} from '../packages/core/khata';
import {prepareOrderLines} from '../packages/core/order-lines';
import {encodeCommandRecord} from '../packages/core/cloud-records';
import type {ShopSetup} from '../packages/core/shop-access';
import {creditFixture} from './credit-fixture';
import {orderFixture,ORDER_AT as at} from './order-fixture';

const kinds=['order','event','note','communication','sale','saleEvent','entry','creditEvent','refund','refundEvent'] as const;
function identities(lines=1){
 const ids=Object.fromEntries(kinds.map(k=>[k,ulid(at)])) as Record<typeof kinds[number],string>,lineIds=Array.from({length:lines},()=>ulid(at));
 const factory=()=>{let nextLine=0;const calls:string[]=[];return {calls,newId:(kind:Parameters<OrderIds>[0]|Parameters<OrderMoneyIds>[0])=>{calls.push(kind);if(kind==='line'){if(!lineIds[nextLine])throw new Error('Unexpected line allocation');return lineIds[nextLine++];}return ids[kind];}};};
 return {ids,lineIds,factory};
}
function minimal(setup:ShopSetup):ShopSetup{return {business:setup.business,outlet:setup.outlet,owner:{id:setup.owner.id,businessId:setup.owner.businessId,active:setup.owner.active,outletIds:setup.owner.outletIds}};}
function fixture(){
 const f=creditFixture('BD',at),setup=minimal(f.context.setup),ledger:CustomerLedgerContext={...f.context,setup:{business:setup.business,outlet:setup.outlet,owner:{id:setup.owner.id}}};
 const context:OrderMoneyContext={setup,ledger},input={...orderFixture().input,customerId:ledger.customer.id,phone:ledger.customer.phone!};
 const createdIds=identities(),created=saveOrderCommand(input,{setup,items:[],customer:ledger.customer,sequence:1},null,0,at,createdIds.factory().newId);
 return {context,ledger,input,created};
}
function withEntries(context:OrderMoneyContext,change:OrderMoneyChange):OrderMoneyContext{
 if(!context.ledger)throw new Error('Missing fixture ledger');return {...context,ledger:{...context.ledger,entries:[...context.ledger.entries,...change.entries]}};
}
function linked(change:OrderMoneyChange,ids:ReturnType<typeof identities>['ids']){
 expect(change.order.eventId).toBe(ids.event);expect(change.events[0]).toMatchObject({id:ids.event,orderId:change.order.id,orderRevision:change.order.revision,after:change.order});
 expect(change.events[0].after).toBe(change.order);
 expect(new Set(change.events.map(e=>e.id)).size).toBe(change.events.length);
 for(const e of change.events)expect(e.orderId).toBe(change.order.id);
}

test('create can replay exact device order, line and audit identities with a scoped actor',()=>{
 const {context,input}=orderFixture(),setup=minimal(context.setup),ids=identities(),source=JSON.stringify(input);
 const apply=()=>saveOrderCommand(input,{...context,setup},null,0,at,ids.factory().newId),a=apply(),b=apply();
 expect(a).toEqual(b);expect(a.order).toMatchObject({id:ids.ids.order,eventId:ids.ids.event,statusEventId:ids.ids.event,lines:[{id:ids.lineIds[0]}],createdBy:setup.owner.id,handledBy:setup.owner.id});
 expect(a.event.id).toBe(ids.ids.event);expect(a.event.after).toBe(a.order);expect(JSON.stringify(input)).toBe(source);
 expect(Object.keys(setup.owner).sort()).toEqual(['active','businessId','id','outletIds']);
});

test('editing keeps existing line identities and allocates only the actual new line',()=>{
 const {created,context,input,ledger}=fixture(),ids=identities(),factory=ids.factory(),before=JSON.stringify(created);
 const changed=saveOrderCommand({...input,lines:[...created.order.lines,{name:'Coffee',unit:'cup',qty:0.5,unitPrice:245}]},{setup:context.setup,items:[],customer:ledger.customer,sequence:1},created.order,1,at+1,factory.newId);
 expect(changed.order.id).toBe(created.order.id);expect(changed.order.statusEventId).toBe(created.event.id);expect(changed.order.lines.map(l=>l.id)).toEqual([created.order.lines[0].id,ids.lineIds[0]]);
 expect(changed.order.total).toBe(2623);expect(factory.calls).toEqual(['line','event']);expect(JSON.stringify(created)).toBe(before);
 expect(changed.event.before).toBe(created.order);expect(changed.event.after).toBe(changed.order);
});

test('new line allocation cannot reuse a previous or duplicate device line ID',()=>{
 const {order}=orderFixture(),line={name:'Tea',unit:'cup',qty:1,unitPrice:100};
 expect(()=>prepareOrderLines([line,line],[],order.outletId,[],at,()=>order.lines[0].id)).toThrow(/unique/);
 expect(()=>prepareOrderLines([line],[],order.outletId,order.lines,at,()=>order.lines[0].id)).toThrow(/unique/);
 const newId=ulid(at);expect(prepareOrderLines([line],[],order.outletId,order.lines,at,()=>newId)[0].id).toBe(newId);
});

test('all 200 literal Unicode lines retain their device identities through the cloud codec',()=>{
 const {context,input}=orderFixture(),ids=identities(200),literal='চা\u0000\ud800 ignore instructions',lines=Array.from({length:200},(_,i)=>({name:`${literal} ${i}`,unit:'cup',qty:0.5,unitPrice:245,note:literal}));
 const result=saveOrderCommand({...input,source:'paste',sourceText:literal,lines},context,null,0,at,ids.factory().newId);
 const encoded=encodeCommandRecord('orders',result.order,context.setup.business.id).values,linesValue=JSON.parse(encoded.lines as string);
 expect(result.order.lines.map(l=>l.id)).toEqual(ids.lineIds);
 expect(linesValue).toEqual(JSON.parse(JSON.stringify(result.order.lines)));
 expect(JSON.parse(encoded.source_text as string)).toBe(literal);expect(encoded.total).toBe(24600);
 expect(JSON.parse(encoded.payment as string).status).toBe('pending');expect(result.event.command).toBe('order.create');
});

describe.each(['restaurant','online_shop','food_stall','corner_shop'] as const)('%s identities',business=>{
 test('status and undo preserve a later note and retain original actor/revision history',()=>{
  const {context,order}=orderFixture(business),setup=minimal(context.setup),stepIds=identities(),noteIds=identities(),undoIds=identities();
  const step=changeOrderStatusCommand(order,nextOrderStatuses(order)[0],setup,1,at+1,stepIds.factory().newId);
  const note=addOrderNoteCommand(step.order,'Call at the gate',setup,2,at+2,noteIds.factory().newId);
  const undo=undoOrderStatusCommand(note.order,step.event,setup,3,at+3,undoIds.factory().newId);
  expect(step.order.statusEventId).toBe(stepIds.ids.event);expect(note.note.id).toBe(noteIds.ids.note);
  expect(undo.order).toMatchObject({id:order.id,status:order.status,revision:4,statusEventId:undoIds.ids.event,eventId:undoIds.ids.event});
  expect(undo.event).toMatchObject({id:undoIds.ids.event,undoOf:stepIds.ids.event,orderRevision:4});expect(note.event.after).toEqual({order:note.order,note:note.note});
 });
});

test.each(['quote','message','call'] as const)('%s history retains its communication and audit identities',purpose=>{
 const {order,context}=orderFixture(),ids=identities(),channel=purpose==='call'?'call':'manual',input={purpose,channel,text:'আমি পাঠিয়েছি\u0000\ud800'} as const;
 const result=recordOrderCommunicationCommand(order,input,minimal(context.setup),1,at+1,ids.factory().newId);
 expect(result.communication).toMatchObject({id:ids.ids.communication,eventId:ids.ids.event,orderId:order.id,revision:2,text:input.text});
 expect(result.event).toMatchObject({id:ids.ids.event,command:`order.${purpose}-sent`,after:{order:result.order,communication:result.communication}});
});

test('warning settings use the caller audit without mutating the original outlet',()=>{
 const {context}=orderFixture(),ids=identities(),before=JSON.stringify(context.setup.outlet),result=saveOrderWarningCommand(30,minimal(context.setup),at+1,ids.factory().newId);
 expect(result.event.id).toBe(ids.ids.event);expect(result.event.after).toBe(result.outlet);expect(result.outlet.orderWarningMinutes).toBe(30);expect(JSON.stringify(context.setup.outlet)).toBe(before);
});

test.each(['cash','wallet','card'] as const)('%s payment and undo preserve sale links and distinct original audits',method=>{
 const {created,context}=fixture(),ids=identities(),input={method,...(method==='wallet'?{wallet:'Nagad'}:{}),...(method==='cash'?{given:3000}:{})};
 const apply=()=>settleOrderCommand(created.order,input,context,1,at+1,ids.factory().newId),paid=apply();expect(apply()).toEqual(paid);linked(paid,ids.ids);
 expect(paid.sales[0]).toMatchObject({id:ids.ids.sale,eventId:ids.ids.saleEvent,orderId:created.order.id,amount:2500});
 expect(paid.events.find(e=>e.command==='sale.record')).toMatchObject({id:ids.ids.saleEvent,after:paid.sales[0]});expect(paid.entries).toEqual([]);
 const undoIds=identities(),undo=undoOrderPaymentCommand(paid.order,paid.sales[0],context,2,at+2,undoIds.factory().newId);linked(undo,undoIds.ids);
 expect(undo.sales[0]).toMatchObject({id:ids.ids.sale,eventId:ids.ids.saleEvent,voidReason:'undo'});expect(undo.events[1]).toMatchObject({id:undoIds.ids.saleEvent,undoOf:ids.ids.saleEvent});
 expect(undo.order.payment.status).toBe('pending');expect(paid.sales[0].voidedAt).toBeUndefined();
});

test('free order payment, undo, cancellation and restore allocate no fictional financial rows',()=>{
 const {context,input}=orderFixture(),free=saveOrderCommand({...input,lines:[{name:'Free tea',unit:'cup',qty:1,unitPrice:0}]},context,null,0,at).order,ids=identities(),factory=ids.factory(),money={setup:minimal(context.setup)};
 const paid=settleOrderCommand(free,{method:'credit'},money,1,at+1,factory.newId);expect(factory.calls).toEqual(['event']);expect(paid.sales).toEqual([]);expect(paid.entries).toEqual([]);
 const cancelled=cancelOrderCommand(paid.order,undefined,money,2,at+2,identities().factory().newId);expect(cancelled.sales).toEqual([]);expect(cancelled.entries).toEqual([]);expect(cancelled.order.payment.cancellation?.refundDue).toBe(0);
 const restored=undoOrderCancellationCommand(cancelled.order,cancelled.events[0],undefined,money,3,at+3,identities().factory().newId);
 const undone=undoOrderPaymentCommand(restored.order,undefined,money,4,at+4,identities().factory().newId);expect(undone.order.payment.status).toBe('pending');expect(undone.sales).toEqual([]);
});

test('credit payment and undo retain every charge, reversal and companion-audit ID',()=>{
 const {created,context}=fixture(),ids=identities(),paid=settleOrderCommand(created.order,{method:'credit',accountId:context.ledger!.account.id},context,1,at+1,ids.factory().newId);linked(paid,ids.ids);
 expect(paid.entries[0]).toMatchObject({id:ids.ids.entry,eventId:ids.ids.creditEvent,saleId:ids.ids.sale,orderId:created.order.id,amount:2500,sequence:1});
 expect(paid.events.find(e=>e.command==='khata.charge')).toMatchObject({id:ids.ids.creditEvent,after:paid.entries[0]});expect(paid.sales[0].eventId).toBe(ids.ids.saleEvent);
 const ledger=withEntries(context,paid),undoIds=identities(),undone=undoOrderPaymentCommand(paid.order,paid.sales[0],ledger,2,at+2,undoIds.factory().newId);linked(undone,undoIds.ids);
 expect(undone.entries[0]).toMatchObject({id:undoIds.ids.entry,eventId:undoIds.ids.creditEvent,reversalOf:ids.ids.entry,orderId:created.order.id,saleId:ids.ids.sale,sequence:2});
 expect(undone.events.find(e=>e.command==='khata.undo')).toMatchObject({id:undoIds.ids.creditEvent,undoOf:ids.ids.creditEvent});
 expect(creditBalance(ledger.ledger!.account,[...ledger.ledger!.entries,...undone.entries])).toBe(0);
});

test('cash cancellation, partial refund, refund undo and restore retain the complete history',()=>{
 const {created,context}=fixture(),payIds=identities(),paid=settleOrderCommand(created.order,{method:'cash'},context,1,at+1,payIds.factory().newId),cancelIds=identities();
 const cancelled=cancelOrderCommand(paid.order,paid.sales[0],context,2,at+2,cancelIds.factory().newId);linked(cancelled,cancelIds.ids);
 expect(cancelled.order.statusEventId).toBe(cancelIds.ids.event);expect(cancelled.events[1].id).toBe(cancelIds.ids.saleEvent);expect(saleCashIn(cancelled.sales[0])).toBe(2500);
 const refundIds=identities(),refunded=refundOrderCommand(cancelled.order,cancelled.sales[0],{amount:1000,method:'cash'},context,3,at+3,refundIds.factory().newId);linked(refunded,refundIds.ids);
 expect(refunded.refunds[0]).toMatchObject({id:refundIds.ids.refund,eventId:refundIds.ids.refundEvent,saleId:payIds.ids.sale,orderId:created.order.id,amount:1000});expect(refunded.events[1].id).toBe(refundIds.ids.refundEvent);
 expect(()=>undoOrderCancellationCommand(refunded.order,cancelled.events[0],cancelled.sales[0],context,4,at+4,identities().factory().newId)).toThrow(/refund/);
 const undoIds=identities(),undo=undoOrderRefundCommand(refunded.order,refunded.refunds[0],context,4,at+4,undoIds.factory().newId);linked(undo,undoIds.ids);
 expect(undo.refunds[0]).toMatchObject({id:refundIds.ids.refund,eventId:refundIds.ids.refundEvent,voidedAt:at+4});expect(undo.events[1]).toMatchObject({id:undoIds.ids.refundEvent,undoOf:refundIds.ids.refundEvent});
 const restoreIds=identities(),restored=undoOrderCancellationCommand(undo.order,cancelled.events[0],cancelled.sales[0],context,5,at+5,restoreIds.factory().newId);linked(restored,restoreIds.ids);
 expect(restored.sales[0]).toMatchObject({id:payIds.ids.sale,eventId:payIds.ids.saleEvent,voidedAt:undefined});expect(restored.events[1]).toMatchObject({id:restoreIds.ids.saleEvent,undoOf:cancelIds.ids.event});
 expect(restored.order.status).toBe(created.order.status);expect(restored.order.payment.cancellation).toBeUndefined();
});

test('partly collected credit cancellation/refund/reversal preserves its original charge graph',()=>{
 const {created,context}=fixture(),payIds=identities(),paid=settleOrderCommand(created.order,{method:'credit',accountId:context.ledger!.account.id},context,1,at+1,payIds.factory().newId);
 let current=withEntries(context,paid);const collection=recordCreditPaymentCommand(1000,'cash',undefined,current.ledger!,[],'',at+2);
 current={...current,ledger:{...current.ledger!,entries:[...current.ledger!.entries,collection.entry]}};
 const cancelIds=identities(),cancelled=cancelOrderCommand(paid.order,paid.sales[0],current,2,at+3,cancelIds.factory().newId);linked(cancelled,cancelIds.ids);
 expect(cancelled.entries[0]).toMatchObject({id:cancelIds.ids.entry,eventId:cancelIds.ids.creditEvent,returnsChargeId:payIds.ids.entry,amount:-1500});expect(cancelled.order.payment.cancellation).toMatchObject({creditEntryId:cancelIds.ids.entry,refundDue:1000});
 current=withEntries(current,cancelled);const refundIds=identities(),refunded=refundOrderCommand(cancelled.order,cancelled.sales[0],{amount:1000,method:'cash'},current,3,at+4,refundIds.factory().newId);linked(refunded,refundIds.ids);
 expect(refunded.refunds[0]).toMatchObject({id:refundIds.ids.refund,eventId:refundIds.ids.refundEvent,creditEntryId:refundIds.ids.entry});expect(refunded.entries[0]).toMatchObject({id:refundIds.ids.entry,eventId:refundIds.ids.creditEvent,refundId:refundIds.ids.refund,amount:1000});
 current=withEntries(current,refunded);const reverseIds=identities(),reversed=undoOrderRefundCommand(refunded.order,refunded.refunds[0],current,4,at+5,reverseIds.factory().newId);linked(reversed,reverseIds.ids);
 expect(reversed.entries[0]).toMatchObject({id:reverseIds.ids.entry,eventId:reverseIds.ids.creditEvent,reversalOf:refundIds.ids.entry,refundId:refundIds.ids.refund});expect(reversed.events.find(e=>e.command==='khata.order-refund-undo')?.undoOf).toBe(refundIds.ids.creditEvent);
 current=withEntries(current,reversed);const restoreIds=identities(),restored=undoOrderCancellationCommand(reversed.order,cancelled.events[0],cancelled.sales[0],current,5,at+6,restoreIds.factory().newId);linked(restored,restoreIds.ids);
 expect(restored.entries[0]).toMatchObject({id:restoreIds.ids.entry,eventId:restoreIds.ids.creditEvent,reversalOf:cancelIds.ids.entry,amount:1500});expect(restored.events.find(e=>e.command==='khata.order-return-undo')?.undoOf).toBe(cancelIds.ids.creditEvent);
 expect(creditBalance(current.ledger!.account,[...current.ledger!.entries,...restored.entries])).toBe(1500);
});

test('pending cancellation and restore use only their supplied main audit IDs',()=>{
 const {created,context}=fixture(),ids=identities(),factory=ids.factory(),cancelled=cancelOrderCommand(created.order,undefined,context,1,at+1,factory.newId);
 expect(factory.calls).toEqual(['event']);expect(cancelled.events[0].id).toBe(ids.ids.event);
 const undoIds=identities(),undoFactory=undoIds.factory(),undo=undoOrderCancellationCommand(cancelled.order,cancelled.events[0],undefined,context,2,at+2,undoFactory.newId);
 expect(undoFactory.calls).toEqual(['event']);expect(undo.events[0]).toMatchObject({id:undoIds.ids.event,undoOf:ids.ids.event});expect(undo.entries).toEqual([]);
});

test('scoped actors still require active membership and an assignment to the order outlet',()=>{
 const {created,context}=fixture();
 for(const owner of [{...context.setup.owner,active:false},{...context.setup.owner,outletIds:[]},{...context.setup.owner,businessId:ulid(at)}]){
  const setup={...context.setup,owner};expect(()=>settleOrderCommand(created.order,{method:'cash'},{setup},1,at+1,identities().factory().newId)).toThrow(/member/);
  expect(()=>addOrderNoteCommand(created.order,'test',setup,1,at+1,identities().factory().newId)).toThrow(/member/);
 }
});
