import {expect,it,vi} from 'vitest';
import {savedClosingParent,savedClosingParentHeader,originalClosingParentReader} from '../packages/core/closing-source';
import {parseClosingCommandReceipt} from '../packages/core/closing-commands';
import {testCloudCommandRemote,testShopCommandRemote} from './command-account-fixture';
import {fixture,id} from './closing-review-fixture';

it.each(['undo','undo-surplus'] as const)('uses the complete original %s audits even when final rows or ordering change',mode=>{
 const f=fixture(mode),before=JSON.stringify(f.row),changes=structuredClone(f.row.changes).reverse();
 for(const row of changes)if(row.table==='dayClosings')row.after={...(row.after as object),eventId:id(88888)};
 expect(savedClosingParent(f.command,changes)).toBe(f.created.closing.eventId);
 expect(JSON.stringify(f.row)).toBe(before);
});
it.each(['missing','duplicate','old-before','wrong-key','wrong-parent','cash-missing','cash-parent','cash-value'] as const)('refuses %s undo evidence instead of borrowing the current closing',kind=>{
 const f=fixture('undo-surplus'),changes=structuredClone(f.row.changes),primary=changes.find(row=>row.table==='events'&&row.key===f.command.id)!,event=primary.after as {id:string;undoOf:string;before:{eventId:string};after:object};
 if(kind==='missing')changes.splice(changes.indexOf(primary),1);
 if(kind==='duplicate')changes.push(structuredClone(primary));
 if(kind==='old-before')primary.before={};
 if(kind==='wrong-key')event.id=id(88888);
 if(kind==='wrong-parent')event.before.eventId=id(88888);
 const cash=changes.find(row=>row.table==='events'&&row.key===f.command.saleEventId)!;
 if(kind==='cash-missing')changes.splice(changes.indexOf(cash),1);
 if(kind==='cash-parent')(cash.after as {undoOf:string}).undoOf=id(88888);
 if(kind==='cash-value')(cash.after as {before:{amount:number}}).before.amount++;
 expect(()=>savedClosingParent(f.command,changes)).toThrow();
});
it('requires the exact saved command and rejects ambiguous queue identities',()=>{
 const f=fixture('undo'),read=originalClosingParentReader([f.row]);
 expect(read(f.command)).toBe(f.created.closing.eventId);
 expect(()=>read({...f.command,occurredAt:f.command.occurredAt+1})).toThrow();
 expect(()=>read({...f.command,id:id(88888)})).toThrow();
 expect(()=>originalClosingParentReader([f.row,f.row])).toThrow();
 expect(originalClosingParentReader([])(fixture('exact').command)).toBeNull();
});

for(const transport of ['cloud','shop'] as const){
 const connect=(auth:()=>Promise<string>,send:typeof fetch)=>transport==='cloud'
  ?testCloudCommandRemote({apiUrl:'https://database.test',publishableKey:'sb_publishable_test_only'},auth,send)
  :testShopCommandRemote('https://database.test','sb_publishable_test_only',auth,send).apply;
 it.each([undefined,'','not-a-parent',id(1)+'x'])(`${transport} refuses an invalid original undo parent before Auth (%s)`,async parent=>{
  const f=fixture('undo-surplus'),auth=vi.fn(async()=>'user.valid.signature'),send=vi.fn<typeof fetch>();
  await expect(connect(auth,send)(f.command,undefined,undefined,parent)).rejects.toMatchObject({kind:'review'});
  expect(auth).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
 });
 it(`${transport} cannot attach an undo parent to a different command family`,async()=>{
  const auth=vi.fn(async()=>'user.valid.signature'),send=vi.fn<typeof fetch>();
  await expect(connect(auth,send)(fixture('exact').command,undefined,undefined,id(1))).rejects.toMatchObject({kind:'review'});
  expect(auth).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
 });
 it(`${transport} freezes the original undo and parent before waiting for Auth`,async()=>{
  const f=fixture('undo-surplus'),original=structuredClone(f.command),closing=f.created.closing,at=f.command.occurredAt+1;
  const receipt=parseClosingCommandReceipt({id:f.command.id,type:f.command.type,outletId:f.command.outletId,closingId:f.command.closingId,occurredAt:f.command.occurredAt,at,day:closing.day,difference:closing.difference,addedWalkIn:closing.addedWalkIn,closingUpdatedAt:at,saleId:f.command.saleId,saleUpdatedAt:at,undoOf:f.command.closingId},f.command);
  let release:(jwt:string)=>void=()=>{};const auth=new Promise<string>(resolve=>{release=resolve;}),send=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify(receipt))),run=connect(()=>auth,send)(f.command,undefined,undefined,closing.eventId);
  f.command.closingId=id(88888);f.command.saleId=id(88889);release('user.valid.signature');
  expect(await run).toEqual(receipt);const request=send.mock.calls[0][1]!;
  expect(new Headers(request.headers).get(savedClosingParentHeader)).toBe(closing.eventId);
  expect(JSON.parse(request.body as string)).toEqual(original);
 });
}
