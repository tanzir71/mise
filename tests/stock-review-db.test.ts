import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {MiseDatabase} from '../apps/web/src/data/db';
import {CloudUploadJournal,uploadWithLocalOutbox} from '../apps/web/src/data/cloud-upload';
import {deliverLocalOutbox} from '../apps/web/src/data/local-outbox';
import {createCloudCommandRemote} from '../apps/web/src/data/cloud-command-remote';
import {prepareSavedStockReview,decideSavedStockReview,readStockReviewWorkspace,hasSavedStockReview} from '../apps/web/src/data/stock-review-session';
import {prepareStockReviewSource} from '../apps/web/src/data/stock-review-source';
import {type CommandAuthorization} from '../apps/web/src/data/command-request';
import {stockFingerprint} from '../packages/core/stock-replay';
import {parseStockReviewSource,type StockReviewRequest} from '../packages/core/stock-review-source';
import {reviewedStockProposal,type StockResolutionReceipt} from '../packages/core/stock-review';
import {parseStockCommandReceipt,stockWritePlan,type StockCommandReceipt} from '../packages/core/stock-commands';
import {adjustStockCommand,type StockContext} from '../packages/core/stock';
import {syncHash} from '../packages/core/sync-read';
import {syncDownloadToken} from '../packages/core/sync-download';
import {backupToken} from '../packages/core/backup';
import {localSchemaVersion} from '../packages/core/local-outbox';
import {localTableNames} from '../packages/core/local-schema';
import {cloudUploadFixture,MemoryCloudUpload,uploadId} from './cloud-upload-fixture';
import {testCommandAccount} from './command-account-fixture';
import {selectCloudOperator} from '../apps/web/src/data/operator-state';
import {view} from './stock-review-fixture';
const config={apiUrl:'https://cloud.test',publishableKey:'sb_publishable_test_only'},databases:Dexie[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(databases.splice(0).map(db=>db.delete()));});
/** Real native journal/account/source writes with an explicit synthetic gateway.
 * The stock-command protocol suite separately uses actual SQL and HTTP adapters. */
