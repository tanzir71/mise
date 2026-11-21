import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {MiseDatabase} from '../apps/web/src/data/db';
import {CloudUploadJournal,uploadWithLocalOutbox} from '../apps/web/src/data/cloud-upload';
import {deliverLocalOutbox} from '../apps/web/src/data/local-outbox';
import {createCloudCommandRemote} from '../apps/web/src/data/cloud-command-remote';
import {type CommandAuthorization} from '../apps/web/src/data/command-request';
import {prepareSavedMoneyReview,decideSavedMoneyReview,readMoneyReviewWorkspace,hasSavedMoneyReview} from '../apps/web/src/data/money-review-session';
import {prepareMoneyReviewSource} from '../apps/web/src/data/money-review-source';
import {selectCloudOperator} from '../apps/web/src/data/operator-state';
import {originalMoneyFacts,reviewedMoneyProposal,type MoneyReviewRequest,type MoneyResolutionReceipt,type PreparedMoneyReview} from '../packages/core/money-review';
import {parseLocalMoneyReview} from '../packages/core/money-review-journal';
import {moneyFingerprint} from '../packages/core/money-replay';
import {parseMoneyCommandReceipt,type MoneyCommandReceipt} from '../packages/core/money-commands';
import {backupToken} from '../packages/core/backup';
import {cloudUploadFixture,MemoryCloudUpload,uploadId} from './cloud-upload-fixture';
import {testCommandAccount} from './command-account-fixture';

const config={apiUrl:'https://cloud.test',publishableKey:'sb_publishable_test_only'};
const databases:Dexie[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(databases.splice(0).map(db=>db.delete()));});

/** Native persistence/account tests. HTTP replies are synthetic here; the
 * separate money protocol suite executes actual PostgreSQL and HTTP handlers. */
