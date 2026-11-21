import {expect,it} from 'vitest';
import {prepareClosingReviewSource} from '../apps/web/src/data/closing-review-source';
import {closingReviewSourceAudits,parseClosingReviewSource} from '../packages/core/closing-review-source';
import {parseClosingCommandReceipt} from '../packages/core/closing-commands';
import {undoClosingCommand} from '../packages/core/closing';
import {closingIntent} from '../apps/web/src/data/outbox-intents';
import {fixture,id,literal,modes} from './closing-review-fixture';
import type {LocalOutboxEntry} from '../packages/core/local-outbox';

it.each(modes)('selects and hashes the untouched first unconfirmed %s action',async mode=>{
 const f=fixture(mode),before=JSON.stringify(f.row),packet=await prepareClosingReviewSource(f.row,0,f.packet.id,f.packet.replacementId);
 expect(packet.command).toEqual(f.command);expect(packet.sourceJson).toBe(f.packet.sourceJson);expect(packet.sourceHash).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(f.row)).toBe(before);
});
it.each(['retained','accepted','negative','fractional','skip','wrong-outlet','not-closing','missing-audit','edited-audit','duplicated-audit','missing-row','wrong-row-unit','wrong-cash','mismatched-audit-key'])('refuses %s selections without changing native source',async mode=>{
 const f=fixture(),row=structuredClone(f.row);let index=0;
 if(mode==='retained'||mode==='accepted')row.status=mode;if(mode==='negative')index=-1;if(mode==='fractional')index=.5;if(mode==='skip')index=1;
 if(mode==='wrong-outlet')row.outletId=id(555);if(mode==='not-closing')row.commands=[];
 const audit=row.changes.find(c=>c.table==='events'&&c.key===f.command.id)!;
 if(mode==='missing-audit')row.changes=row.changes.filter(c=>c!==audit);if(mode==='edited-audit')audit.before={};if(mode==='duplicated-audit')row.changes.push(audit);if(mode==='mismatched-audit-key')(audit.after as {id:string}).id=id(777);
 if(mode==='missing-row')row.changes=row.changes.filter(c=>c.table!=='dayClosings');
 if(mode==='wrong-row-unit')(row.changes.find(c=>c.table==='dayClosings')!.after as {currency:string}).currency='USD';if(mode==='wrong-cash')(row.changes.find(c=>c.table==='sales')!.after as {amount:number}).amount++;
 const before=JSON.stringify(row);await expect(prepareClosingReviewSource(row,index,f.packet.id,f.packet.replacementId)).rejects.toThrow();expect(JSON.stringify(row)).toBe(before);
});
function grouped(){
 const f=fixture(),undo=undoClosingCommand(f.created.closing,f.context.setup,f.created.sale,f.command.occurredAt+1000,kind=>kind==='event'?id(81000):id(81001)),c=closingIntent(undo,true),row=structuredClone(f.row);
 row.commands.push(c);row.changes.find(c=>c.table==='dayClosings')!.after=undo.closing;row.changes.find(c=>c.table==='sales')!.after=undo.sale!;
 row.changes.push(...undo.events.map(after=>({table:'events' as const,key:after.id,before:null,after})));
 return {f,undo,c,row};
}
it('uses the creation audit before a later grouped undo rather than the voided final row',async()=>{
 const {f,row}=grouped(),packet=await prepareClosingReviewSource(row,0,f.packet.id,f.packet.replacementId),source=parseClosingReviewSource(packet);
 expect(source.events[0].after.voidedAt).toBeUndefined();expect(source.events[1].after.voidedAt).toBeUndefined();expect((row.changes[0].after as {voidedAt:number}).voidedAt).toBeDefined();
});
it('selects a later grouped undo only after its genuine original prefix receipt',async()=>{
 const {f,row,c}=grouped(),created=f.created.closing,at=f.command.occurredAt+500;
 const receipt=parseClosingCommandReceipt({id:f.command.id,type:f.command.type,outletId:f.command.outletId,closingId:f.command.closingId,occurredAt:f.command.occurredAt,at,day:created.day,difference:created.difference,addedWalkIn:created.addedWalkIn,closingUpdatedAt:at,saleId:f.command.saleId,saleUpdatedAt:at,undoOf:null},f.command);
 const start=await prepareClosingReviewSource(row,0,f.packet.id,f.packet.replacementId);row.receipts=[receipt];const selected=await prepareClosingReviewSource(row,1,f.packet.id,f.packet.replacementId),source=parseClosingReviewSource(selected);
 expect(source.commandIndex).toBe(1);expect(source.events[0].before).toEqual(f.created.closing);expect(source.at).toBe(c.occurredAt);expect(source.events[0].after.voidedAt).toBe(c.occurredAt);
 row.receipts=[];expect((await prepareClosingReviewSource(row,0,f.packet.id,f.packet.replacementId)).sourceHash).toBe(start.sourceHash);
 row.receipts=[{...receipt,id:id(333)}];await expect(prepareClosingReviewSource(row,1,f.packet.id,f.packet.replacementId)).rejects.toThrow();
});
it('binds all original row and Blob bytes without placing image bytes in the display source',async()=>{
 const f=fixture(),base=await prepareClosingReviewSource(f.row,0,f.packet.id,f.packet.replacementId),row=structuredClone(f.row);
 row.changes.push({table:'events',key:id(777),before:null,after:{text:literal,bytes:new Blob(['original'])}});
 const a=await prepareClosingReviewSource(row,0,f.packet.id,f.packet.replacementId);expect(a.sourceHash).not.toBe(base.sourceHash);expect(a.sourceJson).toBe(base.sourceJson);
 (row.changes.at(-1)!.after as {bytes:Blob}).bytes=new Blob(['different']);const b=await prepareClosingReviewSource(row,0,f.packet.id,f.packet.replacementId);expect(b.sourceHash).not.toBe(a.sourceHash);
});
it('rejects a successful-looking receipt prefix without source evidence',async()=>{
 const f=fixture(),row={...f.row,receipts:[{}]} as LocalOutboxEntry;await expect(prepareClosingReviewSource(row,0,f.packet.id,f.packet.replacementId)).rejects.toThrow();
 expect(()=>closingReviewSourceAudits(f.command,[...f.change.events,{...f.change.events[0],id:id(4321)}])).toThrow();
});
