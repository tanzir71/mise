import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {MiseDatabase} from '../apps/web/src/data/db';
import {CloudUploadJournal,uploadWithLocalOutbox} from '../apps/web/src/data/cloud-upload';
import {deliverLocalOutbox} from '../apps/web/src/data/local-outbox';
import {createCloudCommandRemote} from '../apps/web/src/data/cloud-command-remote';
import {prepareSavedClosingReview,decideSavedClosingReview,readClosingReviewWorkspace,hasSavedClosingReview} from '../apps/web/src/data/closing-review-session';
import {prepareClosingReviewSource} from '../apps/web/src/data/closing-review-source';
import {selectCloudOperator} from '../apps/web/src/data/operator-state';
import type {CommandAuthorization} from '../apps/web/src/data/command-request';
import type {ClosingReviewRequest} from '../packages/core/closing-review-source';
import type {ClosingCommandReceipt} from '../packages/core/closing-commands';
import type {ClosingResolutionReceipt} from '../packages/core/closing-review';
import {closingPreview,type TodayContext} from '../packages/core/today';
import {recordSaleCommand} from '../packages/core/sales';
import {backupToken} from '../packages/core/backup';
import {localSchemaVersion} from '../packages/core/local-outbox';
import {localTableNames} from '../packages/core/local-schema';
import {cloudUploadFixture,MemoryCloudUpload,uploadId} from './cloud-upload-fixture';
import {testCommandAccount} from './command-account-fixture';
import {closingComparison,closingResolution,ordinaryClosingReceipt} from './closing-review-client-fixture';
import {inboxImageFile} from './inbox-fixture';
import {modes,type Mode} from './closing-review-fixture';
const config={apiUrl:'https://cloud.test',publishableKey:'sb_publishable_test_only'},databases:Dexie[]=[];
const withdraw={outcome:'withdrawn' as const},replacement={outcome:'replaced' as const};
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(databases.splice(0).map(db=>db.delete()));});