async function boot(kind:'cash'|'credit'|'payment'|'saleUndo'|'khataUndo'='cash'){
 const db=new MiseDatabase('mise-money-review-'+randomUUID()),journal=new CloudUploadJournal('mise-money-review-upload-'+randomUUID());databases.push(db,journal);
 const source=cloudUploadFixture();await db.restoreBackup(source,await db.previewRestore(source));
 let authorization:CommandAuthorization={jwt:'original.account.signature',userId:'00000000-0000-4000-8000-000000000001',generation:1};
 const account={...testCommandAccount(config,async()=>authorization.jwt),getAuth:async()=>({...authorization}),assertCurrent:(value:CommandAuthorization)=>{if(value.generation!==authorization.generation||value.userId!==authorization.userId)throw Error('Original account changed');}};
 const ledger=source.tables.creditAccounts[0],customer=source.tables.customers[0];
 const parentSale=kind==='saleUndo'?await db.recordSale({expression:'5',method:'cash'}):null,
  parentEntry=kind==='khataUndo'?await db.recordCreditPayment(ledger.id,500,'cash'):null;
 const plan=await journal.prepare(db,uploadId());await uploadWithLocalOutbox(db,journal,plan.manifest.id,account.targetHash,new MemoryCloudUpload());
 if(kind==='cash')await db.recordSale({expression:'5',method:'cash'});
 else if(kind==='credit')await db.recordCreditSale({expression:'5',accountId:ledger.id,customerId:customer.id});
 else if(parentSale)await db.undoSale(parentSale.id);
 else if(parentEntry)await db.undoCreditEntry(parentEntry.id);
 else await db.recordCreditPayment(ledger.id,500,'cash');
 const original=await db.outbox.toArray(),backup=backupToken(await db.readBackup());
 await expect(deliverLocalOutbox(db,account.targetHash,createCloudCommandRemote(config,account,async()=>new Response('Private provider detail',{status:409})))).rejects.toMatchObject({kind:'review'});
 const workspace=await readMoneyReviewWorkspace(db);if(!workspace)throw Error('Expected actual rejected money observation');
 const facts=originalMoneyFacts(await prepareMoneyReviewSource(workspace.source.entry,0,uploadId(91),uploadId(92)));
 let balance=20000,limit=100000,profileCurrency='BDT',lost=false,calls=0,done:MoneyCommandReceipt|MoneyResolutionReceipt|null=null;
 let onRead:(()=>Promise<void>)|null=null,onResolve:(()=>Promise<void>)|null=null;
 const receiptFor=(packet:MoneyReviewRequest,id=packet.command.id):MoneyCommandReceipt=>{
  const c=packet.command,entryId=c.type==='khata.undo'?c.reversalId:'entryId'in c?c.entryId:null;
  return parseMoneyCommandReceipt({id,type:c.type,outletId:c.outletId,occurredAt:c.occurredAt,saleId:'saleId'in c?c.saleId:null,accountId:facts.accountId,entryId,amount:facts.amount,at:Date.now(),saleUpdatedAt:'saleId'in c?c.occurredAt:null,entrySequence:entryId?3:null,undoOf:c.type==='sale.undo'?c.saleId:c.type==='khata.undo'?c.entryId:null},id===c.id?c:reviewedMoneyProposal(c,id));
 };
 const send:typeof fetch=async(url,init)=>{
  const packet=JSON.parse(String(init?.body)) as MoneyReviewRequest&{outcome:'withdrawn'|'replaced';confirmCredit:boolean},c=packet.command;
  if(new URL(String(url)).searchParams.get('review')==='money-resolve'){
   calls++;const consent=c.type==='sale.credit'&&balance+facts.amount>limit?{balance,limit}:null;
   done={id:packet.id,type:'command.resolved',commandId:c.id,commandType:c.type,outletId:c.outletId,occurredAt:c.occurredAt,commandHash:workspace.source.review.commandHash,sourceHash:packet.sourceHash,at:Date.now(),outcome:packet.outcome,replacement:packet.outcome==='withdrawn'?null:{id:packet.replacementId,commandHash:await moneyFingerprint(reviewedMoneyProposal(c,packet.replacementId,consent)),confirmation:consent,receipt:receiptFor(packet,packet.replacementId)}};
   await onResolve?.();if(lost){lost=false;throw Error('Lost reply after actual completion');}
   return Response.json(done);
  }
  if(done)return Response.json({done:true,receipt:done});
  const over=c.type==='sale.credit'&&balance+facts.amount>limit,r=workspace.source.review,at=Date.now();
  const review:PreparedMoneyReview={v:1,id:packet.id,replacementId:packet.replacementId,commandId:c.id,commandHash:r.commandHash,sourceHash:packet.sourceHash,businessId:r.businessId,outletId:r.outletId,actorId:r.actorId,token:'x'.repeat(43),at,expiresAt:at+120000,current:{profileCurrency,sale:parentSale?{id:parentSale.id,currency:parentSale.currency,amount:parentSale.amount,methodName:parentSale.methodName,voided:false,closed:false}:null,entry:parentEntry?{id:parentEntry.id,currency:parentEntry.currency,amount:parentEntry.amount,type:parentEntry.type}:null,accountId:facts.accountId,balance:facts.accountId?balance:null,limit:facts.accountId?limit:null,creditCurrency:facts.accountId?facts.currency:null,creditCustomer:facts.customerId?{id:facts.customerId,name:customer.name,phone:customer.phone??null}:null},proposal:profileCurrency!==facts.currency&&(c.type==='sale.record'||c.type==='sale.credit')?{enabled:false,reason:'currency'}:{enabled:true,currency:facts.currency,amount:facts.amount,balance:facts.accountId?balance+(c.type==='khata.payment'?-facts.amount:facts.amount):null,confirmation:over?{balance,limit}:null,requiresCreditConfirmation:over}};
  await onRead?.();return Response.json({done:false,review});
 };
 return {db,journal,original,backup,id:workspace.source.review.id,options:{config,account,send},facts,calls:()=>calls,
  setBalance:(value:number,newLimit=limit)=>{balance=value;limit=newLimit;},setCurrency:(value:string)=>{profileCurrency=value;},lose:()=>{lost=true;},
  setAuth:()=>{authorization={...authorization,generation:authorization.generation+1};},
  onRead:(value:typeof onRead)=>{onRead=value;},onResolve:(value:typeof onResolve)=>{onResolve=value;},
  setDone:(value:typeof done)=>{done=value;},done:()=>done,receiptFor};
}
const withdraw={outcome:'withdrawn',confirmCredit:false} as const,replacement={outcome:'replaced',confirmCredit:false} as const;

