import Dexie from 'dexie';
import {parseLocalClosingReview,closingReviewQuoteHash} from '@mise/core/closing-review-journal';
import {parseSyncActionReview} from '@mise/core/sync-action-review';
import {parseClosingResolutionReceipt,parseSavedClosingReceipt} from '@mise/core/closing-review';
import {parseClosingReviewSource} from '@mise/core/closing-review-source';
import {parseClosingCommand} from '@mise/core/closing-commands';
import {closingFingerprint} from '@mise/core/closing-replay';
import {syncHash} from '@mise/core/sync-read';
import {syncDownloadToken} from '@mise/core/sync-download';
import type {MiseDatabase} from './db';
import type {ClosingReviewWorkspace,ClosingReviewOptions} from './closing-review-session';
import {localReviewIdentity,parseLocalOutboxEntry} from './local-outbox';
import {nativeRowHash} from './canonical-writes';
import {prepareClosingReviewSource} from './closing-review-source';
import {createCloudClosingReviewRemote} from './cloud-closing-review-remote';
import {assertCommandReceipt} from './command-request';

const same=(a:unknown,b:unknown)=>syncDownloadToken(a)===syncDownloadToken(b);
const tables=(db:MiseDatabase)=>[db.cloudState,db.operatorState,db.outbox,db.syncActionReviews,db.closingReviews];

/** An old generation never authorizes another closing choice. This path is
 * available only AFTER normal, freshly guarded delivery acknowledged the exact
 * original source. It may display history and recheck that existing outcome. */
async function proof(db:MiseDatabase,id?:string){
 return db.transaction('r',tables(db),async()=>{
  const identity=await localReviewIdentity(db),binding=identity.binding,
   operator=await db.operatorState.get('active'),connection=operator?.connection;
  if(!connection)return null;
  const records=id?[await db.closingReviews.get(id)]:(await db.closingReviews.where('uploadId').equals(binding.uploadId).toArray()).sort((a,b)=>(b.attempts.at(-1)?.at??0)-(a.attempts.at(-1)?.at??0));
  for(const raw of records){
   if(!raw)continue;
   const record=parseLocalClosingReview(raw),observation=await db.syncActionReviews.get(record.id);
   if(!observation)throw Error('Keep the original acknowledged review evidence.');
   const review=parseSyncActionReview(observation);
   if(review.uploadId!==binding.uploadId||review.businessId!==binding.businessId||review.outletId!==binding.outletId||review.actorId!==binding.ownerId||review.targetHash!==binding.targetHash||review.accountHash!==connection.accountHash||review.targetHash!==connection.targetHash)continue;
   const saved=await db.outbox.get(record.entryId);if(!saved)throw Error('Keep the complete original acknowledged action.');
   const entry=parseLocalOutboxEntry(saved,binding),actual=entry.receipts[record.commandIndex];
   if(!actual)continue;
   const command=parseClosingCommand(entry.commands[record.commandIndex]),
    packet=await Dexie.waitFor(prepareClosingReviewSource({...entry,status:'pending',receipts:entry.receipts.slice(0,record.commandIndex)},record.commandIndex,record.packet.id,record.packet.replacementId)),
    receipt=actual.type==='command.resolved'?parseClosingResolutionReceipt(actual,packet):parseSavedClosingReceipt(actual,packet);
   if(record.id!==review.id||record.uploadId!==review.uploadId||record.entryId!==review.entryId||record.commandIndex!==review.commandIndex||record.identityHash!==review.identityHash||record.commandHash!==review.commandHash||
    review.commandId!==command.id||review.sequence!==entry.sequence||review.id!==await Dexie.waitFor(syncHash(new TextEncoder().encode(JSON.stringify([review.uploadId,command.id,review.identityHash]))))||
    record.commandHash!==await Dexie.waitFor(closingFingerprint(command))||packet.sourceHash!==review.sourceHash||!same(packet,record.packet)||
    review.receiptsHash!==await Dexie.waitFor(nativeRowHash(entry.receipts.slice(0,record.commandIndex)))||
    review.receiptHash!==null&&review.receiptHash!==await Dexie.waitFor(nativeRowHash(receipt))||
    receipt.type==='command.resolved'&&(receipt.sourceHash!==packet.sourceHash||receipt.commandHash!==record.commandHash)||
    record.receipt!==null&&!same(record.receipt,receipt)||
    record.quoteHash!==null&&record.quoteHash!==await Dexie.waitFor(closingReviewQuoteHash(record.quote!))||
    record.quote&&[record.quote.businessId,record.quote.outletId,record.quote.actorId].join(',')!==[review.businessId,review.outletId,review.actorId].join(','))throw Error('Keep the exact original review, source and acknowledged outcome.');
   const workspace:ClosingReviewWorkspace={source:{review,entry,command},record,original:parseClosingReviewSource(packet),acknowledged:true};
   return {workspace,identityHash:identity.identityHash,rowHash:await Dexie.waitFor(nativeRowHash(entry)),receipt};
  }
  return null;
 });
}
export async function readAcknowledgedClosingReview(db:MiseDatabase,id?:string):Promise<ClosingReviewWorkspace|null>{return (await proof(db,id))?.workspace??null;}

/** Confirm only an already acknowledged outcome, with fresh original-account
 * verification. Preserve the historical decision identity and every source byte;
 * a new operator revision cannot revive or resubmit the old deliberate choice. */
export async function confirmAcknowledgedClosingReview(db:MiseDatabase,id:string,revision:number|null,options:ClosingReviewOptions,signal?:AbortSignal){
 const authorization=await options.account.getAuth(),before=await proof(db,id),record=before?.workspace.record;
 if(!before||!record||record.revision!==revision)throw Error('Read the original acknowledged outcome again.');
 const review=before.workspace.source.review;
 if(options.account.targetHash!==review.targetHash||options.account.accountHash!==review.accountHash)throw Error('Verify the original phone account for this saved outcome.');
 const remote=createCloudClosingReviewRemote(options.config,options.account,{businessId:review.businessId,outletId:review.outletId,actorId:review.actorId},options.send),result=await remote.prepare(record.packet,signal);
 if(!result.done||!same(result.receipt,before.receipt))throw Error('Keep the actual acknowledged server outcome; do not submit another closing decision.');
 const receipt=result.receipt;
 return db.transaction('rw',tables(db),async()=>{
  const tx=Dexie.currentTransaction,current=await proof(db,id);
  if(!current||current.identityHash!==before.identityHash||current.rowHash!==before.rowHash||!same(current.workspace.record,record)||!same(current.receipt,receipt))throw Error('Keep the original account, source and acknowledged receipt.');
  const guard=()=>{
   signal?.throwIfAborted();const value:unknown=options.account.assertCurrent(authorization);
   if(value!==undefined){void Promise.resolve(value).catch(()=>{});throw Error('Keep a synchronous original-account check.');}
   assertCommandReceipt(receipt);
   if(!tx||Dexie.currentTransaction!==tx||!tx.active||tx.db!==db||tx.mode!=='readwrite')throw Error('Keep the acknowledged outcome transaction active.');
  };
  const next=parseLocalClosingReview({...record,revision:record.revision+1,phase:'confirmed',receipt});
  guard();await db.closingReviews.put(next);guard();
  const after=await proof(db,id);
  if(!after||after.identityHash!==before.identityHash||after.rowHash!==before.rowHash||!same(after.workspace.record,next))throw Error('Keep the original account, complete source and saved outcome.');
  guard();return next;
 });
}