/** Synthetic native gateway. SQL/HTTP tests separately prove atomic completion. */
async function boot(mode:Mode='surplus',options:{group?:boolean;image?:boolean}={}){
 const db=new MiseDatabase('mise-closing-review-'+randomUUID()),journal=new CloudUploadJournal('mise-closing-upload-'+randomUUID());databases.push(db,journal);
 const source=cloudUploadFixture();await db.restoreBackup(source,await db.previewRestore(source));await db.recordSale({expression:'100',method:'cash'});
 let authorization:CommandAuthorization={jwt:'original.account.signature',userId:'00000000-0000-4000-8000-000000000001',generation:1};
 const runtime={...testCommandAccount(config,async()=>authorization.jwt),getAuth:async()=>({...authorization}),assertCurrent:(value:CommandAuthorization)=>{if(value.generation!==authorization.generation||value.userId!==authorization.userId)throw Error('Original account changed');}};
 async function count(){const preview=closingPreview(await db.readToday()),surplus=['surplus','undo-surplus'].includes(mode),delta=surplus||mode==='explained-surplus'?2501:mode==='shortfall'?-1001:0;return db.closeDay({id:uploadId(700),day:preview.summary.day,fingerprint:preview.fingerprint,countedCash:preview.summary.expectedCash+delta,addDifference:surplus,note:'Original count · বাংলা\0\ud800'});}
 const imageItem=options.image?await db.captureInbox({text:'Keep the literal customer image',files:[inboxImageFile()]}):null;
 const undo=mode.startsWith('undo');let today:TodayContext=await db.readToday();
 if(undo&&!options.group){await count();today=await db.readToday();}
 const plan=await journal.prepare(db,uploadId());await uploadWithLocalOutbox(db,journal,plan.manifest.id,runtime.targetHash,new MemoryCloudUpload());
 if(options.group){
  if(!undo)throw Error('The grouped fixture retains count followed by undo.');
  await db.transaction('rw',db.tables,async()=>{const closing=await count();today=await db.readToday();await db.undoDayClosing(closing.id);});
  const row=(await db.outbox.toArray())[0],packet=await prepareClosingReviewSource(row,0,uploadId(91),uploadId(92)),receipt=ordinaryClosingReceipt(packet,packet.command,Date.now());
  await deliverLocalOutbox(db,runtime.targetHash,async()=>receipt,packet.command.id);
 }else if(undo)await db.undoDayClosing(uploadId(700));
 else await db.transaction('rw',db.tables,async()=>{await count();if(imageItem)await db.changeInbox(imageItem.id,imageItem.revision,{kind:'order'});});
 const original=await db.outbox.toArray(),backup=backupToken(await db.readBackup());
 await expect(deliverLocalOutbox(db,runtime.targetHash,createCloudCommandRemote(config,runtime,async()=>new Response('Private provider detail',{status:409})))).rejects.toMatchObject({kind:'review'});
 const workspace=await readClosingReviewWorkspace(db);if(!workspace)throw Error('Expected the actual rejected closing action');
 let lost=false,offline=false,calls=0,done:ClosingCommandReceipt|ClosingResolutionReceipt|null=null,onRead:(()=>Promise<void>)|null=null,onResolve:(()=>Promise<void>)|null=null;
 const send:typeof fetch=async(url,init)=>{
  if(offline)throw Error('Synthetic offline');const supplied=JSON.parse(String(init?.body)) as ClosingReviewRequest&{outcome:'withdrawn'|'replaced'},mode=new URL(String(url)).searchParams.get('review');
  if(!mode)return done?Response.json(done):new Response('Private detail',{status:409});
  const packet:ClosingReviewRequest={id:supplied.id,replacementId:supplied.replacementId,command:supplied.command,sourceHash:supplied.sourceHash,sourceJson:supplied.sourceJson};
  if(mode==='closing-resolve'){
   calls++;const comparison=await closingComparison(packet,today),reviewJson=comparison.proposal.enabled?comparison.proposal.reviewJson:null;
   done=await closingResolution(packet,supplied.outcome,reviewJson,Date.now());await onResolve?.();if(lost){lost=false;throw Error('Lost reply after completion');}return Response.json(done);
  }
  if(done)return Response.json({done:true,receipt:done});const review=await closingComparison(packet,today);await onRead?.();return Response.json({done:false,review});
 };
 return {db,original,backup,id:workspace.source.review.id,options:{config,account:runtime,send},calls:()=>calls,done:()=>done,lose:()=>{lost=true;},offline:(value:boolean)=>{offline=value;},setAuth:()=>{authorization={...authorization,generation:authorization.generation+1};},onRead:(value:typeof onRead)=>{onRead=value;},onResolve:(value:typeof onResolve)=>{onResolve=value;},changeCash:()=>{const cash=recordSaleCommand({expression:'10',method:'cash'},{setup:today.setup,items:[],wallets:[]},workspace.original.at-1);today={...today,sales:[...today.sales,cash.sale]};}};
}
it.each(modes)('confirms an explicit %s replacement without editing the original working copy or source',async mode=>{
 const f=await boot(mode);expect(await hasSavedClosingReview(f.db,(await f.db.cloudState.get('binding'))!.uploadId)).toBe(true);
 const record=await prepareSavedClosingReview(f.db,f.id,null,f.options);expect(record.phase).toBe('review');expect(record.quote?.proposal.enabled).toBe(true);
 const result=await decideSavedClosingReview(f.db,f.id,record.revision,replacement,f.options);expect(result.record.phase).toBe('confirmed');expect(result.record.receipt).toMatchObject({outcome:'replaced'});expect(f.calls()).toBe(1);
 expect((await f.db.outbox.toArray())[0].status).toBe('accepted');expect(backupToken(await f.db.readBackup())).toBe(f.backup);expect(result.record.packet).toEqual(record.packet);
 expect(JSON.stringify(await f.db.closingReviews.toArray())).not.toMatch(/"token"|publishableKey|apiUrl|Authorization|original\.account\.signature|auth_user_id/);
});
it('confirms an explicit withdrawal with no replacement closing or cash receipt',async()=>{
 const f=await boot(),record=await prepareSavedClosingReview(f.db,f.id,null,f.options),result=await decideSavedClosingReview(f.db,f.id,record.revision,withdraw,f.options);
 expect(result.record.receipt).toMatchObject({outcome:'withdrawn',replacement:null});expect(backupToken(await f.db.readBackup())).toBe(f.backup);
});
it('recovers a lost reply after reload before submitting another decision',async()=>{
 const f=await boot('undo-surplus'),record=await prepareSavedClosingReview(f.db,f.id,null,f.options);f.lose();await expect(decideSavedClosingReview(f.db,f.id,record.revision,replacement,f.options)).rejects.toThrow();expect(await f.db.outbox.toArray()).toEqual(f.original);
 const name=f.db.name;f.db.close();const reopened=new MiseDatabase(name);databases.push(reopened);const saved=(await reopened.closingReviews.get(f.id))!;
 const result=await decideSavedClosingReview(reopened,f.id,saved.revision,replacement,f.options);expect(result.record.phase).toBe('confirmed');expect(f.calls()).toBe(1);expect(result.record.receipt).toEqual(f.done());expect(backupToken(await reopened.readBackup())).toBe(f.backup);
});
it('saves an offline decision before HTTP and retains its original source for retry',async()=>{
 const f=await boot(),record=await prepareSavedClosingReview(f.db,f.id,null,f.options);f.offline(true);await expect(decideSavedClosingReview(f.db,f.id,record.revision,replacement,f.options)).rejects.toThrow();
 const saved=(await f.db.closingReviews.get(f.id))!;expect(saved.phase).toBe('unconfirmed');expect(saved.choice).toEqual(replacement);expect(saved.attempts).toHaveLength(1);expect(saved.receipt).toBeNull();expect(await f.db.outbox.toArray()).toEqual(f.original);expect(f.calls()).toBe(0);
 f.offline(false);expect((await decideSavedClosingReview(f.db,f.id,saved.revision,replacement,f.options)).record.phase).toBe('confirmed');
});
it('allows only one durable choice from two competing native revisions',async()=>{
 const f=await boot(),record=await prepareSavedClosingReview(f.db,f.id,null,f.options),results=await Promise.allSettled([decideSavedClosingReview(f.db,f.id,record.revision,replacement,f.options),decideSavedClosingReview(f.db,f.id,record.revision,withdraw,f.options)]);
 expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(f.calls()).toBe(1);expect((await f.db.closingReviews.get(f.id))?.phase).toBe('confirmed');
});
it('requires the changed complete comparison to be reviewed before a new cash effect is submitted',async()=>{
 const f=await boot(),record=await prepareSavedClosingReview(f.db,f.id,null,f.options);f.changeCash();const result=await decideSavedClosingReview(f.db,f.id,record.revision,replacement,f.options);
 expect(result.changed).toBe(true);expect(result.record.phase).toBe('review');expect(result.record.choice).toBeNull();expect(result.record.attempts).toHaveLength(1);expect(f.calls()).toBe(0);expect(await f.db.outbox.toArray()).toEqual(f.original);
 expect(result.record.quote?.proposal).toMatchObject({enabled:true,closing:{addedWalkIn:1501}});
 expect((await decideSavedClosingReview(f.db,f.id,result.record.revision,replacement,f.options)).record.phase).toBe('confirmed');
});
it('does not refresh a saved undo choice across its original-day deadline',async()=>{
 const f=await boot('undo-surplus'),record=await prepareSavedClosingReview(f.db,f.id,null,f.options),tomorrow=Date.now()+86400000;vi.spyOn(Date,'now').mockReturnValue(tomorrow);
 const result=await decideSavedClosingReview(f.db,f.id,record.revision,replacement,f.options);expect(result.changed).toBe(true);expect(result.record.quote?.proposal).toEqual({enabled:false,reason:'deadline'});expect(f.calls()).toBe(0);
 await expect(decideSavedClosingReview(f.db,f.id,result.record.revision,replacement,f.options)).rejects.toThrow();expect((await decideSavedClosingReview(f.db,f.id,result.record.revision,withdraw,f.options)).record.phase).toBe('confirmed');
});
it('preserves a genuine grouped count prefix while reviewing only its original undo',async()=>{
 const f=await boot('undo-surplus',{group:true}),record=await prepareSavedClosingReview(f.db,f.id,null,f.options);expect(record.commandIndex).toBe(1);expect(f.original[0].commands).toHaveLength(2);expect(f.original[0].receipts).toHaveLength(1);
 const result=await decideSavedClosingReview(f.db,f.id,record.revision,replacement,f.options),row=(await f.db.outbox.toArray())[0];expect(result.record.phase).toBe('confirmed');expect(row.receipts[0]).toEqual(f.original[0].receipts[0]);expect(row.commands).toEqual(f.original[0].commands);expect(row.changes).toEqual(f.original[0].changes);
});
it('rejects a changed prefix independently of the stable complete-source hash',async()=>{
 const f=await boot('undo-surplus',{group:true}),record=await prepareSavedClosingReview(f.db,f.id,null,f.options),before=await f.db.closingReviews.get(f.id),row=(await f.db.outbox.toArray())[0];
 await f.db.outbox.update(row.id,{receipts:row.receipts.map(receipt=>({...receipt,at:receipt.at+1}))});await expect(decideSavedClosingReview(f.db,f.id,record.revision,replacement,f.options)).rejects.toThrow();expect(f.calls()).toBe(0);expect(await f.db.closingReviews.get(f.id)).toEqual(before);
});
it('rejects a changed literal audit instead of deriving a new source from working records',async()=>{
 const f=await boot(),record=await prepareSavedClosingReview(f.db,f.id,null,f.options),before=await f.db.closingReviews.get(f.id),row=(await f.db.outbox.toArray())[0],changes=structuredClone(row.changes);
 (changes.find(change=>change.table==='events'&&change.key===record.packet.command.id)!.after as {at:number}).at++;
 await f.db.outbox.update(row.id,{changes});await expect(decideSavedClosingReview(f.db,f.id,record.revision,replacement,f.options)).rejects.toThrow();expect(f.calls()).toBe(0);expect(await f.db.closingReviews.get(f.id)).toEqual(before);
});
it('binds all original image bytes in a grouped native source',async()=>{
 const f=await boot('surplus',{image:true}),record=await prepareSavedClosingReview(f.db,f.id,null,f.options),before=await f.db.closingReviews.get(f.id),row=(await f.db.outbox.toArray())[0],changes=structuredClone(row.changes),image=(changes.find(change=>change.table==='inboxItems')!.after as {images:{blob:Blob}[]}).images[0];
 image.blob=new Blob([new Uint8Array(await image.blob.arrayBuffer()).fill(1)]);await f.db.outbox.update(row.id,{changes});
 await expect(decideSavedClosingReview(f.db,f.id,record.revision,replacement,f.options)).rejects.toThrow();expect(f.calls()).toBe(0);expect(await f.db.closingReviews.get(f.id)).toEqual(before);expect(backupToken(await f.db.readBackup())).toBe(f.backup);
});
it.each(['read','resolve'] as const)('an account switch during %s cannot acknowledge the original action',async phase=>{
 const f=await boot(),record=await prepareSavedClosingReview(f.db,f.id,null,f.options);if(phase==='read')f.onRead(async()=>f.setAuth());else f.onResolve(async()=>f.setAuth());
 await expect(decideSavedClosingReview(f.db,f.id,record.revision,replacement,f.options)).rejects.toThrow();expect(await f.db.outbox.toArray()).toEqual(f.original);expect((await f.db.closingReviews.get(f.id))?.receipt).toBeNull();
});
it('an account switch inside the native journal writer rolls back its saved comparison',async()=>{
 const f=await boot(),put=f.db.closingReviews.put.bind(f.db.closingReviews),writer=vi.spyOn(f.db.closingReviews,'put').mockImplementation((async(...args:Parameters<typeof put>)=>{const result=await put(...args);f.setAuth();return result;}) as typeof put);
 try{await expect(prepareSavedClosingReview(f.db,f.id,null,f.options)).rejects.toThrow('Original account changed');}finally{writer.mockRestore();}
 expect(await f.db.closingReviews.count()).toBe(0);expect(await f.db.outbox.toArray()).toEqual(f.original);expect(backupToken(await f.db.readBackup())).toBe(f.backup);
});
it('an expired native review transaction cannot open a separate journal writer',async()=>{
 const f=await boot(),get=f.db.closingReviews.get.bind(f.db.closingReviews),reader=vi.spyOn(f.db.closingReviews,'get').mockImplementation(((...args:Parameters<typeof get>)=>{const result=get(...args);return Dexie.currentTransaction?.mode==='readwrite'?result.then(async row=>{await new Promise(resolve=>setTimeout(resolve,20));return row;}):result;}) as typeof get);
 try{await expect(prepareSavedClosingReview(f.db,f.id,null,f.options)).rejects.toThrow();}finally{reader.mockRestore();}
 expect(await f.db.closingReviews.count()).toBe(0);expect(await f.db.outbox.toArray()).toEqual(f.original);expect(backupToken(await f.db.readBackup())).toBe(f.backup);
});
it('refuses an asynchronous account guard before any native journal write',async()=>{
 const f=await boot(),options={...f.options,account:{...f.options.account,assertCurrent:(async()=>{}) as unknown as typeof f.options.account.assertCurrent}};
 await expect(prepareSavedClosingReview(f.db,f.id,null,options)).rejects.toThrow('synchronous original-account');expect(await f.db.closingReviews.count()).toBe(0);expect(await f.db.outbox.toArray()).toEqual(f.original);
});
async function activateOriginalOwner(f:Awaited<ReturnType<typeof boot>>){const setup=(await f.db.setup())!;await selectCloudOperator(f.db,{version:1,role:'owner',businessId:setup.business.id,outletId:setup.outlet.id,actorId:setup.owner.id,accountHash:f.options.account.accountHash,epoch:'00000000-0000-4000-8000-000000000001',scopeVersion:'00000000-0000-4000-8000-000000000002',businessName:setup.business.name,outletName:setup.outlet.name,actorName:setup.owner.name??null},{targetHash:f.options.account.targetHash,authKey:'mise.cloud.auth.'+'e'.repeat(64)},null,async value=>value);}
it('a new owner generation may confirm an acknowledged outcome without reviving the old decision',async()=>{
 const f=await boot(),record=await prepareSavedClosingReview(f.db,f.id,null,f.options);f.lose();await expect(decideSavedClosingReview(f.db,f.id,record.revision,replacement,f.options)).rejects.toThrow();await activateOriginalOwner(f);
 await deliverLocalOutbox(f.db,f.options.account.targetHash,createCloudCommandRemote(config,f.options.account,async()=>Response.json(f.done())));
 const saved=(await f.db.closingReviews.get(f.id))!,accepted=await f.db.outbox.toArray();expect((await readClosingReviewWorkspace(f.db,f.id))?.acknowledged).toBe(true);
 await expect(decideSavedClosingReview(f.db,f.id,saved.revision,withdraw,f.options)).rejects.toThrow();const confirmed=await prepareSavedClosingReview(f.db,f.id,saved.revision,f.options);expect(confirmed.phase).toBe('confirmed');expect(f.calls()).toBe(1);expect(await f.db.outbox.toArray()).toEqual(accepted);
});
it('a changed owner generation cannot resubmit an unacknowledged decision',async()=>{
 const f=await boot(),record=await prepareSavedClosingReview(f.db,f.id,null,f.options);await activateOriginalOwner(f);expect(await readClosingReviewWorkspace(f.db,f.id)).toBeNull();
 await expect(prepareSavedClosingReview(f.db,f.id,record.revision,f.options)).rejects.toThrow();expect(f.calls()).toBe(0);expect(await f.db.outbox.toArray()).toEqual(f.original);
});
it('upgrades schema27 without changing any queue, receipt, image or portable row',async()=>{
 const f=await boot(),old=new Dexie('mise-closing-review-v27-'+randomUUID()),tables=f.db.tables.filter(table=>table.name!=='closingReviews'),saved=await Promise.all(tables.map(table=>table.toArray()));databases.push(old);
 old.version(27).stores(Object.fromEntries(tables.map(table=>[table.name,[table.schema.primKey.src,...table.schema.indexes.map(index=>index.src)].join(',')])));for(let i=0;i<tables.length;i++)await old.table(tables[i].name).bulkPut(saved[i]);old.close();
 const upgraded=new MiseDatabase(old.name);databases.push(upgraded);await upgraded.open();expect(upgraded.verno).toBe(localSchemaVersion);expect(upgraded.tables).toHaveLength(localTableNames.length);expect(await upgraded.closingReviews.count()).toBe(0);
 for(let i=0;i<tables.length;i++)expect(await upgraded.table(tables[i].name).toArray(),tables[i].name).toEqual(saved[i]);expect(backupToken(await upgraded.readBackup())).toBe(f.backup);expect((await upgraded.readBackup()).tables).not.toHaveProperty('closingReviews');
});