it('journals an explicit withdrawal before HTTP and acknowledges only the real receipt without rewriting original source or money',async()=>{
 const f=await boot(),r=await prepareSavedMoneyReview(f.db,f.id,null,f.options);
 f.onResolve(async()=>{const saved=await f.db.moneyReviews.get(f.id);expect(saved).toMatchObject({phase:'deciding',choice:withdraw});expect(saved?.attempts).toHaveLength(1);expect(await f.db.outbox.toArray()).toEqual(f.original);});
 const result=await decideSavedMoneyReview(f.db,f.id,r.revision,withdraw,f.options);
 expect(result.record.phase).toBe('confirmed');expect(result.record.receipt).toMatchObject({type:'command.resolved',outcome:'withdrawn',replacement:null});
 expect(f.calls()).toBe(1);expect((await f.db.outbox.toArray()).map(row=>row.changes)).toEqual(f.original.map(row=>row.changes));expect(backupToken(await f.db.readBackup())).toBe(f.backup);
 expect(JSON.stringify(result.record)).not.toContain('"token"');expect(Object.keys((await f.db.readBackup()).tables)).toHaveLength(21);
});
it('accepts a distinct genuine replacement while keeping original cash and financial identities intact',async()=>{
 const f=await boot(),r=await prepareSavedMoneyReview(f.db,f.id,null,f.options),result=await decideSavedMoneyReview(f.db,f.id,r.revision,replacement,f.options);
 expect(result.record.receipt).toMatchObject({outcome:'replaced',replacement:{id:r.packet.replacementId,receipt:{saleId:'saleId'in r.packet.command?r.packet.command.saleId:null,amount:500}}});
 const [row]=await f.db.outbox.toArray();expect(row.commands).toEqual(f.original[0].commands);expect(row.changes).toEqual(f.original[0].changes);expect(row.status).toBe('accepted');
 expect(backupToken(await f.db.readBackup())).toBe(f.backup);
});
it('recovers a lost completion after native database reopen with one actual resolution request',async()=>{
 const f=await boot(),r=await prepareSavedMoneyReview(f.db,f.id,null,f.options);f.lose();
 await expect(decideSavedMoneyReview(f.db,f.id,r.revision,withdraw,f.options)).rejects.toThrow();expect(await f.db.outbox.toArray()).toEqual(f.original);
 const name=f.db.name;f.db.close();const reopened=new MiseDatabase(name);databases.push(reopened);
 const saved=(await readMoneyReviewWorkspace(reopened,f.id))!.record!;expect(saved).toMatchObject({phase:'unconfirmed',choice:withdraw});
 const actual=await prepareSavedMoneyReview(reopened,f.id,saved.revision,f.options);expect(actual.phase).toBe('confirmed');expect(f.calls()).toBe(1);expect(actual.attempts).toHaveLength(1);
});
it('changed balances invalidate a saved credit choice without applying it',async()=>{
 const f=await boot('credit'),r=await prepareSavedMoneyReview(f.db,f.id,null,f.options);f.setBalance(99900);
 const changed=await decideSavedMoneyReview(f.db,f.id,r.revision,replacement,f.options);expect(changed.changed).toBe(true);expect(changed.record.choice).toBeNull();expect(changed.record.quote?.proposal).toMatchObject({requiresCreditConfirmation:true,confirmation:{balance:99900,limit:100000}});expect(f.calls()).toBe(0);expect(await f.db.outbox.toArray()).toEqual(f.original);
 await expect(decideSavedMoneyReview(f.db,f.id,changed.record.revision,replacement,f.options)).rejects.toThrow('confirm');
 const result=await decideSavedMoneyReview(f.db,f.id,changed.record.revision,{...replacement,confirmCredit:true},f.options);
 expect(result.record.receipt).toMatchObject({outcome:'replaced',replacement:{confirmation:{balance:99900,limit:100000}}});
 expect(result.record.packet.command).toEqual(r.packet.command);expect(result.record.attempts).toHaveLength(2);
});
it('never reuses old credit consent after the current balance falls below the limit',async()=>{
 const f=await boot('credit');f.setBalance(99900);const r=await prepareSavedMoneyReview(f.db,f.id,null,f.options);f.setBalance(10000);
 const changed=await decideSavedMoneyReview(f.db,f.id,r.revision,{...replacement,confirmCredit:true},f.options);expect(changed.changed).toBe(true);
 await expect(decideSavedMoneyReview(f.db,f.id,changed.record.revision,{...replacement,confirmCredit:true},f.options)).rejects.toThrow('confirm');expect(f.calls()).toBe(0);
});
it('a historical BDT payment stays BDT under a later USD profile',async()=>{
 const f=await boot('payment');f.setCurrency('USD');const r=await prepareSavedMoneyReview(f.db,f.id,null,f.options);
 expect(r.quote?.current.profileCurrency).toBe('USD');expect(r.quote?.proposal).toMatchObject({enabled:true,currency:'BDT',amount:500});
 const result=await decideSavedMoneyReview(f.db,f.id,r.revision,replacement,f.options);expect(result.record.phase).toBe('confirmed');expect(backupToken(await f.db.readBackup())).toBe(f.backup);
});
it('a new cash sale with a changed currency offers withdrawal and cannot be silently converted',async()=>{
 const f=await boot();f.setCurrency('USD');const r=await prepareSavedMoneyReview(f.db,f.id,null,f.options);
 await expect(decideSavedMoneyReview(f.db,f.id,r.revision,replacement,f.options)).rejects.toThrow('current values');expect(f.calls()).toBe(0);
 const result=await decideSavedMoneyReview(f.db,f.id,r.revision,withdraw,f.options);expect(result.record.receipt).toMatchObject({outcome:'withdrawn'});expect(factsCurrency(result.record.packet)).toBe('BDT');
});
it.each(['saleUndo','khataUndo'] as const)('keeps a historical BDT %s target, original deadline and reversal identity under a USD profile',async kind=>{
 const f=await boot(kind);f.setCurrency('USD');const r=await prepareSavedMoneyReview(f.db,f.id,null,f.options);
 expect(r.quote?.proposal).toMatchObject({enabled:true,currency:'BDT',amount:kind==='saleUndo'?-500:500});
 const result=await decideSavedMoneyReview(f.db,f.id,r.revision,replacement,f.options);
 expect(result.record.phase).toBe('confirmed');expect(result.record.packet.command).toEqual(r.packet.command);expect((await f.db.outbox.toArray())[0].commands).toEqual(f.original[0].commands);expect(backupToken(await f.db.readBackup())).toBe(f.backup);
});
function factsCurrency(packet:MoneyReviewRequest){return originalMoneyFacts(packet).currency;}
it('an already completed original cash action is recovered as its actual receipt without inventing a resolution',async()=>{
 const f=await boot(),r=await prepareSavedMoneyReview(f.db,f.id,null,f.options);f.setDone(f.receiptFor(r.packet));
 const result=await decideSavedMoneyReview(f.db,f.id,r.revision,withdraw,f.options);expect(result.record.receipt).toMatchObject({type:'sale.record'});expect(f.calls()).toBe(0);
});
it('adopts the actual source-bound outcome completed elsewhere even when it differs from the local choice and nonce',async()=>{
 const f=await boot(),r=await prepareSavedMoneyReview(f.db,f.id,null,f.options),c=r.packet.command;
 f.setDone({id:uploadId(99),type:'command.resolved',commandId:c.id,commandType:c.type,outletId:c.outletId,occurredAt:c.occurredAt,commandHash:r.commandHash,sourceHash:r.packet.sourceHash,at:Date.now(),outcome:'withdrawn',replacement:null});
 const actual=await decideSavedMoneyReview(f.db,f.id,r.revision,replacement,f.options);expect(actual.record.choice).toEqual(replacement);expect(actual.record.receipt).toMatchObject({id:uploadId(99),outcome:'withdrawn'});expect(f.calls()).toBe(0);
});
it('rejects a receipt for another original source without acknowledging cash',async()=>{
 const f=await boot(),r=await prepareSavedMoneyReview(f.db,f.id,null,f.options),c=r.packet.command;
 f.setDone({id:uploadId(99),type:'command.resolved',commandId:c.id,commandType:c.type,outletId:c.outletId,occurredAt:c.occurredAt,commandHash:r.commandHash,sourceHash:'e'.repeat(64),at:Date.now(),outcome:'withdrawn',replacement:null});
 await expect(decideSavedMoneyReview(f.db,f.id,r.revision,withdraw,f.options)).rejects.toThrow();expect(await f.db.outbox.toArray()).toEqual(f.original);expect((await f.db.moneyReviews.get(f.id))?.phase).toBe('unconfirmed');
});
it('retains original work and the durable choice if the account changes after the remote completion',async()=>{
 const f=await boot(),r=await prepareSavedMoneyReview(f.db,f.id,null,f.options);f.onResolve(async()=>{f.setAuth();});
 await expect(decideSavedMoneyReview(f.db,f.id,r.revision,withdraw,f.options)).rejects.toThrow();expect(await f.db.outbox.toArray()).toEqual(f.original);expect((await f.db.moneyReviews.get(f.id))?.choice).toEqual(withdraw);
});
it.each(['account','connection','source','quota'] as const)('rolls back a native %s change during the saved review write without sending money',async kind=>{
 const f=await boot(),binding=await f.db.cloudState.get('binding');
 const change=()=>{if(kind==='account')f.setAuth();else if(kind==='connection')void f.db.cloudState.update('binding',{targetHash:'a'.repeat(64)});else if(kind==='source')void f.db.outbox.update(f.original[0].id,{at:f.original[0].at+1});else throw new DOMException('Storage full','QuotaExceededError');};
 f.db.moneyReviews.hook('creating',change);
 try{await expect(prepareSavedMoneyReview(f.db,f.id,null,f.options)).rejects.toThrow();}finally{f.db.moneyReviews.hook('creating').unsubscribe(change);}
 expect(await f.db.moneyReviews.count()).toBe(0);expect(await f.db.cloudState.get('binding')).toEqual(binding);expect(await f.db.outbox.toArray()).toEqual(f.original);expect(f.calls()).toBe(0);
});
it('a newer native review blocks a superseded saved decision before resolve',async()=>{
 const f=await boot(),r=await prepareSavedMoneyReview(f.db,f.id,null,f.options);
 f.onRead(async()=>{const current=(await f.db.moneyReviews.get(f.id))!;await f.db.moneyReviews.put({...current,revision:current.revision+1,phase:'preparing'});});
 await expect(decideSavedMoneyReview(f.db,f.id,r.revision,withdraw,f.options)).rejects.toThrow('changed');expect(f.calls()).toBe(0);expect(await f.db.outbox.toArray()).toEqual(f.original);
});
it('rejects tokens or forged completed choices in the durable journal',async()=>{
 const f=await boot(),r=await prepareSavedMoneyReview(f.db,f.id,null,f.options);
 for(const patch of [{quote:{...r.quote,token:'x'.repeat(43)}},{phase:'confirmed'},{choice:{outcome:'withdrawn',confirmCredit:true}},{receipt:f.receiptFor(r.packet)}])expect(()=>parseLocalMoneyReview({...r,...patch})).toThrow();
 for(const value of [config.apiUrl,config.publishableKey,'original.account.signature','00000000-0000-4000-8000-000000000001'])expect(JSON.stringify(r)).not.toContain(value);
 expect(await hasSavedMoneyReview(f.db,f.original[0].uploadId)).toBe(true);
});
it('a real schema-23 upgrade preserves every original store and complete image while adding only an empty private review journal',async()=>{
 const f=await boot(),old=new Dexie('mise-money-review-v23-'+randomUUID()),tables=f.db.tables.filter(t=>t.name!=='moneyReviews'&&t.name!=='purchaseReviews'&&t.name!=='stockReviews'),saved=await Promise.all(tables.map(t=>t.toArray()));databases.push(old);
 old.version(23).stores(Object.fromEntries(tables.map(t=>[t.name,[t.schema.primKey.src,...t.schema.indexes.map(i=>i.src)].join(',')])));
 for(let i=0;i<tables.length;i++)await old.table(tables[i].name).bulkPut(saved[i]);old.close();
 const upgraded=new MiseDatabase(old.name);databases.push(upgraded);await upgraded.open();
 expect(upgraded.verno).toBe(26);expect(upgraded.tables).toHaveLength(40);expect(await upgraded.moneyReviews.count()).toBe(0);expect(await upgraded.purchaseReviews.count()).toBe(0);
 expect(await Promise.all(tables.map(t=>upgraded.table(t.name).toArray()))).toEqual(saved);expect(backupToken(await upgraded.readBackup())).toBe(f.backup);expect(Object.keys((await upgraded.readBackup()).tables)).toHaveLength(21);
});
async function activateOriginalOwner(f:Awaited<ReturnType<typeof boot>>){
 const setup=(await f.db.setup())!;
 return selectCloudOperator(f.db,{version:1,role:'owner',businessId:setup.business.id,outletId:setup.outlet.id,actorId:setup.owner.id,accountHash:f.options.account.accountHash,epoch:'00000000-0000-4000-8000-000000000001',scopeVersion:'00000000-0000-4000-8000-000000000002',businessName:setup.business.name,outletName:setup.outlet.name,actorName:setup.owner.name??null},{targetHash:f.options.account.targetHash,authKey:'mise.cloud.auth.'+'e'.repeat(64)},null,async value=>value);
}
async function acknowledgedFixture(){
 const f=await boot(),r=await prepareSavedMoneyReview(f.db,f.id,null,f.options);f.lose();
 await expect(decideSavedMoneyReview(f.db,f.id,r.revision,replacement,f.options)).rejects.toThrow();
 await activateOriginalOwner(f);
 const remote=createCloudCommandRemote(config,f.options.account,async()=>Response.json(f.done()));
 await deliverLocalOutbox(f.db,f.options.account.targetHash,remote);
 const record=(await f.db.moneyReviews.get(f.id))!;
 return {...f,record,accepted:await f.db.outbox.toArray(),operator:await f.db.operatorState.get('active')};
}
it('rechecks an outcome acknowledged by normal delivery after a fresh operator generation without reviving the old decision',async()=>{
 const f=await acknowledgedFixture(),view=await readMoneyReviewWorkspace(f.db,f.id);
 expect(view?.acknowledged).toBe(true);expect(view?.record?.phase).toBe('unconfirmed');
 await expect(decideSavedMoneyReview(f.db,f.id,f.record.revision,replacement,f.options)).rejects.toThrow('original');
 const actual=await prepareSavedMoneyReview(f.db,f.id,f.record.revision,f.options);
 expect(actual.phase).toBe('confirmed');expect(actual.receipt).toEqual(f.done());expect(actual.identityHash).toBe(f.record.identityHash);expect(actual.packet).toEqual(f.record.packet);expect(actual.attempts).toEqual(f.record.attempts);expect(f.calls()).toBe(1);
 expect(await f.db.outbox.toArray()).toEqual(f.accepted);expect(backupToken(await f.db.readBackup())).toBe(f.backup);expect((await readMoneyReviewWorkspace(f.db,f.id))?.record?.phase).toBe('confirmed');
});
it('a later generation cannot reuse an old pending choice before actual guarded acknowledgement',async()=>{
 const f=await boot(),r=await prepareSavedMoneyReview(f.db,f.id,null,f.options);
 await activateOriginalOwner(f);
 expect(await readMoneyReviewWorkspace(f.db,f.id)).toBeNull();
 await expect(prepareSavedMoneyReview(f.db,f.id,r.revision,f.options)).rejects.toThrow('original');expect(f.calls()).toBe(0);expect(await f.db.outbox.toArray()).toEqual(f.original);
});
it('a cached acknowledgement cannot invent a server-confirmed history or resubmit money when the actual outcome is unavailable',async()=>{
 const f=await acknowledgedFixture();f.setDone(null);
 await expect(prepareSavedMoneyReview(f.db,f.id,f.record.revision,f.options)).rejects.toThrow('actual acknowledged');
 expect(await f.db.moneyReviews.get(f.id)).toEqual(f.record);expect(await f.db.outbox.toArray()).toEqual(f.accepted);expect(f.calls()).toBe(1);
});
it('an acknowledged history cannot be adopted by a different restored phone account',async()=>{
 const f=await acknowledgedFixture(),operator=f.operator!;
 await f.db.operatorState.put({...operator,connection:{...operator.connection!,accountHash:'d'.repeat(64)}});
 expect(await readMoneyReviewWorkspace(f.db,f.id)).toBeNull();
 await expect(prepareSavedMoneyReview(f.db,f.id,f.record.revision,f.options)).rejects.toThrow('original');
 expect(await f.db.moneyReviews.get(f.id)).toEqual(f.record);expect(await f.db.outbox.toArray()).toEqual(f.accepted);expect(f.calls()).toBe(1);
});
it.each(['account','operator','source','quota'] as const)('acknowledged-history confirmation rolls back a native %s change while preserving the original receipt',async kind=>{
 const f=await acknowledgedFixture();
 const change=(changes:object)=>{if(!('phase'in changes)||changes.phase!=='confirmed')return;
  if(kind==='account')f.setAuth();else if(kind==='operator')void f.db.operatorState.put({...f.operator!,revision:f.operator!.revision+1});else if(kind==='source')void f.db.outbox.update(f.accepted[0].id,{at:f.accepted[0].at+1});else throw new DOMException('Storage full','QuotaExceededError');};
 f.db.moneyReviews.hook('updating',change);
 try{await expect(prepareSavedMoneyReview(f.db,f.id,f.record.revision,f.options)).rejects.toThrow();}finally{f.db.moneyReviews.hook('updating').unsubscribe(change);}
 expect(await f.db.moneyReviews.get(f.id)).toEqual(f.record);expect(await f.db.operatorState.get('active')).toEqual(f.operator);expect(await f.db.outbox.toArray()).toEqual(f.accepted);expect(f.calls()).toBe(1);
});
