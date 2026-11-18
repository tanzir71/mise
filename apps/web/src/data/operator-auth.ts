import {operatorAccountHash,parseLocalOperatorState,OperatorContextError} from '@mise/core/operators';
import {cloudConnectionStorageKey,type KeyStorage} from '@mise/core/cloud-connection';
import type {LocalStore} from './local-store';

const eventName='mise:operator-auth';
interface Notice {key:string;accountHash:string|null}
const current=new Map<string,Notice>();
/** Notifications only revoke cached selection; they never authorize an operator. */
export function publishOperatorAuth(key:string,accountHash:string|null){
 const notice={key,accountHash};current.set(key,notice);
 if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent(eventName,{detail:notice}));
}
export async function reconcileOperatorAuth(db:LocalStore,key:string,accountHash:string|null,stillCurrent=()=>true){
 await db.transaction('rw',db.operatorState,async()=>{
  if(!stillCurrent())return;const raw=await db.operatorState.get('active');if(!raw)return;const state=parseLocalOperatorState(raw);
  if(!state.connection||state.connection.authKey!==key||state.phase==='locked'||state.connection.accountHash===accountHash)return;
  if(state.revision===Number.MAX_SAFE_INTEGER)throw new OperatorContextError('Keep a backup before reviewing this operator.');
  await db.operatorState.put({...state,revision:state.revision+1,phase:'locked'});
 });
}
/** Saved session bytes are inspected only to detect removal/account changes.
 * They never activate a selection or stand in for fresh server authorization. */
export async function reviewStoredOperatorAuth(db:LocalStore,storage:KeyStorage){
 const raw=await db.operatorState.get('active');if(!raw)return;const state=parseLocalOperatorState(raw);if(!state.connection)return;
 const key=state.connection.authKey,known=current.get(key);if(known)return reconcileOperatorAuth(db,key,known.accountHash,()=>current.get(key)===known);
 let accountHash:string|null=null,saved:string|null=null;
 try{saved=storage.getItem(key);if(saved&&saved.length<=32768){const session=JSON.parse(saved);accountHash=await operatorAccountHash(session?.user?.id);}if(storage.getItem(key)!==saved)accountHash=null;}catch{/* Unreadable sessions cannot establish continuity. */accountHash=null;}
 // Recheck the session and in-memory notice after hashing, before changing IDB.
 const now=current.get(key);if(now)return reconcileOperatorAuth(db,key,now.accountHash,()=>current.get(key)===now);
 return reconcileOperatorAuth(db,key,accountHash);
}
export function watchOperatorAuth(db:LocalStore,storage:KeyStorage,onFailure:()=>void){
 let closed=false,configGeneration=0;const generations=new Map<string,number>();
 const run=(task:Promise<unknown>)=>{void task.catch(()=>{if(!closed)onFailure();});};
 const identity=(event:Event)=>{const notice=(event as CustomEvent<Notice>).detail;if(notice&&current.get(notice.key)===notice){generations.set(notice.key,(generations.get(notice.key)??0)+1);run(reconcileOperatorAuth(db,notice.key,notice.accountHash,()=>!closed&&current.get(notice.key)===notice));}};
 const changed=(event:StorageEvent)=>{
  if(event.key!==null&&event.key!==cloudConnectionStorageKey&&!event.key.startsWith('mise.cloud.auth.'))return;
  const sessionKey=event.key?.startsWith('mise.cloud.auth.')?event.key:null;
  if(sessionKey){current.delete(sessionKey);generations.set(sessionKey,(generations.get(sessionKey)??0)+1);}else{configGeneration++;current.clear();}
  const ticket=sessionKey?generations.get(sessionKey):null,configTicket=configGeneration,stillCurrent=()=>!closed&&configTicket===configGeneration&&(!sessionKey||generations.get(sessionKey)===ticket);
  run((async()=>{
   const raw=await db.operatorState.get('active');if(!raw||!stillCurrent())return;const state=parseLocalOperatorState(raw),connection=state.connection;if(!connection)return;
   if(event.key!==null&&event.key!==cloudConnectionStorageKey&&event.key!==connection.authKey)return;
   let accountHash:string|null=null;
   if(event.key===connection.authKey&&event.newValue!==null)try{if(event.newValue.length<=32768)accountHash=await operatorAccountHash(JSON.parse(event.newValue)?.user?.id);}catch{/* Damaged or changed identities require a new review. */}
   await reconcileOperatorAuth(db,connection.authKey,accountHash,stillCurrent);
  })());
 };
 if(typeof window!=='undefined'){window.addEventListener(eventName,identity);window.addEventListener('storage',changed);}
 return ()=>{closed=true;if(typeof window!=='undefined'){window.removeEventListener(eventName,identity);window.removeEventListener('storage',changed);}};
}
