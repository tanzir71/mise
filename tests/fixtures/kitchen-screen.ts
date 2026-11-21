import {kitchenContentHash,newKitchenId} from '../../packages/core/kitchen';
import {kitchenTicketWire,parseKitchenPage} from '../../packages/core/kitchen-tickets';
import {receiveKitchenPage} from '../../packages/core/kitchen-screen';
import type {SharedDevice,StaffDeviceSession,StaffDeviceAccess} from '../../packages/core/device-access';
import type {ScreenState} from '../../packages/core/device-screen-state';
import {orderFixture,ORDER_AT} from '../order-fixture';
export async function kitchenScreenFixture(){
 const f=orderFixture('restaurant'),now=ORDER_AT+180000;
 const device:SharedDevice={id:newKitchenId(),businessId:f.context.setup.business.id,outletId:f.order.outletId,name:'Kitchen',mode:'kitchen',createdAt:ORDER_AT,expiresAt:ORDER_AT+90*86400000,revokedAt:null};
 const session:StaffDeviceSession={id:newKitchenId(),deviceId:device.id,memberId:newKitchenId(),token:'S'.repeat(43),createdAt:ORDER_AT,expiresAt:ORDER_AT+43200000};
 const access:StaffDeviceAccess={v:1,deviceId:device.id,businessId:device.businessId,outletId:device.outletId,sessionId:session.id,memberId:session.memberId,role:'kitchen',mode:'kitchen',permissions:['orders.acknowledge','orders.read','orders.ready'],expiresAt:session.expiresAt};
 const order={...f.order,status:'confirmed' as const};
 const ticket={id:order.id,outletId:order.outletId,businessType:order.businessType,number:order.number,type:order.type,source:order.source,table:order.table,
  scheduledFor:order.scheduledFor,status:order.status,lines:order.lines.map(({id,itemId,name,unit,qty,note,unavailable,substitution})=>({id,itemId,name,unit,qty,note,unavailable,substitution})),
  revision:order.revision,createdAt:order.createdAt,updatedAt:order.updatedAt,statusChangedAt:order.statusChangedAt,timezone:order.timezone,contentHash:await kitchenContentHash(order),priced:true,acknowledgement:null};
 const wire={v:1,access,outletName:'Kitchen outlet',at:now,warningMinutes:2,watermark:7,tickets:[kitchenTicketWire(ticket)],next:null};
 const page=await parseKitchenPage(wire,{device,session}),state=receiveKitchenPage(null,page,newKitchenId());
 const screen:ScreenState={phase:'signed-in',credential:{v:1,connection:{apiUrl:'https://screen.test',publishableKey:'sb_publishable_test_only'},device,token:'D'.repeat(43)},outletNameJson:JSON.stringify(wire.outletName),attemptId:newKitchenId(),session};
 return {now,device,session,access,order,ticket:page.tickets[0],page,state,screen,wire};
}
