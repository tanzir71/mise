import {newInboxId} from '@mise/core/inbox';
import {deviceSecretHash} from '@mise/core/device-access';
import {cloudConnectionStorageKey} from '@mise/core/cloud-connection';
import {parseScreenJournalRecord,parseScreenState,type ScreenJournalRecord,type ScreenState} from '@mise/core/device-screen-state';

export class ScreenStorageError extends Error {
 constructor(readonly kind:'changed'|'unavailable'|'owner'|'damaged'){
  super(kind==='changed'?'This screen changed in another tab. Open its current setup.':kind==='owner'?'Use a separate blank browser profile for a shared screen. Keep the shop and its sign-in in this profile.':kind==='damaged'?'This screen’s saved setup could not be verified. Keep it and ask the owner to revoke this screen.':'This browser could not save the screen setup. Keep this page open and try again.');
 }
}
export function screenJournalDatabaseName(base:string):string{
 if(typeof base!=='string'||!base.startsWith('/')||!base.endsWith('/')||/[?#\u0000-\u0020\\]/.test(base)||base.includes('..')||base.length>2048)throw new ScreenStorageError('unavailable');
 return 'mise.screen.v1:'+base;
}
function openDatabase(factory:IDBFactory,name:string):Promise<IDBDatabase>{
 return new Promise((resolve,reject)=>{
  let settled=false;const timer=setTimeout(()=>fail(),5000);
  const fail=()=>{if(settled)return;settled=true;clearTimeout(timer);reject(new ScreenStorageError('unavailable'));};
  try{
   const request=factory.open(name,1);
   request.onblocked=fail;request.onerror=fail;
   request.onupgradeneeded=()=>{if(settled){request.transaction?.abort();return;}request.result.createObjectStore('state',{keyPath:'id'});};
   request.onsuccess=()=>{if(settled){request.result.close();return;}settled=true;clearTimeout(timer);resolve(request.result);};
  }catch{fail();}
 });
}
export async function openScreenJournal(base:string,factory:IDBFactory=indexedDB){
 const database=await openDatabase(factory,screenJournalDatabaseName(base));let closed=false;
 database.onversionchange=()=>{closed=true;database.close();};
 function transaction(expected:ScreenJournalRecord|null,next?:ScreenState,guard?:()=>void,signal?:AbortSignal):Promise<ScreenJournalRecord>{
  return new Promise((resolve,reject)=>{
   if(signal?.aborted){reject(new ScreenStorageError('changed'));return;}
   let tx:IDBTransaction;try{if(closed)throw Error();tx=database.transaction('state','readwrite');}catch{reject(new ScreenStorageError('unavailable'));return;}
   let result:ScreenJournalRecord|undefined,failure:ScreenStorageError|undefined;
   const timer=setTimeout(()=>{failure=new ScreenStorageError('unavailable');try{tx.abort();}catch{reject(failure);}},10000);
   const abort=()=>{failure=new ScreenStorageError('changed');try{tx.abort();}catch{reject(failure);}};
   const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
   function assertWriter(){try{if(signal?.aborted)throw Error();const value:unknown=guard?.();if(value!==undefined){void Promise.resolve(value).catch(()=>{});throw Error();}}catch{throw new ScreenStorageError('changed');}}
   signal?.addEventListener('abort',abort,{once:true});
   tx.oncomplete=()=>{cleanup();try{assertWriter();if(result)resolve(result);else reject(failure??new ScreenStorageError('unavailable'));}catch(error){reject(error);}};
   tx.onabort=()=>{cleanup();reject(failure??new ScreenStorageError('unavailable'));};
   tx.onerror=()=>{failure??=new ScreenStorageError('unavailable');};
   const store=tx.objectStore('state'),request=store.get('current');
   request.onsuccess=()=>{
    try{
     let current:ScreenJournalRecord;
     try{current=request.result===undefined?{v:1,id:'current',revision:newInboxId(),state:{phase:'empty'}}:parseScreenJournalRecord(request.result);}catch{throw new ScreenStorageError('damaged');}
     if(expected&&JSON.stringify(current)!==JSON.stringify(expected))throw new ScreenStorageError('changed');
     // The route/generation is checked inside the native transaction, after
     // its source read and immediately before the actual write.
     assertWriter();
     if(next!==undefined){current={v:1,id:'current',revision:newInboxId(),state:next};store.put(current);}
     else if(request.result===undefined)store.add(current);
     result=current;
    }catch(error){failure=error instanceof ScreenStorageError?error:new ScreenStorageError('unavailable');tx.abort();}
   };
  });
 }
 async function verified(value:ScreenJournalRecord):Promise<ScreenJournalRecord>{
  if(value.state.phase==='pairing'&&await deviceSecretHash(value.state.source.token)!==value.state.source.tokenHash)throw new ScreenStorageError('damaged');
  return value;
 }
 return {
  name:database.name,
  async read(){return verified(await transaction(null));},
  async assertCurrent(expected:ScreenJournalRecord){
   const original=parseScreenJournalRecord(expected);await verified(await transaction(original));
  },
  async replace(expected:ScreenJournalRecord,next:ScreenState,options:{assertCurrent?:()=>void;signal?:AbortSignal}={}){
   // Copy both sides before the first await. Complete-source equality catches
   // corruption even when a stale tab still has the original revision string.
   const original=parseScreenJournalRecord(expected),replacement=parseScreenState(next),guard=options.assertCurrent,signal=options.signal;
   await verified({v:1,id:'current',revision:original.revision,state:replacement});
   const saved=await verified(await transaction(original,replacement,guard,signal));
   // Notify sibling owner/screen routes using no credential or source fields.
   if(typeof window!=='undefined')try{window.dispatchEvent(new Event('mise-screen-profile'));if(typeof BroadcastChannel==='function'){const channel=new BroadcastChannel('mise.screen.profile:'+base);channel.postMessage({changed:true});channel.close();}}catch{/* The native commit is authoritative even when notifications are unavailable. */}
   return saved;
  },
  close(){closed=true;database.close();},
 };
}
export type ScreenJournal=Awaited<ReturnType<typeof openScreenJournal>>;

/** Inspect existing owner stores without importing/creating the owner DB or
 * deleting any record. Fail closed if this browser cannot establish separation.
 * The screen route also checks this before every request and response commit. */
export async function assertBlankScreenProfile(storage:Pick<Storage,'length'|'key'|'getItem'>=localStorage,factory:IDBFactory=indexedDB):Promise<void>{
 try{
  for(let i=0;i<storage.length;i++){
   const key=storage.key(i);if(key&&(key===cloudConnectionStorageKey||key.startsWith('mise.cloud.auth.'))&&storage.getItem(key))throw new ScreenStorageError('owner');
  }
  if(typeof factory.databases!=='function')throw new ScreenStorageError('unavailable');
  // Production names include the app base (for example mise-local:/mise/app/).
  // Check other Mise bases too: a shared browser profile must not retain an
  // owner's records under a sibling deployment's name.
  const owners=(await factory.databases()).filter(d=>typeof d.name==='string'&&/^mise-(?:local|cloud-uploads)(?::|$)/.test(d.name));
  for(const entry of owners)await new Promise<void>((resolve,reject)=>{
   let db:IDBDatabase|undefined,done=false;
   const finish=(error?:ScreenStorageError)=>{if(done)return;done=true;clearTimeout(timer);db?.close();if(error)reject(error);else resolve();};
   const timer=setTimeout(()=>finish(new ScreenStorageError('unavailable')),5000),request=factory.open(entry.name!);
   request.onerror=()=>finish(new ScreenStorageError('unavailable'));request.onblocked=()=>finish(new ScreenStorageError('unavailable'));
   request.onupgradeneeded=()=>{request.transaction?.abort();finish(new ScreenStorageError('unavailable'));};
   request.onsuccess=()=>{
    db=request.result;if(done){db.close();return;}db.onversionchange=()=>finish(new ScreenStorageError('unavailable'));
    const names=Array.from(db.objectStoreNames);if(!names.length){finish();return;}
    try{
     const tx=db.transaction(names,'readonly');let present=false;
     tx.onabort=()=>finish(new ScreenStorageError('unavailable'));tx.onerror=()=>finish(new ScreenStorageError('unavailable'));
     for(const name of names){const count=tx.objectStore(name).count();count.onsuccess=()=>{if(count.result>0)present=true;};}
     tx.oncomplete=()=>finish(present?new ScreenStorageError('owner'):undefined);
    }catch{finish(new ScreenStorageError('unavailable'));}
   };
  });
 }catch(error){if(error instanceof ScreenStorageError)throw error;throw new ScreenStorageError('unavailable');}
}
