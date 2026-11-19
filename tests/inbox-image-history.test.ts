import {expect,it} from 'vitest';
import {syncImagesFixture} from './sync-images-fixture';
import {createBackup} from '../packages/core/backup';
import {newInboxId} from '../packages/core/inbox';
import type {AuditEvent} from '../packages/core/models';
async function fixture(){
 const {backup}=await syncImagesFixture(),item=backup.tables.inboxItems.find(item=>item.images.length)!,image=item.images[0],at=Date.now(),event:AuditEvent={id:newInboxId(),outletId:item.outletId!,inboxId:item.id,actor:{type:'member',id:backup.tables.members[0].id},command:'inbox.image.upload',before:{imageId:image.id,uploadedAt:null},after:{imageId:image.id,uploadedAt:at},at};
 return {backup,item,image,event};
}
it('preserves an original server image-upload audit without changing manual Inbox revisions or complete bytes',async()=>{
 const f=await fixture(),result=createBackup({...f.backup.tables,events:[...f.backup.tables.events,f.event]});expect(result.tables.inboxItems).toEqual(f.backup.tables.inboxItems);expect(result.tables.events.at(-1)).toEqual(f.event);expect(createBackup(result.tables).tables).toEqual(result.tables);
});
it.each(['image','revision','actor','time','before','extra']as const)('rejects malformed image-upload %s evidence',async field=>{
 const f=await fixture(),event=structuredClone(f.event);if(field==='image')(event.after as Record<string,unknown>).imageId=newInboxId();if(field==='revision')event.inboxRevision=1;if(field==='actor')event.actor.type='agent';if(field==='time')(event.after as Record<string,unknown>).uploadedAt=event.at+1;if(field==='before')(event.before as Record<string,unknown>).uploadedAt=0;if(field==='extra')(event.after as Record<string,unknown>).path='unexpected';expect(()=>createBackup({...f.backup.tables,events:[...f.backup.tables.events,event]})).toThrow();
});
it('rejects duplicate upload confirmations for one immutable original image',async()=>{
 const f=await fixture();expect(()=>createBackup({...f.backup.tables,events:[...f.backup.tables.events,f.event,{...f.event,id:newInboxId()}]})).toThrow(/image upload history/);
});
