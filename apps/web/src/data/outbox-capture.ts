import Dexie,{type Transaction} from 'dexie';
import type {DBCore,DBCoreMutateRequest,DBCoreTable,DBCoreTransaction} from 'dexie';
import {backupTableNames,type BackupTable} from '@mise/core/backup-tables';
import {localSyncTableNames,parseLocalCloudState,type LocalCloudState,type LocalOutboxEntry} from '@mise/core/local-outbox';
import {newInboxId} from '@mise/core/inbox';
import {parseShopCommand,type ShopCommand} from '@mise/core/shop-commands';
import {localOperatorTableNames} from '@mise/core/operators';
import {canonicalWritesFor,hasCanonicalWrites,nativeRowHash} from './canonical-writes';
import {syncDownloadToken} from '@mise/core/sync-download';
import {ReconciliationError} from '@mise/core/sync-materialize';

interface Capture {state:LocalCloudState;entry:LocalOutboxEntry;changes:Map<string,LocalOutboxEntry['changes'][number]>;persist:Promise<void>;inserted?:boolean}
const intents=new WeakMap<Transaction,readonly ShopCommand[]>();
/** Annotate the actual writes, never infer authority or a command from stored row changes. */
export async function withOutboxIntent<T>(db:Dexie,input:ShopCommand,write:()=>Promise<T>):Promise<T>{
 return withOutboxIntents(db,[input],write);
}
/** One atomic local group, with durable delivery progress for each original intent. */
export async function withOutboxIntents<T>(db:Dexie,inputs:readonly ShopCommand[],write:()=>Promise<T>):Promise<T>{
 const tx=Dexie.currentTransaction;if(!tx||tx.db!==db||tx.mode!=='readwrite')throw new Error('Queue the command in its local write transaction.');
 if(hasCanonicalWrites(tx))throw new ReconciliationError('integrity');
 const previous=intents.get(tx),commands=inputs.map(parseShopCommand);if(!commands.length||commands.length>1000||new Set(commands.map(command=>command.id)).size!==commands.length)throw new Error('Keep between one and 1,000 distinct original commands.');intents.set(tx,commands);
 try{return await write();}catch(error){try{tx.abort();}catch{/* A failed financial command stays atomic even if its caller catches it. */}throw error;}finally{if(previous)intents.set(tx,previous);else intents.delete(tx);}
}
function currentIntent():readonly ShopCommand[]|undefined {for(let tx:Transaction|undefined=Dexie.currentTransaction;tx;tx=tx.parent){const commands=intents.get(tx);if(commands)return commands;}return undefined;}
/** All writes, including the receiving worker and narrow/raw transactions, share this fence. */
export function installOutboxCapture(db:Dexie):void {
 // Below user hooks (2), above observability (0): internal writes still notify readers.
 db.use({stack:'dbcore',name:'mise-local-outbox',level:1,create(down:DBCore){
  const enabled=localSyncTableNames.every(name=>down.schema.tables.some(t=>t.name===name));
  if(!enabled)return down;
  const states=down.table('cloudState'),outbox=down.table('outbox'),contexts=new WeakMap<DBCoreTransaction,Promise<Capture|null>>();
  const keep=<T>(promise:Promise<T>)=>Dexie.Promise.resolve(promise);
  function context(trans:DBCoreTransaction):Promise<Capture|null>{
   let promise=contexts.get(trans);
   if(!promise){promise=keep(states.get({trans,key:'binding'})).then((value:unknown)=>{if(value===undefined)return null;const state=parseLocalCloudState(value);if(state.phase==='cancelled')return null;if(state.sequence===Number.MAX_SAFE_INTEGER)throw new Error('The local change queue is full. Keep a backup.');return {state,entry:{id:newInboxId(),version:1,uploadId:state.uploadId,businessId:state.businessId,outletId:state.outletId,sequence:state.sequence+1,at:Date.now(),status:'pending' as const,commands:[],receipts:[],changes:[]},changes:new Map(),persist:Dexie.Promise.resolve()};});contexts.set(trans,promise);}
   return promise;
  }
  function rows(table:DBCoreTable,request:DBCoreMutateRequest):Promise<{keys:string[];before:unknown[]}>{
   if(request.type==='deleteRange'){
    return keep(table.query({trans:request.trans,values:true,query:{index:table.schema.primaryKey,range:request.range}})).then(found=>({keys:found.result.map(value=>table.schema.primaryKey.extractKey!(value) as string),before:found.result}));
   }
   // Inbound primary-key requests can contain an empty keys array; use each row's id.
   const keys=(request.type==='delete'?request.keys:request.type==='put'&&request.updates?request.updates.keys:request.values.map((value,index)=>request.keys?.[index]??table.schema.primaryKey.extractKey!(value))) as string[];
   if(keys.some(key=>typeof key!=='string'))throw new Error('Use stable record identities while cloud setup is active.');
   return keep(table.getMany({trans:request.trans,keys})).then(before=>({keys,before}));
  }
  return {...down,transaction(stores,mode,options){
   let names=mode==='readwrite'&&stores.some(name=>(backupTableNames as readonly string[]).includes(name))?[...new Set([...stores,...localSyncTableNames])]:stores;
   if(stores.some(name=>['businesses','outlets','members'].includes(name)))names=[...new Set([...names,...localOperatorTableNames.filter(name=>down.schema.tables.some(t=>t.name===name))])];
   return down.transaction(names,mode,options);
  },table(name){
   const table=down.table(name);if(!(backupTableNames as readonly string[]).includes(name))return table;
   return {...table,mutate(request){
    const intent=currentIntent();
    const canonical=canonicalWritesFor(request.trans);
    if(canonical)return keep((async()=>{
     if(intent||request.type==='deleteRange'||syncDownloadToken(await states.get({trans:request.trans,key:'binding'}))!==canonical.bindingToken)throw new ReconciliationError('integrity');
     const source=await rows(table,request);if(new Set(source.keys).size!==source.keys.length)throw new ReconciliationError('integrity');
     for(let n=0;n<source.keys.length;n++){const expected=canonical.writes.get(name+'\0'+source.keys[n]),step=expected?.steps[expected.used];if(!expected||!step||await Dexie.waitFor(nativeRowHash(source.before[n]??null))!==step.before)throw new ReconciliationError('integrity');}
     const response=await table.mutate(request);if(response.numFailures)throw new ReconciliationError('integrity');const after=await table.getMany({trans:request.trans,keys:source.keys});
     for(let n=0;n<source.keys.length;n++){const expected=canonical.writes.get(name+'\0'+source.keys[n])!,step=expected.steps[expected.used];if(!step||await Dexie.waitFor(nativeRowHash(after[n]??null))!==step.after)throw new ReconciliationError('integrity');expected.used++;}
     return response;
    })()).catch(error=>{try{request.trans.abort();}catch{/* Keep every reconciliation write atomic. */}throw error;});
    // DBCore callbacks must retain Dexie's transaction zone across every continuation.
    return keep(context(request.trans)).then(capture=>{
     if(!capture)return table.mutate(request);
     return keep(rows(table,request)).then(source=>keep(table.mutate(request)).then(response=>keep(table.getMany({trans:request.trans,keys:source.keys})).then(after=>{
     let changed=false;
     for(let index=0;index<source.keys.length;index++){
      if(request.type!=='deleteRange'&&response.failures[index])continue;
      const key=source.keys[index];if(source.before[index]===undefined&&after[index]===undefined)continue;
      changed=true;
      const identity=name+'\0'+key,previous=capture.changes.get(identity);
      capture.changes.set(identity,{table:name as BackupTable,key,before:previous?previous.before:structuredClone(source.before[index]??null),after:structuredClone(after[index]??null)});
     }
     if(changed){
      if(!intent)capture.entry.status='retained';
      else for(const command of intent){const saved=capture.entry.commands.find(c=>c.id===command.id);if(saved&&JSON.stringify(saved)!==JSON.stringify(command))throw new Error('A queued action identity changed.');if('outletId'in command&&command.outletId!==capture.state.outletId)throw new Error('This queued action belongs to another outlet.');if(!saved)capture.entry.commands.push(command);}
      capture.entry.changes=[...capture.changes.values()];
      const pending=keep(capture.persist).then(()=>keep(outbox.mutate({type:capture.inserted?'put':'add',trans:request.trans,values:[structuredClone(capture.entry)]})).then(saved=>{
       if(saved.numFailures)throw new Error('The local change could not be queued.');
       capture.inserted=true;
       return keep(states.mutate({type:'put',trans:request.trans,values:[{...capture.state,sequence:capture.entry.sequence}]})).then(updated=>{if(updated.numFailures)throw new Error('The local change fence could not be saved.');});
      }));capture.persist=pending;return pending.then(()=>response);
     }
     return response;
     })));
    }).catch(error=>{try{request.trans.abort();}catch{/* Preserve the original failure after an automatic abort. */}throw error;});
   }};
  }};
 }});
}
