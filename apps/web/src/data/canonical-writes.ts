import Dexie,{type Transaction} from 'dexie';
import type {DBCoreTransaction} from 'dexie';
import {materializationHash,ReconciliationError} from '@mise/core/sync-materialize';
import {syncDownloadToken} from '@mise/core/sync-download';
import type {LocalRowChange} from '@mise/core/local-outbox';

interface ExpectedWrite {steps:{before:string;after:string}[];used:number}
export interface CanonicalWritePlan {readonly writes:ReadonlyMap<string,ExpectedWrite>;readonly bindingToken:string}
const issued=new WeakSet<CanonicalWritePlan>(),active=new WeakMap<DBCoreTransaction,CanonicalWritePlan>();
async function comparable(value:unknown):Promise<unknown>{
 if(value instanceof Blob)return {type:'original-blob',mime:value.type,size:value.size,sha256:await crypto.subtle.digest('SHA-256',await value.arrayBuffer()).then(hash=>Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join(''))};
 if(Array.isArray(value))return Promise.all(value.map(v=>v===undefined?null:comparable(v)));
 if(value!==null&&typeof value==='object'){if(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)throw new ReconciliationError('integrity');return Object.fromEntries(await Promise.all(Object.entries(value).filter(([,v])=>v!==undefined).map(async([k,v])=>[k,await comparable(v)])));}
 if(value===undefined||typeof value==='function'||typeof value==='symbol'||typeof value==='bigint'||typeof value==='number'&&!Number.isFinite(value))throw new ReconciliationError('integrity');return value;
}
export async function nativeRowHash(value:unknown):Promise<string>{return materializationHash(await comparable(value));}
/** This issues a finite, exact write set, never an unrestricted capture bypass. */
export async function prepareCanonicalWrites(changes:readonly LocalRowChange[],binding:unknown):Promise<CanonicalWritePlan>{
 const writes=new Map<string,ExpectedWrite>();for(const change of changes){const key=change.table+'\0'+change.key,before=await nativeRowHash(change.before),after=await nativeRowHash(change.after),previous=writes.get(key);if(previous){if(previous.steps.at(-1)!.after!==before)throw new ReconciliationError('integrity');previous.steps.push({before,after});}else writes.set(key,{steps:[{before,after}],used:0});}
 const plan={writes,bindingToken:syncDownloadToken(binding)};issued.add(plan);return plan;
}
function native(tx:Transaction):DBCoreTransaction {return tx.idbtrans as DBCoreTransaction;}
export function canonicalWritesFor(transaction:DBCoreTransaction):CanonicalWritePlan|undefined{return active.get(transaction);}
export function hasCanonicalWrites(tx:Transaction):boolean{return active.has(native(tx));}
export async function withCanonicalWrites<T>(db:Dexie,plan:CanonicalWritePlan,write:()=>Promise<T>):Promise<T>{
 const tx=Dexie.currentTransaction;if(!tx||tx.db!==db||tx.mode!=='readwrite'||!issued.has(plan)||active.has(native(tx))||[...plan.writes.values()].some(p=>p.used))throw new ReconciliationError('integrity');
 active.set(native(tx),plan);issued.delete(plan);
 try{const result=await write();if([...plan.writes.values()].some(p=>p.used!==p.steps.length))throw new ReconciliationError('integrity');return result;}catch(error){try{tx.abort();}catch{/* Preserve the original failure. */}throw error;}finally{active.delete(native(tx));}
}
