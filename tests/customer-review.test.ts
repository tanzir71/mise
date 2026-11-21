import {expect,it} from 'vitest';
import {parseCustomerCommand,type CustomerCommand,type CustomerCommandReceipt} from '../packages/core/customer-commands';
import {customerReviewReservedIds,reviewedCustomerProposal,parseCustomerResolutionReceipt} from '../packages/core/customer-review';
import {parseShopCommandReceipt} from '../packages/core/shop-commands';

const id=(n:number)=>String(n).padStart(26,'0'),ids={accountId:id(4),accountEventId:id(5),openingEntryId:id(6),openingEventId:id(7)};
const profile={name:'Customer · বাংলা\0\ud800',nickname:'Original',phone:'',address:'Road 12',notes:'Original notes',tags:['saved']};
const terms={allowed:true,limit:45000,reminder:{enabled:true,dayOfMonth:12,tone:'gentle',channel:'whatsapp'}};
const base={id:id(1),customerId:id(2),outletId:id(3)},commands=[
 {...base,type:'customer.create',input:profile,credit:terms,opening:{amount:12000,occurredAt:1000},ids},
 {...base,type:'customer.update',input:profile,credit:terms,opening:null,ids},
 {...base,type:'customer.update',input:profile,credit:null,opening:null,ids},
 {...base,type:'khata.settings',accountId:null,input:terms,ids},
 {...base,type:'khata.settings',accountId:id(4),input:terms,ids},
 {...base,type:'customer.archive'},
 {...base,type:'customer.restore'},
].map(parseCustomerCommand);
function ordinary(c:CustomerCommand,at=5000):CustomerCommandReceipt{
 const status=c.type==='customer.archive'||c.type==='customer.restore',metadata=c.type==='customer.update'&&c.credit===null&&c.opening===null,opening='opening'in c&&c.opening!==null;
 return {id:c.id,type:c.type,customerId:c.customerId,outletId:c.outletId,accountId:status?null:ids.accountId,accountEventId:status||metadata?null:c.type==='khata.settings'?c.id:ids.accountEventId,entryId:opening?ids.openingEntryId:null,openingEventId:opening?ids.openingEventId:null,at,customerUpdatedAt:5000,accountUpdatedAt:status?null:metadata?4000:5000};
}
const withdrawn=(c:CustomerCommand)=>({id:id(20),type:'command.resolved',commandId:c.id,commandType:c.type,customerId:c.customerId,outletId:c.outletId,commandHash:'a'.repeat(64),sourceHash:'b'.repeat(64),at:6000,outcome:'withdrawn',replacement:null});
function replaced(c:CustomerCommand){const proposal=reviewedCustomerProposal(c,id(21));return {...withdrawn(c),outcome:'replaced',replacement:{id:proposal.id,commandHash:'c'.repeat(64),receipt:ordinary(proposal)}};}
it.each(commands)('keeps every original $type field and companion except the distinct primary ID',c=>{
 const before=JSON.stringify(c),proposal=reviewedCustomerProposal(c,id(21));expect(proposal).toEqual({...c,id:id(21)});expect(JSON.stringify(c)).toBe(before);
 for(const reserved of customerReviewReservedIds(c))expect(()=>reviewedCustomerProposal(c,reserved)).toThrow();
 if('ids'in proposal){if(!('ids'in c))throw Error('Original IDs missing');proposal.ids.accountId=id(99);expect(c.ids.accountId).toBe(id(4));}
 if('credit'in proposal&&proposal.credit){if(!('credit'in c)||!c.credit)throw Error('Original terms missing');proposal.credit.reminder.enabled=false;expect(c.credit.reminder.enabled).toBe(true);proposal.input.tags.push('changed');expect(c.input.tags).toEqual(['saved']);}
});
it.each(commands)('checks withdrawal and a distinct $type receipt',c=>{
 const w=withdrawn(c);expect(parseCustomerResolutionReceipt(w,c)).toEqual(w);expect(parseShopCommandReceipt(w,c)).toEqual(w);
 const r=replaced(c);expect(parseCustomerResolutionReceipt(r,c)).toEqual(r);expect(parseShopCommandReceipt(r,c)).toEqual(r);
 expect(()=>parseCustomerResolutionReceipt({...w,replacement:r.replacement},c)).toThrow();
 expect(()=>parseCustomerResolutionReceipt({...r,replacement:null},c)).toThrow();
 expect(()=>parseCustomerResolutionReceipt({...r,customerId:id(99)},c)).toThrow();
 expect(()=>parseCustomerResolutionReceipt({...r,commandId:id(99)},c)).toThrow();
 expect(()=>parseCustomerResolutionReceipt({...r,occurredAt:1000},c)).toThrow();
 expect(()=>parseCustomerResolutionReceipt({...r,at:4000},c)).toThrow();
 expect(()=>parseCustomerResolutionReceipt({...r,replacement:{...r.replacement,id:r.id}},c)).toThrow();
 expect(()=>parseCustomerResolutionReceipt({...r,replacement:{...r.replacement,receipt:{...r.replacement.receipt,id:c.id}}},c)).toThrow();
});
it('does not replace or normalize opening amounts, physical time, raw text or account parents',()=>{
 const c=commands[0],proposal=reviewedCustomerProposal(c,id(21));expect(proposal).toMatchObject({customerId:c.customerId,input:{name:profile.name},opening:{amount:12000,occurredAt:1000},ids});
 const r=replaced(c);expect(()=>parseCustomerResolutionReceipt({...r,replacement:{...r.replacement,receipt:{...r.replacement.receipt,accountId:id(99)}}},c)).toThrow();
 expect(()=>parseCustomerResolutionReceipt({...r,sourceHash:'invalid'},c)).toThrow();
 expect(()=>parseCustomerResolutionReceipt({...r,id:ids.openingEntryId},c)).toThrow();
});
it('retains permitted future legacy record clocks without changing the actual admission clock',()=>{
 const c=commands[1],r=replaced(c),receipt={...r.replacement.receipt,customerUpdatedAt:9000,accountUpdatedAt:10000};
 expect(parseCustomerResolutionReceipt({...r,replacement:{...r.replacement,receipt}},c).replacement?.receipt).toMatchObject({at:5000,customerUpdatedAt:9000,accountUpdatedAt:10000});
});
