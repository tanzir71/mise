import {expect,it} from 'vitest';
import {closingReviewProjection,parsePreparedClosingReview,readClosingReviewContext} from '../packages/core/closing-review-view';
import {reviewedClosingProposal} from '../packages/core/closing-review';
import {replayClosingRecords} from '../packages/core/closing-replay';
import {parseClosingReview} from '../packages/core/closing-commands';
import {recordSaleCommand} from '../packages/core/sales';
import {fixture,id,modes,view,currentContext} from './closing-review-fixture';

it.each(modes)('recomputes the full original %s comparison using ordinary domain rules',async mode=>{
 const f=fixture(mode),prepared=await view(f);expect(prepared.proposal.enabled).toBe(true);if(!prepared.proposal.enabled)throw Error();
 expect(prepared.proposal.closing.countedCash).toBe(f.change.closing.countedCash);expect(prepared.proposal.closing.createdAt).toBe(f.created.closing.createdAt);expect(prepared.proposal.closing.currency).toBe(f.change.closing.currency);
 expect(prepared.proposal.closing.voidedAt).toBe(f.command.type==='closing.undo'?f.command.occurredAt:undefined);expect(prepared.proposal.sale?.id??null).toBe(f.command.saleId);
 expect(parsePreparedClosingReview(JSON.parse(JSON.stringify(prepared)),f.packet)).toEqual(prepared);
});
it('exposes the newly compared surplus while retaining the original physical count and time',async()=>{
 const f=fixture(),extra=recordSaleCommand({expression:'10',method:'cash'},{setup:f.context.setup,items:[],wallets:[]},f.command.occurredAt-1,kind=>kind==='sale'?id(70001):id(70002)),context={...f.context,sales:[...f.context.sales,extra.sale]},prepared=await view(f,{context});
 expect(prepared.proposal.enabled).toBe(true);if(!prepared.proposal.enabled)throw Error();
 expect(prepared.proposal.closing).toMatchObject({countedCash:12501,expectedCash:11000,difference:1501,addedWalkIn:1501,createdAt:f.command.occurredAt});expect(prepared.proposal.sale).toMatchObject({amount:1501,createdAt:f.command.occurredAt});
 expect(prepared.proposal.closing.summary.expectedCash).toBe(12501);expect(parseClosingReview(prepared.proposal.reviewJson).expectedCash).toBe(11000);
});
it('excludes cash received after the physical count instead of moving the count forward',async()=>{
 const f=fixture(),extra=recordSaleCommand({expression:'10',method:'cash'},{setup:f.context.setup,items:[],wallets:[]},f.command.occurredAt+1,kind=>kind==='sale'?id(70001):id(70002)),prepared=await view(f,{context:{...f.context,sales:[...f.context.sales,extra.sale]}});
 expect(prepared.proposal.enabled).toBe(true);if(!prepared.proposal.enabled)throw Error();expect(prepared.proposal.closing.addedWalkIn).toBe(2501);expect(prepared.proposal.closing.createdAt).toBe(f.command.occurredAt);
});
it.each(modes)('keeps a later real admission stamp out of the reviewed %s choice',async mode=>{
 const f=fixture(mode),prepared=await view(f);if(!prepared.proposal.enabled)throw Error();const c=reviewedClosingProposal(f.command,f.packet.replacementId,prepared.proposal.reviewJson);
 const records=replayClosingRecords({businessId:f.row.businessId,outletId:f.row.outletId,actorId:prepared.actorId,at:prepared.at+500,contextJson:prepared.current.contextJson},c);
 expect(closingReviewProjection(records,c)).toEqual(prepared.proposal);expect('updatedAt' in prepared.proposal.closing).toBe(false);expect(prepared.proposal.closing.createdAt).toBe(f.created.closing.createdAt);
});
it.each(['BDT','USD','IDR','JPY','BHD'])('keeps exact original minor units and linked cash for %s',async currency=>{
 const f=fixture('surplus',{currency}),prepared=await view(f);expect(prepared.proposal.enabled).toBe(true);if(!prepared.proposal.enabled)throw Error();
 expect(prepared.proposal.closing.currency).toBe(currency);expect(prepared.proposal.closing.addedWalkIn).toBe(2501);expect(prepared.proposal.sale?.amount).toBe(2501);
});
it('blocks a complete new review that exceeds ordinary UTF-8 command bytes without truncating it',async()=>{
 const f=fixture(),context=structuredClone(f.context),name='ন'.repeat(11000);context.setup.business.name=name;
 const prepared=await view(f,{context});expect(prepared.proposal).toEqual({enabled:false,reason:'choice'});expect(prepared.current.contextJson).toContain(name);expect(f.packet.sourceJson).toContain('Count');
});
it.each(['unit','day','closed','parent','choice','deadline','unavailable'])('retains a blocked %s proposal with the complete original source',async reason=>{
 const f=fixture(),context=structuredClone(f.context);let options:Parameters<typeof currentContext>[1]={context},patch={},at=f.command.occurredAt+60000;
 if(reason==='unit')context.setup.outlet.currency='USD';if(reason==='day')context.setup.outlet.timezone='UTC';
 if(reason==='closed')context.closings=[{...f.created.closing,id:id(7777)}];if(reason==='parent')options={context,closing:f.created.closing};
 if(reason==='choice')context.sales=[{...f.initial.sale,amount:f.created.closing.countedCash}];if(reason==='deadline')at=f.command.occurredAt-300001;if(reason==='unavailable')patch={available:false};
 const prepared=await view(f,options,patch,at);expect(prepared.proposal).toEqual({enabled:false,reason});expect(f.packet.sourceJson).toContain('Count');expect(parsePreparedClosingReview(prepared,f.packet)).toEqual(prepared);
});
it('undoes only the original closing unit/day even after current outlet settings change',async()=>{
 const f=fixture('undo-surplus'),context=structuredClone(f.context);context.setup.outlet.currency='USD';context.setup.outlet.timezone='America/Los_Angeles';
 const prepared=await view(f,{context});expect(prepared.proposal.enabled).toBe(true);if(!prepared.proposal.enabled)throw Error();expect(prepared.proposal.closing.currency).toBe('BDT');expect(prepared.proposal.closing.timezone).toBe('Asia/Dhaka');expect(prepared.proposal.sale?.currency).toBe('BDT');
 const expired=await view(f,{context},{},Date.UTC(2026,10,15,18));expect(expired.proposal).toEqual({enabled:false,reason:'deadline'});
});
it('allows real admission stamps and a renamed member without reparenting the undo',async()=>{
 const f=fixture('undo-surplus'),prepared=await view(f,{closing:{...f.created.closing,updatedAt:f.command.occurredAt,createdByName:'Renamed member'},sale:{...f.created.sale!,updatedAt:f.command.occurredAt,shopLink:'https://shop.test/current'}});
 expect(prepared.proposal.enabled).toBe(true);
});
it.each(['missing','voided','event','cash-amount','cash-unit','count','cash-given'])('refuses an undo with a changed %s parent',async mode=>{
 const f=fixture('undo-surplus'),closing=structuredClone(f.created.closing),sale=structuredClone(f.created.sale!);
 if(mode==='voided')closing.voidedAt=f.command.occurredAt;if(mode==='event')closing.eventId=id(4444);if(mode==='cash-amount')sale.amount++;if(mode==='cash-unit')sale.currency='USD';if(mode==='count')closing.countedCash++;if(mode==='cash-given')sale.given!++;
 const prepared=await view(f,{closing:mode==='missing'?null:closing,sale:mode==='missing'?null:sale});expect(prepared.proposal).toEqual({enabled:false,reason:mode==='voided'?'closed':'parent'});
});
it.each(['count','time','cash','review','reason','actor','source','clock','context-scope','duplicate'])('rejects a forged %s comparison even when it looks successful',async mode=>{
 const f=fixture(),prepared=structuredClone(await view(f));if(!prepared.proposal.enabled)throw Error();
 if(mode==='count')prepared.proposal.closing.countedCash++;if(mode==='time')prepared.proposal.closing.createdAt++;if(mode==='cash')prepared.proposal.sale!.amount++;
 if(mode==='review')prepared.proposal.reviewJson=prepared.proposal.reviewJson!.replace('"expectedCash":10000','"expectedCash":9999');
 if(mode==='reason')prepared.proposal={enabled:false,reason:'unit'};if(mode==='actor')prepared.actorId=id(4444);if(mode==='source')prepared.sourceHash='d'.repeat(64);if(mode==='clock')prepared.expiresAt=prepared.at;
 if(mode==='context-scope'||mode==='duplicate'){const raw=JSON.parse(prepared.current.contextJson);if(mode==='context-scope')raw.sales[0].outlet_id=id(4444);else raw.sales.push(raw.sales[0]);prepared.current.contextJson=JSON.stringify(raw);}
 expect(()=>parsePreparedClosingReview(prepared,f.packet)).toThrow();
});
it('checks every current row even for a blocked comparison',async()=>{
 const f=fixture(),raw=JSON.parse(currentContext(f));raw.stock=[{id:id(4444)}];
 expect(()=>readClosingReviewContext(JSON.stringify(raw),f.row.businessId,f.row.outletId,f.context.setup.owner.id,f.command.closingId)).toThrow();
 await expect(view(f,{}, {available:false,contextJson:JSON.stringify(raw)})).rejects.toThrow();
});
