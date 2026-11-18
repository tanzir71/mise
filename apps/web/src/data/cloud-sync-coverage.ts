import {SyncCoverageError,parseSyncCoverageSource,parseSyncCoveragePage,syncCoverageIntents,syncCoverageHash,classifySyncCoverage,type SyncCoverageSource,type SyncCoveragePage,type LocalSyncCoverage} from '@mise/core/sync-coverage';
import {syncDownloadToken,type SyncDownloadTarget} from '@mise/core/sync-download';
import type {ShopCommand} from '@mise/core/shop-commands';
import {assertSyncDownloadContext,readVerifiedSyncRecords,type SyncDownloadContext} from './cloud-sync-journal';
import type {LocalStore} from './local-store';

export interface SyncCoverageRemote {get(source:SyncCoverageSource,signal?:AbortSignal):Promise<SyncCoveragePage>}
interface Plan {context:SyncDownloadContext;source:SyncCoverageSource;sourceHash:string;batchHash:string}
const abort=(signal?:AbortSignal)=>{if(signal?.aborted)throw new SyncCoverageError('retry');};
async function current(db:LocalStore,plan:Plan){const state=await assertSyncDownloadContext(db,plan.context);if(syncDownloadToken(state)!==syncDownloadToken(plan.context.state))throw new SyncCoverageError();}
function parseRow(value:unknown,plan:Plan):LocalSyncCoverage {
 const v=value as LocalSyncCoverage;if(!v||typeof v!=='object'||Object.keys(v).sort().join(',')!=='batchHash,readId,result,resultHash,source,sourceHash'||v.readId!==plan.source.readId||v.batchHash!==plan.batchHash||v.sourceHash!==plan.sourceHash||syncDownloadToken(parseSyncCoverageSource(v.source))!==syncDownloadToken(plan.source)||(v.result===null?v.resultHash!==null:typeof v.resultHash!=='string'||!/^[a-f0-9]{64}$/.test(v.resultHash)))throw new SyncCoverageError('integrity');return v;
}
async function prepare(db:LocalStore,id:string,target:SyncDownloadTarget,commands:readonly ShopCommand[],signal?:AbortSignal):Promise<Plan>{
 abort(signal);commands=structuredClone(commands);target=structuredClone(target);const {context}=await readVerifiedSyncRecords(db,id,target,signal),state=context.state;
 if(!state.seal||!state.window||!state.receivedCursor)throw new SyncCoverageError();const intents=await syncCoverageIntents(commands);
 if(commands.some(c=>c.outletId!==target.outletId))throw new SyncCoverageError();
 const source=parseSyncCoverageSource({version:1,readId:id,readSourceHash:state.sourceHash,readSeal:state.seal,target,window:state.window,cursor:state.receivedCursor,intents}),sourceHash=await syncCoverageHash(source),batchHash=await syncCoverageHash(intents.map(c=>c.id)),plan={context,source,sourceHash,batchHash};abort(signal);
 await db.transaction('rw',db.cloudState,db.syncReads,db.syncCoverage,async()=>{await current(db,plan);const saved=await db.syncCoverage.get([id,batchHash]);if(saved){parseRow(saved,plan);return;}await db.syncCoverage.add({readId:id,batchHash,source,sourceHash,result:null,resultHash:null});});return plan;
}
async function cached(db:LocalStore,plan:Plan){
 const row=await db.transaction('r',db.cloudState,db.syncReads,db.syncCoverage,async()=>{await current(db,plan);return parseRow(await db.syncCoverage.get([plan.source.readId,plan.batchHash]),plan);});
 if(row.result===null)return null;const page=parseSyncCoveragePage(row.result,plan.source.window,plan.source.intents.map(c=>c.id),plan.source.cursor);if(await syncCoverageHash(page)!==row.resultHash)throw new SyncCoverageError('integrity');return page;
}
/** Persist the original batch before networking; retain conflicts/unknowns without rewriting the queue. */
export async function downloadSyncCoverage(db:LocalStore,id:string,target:SyncDownloadTarget,commands:readonly ShopCommand[],remote:SyncCoverageRemote,signal?:AbortSignal){
 const plan=await prepare(db,id,target,commands,signal);let page=await cached(db,plan);
 if(!page){abort(signal);page=parseSyncCoveragePage(await remote.get(structuredClone(plan.source),signal),plan.source.window,plan.source.intents.map(c=>c.id),plan.source.cursor);const resultHash=await syncCoverageHash(page);abort(signal);
  await db.transaction('rw',db.cloudState,db.syncReads,db.syncCoverage,async()=>{await current(db,plan);const saved=parseRow(await db.syncCoverage.get([id,plan.batchHash]),plan);if(saved.result!==null){if(saved.resultHash!==resultHash||syncDownloadToken(saved.result)!==syncDownloadToken(page))throw new SyncCoverageError('integrity');return;}await db.syncCoverage.put({...saved,result:page,resultHash});});
 }
 abort(signal);await db.transaction('r',db.cloudState,db.syncReads,async()=>current(db,plan));return {readId:id,batchHash:plan.batchHash,readSeal:plan.source.readSeal,page,...classifySyncCoverage(plan.source.intents,page)};
}
/** Cached proof describes its original snapshot; it never grants current membership. */
export function readVerifiedSyncCoverage(db:LocalStore,id:string,target:SyncDownloadTarget,commands:readonly ShopCommand[],signal?:AbortSignal){return downloadSyncCoverage(db,id,target,commands,{get:async()=>{throw new SyncCoverageError('retry');}},signal);}
