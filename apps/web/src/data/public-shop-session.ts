import type {CloudConnection,KeyStorage} from '@mise/core/cloud-connection';
import {publicOrderHash} from '@mise/core/public-order-submission';
import {publicOrderingUrl,publicOrderShopSource} from '@mise/core/public-order-link';
import {publicShopId,parsePublicShopSource,parsePublicShopMetadata,parsePublicShopPage,type PublicShopSource,type PublicShopScope,type PublicShopMetadata} from '@mise/core/public-shop-admin';
import {newInboxId} from '@mise/core/inbox';
import {publicRecord} from '@mise/core/public-shop';
import {assertLiveCommandReceipt,bindCommandReceipt,CommandRequestError,createPublicShopRequest,type CommandAccount,type PublicShopRpc} from './command-request';
interface Publication {source:PublicShopSource;metadata:PublicShopMetadata|null}
interface Revocation {id:string;eventId:string;metadata:PublicShopMetadata|null}
interface Journal {v:1;publications:Publication[];revocations:Revocation[]}
const bad=()=>new CommandRequestError('review');
const exact=(v:unknown,keys:string)=>{const r=publicRecord(v,keys.split(','));if(Object.keys(r).sort().join(',')!==keys.split(',').sort().join(','))throw bad();return r;};
export function createPublicShopSession(config:CloudConnection,account:CommandAccount,scope:PublicShopScope,deps:{storage:KeyStorage;locks?:Pick<LockManager,'request'>;assertScope:()=>Promise<void>;send?:typeof fetch}){
 const key=['mise.publications.v1',account.targetHash,account.accountHash,scope.businessId,scope.outletId,scope.actorId].join(':'),requests=new Map<PublicShopRpc,ReturnType<typeof createPublicShopRequest>>();let active=true,shareable:{source:PublicShopSource;metadata:PublicShopMetadata}|null=null;
 const current=async()=>{if(!active)throw bad();await deps.assertScope();if(!active)throw bad();};
 async function call<T extends object>(rpc:PublicShopRpc,body:Record<string,unknown>,parse:(v:unknown)=>T,signal?:AbortSignal){
  await current();let request=requests.get(rpc);if(!request){request=createPublicShopRequest(config,account,rpc,deps.send??fetch);requests.set(rpc,request);}
  const result=await request(JSON.stringify(body),{'Content-Type':'application/json'},30000,signal);result.guard();let value:T;try{value=parse(result.value);}catch{throw bad();}await current();result.guard();return bindCommandReceipt(value,result.guard);
 }
 function saved():Journal{
  try{const raw=deps.storage.getItem(key);if(raw===null)return {v:1,publications:[],revocations:[]};if(raw.length>2000000)throw bad();const r=exact(JSON.parse(raw),'v,publications,revocations');
   if(r.v!==1||!Array.isArray(r.publications)||r.publications.length>100||!Array.isArray(r.revocations)||r.revocations.length>200)throw bad();
   const publications=r.publications.map(value=>{const p=exact(value,'source,metadata'),source=parsePublicShopSource(p.source),metadata=p.metadata===null?null:parsePublicShopMetadata(p.metadata);
    if(metadata&&(metadata.id!==source.id||metadata.createEventId!==null&&metadata.createEventId!==source.eventId))throw bad();return {source,metadata};});
   const revocations=r.revocations.map(value=>{const p=exact(value,'id,eventId,metadata');if(!publicShopId(p.id)||!publicShopId(p.eventId)||p.id===p.eventId)throw bad();const metadata=p.metadata===null?null:parsePublicShopMetadata(p.metadata);if(metadata&&(metadata.id!==p.id||metadata.revokedAt===null))throw bad();return {id:p.id,eventId:p.eventId,metadata};});
   if(new Set(publications.map(p=>p.source.id)).size!==publications.length||new Set(revocations.map(p=>p.eventId)).size!==revocations.length)throw bad();
   return {v:1,publications,revocations};
  }catch{throw bad();}
 }
 async function persist(previous:Journal,next:Journal,proof:object){assertLiveCommandReceipt(proof);await current();assertLiveCommandReceipt(proof);const raw=JSON.stringify(next);if(raw.length>2000000||JSON.stringify(saved())!==JSON.stringify(previous))throw bad();try{deps.storage.setItem(key,raw);if(deps.storage.getItem(key)!==raw)throw bad();}catch{throw bad();}assertLiveCommandReceipt(proof);}
 function page(after:string|null=null,limit=50,signal?:AbortSignal){if(after!==null&&!publicShopId(after)||!Number.isInteger(limit)||limit<1||limit>100)throw bad();return call('read_public_shop_page',{p_outlet_id:scope.outletId,p_after_id:after,p_page_size:limit},v=>parsePublicShopPage(v,scope,after,limit),signal);}
 const exclusive=<T>(run:()=>Promise<T>)=>{const locks=deps.locks??globalThis.navigator?.locks;if(!locks)throw bad();return locks.request(key,{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock)throw new CommandRequestError('retry');await current();return run();});};
 async function publish(source:PublicShopSource,signal?:AbortSignal){
  if(saved().revocations.some(r=>r.id===source.id))throw bad();shareable=null;
  const result=await call('publish_public_shop',{p_id:source.id,p_event_id:source.eventId,p_outlet_id:scope.outletId,p_source_url:source.sourceUrl,p_payload_json:JSON.stringify(publicOrderShopSource(source.sourceUrl).shop),p_secret_hash:await publicOrderHash(source.shopToken),p_table:source.table,p_expiry:source.expiresAt},v=>{const m=parsePublicShopMetadata(v);if(m.id!==source.id||m.createEventId!==source.eventId||m.expiresAt!==source.expiresAt||m.table!==source.table)throw bad();return m;},signal);
  const previous=saved(),next=structuredClone(previous),publication=next.publications.find(p=>p.source.id===source.id);if(!publication||JSON.stringify(publication.source)!==JSON.stringify(source))throw bad();publication.metadata=result;await persist(previous,next,result);assertLiveCommandReceipt(result);shareable={source,metadata:result};return result;
 }
 return {key,saved,page,
  begin(input:{sourceUrl:string;table:string|null;expiresAt:number|null},signal?:AbortSignal){return exclusive(async()=>{const authority=await page(null,1,signal),previous=saved();if(previous.publications.some(p=>p.metadata===null)||previous.revocations.some(p=>p.metadata===null)||previous.publications.length>=100)throw bad();
   const bytes=crypto.getRandomValues(new Uint8Array(32)),shopToken=btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''),source=parsePublicShopSource({id:newInboxId(),eventId:newInboxId(),...input,shopToken});
   await persist(previous,{...previous,publications:[...previous.publications,{source,metadata:null}]},authority);return {source,metadata:await publish(source,signal)};});},
  resume(id:string,signal?:AbortSignal){return exclusive(async()=>{const source=saved().publications.find(p=>p.source.id===id)?.source;if(!source)throw bad();return {source,metadata:await publish(source,signal)};});},
  revoke(id:string,signal?:AbortSignal){shareable=null;return exclusive(async()=>{if(!publicShopId(id))throw bad();let previous=saved(),pending=previous.revocations.find(p=>p.id===id&&p.metadata===null);if(!pending){const authority=await page(null,1,signal);if(previous.revocations.length>=200)throw bad();pending={id,eventId:newInboxId(),metadata:null};const next={...previous,revocations:[...previous.revocations,pending]};await persist(previous,next,authority);previous=next;}
   const captured=pending,result=await call('revoke_public_shop',{p_id:id,p_event_id:captured.eventId,p_outlet_id:scope.outletId},v=>{const m=parsePublicShopMetadata(v);if(m.id!==id||m.revokedAt===null)throw bad();return m;},signal),fresh=saved();if(JSON.stringify(fresh)!==JSON.stringify(previous))throw bad();const next=structuredClone(fresh);next.revocations.find(p=>p.eventId===captured.eventId)!.metadata=result;for(const p of next.publications)if(p.source.id===id)p.metadata=result;await persist(fresh,next,result);return result;});},
  url(source:PublicShopSource){if(!active||!shareable||JSON.stringify(source)!==JSON.stringify(shareable.source)||shareable.metadata.revokedAt!==null||shareable.metadata.expiresAt!==null&&shareable.metadata.expiresAt<=Date.now()||saved().revocations.some(r=>r.id===source.id)||JSON.stringify(saved().publications.find(p=>p.source.id===source.id)?.source)!==JSON.stringify(source))throw bad();assertLiveCommandReceipt(shareable.metadata);return publicOrderingUrl({v:1,sourceUrl:source.sourceUrl,shopToken:source.shopToken,table:source.table,apiUrl:config.apiUrl});},stop(){active=false;shareable=null;},
 };
}
export type PublicShopSession=ReturnType<typeof createPublicShopSession>;
