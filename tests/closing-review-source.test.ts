import {expect,it} from 'vitest';
import {closingReviewCreatedIds,closingReviewFacts,closingReviewSourceAudits,parseClosingReviewRequest,parseClosingReviewSource,closingReviewSourceLimit} from '../packages/core/closing-review-source';
import {undoClosingCommand} from '../packages/core/closing';
import {closingIntent} from '../apps/web/src/data/outbox-intents';
import {fixture,id,literal,modes} from './closing-review-fixture';

it.each(modes)('retains every original closing fact for %s',mode=>{
 const f=fixture(mode),source=parseClosingReviewSource(f.packet),facts=closingReviewFacts(f.packet),c=f.command;
 expect(source.events[0].after).toEqual(f.change.closing);expect(source.at).toBe(c.occurredAt);expect(source.events[0].after.note).toBe(literal);
 expect(facts).toMatchObject({businessId:f.row.businessId,actorId:f.context.setup.owner.id,at:c.occurredAt,currency:'BDT',countedCash:f.change.closing.countedCash,expectedCash:f.change.closing.expectedCash,closingCreatedAt:f.created.closing.createdAt});
 const created=closingReviewCreatedIds(source);expect(created.has(c.id)).toBe(true);expect(created.has(c.closingId)).toBe(c.type==='closing.record');
 if(c.saleId){expect(created.has(c.saleId)).toBe(c.type==='closing.record');expect(created.has(c.saleEventId!)).toBe(true);}
 expect(JSON.stringify(source)).toBe(f.packet.sourceJson);
});
it('sorts the cash-first domain audits without losing their complete source',()=>{const f=fixture();expect(f.change.events[0].command).toBe('sale.record');expect(closingReviewSourceAudits(f.command,f.change.events)[0].id).toBe(f.command.id);});
it('keeps literal JSON envelopes opaque for SQL without decoding unrelated NUL or surrogate text',()=>{
 const f=fixture(),facts=closingReviewFacts(f.packet);expect(facts.inputNoteJson).toBe(JSON.stringify(literal));expect(facts.inputNoteJson).not.toContain('\0');expect(JSON.parse(facts.inputNoteJson!)).toBe(literal);
 expect(facts.reviewJson).toBe(f.command.type==='closing.record'?f.command.input.fingerprint:null);const undo=closingReviewFacts(fixture('undo-surplus').packet);expect(undo.inputNoteJson).toBeNull();expect(undo.reviewJson).toBeNull();
});
it.each(['actor','outlet','physical-time','count','expected-cash','summary','choice','note','cash-currency','cash-amount','cash-parent','cash-extra','undo-link','undo-snapshot','undo-day'])('rejects a forged %s source',mode=>{
 const f=fixture(mode.startsWith('undo')?'undo-surplus':'surplus'),raw=JSON.parse(f.packet.sourceJson),closing=raw.events[0],cash=raw.events[1];
 if(mode==='actor')cash.actorId=id(999);if(mode==='outlet')closing.outletId=id(999);if(mode==='physical-time')closing.at++;
 if(mode==='count')closing.after.countedCash++;if(mode==='expected-cash')closing.after.expectedCash++;if(mode==='summary')closing.after.summary.waitingOrders++;
 if(mode==='choice')closing.after.addedWalkIn=0;if(mode==='note')closing.after.note+='changed';
 if(mode==='cash-currency')cash.after.currency='USD';if(mode==='cash-amount')cash.after.amount++;if(mode==='cash-parent')cash.after.closingId=id(999);if(mode==='cash-extra')cash.after.customerId=id(999);
 if(mode==='undo-link')cash.undoOf=id(999);if(mode==='undo-snapshot')closing.after.createdByName+='changed';if(mode==='undo-day'){closing.at+=86400000;cash.at=closing.at;}
 expect(()=>parseClosingReviewSource({...f.packet,sourceJson:JSON.stringify(raw)})).toThrow();
});
it('requires a canonical literal source and an exact complete companion set',()=>{
 const f=fixture(),raw=JSON.parse(f.packet.sourceJson);
 for(const sourceJson of [JSON.stringify(raw,null,2),f.packet.sourceJson.replace('"v":1','"v":1,"v":1'),JSON.stringify({...raw,events:raw.events.slice(0,1)}),JSON.stringify({...raw,events:[...raw.events,raw.events[1]]})])expect(()=>parseClosingReviewSource({...f.packet,sourceJson})).toThrow();
});
it('retains a full imported million-character note and original name through undo',()=>{
 const f=fixture(),note='ন'.repeat(1_000_000),before={...f.created.closing,note,createdByName:'N'.repeat(1_000_000)};
 const change=undoClosingCommand(before,f.context.setup,f.created.sale,f.command.occurredAt+1000,kind=>kind==='event'?id(81000):id(81001)),command=closingIntent(change,true),events=closingReviewSourceAudits(command,change.events);
 const sourceJson=JSON.stringify({v:1,businessId:f.row.businessId,entryId:f.row.id,sequence:1,commandIndex:0,at:command.occurredAt,events});expect(new TextEncoder().encode(sourceJson).length).toBeLessThan(closingReviewSourceLimit);
 const source=parseClosingReviewSource({command,sourceJson});expect(source.events[0].before!.note).toBe(note);expect(source.events[0].after.note).toBe(note);expect(source.events[0].after.createdByName.length).toBe(1_000_000);
});
it('rejects oversize source instead of truncating the saved count',()=>{const f=fixture();expect(()=>parseClosingReviewSource({...f.packet,sourceJson:' '.repeat(closingReviewSourceLimit+1)})).toThrow();expect(f.packet.sourceJson).toContain('Count');});
it('keeps review identities separate from every source parent and actor',()=>{
 const f=fixture('undo-surplus'),source=parseClosingReviewSource(f.packet),reserved=[f.command.id,f.command.outletId,f.command.closingId,f.command.saleId,f.command.saleEventId,f.row.id,f.row.businessId,source.events[0].actorId,source.events[0].after.eventId,source.events[1].after.eventId];
 for(const key of reserved)for(const field of ['id','replacementId'])expect(()=>parseClosingReviewRequest({...f.packet,[field]:key},false)).toThrow();
 expect(parseClosingReviewRequest({...f.packet,token:'t'.repeat(43),outcome:'withdrawn'},true).outcome).toBe('withdrawn');
 expect(()=>parseClosingReviewRequest({...f.packet,token:'bad',outcome:'withdrawn'},true)).toThrow();expect(()=>parseClosingReviewRequest({...f.packet,extra:true},false)).toThrow();
});
