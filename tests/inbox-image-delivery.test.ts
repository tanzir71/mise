import 'fake-indexeddb/auto';
import {afterEach,expect,it,vi} from 'vitest';
import {joinedApplyFixture} from './sync-apply-fixture';
import {inboxImageFile,inboxPng} from './inbox-fixture';
import {deliverLocalOutbox,deliverLocalInboxImages} from '../apps/web/src/data/local-outbox';
import {lockLocalOperator} from '../apps/web/src/data/operator-state';
import {parseInboxCommandReceipt} from '../packages/core/inbox-commands';
import type {MiseDatabase} from '../apps/web/src/data/db';
const databases:MiseDatabase[]=[];
afterEach(async()=>{for(const db of databases.splice(0))await db.delete();});
async function boot(accept=true){
 const f=await joinedApplyFixture();databases.push(f.db);const item=await f.db.captureInbox({title:'Original capture',files:[inboxImageFile()]});
 if(accept)await deliverLocalOutbox(f.db,f.target.targetHash,async command=>{
  if(command.type!=='inbox.capture')throw Error('Expected original capture');
  return parseInboxCommandReceipt({id:command.id,type:command.type,itemId:command.itemId,outletId:command.outletId,occurredAt:command.occurredAt,at:command.occurredAt+10,createdAt:command.createdAt,updatedAt:Math.max(command.createdAt,command.occurredAt),revision:1,kind:'unclassified',archived:false,imageCount:command.input.images.length,imageBytes:command.input.images.reduce((n,image)=>n+image.size,0),eventId:command.id,changed:true},command);
 });
 return {...f,item};
}
it('sends the complete original Blob after metadata acceptance without changing queue receipts or source bytes',async()=>{
 const f=await boot(),queue=await f.db.outbox.toArray(),before=(await f.db.readBackup()).tables,put=vi.fn(async(image,blob:Blob)=>{expect(new Uint8Array(await blob.arrayBuffer())).toEqual(inboxPng);expect(image).toMatchObject({id:f.item.images[0].id,businessId:f.target.businessId,outletId:f.target.outletId,inboxId:f.item.id,size:inboxPng.length});return {id:image.id,uploadedAt:Date.now()};});
 expect(await deliverLocalInboxImages(f.db,f.target.targetHash,put)).toBe(1);expect(put).toHaveBeenCalledTimes(1);expect(await f.db.outbox.toArray()).toEqual(queue);expect((await f.db.readBackup()).tables).toEqual(before);
});
it('does not send image bytes before the original capture receipt exists',async()=>{
 const f=await boot(false),put=vi.fn();await expect(deliverLocalInboxImages(f.db,f.target.targetHash,put)).rejects.toThrow(/metadata/);expect(put).not.toHaveBeenCalled();expect((await f.db.outbox.toArray())[0].receipts).toEqual([]);
});
it('retains the accepted original action and exact Blob after a lost upload reply',async()=>{
 const f=await boot(),queue=await f.db.outbox.toArray(),put=vi.fn(async(image)=>({id:image.id,uploadedAt:Date.now()}));await expect(deliverLocalInboxImages(f.db,f.target.targetHash,async()=>{throw Error('Lost image reply');})).rejects.toThrow('Lost image reply');expect(await f.db.outbox.toArray()).toEqual(queue);expect(await deliverLocalInboxImages(f.db,f.target.targetHash,put)).toBe(1);expect(await f.db.outbox.toArray()).toEqual(queue);
});
it('rejects a changed original Blob before sending even when its size and file signature match',async()=>{
 const f=await boot(),row=(await f.db.outbox.toArray())[0],source=row.changes.find(change=>change.table==='inboxItems')!.after as unknown as {images:{blob:Blob}[]},bytes=new Uint8Array(inboxPng);bytes[bytes.length-1]^=1;source.images[0].blob=new Blob([bytes],{type:'image/png'});await f.db.outbox.put(row);const put=vi.fn();await expect(deliverLocalInboxImages(f.db,f.target.targetHash,put)).rejects.toThrow(/original image bytes/);expect(put).not.toHaveBeenCalled();
});
it('rejects an operator lock after remote completion and retains every original queue record',async()=>{
 const f=await boot(),queue=await f.db.outbox.toArray(),selected=(await f.db.operatorState.get('active'))!;await expect(deliverLocalInboxImages(f.db,f.target.targetHash,async image=>{await lockLocalOperator(f.db,selected.revision);return {id:image.id,uploadedAt:Date.now()};})).rejects.toThrow(/operator/);expect(await f.db.outbox.toArray()).toEqual(queue);
});
it('does not send any bytes from an aborted cycle',async()=>{
 const f=await boot(),put=vi.fn(),controller=new AbortController();controller.abort();await expect(deliverLocalInboxImages(f.db,f.target.targetHash,put,controller.signal)).rejects.toThrow();expect(put).not.toHaveBeenCalled();
});
