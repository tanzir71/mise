import {expect,it} from 'vitest';
import {customerReviewBoundary} from '../packages/core/customer-review-boundary';
import {parseCustomerCommand} from '../packages/core/customer-commands';
import {parseCustomerReviewSource,customerReviewCreatedIds} from '../packages/core/customer-review-source';
import {backupTableNames,type BackupTables} from '../packages/core/backup-tables';
import {createBackup} from '../packages/core/backup';
import {encodeCommandRecord} from '../packages/core/cloud-records';
import {replayPendingIntent} from '../packages/core/sync-materialize';
import {fixture,modes,id,replay} from './customer-review-fixture';
import {customerResolutionEvent} from './customer-resolution-fixture';
import {at} from './credit-fixture';

function current(f:ReturnType<typeof fixture>){
 const source=parseCustomerReviewSource(f.packet),profile=source.events.find(e=>e.kind==='customer'),account=source.events.find(e=>e.kind==='account');
 const customers=(profile?profile.before?[profile.before]:[]:[f.customer]).map(p=>({...p,phone:p.phone??undefined,archivedAt:p.archivedAt??undefined}));
 const tables={...Object.fromEntries(backupTableNames.map(name=>[name,[]])),businesses:[f.setup.business],outlets:[f.setup.outlet],members:[f.setup.owner],customers,creditAccounts:account?account.before?[account.before]:[]:[f.account]} as BackupTables;
 return createBackup(tables,at+60000);
}
it.each(modes)('reserves only actual emitted %s identities, without treating existing parents or planned slots as creations',async mode=>{
 const f=fixture(mode),source=parseCustomerReviewSource(f.packet),event=await customerResolutionEvent(f),boundary=await customerReviewBoundary([event],f.command.outletId),base=current(f),created=customerReviewCreatedIds(source);
 for(const value of created)expect(()=>boundary.assert([{table:'credit_entries',values:{id:value}}],base)).toThrow();
 const unused='ids'in f.command?Object.values(f.command.ids).filter(value=>!created.has(value)):[];
 for(const value of unused)expect(()=>boundary.assert([{table:'credit_entries',values:{id:value}}],base)).not.toThrow();
 if(mode==='update-terms'||mode==='khata-settings')expect(()=>boundary.assert(replay(f).filter(record=>record.table!=='events'),base)).not.toThrow();
});
it('prevents a later contact save from silently resurrecting its withdrawn implicit khata',async()=>{
 const f=fixture('update-implicit');if(!('ids'in f.command))throw Error();const event=await customerResolutionEvent(f),base=current(f),next=parseCustomerCommand({...f.command,id:id(840001),ids:{...f.command.ids,accountEventId:id(840002),openingEventId:id(840003),openingEntryId:id(840004)}});
 const allowed=await replayPendingIntent(base,next,f.setup.owner.id,at+60000,base,at+1000,f.setup.outlet.currency);expect(allowed.tables.creditAccounts).toHaveLength(1);base.tables.events.push(event);await expect(replayPendingIntent(base,next,f.setup.owner.id,at+60000,base,at+1000,f.setup.outlet.currency)).rejects.toMatchObject({kind:'conflict',commandId:next.id});
});
it('permits fresh terms on an existing canonical parent after a genuine replacement',async()=>{
 const f=fixture('update-terms');if(!('ids'in f.command))throw Error();const base=current(f),event=await customerResolutionEvent(f,'replaced');base.tables.events.push(event);const next=parseCustomerCommand({...f.command,id:id(840001),ids:{...f.command.ids,accountEventId:id(840002)}}),result=await replayPendingIntent(base,next,f.setup.owner.id,at+60000,base,at+1000,f.setup.outlet.currency);expect(result.tables.creditAccounts[0].id).toBe(f.account.id);
});
it('does not allow a missing replaced identity to be created again while permitting an existing canonical row',async()=>{
 const f=fixture('create-default'),event=await customerResolutionEvent(f,'replaced'),boundary=await customerReviewBoundary([event],f.command.outletId),base=current(f),source=parseCustomerReviewSource(f.packet),profile=source.events.find(e=>e.kind==='customer')!;if(profile.kind!=='customer')throw Error();const record=encodeCommandRecord('customers',profile.after,f.setup.business.id);expect(()=>boundary.assert([record],base)).toThrow();base.tables.customers.push({...profile.after,phone:undefined,archivedAt:undefined});expect(()=>boundary.assert([record],base)).not.toThrow();
});
it.each(['position','duplicate','source','hash','actor','customer','scope','outcome','time','resolution','replacement hash','missing kind','missing before','missing after','missing position'] as const)('rejects damaged canonical %s evidence',async kind=>{
 const f=fixture('create-opening'),event=await customerResolutionEvent(f,kind==='replacement hash'?'replaced':'withdrawn'),before=event.before as Record<string,unknown>,after=event.after as Record<string,unknown>;
 if(kind==='position')after.customerResolutionPosition='0';if(kind==='source')before.sourceJson='{}';if(kind==='hash')before.commandHash='f'.repeat(64);if(kind==='actor')event.actor.id=id(840001);if(kind==='customer')event.customerId=id(840001);if(kind==='scope')(after.receipt as {outletId:string}).outletId=id(840001);if(kind==='outcome')after.outcome='replaced';if(kind==='time')event.at++;if(kind==='resolution')before.resolutionId=id(840001);if(kind==='replacement hash')(after.receipt as {replacement:{commandHash:string}}).replacement.commandHash='f'.repeat(64);if(kind==='missing kind')delete before.commandType;if(kind==='missing before')event.before=null;if(kind==='missing after')event.after=null;if(kind==='missing position')delete after.customerResolutionPosition;
 await expect(customerReviewBoundary(kind==='duplicate'?[event,event]:[event],f.command.outletId)).rejects.toMatchObject({kind:'integrity'});
});