async function boot(){
 const db=new MiseDatabase('mise-stock-review-'+randomUUID()),journal=new CloudUploadJournal('mise-stock-review-upload-'+randomUUID());databases.push(db,journal);const source=cloudUploadFixture();await db.restoreBackup(source,await db.previewRestore(source));
 const item=await db.saveStockItem({name:'Original stock rice',unit:'kg',onHand:20,target:30,packSize:1,aliases:['ধান']});
 const setup=await db.setup();if(!setup)throw Error();const canonical:StockContext={setup,items:await db.stockItems.toArray(),moves:await db.stockMoves.toArray(),suppliers:await db.suppliers.toArray()};
 let authorization:CommandAuthorization={jwt:'original.account.signature',userId:'00000000-0000-4000-8000-000000000001',generation:1};
 const account={...testCommandAccount(config,async()=>authorization.jwt),getAuth:async()=>({...authorization}),assertCurrent:(value:CommandAuthorization)=>{if(value.generation!==authorization.generation||value.userId!==authorization.userId)throw Error('Original account changed');}};
 const plan=await journal.prepare(db,uploadId());await uploadWithLocalOutbox(db,journal,plan.manifest.id,account.targetHash,new MemoryCloudUpload());await db.adjustStock({id:item.id,revision:item.revision,reason:'count',quantity:7,note:'Original · বাংলা\0\ud800'});
 const original=await db.outbox.toArray(),backup=backupToken(await db.readBackup());await expect(deliverLocalOutbox(db,account.targetHash,createCloudCommandRemote(config,account,async()=>new Response('Private provider detail',{status:409})))).rejects.toMatchObject({kind:'review'});
 const workspace=await readStockReviewWorkspace(db);if(!workspace)throw Error('Expected actual rejected stock action');
 let lost=false,calls=0,done:StockCommandReceipt|StockResolutionReceipt|null=null,onRead:(()=>Promise<void>)|null=null,onResolve:(()=>Promise<void>)|null=null;
 const setCount=(quantity:number)=>{const before=canonical.items.find(i=>i.id===item.id)!,change=adjustStockCommand({id:item.id,revision:before.revision,reason:'count',quantity},canonical,Date.now()-1);canonical.items=canonical.items.map(i=>i.id===item.id?change.items[0]:i);canonical.moves.push(...change.moves);};setCount(10);
 const receiptFor=(packet:StockReviewRequest,replaced=false):StockCommandReceipt=>{const quote=view(canonical,packet,Date.now()),revisions=quote.current.items.map(row=>({stockItemId:row.stockItemId,revision:row.item!.revision})),c=replaced?reviewedStockProposal(packet.command,packet.replacementId,revisions):packet.command,p=stockWritePlan(c);return parseStockCommandReceipt({id:c.id,type:c.type,outletId:c.outletId,occurredAt:c.occurredAt,at:quote.at,batchId:p.batchId,undoOf:p.undoMoveId,results:p.rows.map((row,i)=>({stockItemId:row.itemId,eventId:row.eventId,moveId:row.moveId,revision:replaced?revisions[i].revision+1:row.revision+1,onHand:7,updatedAt:quote.at}))},c);};
 const send:typeof fetch=async(url,init)=>{
  const packet=JSON.parse(String(init?.body)) as StockReviewRequest&{outcome:'withdrawn'|'replaced'},mode=new URL(String(url)).searchParams.get('review'),c=packet.command;
  if(!mode)return done?Response.json(done):new Response('Private detail',{status:409});
  if(mode==='stock-resolve'){
   calls++;const quote=view(canonical,packet,Date.now()),revisions=quote.current.items.map(row=>({stockItemId:row.stockItemId,revision:row.item!.revision})),receipt=packet.outcome==='withdrawn'?null:receiptFor(packet,true);done={id:packet.id,type:'command.resolved',commandId:c.id,commandType:c.type,outletId:c.outletId,occurredAt:c.occurredAt,commandHash:await stockFingerprint(c),sourceHash:packet.sourceHash,at:Math.max(Date.now(),receipt?.at??0),outcome:packet.outcome,replacement:receipt?{id:packet.replacementId,commandHash:await stockFingerprint(reviewedStockProposal(c,packet.replacementId,revisions)),revisions,receipt}:null};
   await onResolve?.();if(lost){lost=false;throw Error('Lost reply after actual completion');}return Response.json(done);
  }
  if(done)return Response.json({done:true,receipt:done});const source=parseStockReviewSource(packet),sameUnit=source.events.every(e=>canonical.items.find(i=>i.id===e.stockItemId)?.unit===e.after.item.unit),review=view(canonical,packet,Date.now(),sameUnit);if(!sameUnit)review.proposal={enabled:false,reason:'unit'};review.commandHash=await stockFingerprint(c);review.current.stateHash=await syncHash(new TextEncoder().encode(syncDownloadToken({items:canonical.items,moves:canonical.moves})));await onRead?.();return Response.json({done:false,review});
 };
 return {db,journal,item,original,backup,id:workspace.source.review.id,options:{config,account,send},canonical,setCount,calls:()=>calls,done:()=>done,lose:()=>{lost=true;},setAuth:()=>{authorization={...authorization,generation:authorization.generation+1};},onRead:(value:typeof onRead)=>{onRead=value;},onResolve:(value:typeof onResolve)=>{onResolve=value;},setDone:(value:typeof done)=>{done=value;},receiptFor};
}
const withdraw={outcome:'withdrawn' as const},replacement={outcome:'replaced' as const};
it('native stock review retains original count/source and a token-free choice while confirming a checked replacement',async()=>{
 const f=await boot();expect(await hasSavedStockReview(f.db,(await f.db.cloudState.get('binding'))!.uploadId)).toBe(true);const r=await prepareSavedStockReview(f.db,f.id,null,f.options);expect(r.phase).toBe('review');expect(r.quote?.current.items[0].item?.onHand).toBe(10);expect(r.quote?.proposal).toMatchObject({enabled:true,items:[{onHand:7,unit:'kg'}]});const result=await decideSavedStockReview(f.db,f.id,r.revision,replacement,f.options);expect(result.changed).toBe(false);expect(result.record.phase).toBe('confirmed');expect(result.record.receipt).toMatchObject({outcome:'replaced',replacement:{revisions:[{revision:2}],receipt:{results:[{onHand:7,revision:3}]}}});expect(f.calls()).toBe(1);expect((await f.db.outbox.toArray())[0].status).toBe('accepted');expect(backupToken(await f.db.readBackup())).toBe(f.backup);const saved=JSON.stringify(await f.db.stockReviews.toArray());expect(saved).not.toContain('"token"');expect(saved).not.toContain(config.apiUrl);expect(saved).not.toContain(config.publishableKey);expect(saved).not.toContain('original.account.signature');
});
it('a lost stock resolution response survives close/reload and checks the actual outcome before another send',async()=>{
 const f=await boot(),r=await prepareSavedStockReview(f.db,f.id,null,f.options);f.lose();await expect(decideSavedStockReview(f.db,f.id,r.revision,replacement,f.options)).rejects.toThrow();expect(await f.db.outbox.toArray()).toEqual(f.original);const name=f.db.name;f.db.close();const reopened=new MiseDatabase(name);databases.push(reopened);const saved=(await reopened.stockReviews.get(f.id))!;expect(saved.phase).toBe('unconfirmed');expect(saved.attempts).toHaveLength(1);const result=await prepareSavedStockReview(reopened,f.id,saved.revision,f.options);expect(result.phase).toBe('confirmed');expect(f.calls()).toBe(1);expect(backupToken(await reopened.readBackup())).toBe(f.backup);
});
it('a changed current stock comparison requires a fresh explicit choice without reusing saved consent',async()=>{
 const f=await boot(),r=await prepareSavedStockReview(f.db,f.id,null,f.options);f.setCount(12);const changed=await decideSavedStockReview(f.db,f.id,r.revision,replacement,f.options);expect(changed.changed).toBe(true);expect(changed.record.choice).toBeNull();expect(changed.record.quote?.current.items[0].item?.onHand).toBe(12);expect(changed.record.quote?.proposal).toMatchObject({enabled:true,items:[{onHand:7}]});expect(f.calls()).toBe(0);expect(await f.db.outbox.toArray()).toEqual(f.original);const actual=await decideSavedStockReview(f.db,f.id,changed.record.revision,replacement,f.options);expect(actual.record.phase).toBe('confirmed');expect(actual.record.attempts).toHaveLength(2);
});
it('withdrawal confirms a resolution without changing the complete original working source or count',async()=>{
 const f=await boot(),r=await prepareSavedStockReview(f.db,f.id,null,f.options),result=await decideSavedStockReview(f.db,f.id,r.revision,withdraw,f.options);expect(result.record.receipt).toMatchObject({outcome:'withdrawn',replacement:null});expect(backupToken(await f.db.readBackup())).toBe(f.backup);expect((await f.db.stockItems.get(f.item.id))?.onHand).toBe(7);expect(result.record.packet.sourceJson).toBe(r.packet.sourceJson);
});
it('a completed ordinary stock action is recovered without manufacturing a resolution',async()=>{
 const f=await boot(),workspace=(await readStockReviewWorkspace(f.db,f.id))!,p=await prepareStockReviewSource(workspace.source.entry,0,uploadId(91),uploadId(92));f.setDone(f.receiptFor(p));const r=await prepareSavedStockReview(f.db,f.id,null,f.options);expect(r.phase).toBe('confirmed');expect(r.receipt?.type).toBe('stock.adjust');expect(f.calls()).toBe(0);
});
it('the native source and account are rechecked around HTTP and no stale generation acknowledges a choice',async()=>{
 const f=await boot(),r=await prepareSavedStockReview(f.db,f.id,null,f.options);f.onResolve(async()=>{f.setAuth();});await expect(decideSavedStockReview(f.db,f.id,r.revision,replacement,f.options)).rejects.toThrow();expect(await f.db.outbox.toArray()).toEqual(f.original);expect((await f.db.stockReviews.get(f.id))?.phase).toBe('unconfirmed');expect(backupToken(await f.db.readBackup())).toBe(f.backup);
});
it('a schema-25 shop upgrades with all original source, receipt and pending work intact',async()=>{
 const f=await boot(),old=new Dexie('mise-stock-review-v25-'+randomUUID()),tables=f.db.tables.filter(t=>t.name!=='payments'&&t.name!=='stockReviews'&&t.name!=='customerReviews'&&t.name!=='closingReviews'),saved=await Promise.all(tables.map(t=>t.toArray()));databases.push(old);old.version(25).stores(Object.fromEntries(tables.map(t=>[t.name,[t.schema.primKey.src,...t.schema.indexes.map(i=>i.src)].join(',')])));for(let i=0;i<tables.length;i++)await old.table(tables[i].name).bulkPut(saved[i]);old.close();const upgraded=new MiseDatabase(old.name);databases.push(upgraded);await upgraded.open();expect(upgraded.verno).toBe(localSchemaVersion);expect(upgraded.tables).toHaveLength(localTableNames.length);expect(await upgraded.stockReviews.count()).toBe(0);expect(await Promise.all(tables.map(t=>upgraded.table(t.name).toArray()))).toEqual(saved);expect(backupToken(await upgraded.readBackup())).toBe(f.backup);expect(Object.keys((await upgraded.readBackup()).tables)).toHaveLength(22);
});
it('changing a retained original audit cannot borrow the current working row for confirmation',async()=>{
 const f=await boot(),r=await prepareSavedStockReview(f.db,f.id,null,f.options),before=await f.db.stockReviews.get(f.id),entry=(await f.db.outbox.toArray())[0],audit=entry.changes.find(c=>c.table==='events')!;(audit.after as {after:{item:{unit:string}}}).after.item.unit='g';await f.db.outbox.put(entry);await expect(decideSavedStockReview(f.db,f.id,r.revision,replacement,f.options)).rejects.toThrow();expect(await f.db.stockReviews.get(f.id)).toEqual(before);expect(f.calls()).toBe(0);expect(parseStockReviewSource(r.packet).events[0].after.item.unit).toBe('kg');
});
it('a changed online unit disables substitution while preserving the original count for withdrawal',async()=>{
 const f=await boot();f.canonical.items.find(i=>i.id===f.item.id)!.unit='g';const r=await prepareSavedStockReview(f.db,f.id,null,f.options);expect(r.quote?.proposal).toEqual({enabled:false,reason:'unit'});await expect(decideSavedStockReview(f.db,f.id,r.revision,replacement,f.options)).rejects.toThrow();expect(f.calls()).toBe(0);expect((await decideSavedStockReview(f.db,f.id,r.revision,withdraw,f.options)).record.phase).toBe('confirmed');expect(backupToken(await f.db.readBackup())).toBe(f.backup);
});
it('a newer native comparison supersedes an older decision before any resolve call',async()=>{
 const f=await boot(),r=await prepareSavedStockReview(f.db,f.id,null,f.options),newer=await prepareSavedStockReview(f.db,f.id,r.revision,f.options);await expect(decideSavedStockReview(f.db,f.id,r.revision,replacement,f.options)).rejects.toThrow();expect((await f.db.stockReviews.get(f.id))?.revision).toBe(newer.revision);expect(f.calls()).toBe(0);
});
it('an account change inside the native stock journal writer rolls the review back before HTTP',async()=>{
 const f=await boot(),before=await f.db.stockReviews.toArray(),change=()=>{f.setAuth();};f.db.stockReviews.hook('creating',change);try{await expect(prepareSavedStockReview(f.db,f.id,null,f.options)).rejects.toThrow();expect(await f.db.stockReviews.toArray()).toEqual(before);expect(await f.db.outbox.toArray()).toEqual(f.original);expect(f.calls()).toBe(0);}finally{f.db.stockReviews.hook('creating').unsubscribe(change);}
});
it('an original outbox change inside the stock journal writer rolls both records back without a decision',async()=>{
 const f=await boot(),before=await f.db.stockReviews.toArray();let changed=false;const mutate=()=>{void f.db.outbox.update(f.original[0].id,{at:f.original[0].at+1}).then(()=>{changed=true;}).catch(()=>{});};f.db.stockReviews.hook('creating',mutate);
 try{await expect(prepareSavedStockReview(f.db,f.id,null,f.options)).rejects.toThrow();expect(changed).toBe(true);expect(await f.db.stockReviews.toArray()).toEqual(before);expect(await f.db.outbox.toArray()).toEqual(f.original);expect(f.calls()).toBe(0);expect(backupToken(await f.db.readBackup())).toBe(f.backup);}finally{f.db.stockReviews.hook('creating').unsubscribe(mutate);}
});
async function activateOriginalOwner(f:Awaited<ReturnType<typeof boot>>){const setup=(await f.db.setup())!;return selectCloudOperator(f.db,{version:1,role:'owner',businessId:setup.business.id,outletId:setup.outlet.id,actorId:setup.owner.id,accountHash:f.options.account.accountHash,epoch:'00000000-0000-4000-8000-000000000001',scopeVersion:'00000000-0000-4000-8000-000000000002',businessName:setup.business.name,outletName:setup.outlet.name,actorName:setup.owner.name??null},{targetHash:f.options.account.targetHash,authKey:'mise.cloud.auth.'+'e'.repeat(64)},null,async value=>value);}
async function acknowledgedFixture(){const f=await boot(),r=await prepareSavedStockReview(f.db,f.id,null,f.options);f.lose();await expect(decideSavedStockReview(f.db,f.id,r.revision,replacement,f.options)).rejects.toThrow();await activateOriginalOwner(f);await deliverLocalOutbox(f.db,f.options.account.targetHash,createCloudCommandRemote(config,f.options.account,async()=>Response.json(f.done())));const record=(await f.db.stockReviews.get(f.id))!;return {...f,record,accepted:await f.db.outbox.toArray(),operator:await f.db.operatorState.get('active')};}
it('rechecks an outcome acknowledged under a fresh original-owner generation without reviving the stock decision',async()=>{
 const f=await acknowledgedFixture();expect((await readStockReviewWorkspace(f.db,f.id))?.acknowledged).toBe(true);await expect(decideSavedStockReview(f.db,f.id,f.record.revision,replacement,f.options)).rejects.toThrow('original');const actual=await prepareSavedStockReview(f.db,f.id,f.record.revision,f.options);expect(actual.phase).toBe('confirmed');expect(actual.receipt).toEqual(f.done());expect(actual.identityHash).toBe(f.record.identityHash);expect(actual.packet).toEqual(f.record.packet);expect(actual.attempts).toEqual(f.record.attempts);expect(f.calls()).toBe(1);expect(await f.db.outbox.toArray()).toEqual(f.accepted);expect(backupToken(await f.db.readBackup())).toBe(f.backup);
});
it('a later generation cannot submit an old pending stock choice before a genuine acknowledgement',async()=>{
 const f=await boot(),r=await prepareSavedStockReview(f.db,f.id,null,f.options);await activateOriginalOwner(f);expect(await readStockReviewWorkspace(f.db,f.id)).toBeNull();await expect(prepareSavedStockReview(f.db,f.id,r.revision,f.options)).rejects.toThrow('original');expect(f.calls()).toBe(0);expect(await f.db.outbox.toArray()).toEqual(f.original);
});
it('cached acknowledgement cannot invent confirmed stock history or resubmit its choice',async()=>{
 const f=await acknowledgedFixture();f.setDone(null);await expect(prepareSavedStockReview(f.db,f.id,f.record.revision,f.options)).rejects.toThrow('actual acknowledged');expect(await f.db.stockReviews.get(f.id)).toEqual(f.record);expect(await f.db.outbox.toArray()).toEqual(f.accepted);expect(f.calls()).toBe(1);
});
it('a different restored phone account cannot adopt the acknowledged stock history',async()=>{
 const f=await acknowledgedFixture(),operator=f.operator!;await f.db.operatorState.put({...operator,connection:{...operator.connection!,accountHash:'d'.repeat(64)}});expect(await readStockReviewWorkspace(f.db,f.id)).toBeNull();await expect(prepareSavedStockReview(f.db,f.id,f.record.revision,f.options)).rejects.toThrow('original');expect(await f.db.outbox.toArray()).toEqual(f.accepted);
});
