import {beforeAll,expect,it} from 'vitest';
import {evaluateKitchenAlarm,parseKitchenAlarmSettings} from '../packages/core/kitchen-alarms';
import {kitchenScreenFixture} from './fixtures/kitchen-screen';
import {orderFixture} from './order-fixture';
import {applyKitchenAction,prepareKitchenAction} from '../packages/core/kitchen';
import type {KitchenTicket} from '../packages/core/kitchen-tickets';
let f:Awaited<ReturnType<typeof kitchenScreenFixture>>,current:KitchenTicket;
let scope:{businessId:string;outletId:string};
const on={enabled:true,minutes:2};
beforeAll(async()=>{
 f=await kitchenScreenFixture();scope={businessId:f.access.businessId,outletId:f.ticket.outletId};
 const seed=orderFixture('restaurant').context.setup,shop={business:{...seed.business,id:scope.businessId},outlet:{...seed.outlet,id:scope.outletId,businessId:scope.businessId}};
 const action=await prepareKitchenAction(f.ticket,'kitchen.acknowledge',null,f.now),accepted=await applyKitchenAction({order:f.order,shop,access:f.access,action,admittedAt:f.now,acknowledgement:null});
 current={...f.ticket,status:accepted.order.status,revision:accepted.order.revision,acknowledgement:accepted.receipt};
});
it('keeps a disabled alarm quiet after its deadline',()=>{expect(evaluateKitchenAlarm(f.ticket,{enabled:false,minutes:2},scope,f.now).state).toBe('disabled');});
it.each([[119999,'waiting'],[120000,'due'],[120001,'due']] as const)('checks the actual two-minute boundary at %s milliseconds', (elapsed,state)=>{
 const result=evaluateKitchenAlarm(f.ticket,on,scope,f.ticket.createdAt+elapsed);expect(result.state).toBe(state);expect(result.dueAt).toBe(f.ticket.createdAt+120000);
});
it('uses the configured period instead of raising at the previous default',()=>{expect(evaluateKitchenAlarm(f.ticket,{enabled:true,minutes:5},scope,f.ticket.createdAt+120000)).toMatchObject({state:'waiting',dueAt:f.ticket.createdAt+300000});});
it('starts a scheduled acknowledgement clock at the original scheduled time and keeps the two-minute boundary',()=>{
 const start=f.now+3600000,ticket={...f.ticket,scheduledFor:start};
 expect(evaluateKitchenAlarm(ticket,on,scope,f.ticket.createdAt+120000)).toMatchObject({state:'waiting',dueAt:start+120000});
 expect(evaluateKitchenAlarm(ticket,on,scope,start+119999).state).toBe('waiting');
 expect(evaluateKitchenAlarm(ticket,on,scope,start+120000).state).toBe('due');
 expect(evaluateKitchenAlarm({...ticket,scheduledFor:f.ticket.createdAt-1},on,scope,f.ticket.createdAt+120000)).toMatchObject({state:'due',dueAt:f.ticket.createdAt+120000});
});
it.each(['out','booked','with_courier','returning','delivering'] as const)('does not warn about %s after preparation has been handed off',status=>{
 expect(evaluateKitchenAlarm({...f.ticket,status},on,scope,f.now).state).toBe('finished');
});
it.each([-1,Number.NaN,Number.POSITIVE_INFINITY])('rejects an invalid original scheduled clock: %s',scheduledFor=>{
 expect(()=>evaluateKitchenAlarm({...f.ticket,scheduledFor},on,scope,f.now)).toThrow();
});
it('does not substitute Ready status for a real acknowledgement',()=>{expect(evaluateKitchenAlarm({...f.ticket,status:'ready'},on,scope,f.now).state).toBe('due');});
it.each([['cancelled','cancelled'],['delivered','finished']] as const)('stops preparation alerts for %s orders', (status,state)=>{expect(evaluateKitchenAlarm({...f.ticket,status},on,scope,f.now).state).toBe(state);});
it('stops on the actual current domain acknowledgement',()=>{expect(evaluateKitchenAlarm(current,on,scope,f.now+1)).toMatchObject({state:'acknowledged',acknowledgementId:current.acknowledgement!.id});});
it('can become due again when the scoped current reader removes an undone acknowledgement',()=>{
 expect(evaluateKitchenAlarm({...current,revision:current.revision+1,status:'confirmed',acknowledgement:null},on,scope,f.now+1)).toMatchObject({state:'due',acknowledgementId:null});
});
it('rejects another preparation content hash instead of using its receipt to stop the alarm',()=>{
 expect(()=>evaluateKitchenAlarm({...current,acknowledgement:{...current.acknowledgement!,contentHash:'0'.repeat(64)}},on,scope,f.now+1)).toThrow();
});
it('rejects another outlet scope',()=>{expect(()=>evaluateKitchenAlarm(current,on,{...scope,outletId:scope.businessId},f.now+1)).toThrow();});
it('requires a receipt accepted by the current server observation',()=>{expect(()=>evaluateKitchenAlarm(current,on,scope,f.now-1)).toThrow();});
it.each([{enabled:true,minutes:0},{enabled:true,minutes:1441},{enabled:true,minutes:1.5},{enabled:1,minutes:2},{enabled:true,minutes:2,scope:'other'}])('rejects invalid or caller-extended alarm settings: %j',settings=>{expect(()=>parseKitchenAlarmSettings(settings)).toThrow();});
it('rejects an invalid server clock',()=>{expect(()=>evaluateKitchenAlarm(f.ticket,on,scope,Number.NaN)).toThrow();});
