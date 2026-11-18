import {authHttp,readAuthBody,AuthBodyError} from './auth-http.ts';
import {parseSyncReadRequest,parseSyncCursor,parseSyncScope,parseSyncWindow,parseSyncPage,syncReadHeader,syncReadBodyLimit,decodeSyncBase64,type SyncReadCursor,type SyncReadRequest} from '../../../packages/core/sync-read.ts';
import {sealSyncWire,syncBase64} from '../../../packages/core/sync-wire.ts';
import {parseSyncCoverageRequest,parseSyncCoveragePage,type SyncCoverageRequest} from '../../../packages/core/sync-coverage.ts';
export class SyncReadDenied extends Error {constructor(readonly status:401|403=403){super('This sync scope is unavailable.');}}
export class SyncReadConflict extends Error {}
export class SyncReadInvalid extends Error {}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const base64url=(bytes:Uint8Array)=>syncBase64(bytes).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
function unbase64url(value:string,maximum:number){if(!/^[A-Za-z0-9_-]+$/.test(value))throw new SyncReadInvalid();const bytes=decodeSyncBase64(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4),maximum);if(base64url(bytes)!==value)throw new SyncReadInvalid();return bytes;}
/** A dedicated server-only key signs progress. The cursor never grants data access. */
export function createSyncCursorCodec(secret:string){
 if(!/^[0-9a-f]{64}$/.test(secret))throw new Error('Sync cursor signing is unavailable.');
 const raw=Uint8Array.from(secret.match(/../g)!,v=>parseInt(v,16)),key=crypto.subtle.importKey('raw',raw,{name:'HMAC',hash:'SHA-256'},false,['sign','verify']),message=(payload:string)=>new TextEncoder().encode('mise-sync-cursor-v1\0'+payload);
 return {async sign(value:SyncReadCursor){const payload=base64url(new TextEncoder().encode(JSON.stringify(parseSyncCursor(value)))),signature=await crypto.subtle.sign('HMAC',await key,message(payload));return 'v1.'+payload+'.'+base64url(new Uint8Array(signature));},async verify(token:string):Promise<SyncReadCursor>{try{if(typeof token!=='string'||token.length>131072)throw new Error();const [version,payload,mac,...extra]=token.split('.');if(version!=='v1'||!payload||!mac||mac.length!==43||extra.length)throw new Error();const signature=unbase64url(mac,32);if(!await crypto.subtle.verify('HMAC',await key,new Uint8Array(signature).buffer,message(payload)))throw new Error();const bytes=unbase64url(payload,98304);return parseSyncCursor(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}catch{throw new SyncReadInvalid();}}};
}
export interface SyncReadStore {admit(jwt:string,outletId:string):Promise<void>;begin(jwt:string,request:Extract<SyncReadRequest,{type:'begin'}>,previous:SyncReadCursor|null):Promise<unknown>;page(jwt:string,request:Extract<SyncReadRequest,{type:'page'}>):Promise<unknown>;coverage?(jwt:string,request:SyncCoverageRequest):Promise<unknown>}
export function createSyncReadHandler(deps:{origins:ReadonlySet<string>;store:SyncReadStore;cursorKey:string}){
 const origins=new Set(deps.origins),codec=createSyncCursorCodec(deps.cursorKey);
 return async(request:Request):Promise<Response>=>{
  const {reply,blocked}=authHttp(request,origins,[syncReadHeader.toLowerCase()]);if(blocked)return blocked;
  const auth=request.headers.get('authorization')??'',jwt=auth.length<=8192?auth.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1]:undefined;
  if(!jwt)return reply(401,{error:'Verify your phone before reading this shop.'});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type')??''))return reply(415,{error:'Use JSON.'});
  const outlet=request.headers.get(syncReadHeader);if(!outlet||!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(outlet))return reply(400,{error:'Keep the selected outlet.'});
  try{await deps.store.admit(jwt,outlet);}catch(error){return reply(error instanceof SyncReadDenied?error.status:503,{error:'Sync is unavailable for this account.'});}
  let action:SyncReadRequest|SyncCoverageRequest;try{const raw=await readAuthBody(request,syncReadBodyLimit,20000);action=object(raw)&&raw.type==='coverage'?parseSyncCoverageRequest(raw):parseSyncReadRequest(raw);}catch(error){return reply(error instanceof AuthBodyError?error.status:400,{error:'Keep the complete sync request.'});}
  if(action.outletId!==outlet)return reply(400,{error:'Keep the admitted outlet.'});
  try{
   if(action.type==='coverage'){
    if(!deps.store.coverage)throw new Error('Coverage unavailable');const raw=await deps.store.coverage(jwt,action);if(!object(raw))throw new Error('Invalid coverage');
    const {snapshot,...body}=raw,scope=parseSyncScope(raw),cursor=await codec.sign(parseSyncCursor({...scope,v:1,snapshot}));
    const value=parseSyncCoveragePage({...body,cursor},{...scope,v:1,id:action.id,createdAt:0,expiresAt:8640000000000000},action.ids,cursor);if(value.outletId!==action.outletId)throw new SyncReadInvalid();return reply(200,await sealSyncWire(value));
   }
   if(action.type==='begin'){
    const previous=action.cursor===null?null:await codec.verify(action.cursor);if(previous&&previous.outletId!==action.outletId)throw new SyncReadInvalid();const raw=await deps.store.begin(jwt,action,previous);if(!object(raw))throw new Error('Invalid sync review');
    const {snapshot,...body}=raw;parseSyncCursor({...parseSyncScope(raw),v:1,snapshot});const value=parseSyncWindow(body,action);return reply(200,await sealSyncWire(value));
   }
   const raw=await deps.store.page(jwt,action);if(!object(raw))throw new Error('Invalid sync page');const {snapshot,...body}=raw,scope=parseSyncScope(raw),cursor=parseSyncCursor({...scope,v:1,snapshot}),value=parseSyncPage({...body,cursor:raw.done===true?await codec.sign(cursor):null},{...scope,v:1,id:action.id,createdAt:0,expiresAt:8640000000000000},action.index);
   if(value.outletId!==action.outletId)throw new Error('Invalid sync page scope');return reply(200,await sealSyncWire(value));
  }catch(error){return error instanceof SyncReadDenied?reply(error.status,{error:'This shop is unavailable for this account.'}):error instanceof SyncReadConflict?reply(409,{error:'Review the outlet again from its last accepted cursor. Keep local work.'}):error instanceof SyncReadInvalid?reply(400,{error:'Keep the original sync review, cursor and page order.'}):reply(503,{error:'Sync could not be confirmed. Keep local work and retry this page.'});}
 };
}
export function createSyncReadStore(apiUrl:string,publishableKey:string,send:typeof fetch=fetch):SyncReadStore {
 let root:URL;try{root=new URL(apiUrl);if(root.pathname!=='/'||root.username||root.password||root.search||root.hash||root.protocol!=='https:'&&!(root.protocol==='http:'&&['127.0.0.1','localhost'].includes(root.hostname))||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey))throw Error();}catch{throw new Error('Sync reads are not configured.');}
 async function rpc(name:string,args:Record<string,unknown>,jwt:string){const response=await send(new URL('rest/v1/rpc/'+name,root),{method:'POST',redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(20000),headers:{apikey:publishableKey,Authorization:'Bearer '+jwt,'Content-Type':'application/json'},body:JSON.stringify(args)});if([401,403].includes(response.status))throw new SyncReadDenied(response.status as 401|403);if(response.status===409)throw new SyncReadConflict();if(response.status===400)throw new SyncReadInvalid();if(!response.ok)throw new Error('Sync read unavailable');return response.json();}
 return {admit:async(jwt,outletId)=>{if(await rpc('admit_sync_read',{p_outlet_id:outletId},jwt)!==true)throw new SyncReadDenied();},begin:(jwt,request,previous)=>rpc('prepare_sync_read',{p_id:request.id,p_outlet_id:request.outletId,p_previous:previous},jwt),page:(jwt,request)=>rpc('read_sync_page',{p_id:request.id,p_outlet_id:request.outletId,p_index:request.index},jwt),coverage:(jwt,request)=>rpc('read_sync_coverage',{p_id:request.id,p_outlet_id:request.outletId,p_command_ids:request.ids},jwt)};
}
