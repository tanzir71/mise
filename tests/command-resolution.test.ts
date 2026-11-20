import {expect,it} from 'vitest';
import {parseCommandResolutionReceipt,reviewedOrderProposal} from '../packages/core/command-resolution';
import type {OrderCommand} from '../packages/core/order-commands';
const id=(n:number)=>String(n).padStart(26,'0');
const original:Extract<OrderCommand,{type:'order.payment'}>={id:id(1),type:'order.payment',outletId:id(2),orderId:id(3),revision:2,occurredAt:100,input:{method:'cash',given:5000},ids:{saleId:id(4),saleEventId:id(5),entryId:id(6),creditEventId:id(7),refundId:id(8),refundEventId:id(9)}};
const withdrawn={id:id(10),type:'command.resolved',commandId:original.id,commandType:original.type,outletId:original.outletId,occurredAt:original.occurredAt,commandHash:'a'.repeat(64),sourceHash:'b'.repeat(64),at:200,outcome:'withdrawn',replacement:null};
it('a reviewed proposal preserves physical time, exact input and every original related financial identity',()=>{const before=structuredClone(original),proposal=reviewedOrderProposal(original,5,id(11));expect(proposal).toEqual({...original,id:id(11),revision:5});expect(original).toEqual(before);});
it('a withdrawn outcome is a distinct actual resolution, not an accepted payment receipt',()=>{expect(parseCommandResolutionReceipt(withdrawn,original)).toEqual(withdrawn);for(const patch of [{id:original.id},{type:'order.payment'},{commandId:id(30)},{commandType:'order.refund'},{sourceHash:''},{replacement:{saleId:original.ids.saleId}},{jwt:'PRIVATE'}])expect(()=>parseCommandResolutionReceipt({...withdrawn,...patch},original)).toThrow();});
it('future original revisions cannot be silently rebased backwards',()=>{expect(()=>reviewedOrderProposal(original,1,id(11))).toThrow('current revision');});
it('a reviewed payment requires its exact genuine replacement receipt and retains its explicit lineage',()=>{
 const command=reviewedOrderProposal(original,5,id(11)),receipt={id:command.id,type:command.type,outletId:command.outletId,orderId:original.orderId,occurredAt:100,at:200,revision:6,sequence:1,number:'A-0001',total:2500,updatedAt:200,saleId:original.ids.saleId,entryId:null,refundId:null,noteId:null,communicationId:null,undoOf:null};
 const replacement={id:command.id,revision:5,commandHash:'c'.repeat(64),receipt},value={...withdrawn,outcome:'replaced',replacement};expect(parseCommandResolutionReceipt(value,original)).toEqual(value);
 for(const patch of [{id:original.id},{revision:1},{commandHash:''},{input:{method:'card'}}])expect(()=>parseCommandResolutionReceipt({...value,replacement:{...replacement,...patch}},original)).toThrow();
 expect(()=>parseCommandResolutionReceipt({...value,replacement:{...replacement,receipt:{...receipt,id:id(90)}}},original)).toThrow();
});
