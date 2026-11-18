import {parseShopCommand,type ShopCommand} from './shop-commands';
import {parseSyncScope,parseSyncWindow,syncHash,syncPageLimit,type SyncReadWindow,type SyncScope} from './sync-read';
import {parseSyncDownloadTarget,syncDownloadToken,type SyncDownloadTarget} from './sync-download';

export const syncCoverageLimit=128,localCoverageTableNames=['syncCoverage'] as const;
export interface SyncCoverageRequest {type:'coverage';id:string;outletId:string;ids:string[]}
export interface SyncCoverageFact {id:string;state:'absent'|'unknown'|'later'|'visible';type:string|null;requestHash:string|null}
export interface SyncCoveragePage extends SyncScope {v:1;id:string;ids:string[];coverage:SyncCoverageFact[];cursor:string}
export interface SyncCoverageIntent {id:string;type:ShopCommand['type'];requestHash:string}
export interface SyncCoverageSource {version:1;readId:string;readSourceHash:string;readSeal:string;target:SyncDownloadTarget;window:SyncReadWindow;cursor:string;intents:SyncCoverageIntent[]}
export interface LocalSyncCoverage {readId:string;batchHash:string;source:SyncCoverageSource;sourceHash:string;result:SyncCoveragePage|null;resultHash:string|null}
export class SyncCoverageError extends Error {constructor(readonly kind:'auth'|'review'|'retry'|'integrity'='review'){super({auth:'Verify the original phone account before checking command coverage.',review:'Keep the original commands and download. Review this outlet before applying changes.',retry:'Command coverage is unconfirmed. Keep local work and retry the original batch.',integrity:'The saved command coverage could not be verified. Keep its original recovery records.'}[kind]);}}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function parseSyncCoverageIds(v:unknown):string[]{if(!Array.isArray(v)||!v.length||v.length>syncCoverageLimit||!v.every(id)||new Set(v).size!==v.length)throw new SyncCoverageError();return [...v];}
export function parseSyncCoverageRequest(v:unknown):SyncCoverageRequest {if(!object(v)||!exact(v,'type,id,outletId,ids')||v.type!=='coverage'||!id(v.id)||!id(v.outletId))throw new SyncCoverageError();return {type:'coverage',id:v.id,outletId:v.outletId,ids:parseSyncCoverageIds(v.ids)};}
/** Matches the existing server preparation fingerprints, including literal JSON strings. */
export async function shopCommandFingerprint(value:ShopCommand):Promise<string>{return syncHash(new TextEncoder().encode(JSON.stringify(parseShopCommand(value))));}
export async function syncCoverageIntents(values:readonly ShopCommand[]):Promise<SyncCoverageIntent[]>{
 const commands=values.map(value=>parseShopCommand(structuredClone(value))).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);parseSyncCoverageIds(commands.map(c=>c.id));return Promise.all(commands.map(async c=>({id:c.id,type:c.type,requestHash:await shopCommandFingerprint(c)})));
}
export function parseSyncCoverageSource(v:unknown):SyncCoverageSource {
 try{
  if(!object(v)||!exact(v,'version,readId,readSourceHash,readSeal,target,window,cursor,intents')||v.version!==1||!id(v.readId)||!hash(v.readSourceHash)||!hash(v.readSeal)||typeof v.cursor!=='string'||!v.cursor||v.cursor.length>131072||!Array.isArray(v.intents))throw Error();
  const target=parseSyncDownloadTarget(v.target),window=parseSyncWindow(v.window,{type:'begin',id:v.readId,outletId:target.outletId,cursor:null});
  if(['businessId','outletId','actorId','accountHash','role'].some(k=>window[k as keyof SyncReadWindow]!==target[k as keyof SyncDownloadTarget]))throw Error();
  const intents=v.intents.map((c):SyncCoverageIntent=>{if(!object(c)||!exact(c,'id,type,requestHash')||!id(c.id)||!hash(c.requestHash)||typeof c.type!=='string'||!/^[A-Za-z][A-Za-z0-9.-]{1,79}$/.test(c.type))throw Error();return {id:c.id,type:c.type as ShopCommand['type'],requestHash:c.requestHash};});
  const ids=parseSyncCoverageIds(intents.map(c=>c.id));if(ids.some((value,n)=>n>0&&ids[n-1]>=value))throw Error();
  return {version:1,readId:v.readId,readSourceHash:v.readSourceHash,readSeal:v.readSeal,target,window,cursor:v.cursor,intents};
 }catch{throw new SyncCoverageError('integrity');}
}
export function syncCoverageHash(v:unknown){return syncHash(new TextEncoder().encode(syncDownloadToken(v)));}
export function parseSyncCoveragePage(v:unknown,window:SyncReadWindow,ids:readonly string[],cursor:string):SyncCoveragePage {
 try{
  const expected=parseSyncCoverageIds(ids);
  if(!object(v)||!exact(v,'v,id,businessId,outletId,actorId,accountHash,role,epoch,scopeVersion,ids,coverage,cursor')||v.v!==1||v.id!==window.id||v.cursor!==cursor||typeof cursor!=='string'||!cursor||cursor.length>131072||syncDownloadToken(parseSyncScope(v))!==syncDownloadToken(parseSyncScope(window))||syncDownloadToken(parseSyncCoverageIds(v.ids))!==syncDownloadToken(expected)||!Array.isArray(v.coverage)||v.coverage.length!==expected.length)throw Error();
  const coverage=v.coverage.map((f,index):SyncCoverageFact=>{
   if(!object(f)||!exact(f,'id,state,type,requestHash')||f.id!==expected[index]||!['absent','unknown','later','visible'].includes(f.state as string)||!(f.type===null||typeof f.type==='string'&&/^[A-Za-z][A-Za-z0-9.-]{1,79}$/.test(f.type))||!(f.requestHash===null||hash(f.requestHash)))throw Error();
   if(f.state==='absent'?(f.type!==null||f.requestHash!==null):f.type===null||(f.state!=='unknown'&&f.requestHash===null))throw Error();
   return {id:f.id,state:f.state as SyncCoverageFact['state'],type:f.type,requestHash:f.requestHash};
  });
  const page:SyncCoveragePage={...parseSyncScope(v),v:1,id:window.id,ids:expected,coverage,cursor};if(new TextEncoder().encode(JSON.stringify(page)).length>syncPageLimit)throw Error();return page;
 }catch{throw new SyncCoverageError('integrity');}
}
/** Only exact accepted intent hashes in the fixed snapshot remove an overlay. */
export function classifySyncCoverage(intents:readonly SyncCoverageIntent[],page:SyncCoveragePage){
 if(intents.length!==page.coverage.length)throw new SyncCoverageError('integrity');
 const visible:string[]=[],pending:string[]=[],unknown:string[]=[],conflicts:string[]=[];
 for(let n=0;n<intents.length;n++){const c=intents[n],f=page.coverage[n];if(!id(c.id)||!hash(c.requestHash)||c.id!==f.id)throw new SyncCoverageError('integrity');
  if(f.state==='absent')pending.push(c.id);else if(f.type!==c.type||f.requestHash!==null&&f.requestHash!==c.requestHash||f.state==='visible'&&f.requestHash===null)conflicts.push(c.id);else if(f.state==='visible')visible.push(c.id);else if(f.state==='unknown')unknown.push(c.id);else pending.push(c.id);
 }
 return {visible,pending,unknown,conflicts};
}
