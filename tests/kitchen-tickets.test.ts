import {expect,it} from 'vitest';
import {kitchenContentHash,newKitchenId,prepareKitchenAction,applyKitchenAction} from '../packages/core/kitchen';
import {kitchenLineWire,kitchenTicketWire,parseKitchenPage,parseKitchenChanges,type KitchenTicket} from '../packages/core/kitchen-tickets';
import type {SharedDevice,StaffDeviceSession,StaffDeviceAccess} from '../packages/core/device-access';
import type {BusinessType} from '../packages/core/packs';
import type {Order} from '../packages/core/models';
import {orderFixture,ORDER_AT} from './order-fixture';
const now=ORDER_AT+180000;
async function fixture(pack:BusinessType='restaurant'){
 const f=orderFixture(pack),setup=f.context.setup;
 const device:SharedDevice={id:newKitchenId(),businessId:setup.business.id,outletId:setup.outlet.id,name:'Kitchen',mode:'kitchen',createdAt:ORDER_AT,expiresAt:now+86400000,revokedAt:null};
 const session:StaffDeviceSession={id:newKitchenId(),token:'S'.repeat(43),deviceId:device.id,memberId:newKitchenId(),createdAt:ORDER_AT,expiresAt:ORDER_AT+43200000};
 const access:StaffDeviceAccess={v:1,businessId:device.businessId,outletId:device.outletId,deviceId:device.id,sessionId:session.id,memberId:session.memberId,role:'kitchen',mode:'kitchen',permissions:['orders.acknowledge','orders.read','orders.ready'],expiresAt:session.expiresAt};
 const make=async(order:Order):Promise<KitchenTicket>=>({id:order.id,outletId:order.outletId,businessType:order.businessType,number:order.number,type:order.type,source:order.source,
  table:order.table,scheduledFor:order.scheduledFor,status:order.status,lines:order.lines.map(l=>({id:l.id,itemId:l.itemId,name:l.name,unit:l.unit,qty:l.qty,note:l.note,unavailable:l.unavailable,substitution:l.substitution})),
  revision:order.revision,createdAt:order.createdAt,updatedAt:order.updatedAt,statusChangedAt:order.statusChangedAt,timezone:order.timezone,contentHash:await kitchenContentHash(order),priced:order.total!==null,acknowledgement:null});
 const ticket=await make(f.order),wire=kitchenTicketWire(ticket),page={v:1,access,outletName:'Kitchen outlet',at:now,warningMinutes:2,watermark:7,tickets:[wire],next:null};
 return {...f,device,session,access,ticket,wire,page,make};
}
it.each<BusinessType>(['restaurant','online_shop','food_stall','corner_shop'])('prepares %s actions from real private-field-free ticket data',async pack=>{
 const f=await fixture(pack),page=await parseKitchenPage(f.page,f);
 const thin=page.tickets[0];expect(await kitchenContentHash(thin)).toBe(await kitchenContentHash(f.order));
 const action=await prepareKitchenAction(thin,'kitchen.acknowledge',null,now);
 expect(action).toMatchObject({orderId:f.order.id,outletId:f.order.outletId,contentHash:await kitchenContentHash(f.order),revision:f.order.revision});
 const text=JSON.stringify(kitchenTicketWire(thin));for(const key of ['customer','phone','payment','unitPrice','lineTotal','sourceText','address','subtotal','total'])expect(text).not.toContain('"'+key+'":');
});
it('retains complete literal names and notes without UTF-16 replacement or truncation',async()=>{
 const f=await fixture(),text='বাংলা\0'+String.fromCharCode(0xd800)+'x'.repeat(1000000);
 f.order.lines[0].note=text;const ticket=await f.make(f.order),wire=kitchenTicketWire(ticket);
 const page=await parseKitchenPage({...f.page,tickets:[wire]},f);expect(page.tickets[0].lines[0].note).toBe(text);
 expect(await kitchenContentHash(page.tickets[0])).toBe(await kitchenContentHash(f.order));
});
it.each(['top','line','swap','header'] as const)('rejects hidden private fields at the %s boundary',async kind=>{
 const f=await fixture(),page=structuredClone(f.page);
 if(kind==='top')Object.assign(page.tickets[0],{customerName:'PRIVATE'});
 else if(kind==='line')Object.assign(page.tickets[0].lines[0],{unitPrice:1200});
 else if(kind==='swap')page.tickets[0].lines[0].substitution={from:'Tea',accepted:false,acceptedAt:null,phone:'PRIVATE'} as never;
 else Object.assign(page,{token:'PRIVATE'});
 await expect(parseKitchenPage(page,f)).rejects.toThrow();
});
it.each(['device','member','outlet','expiry','permission','hash','line-id','status'] as const)('refuses %s changes instead of granting or silently repairing a cached ticket',async kind=>{
 const f=await fixture(),page=structuredClone(f.page);
 if(kind==='device')page.access.deviceId=newKitchenId();
 else if(kind==='member')page.access.memberId=newKitchenId();
 else if(kind==='outlet')page.tickets[0].outletId=newKitchenId();
 else if(kind==='expiry')page.at=page.access.expiresAt;
 else if(kind==='permission')page.access.permissions=['orders.acknowledge'];
 else if(kind==='hash')page.tickets[0].contentHash='0'.repeat(64);
 else if(kind==='line-id')page.tickets[0].lines.push({...page.tickets[0].lines[0]});
 else page.tickets[0].status='with_courier';
 await expect(parseKitchenPage(page,f)).rejects.toThrow();
});
it('accepts an actual matching acknowledgement from another screen and rejects one for changed content',async()=>{
 const f=await fixture(),action=await prepareKitchenAction(f.order,'kitchen.acknowledge',null,now-1);
 const other={...f.access,deviceId:newKitchenId(),sessionId:newKitchenId(),memberId:newKitchenId()};
 const result=await applyKitchenAction({order:f.order,shop:f.context.setup,access:other,action,admittedAt:now,acknowledgement:null});
 const ticket=await f.make(result.order);ticket.acknowledgement=result.receipt;
 expect((await parseKitchenPage({...f.page,tickets:[kitchenTicketWire(ticket)]},f)).tickets[0].acknowledgement).toEqual(result.receipt);
 ticket.acknowledgement={...result.receipt,contentHash:'0'.repeat(64)};
 await expect(parseKitchenPage({...f.page,tickets:[kitchenTicketWire(ticket)]},f)).rejects.toThrow();
});
it('supports byte-bounded short pages without omission, duplicate cursors or skipped source ordering',async()=>{
 const f=await fixture(),next={createdAt:f.ticket.createdAt,id:f.ticket.id};
 expect((await parseKitchenPage({...f.page,next},f,null,50)).next).toEqual(next);
 await expect(parseKitchenPage({...f.page,next:{...next,id:newKitchenId()}},f)).rejects.toThrow();
 await expect(parseKitchenPage(f.page,f,next)).rejects.toThrow();
 await expect(parseKitchenPage({...f.page,tickets:[f.wire,f.wire]},f)).rejects.toThrow();
});
it('checks a frozen change window, cursor progress and removal identities without interpreting a cursor as access',async()=>{
 const f=await fixture(),{next:_,...base}=f.page;void _;
 const changes={...base,nextSeq:7,removed:[]};
 expect((await parseKitchenChanges(changes,f,3,7)).nextSeq).toBe(7);
 for(const patch of [{nextSeq:2},{nextSeq:3},{nextSeq:8},{watermark:8},{removed:[f.ticket.id]},{removed:[newKitchenId(),newKitchenId()],tickets:[]}]){
  const limit='tickets'in patch?1:50;await expect(parseKitchenChanges({...changes,...patch},f,3,7,limit)).rejects.toThrow();
 }
});
it('normalizes optional line fields without introducing any money or contact values',async()=>{
 const f=await fixture(),wire=kitchenLineWire(f.ticket.lines);
 expect(wire[0].itemId).toBeNull();expect(wire[0].substitution).toBeNull();
 expect((await parseKitchenPage(f.page,f)).tickets[0].lines[0].itemId).toBeUndefined();
});
