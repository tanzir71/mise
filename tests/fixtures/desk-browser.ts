import {DeskCache,deskProfileScope,type DeskBinding,type DeskSnapshot} from '../../apps/web/src/data/desk-cache';
import {deskRegistrationFingerprint,deskRegistrationPayload} from '../../apps/web/src/data/desk-operation';
import {createDeskRemote} from '../../apps/web/src/data/desk-remote';
import {cloudAuthStorageKey,cloudConnectionTarget} from '../../packages/core/cloud-connection';
import {operatorAccountHash} from '../../packages/core/operators';
import type {CommandAuthorization} from '../../apps/web/src/data/command-request';
import {deskId as id,deskPage} from '../desk-task-fixture';

const base='/mise/app/',config={apiUrl:'https://cloud.test',publishableKey:'sb_publishable_test_only'},scope='/fixture/desk',userId='00000000-0000-4000-8000-000000000001',opened=new Set<DeskCache>();
type BrowserSource={applicationKey:string;subscription:{endpoint:string;expirationTime:null;keys:{p256dh:string;auth:string}}};
const metadata=(subscriptionId:string)=>({v:1,id:subscriptionId,businessId:id(1),outletId:id(2),memberId:id(3),createdAt:1000,expiresAt:null,revokedAt:null});
const encode=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
async function browserSource():Promise<BrowserSource>{
 const key=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']),point=encode(new Uint8Array(await crypto.subtle.exportKey('raw',key.publicKey)));
 return {applicationKey:point,subscription:{endpoint:'https://fcm.googleapis.com/fcm/send/browser-fixture-only',expirationTime:null,keys:{p256dh:point,auth:encode(crypto.getRandomValues(new Uint8Array(16)))}}};
}
async function open(){
 let generation=1,registers=0,withdrawals=0;const accountHash=await operatorAccountHash(userId),targetHash=await cloudConnectionTarget(config,scope,userId),authKey=await cloudAuthStorageKey(config,scope);
 const binding:DeskBinding={id:'active',version:1,revision:1,phase:'active',businessId:id(1),outletId:id(2),actorId:id(3),role:'owner',connection:{accountHash,targetHash,authKey,epoch:'00000000-0000-4000-8000-000000000009',scopeVersion:'00000000-0000-4000-8000-000000000010'}};
 const guard=()=>{if(generation!==1)throw Error('Original browser phone changed');},account={scope,accountHash,targetHash,getAuth:async()=>({jwt:'original.phone.signature',userId,generation}),assertCurrent:(value:CommandAuthorization)=>{guard();if(value.generation!==1||value.userId!==userId)throw Error('Original browser phone changed');}};
 const send:typeof fetch=async(url,init)=>{
  const input=JSON.parse(String(init?.body));if(String(url).endsWith('/read_kitchen_alarm_task_page'))return Response.json(deskPage([1,2]));
  if(input.action==='register'){registers++;return Response.json(metadata(input.id));}
  if(input.action==='revoke'){withdrawals++;return Response.json(null);}
  throw Error('Unexpected browser fixture request');
 };
 const cache=new DeskCache(base);opened.add(cache);const remote=createDeskRemote(config,account,deskProfileScope(binding),send);
 const current=async()=>{const saved=await cache.read(binding);if(!saved)throw Error('Missing browser desk');return saved;};
 return {cache,binding,account,guard,send,remote,current,expire:()=>{generation++;},counts:()=>({registers,withdrawals}),close:()=>{cache.close();opened.delete(cache);}};
}
async function prepare(){
 const f=await open();try{
  const saved=await f.cache.activate(await f.cache.pointer(),f.binding,await f.remote.tasks(),f.guard),source=await browserSource(),operation=await f.cache.queueOperation(saved,{eventId:id(6),request:{kind:'register',subscriptionId:id(5),...await deskRegistrationFingerprint(source)}},f.guard);
  const stored=JSON.stringify(await f.cache.operations.toArray());return {source,id:operation.id,profileId:saved.profile.id,counts:f.counts(),privateValuesCopied:[source.applicationKey,source.subscription.endpoint,source.subscription.keys.auth,source.subscription.keys.p256dh,'original.phone.signature'].some(value=>stored.includes(value))};
 }finally{f.close();}
}
async function inspect(){
 const f=await open();try{const saved=await f.current(),history=await f.cache.operationHistory(f.binding),pending=await f.cache.pendingOperations(f.binding);return {snapshot:saved,events:history.map(row=>({id:row.id,kind:row.request.kind,confirmed:row.receipt!==null})),pending:pending.map(row=>({id:row.id,kind:row.request.kind})),version:f.cache.verno};}finally{f.close();}
}
async function confirm(source:BrowserSource){
 const f=await open();try{const [operation]=await f.cache.pendingOperations(f.binding);if(!operation||operation.request.kind!=='register')throw Error('Missing original browser registration');
  const payload=await deskRegistrationPayload(operation,source),proof=await f.remote.register(payload);await f.cache.confirmOperation(operation,proof,f.guard);return {eventId:payload.eventId,id:payload.id,counts:f.counts(),enabled:(await f.current()).profile.enabled};
 }finally{f.close();}
}
async function disable(){
 const f=await open();try{const operations=await f.cache.disable(await f.current(),f.guard);return {events:operations.map(row=>row.id),counts:f.counts(),enabled:(await f.current()).profile.enabled,tasks:(await f.current()).profile.tasks.tasks.length};}finally{f.close();}
}
async function lateResult(source:BrowserSource){
 const f=await open();try{
  let started!:()=>void,release!:()=>void;const reached=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const remote=createDeskRemote(config,f.account,deskProfileScope(f.binding),async(url,init)=>{if(JSON.parse(String(init?.body)).action==='register'){started();await gate;}return f.send(url,init);});
  const [operation]=await f.cache.pendingOperations(f.binding),payload=await deskRegistrationPayload(operation,source),pending=remote.register(payload);await reached;await f.cache.disable(await f.current());release();const proof=await pending;await f.cache.confirmOperation(operation,proof,f.guard);
  return {enabled:(await f.current()).profile.enabled,history:(await f.cache.operationHistory(f.binding)).map(row=>({kind:row.request.kind,confirmed:row.receipt!==null})),pending:(await f.cache.pendingOperations(f.binding)).map(row=>row.request.kind)};
 }finally{f.close();}
}
async function queue(snapshot:DeskSnapshot,source:BrowserSource,offset:number){
 const f=await open();try{await f.cache.queueOperation(snapshot,{eventId:id(20+offset),request:{kind:'register',subscriptionId:id(30+offset),...await deskRegistrationFingerprint(source)}},f.guard);return true;}catch{return false;}finally{f.close();}
}
async function quota(){
 const f=await open(),put=IDBObjectStore.prototype.put;try{
  const before=await f.current(),count=await f.cache.operations.count();IDBObjectStore.prototype.put=function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['put']>){if(this.name==='profiles')throw new DOMException('Native browser quota failure','QuotaExceededError');return put.apply(this,args);};
  let rejected=false;try{await f.cache.disable(before,f.guard);}catch{rejected=true;}IDBObjectStore.prototype.put=put;
  return {rejected,profileRetained:JSON.stringify(await f.current())===JSON.stringify(before),journalRetained:await f.cache.operations.count()===count};
 }finally{IDBObjectStore.prototype.put=put;f.close();}
}
async function proofAndAccount(source:BrowserSource){
 const f=await open();try{
  const [operation]=await f.cache.pendingOperations(f.binding),proof=await f.remote.register(await deskRegistrationPayload(operation,source));let copiedRejected=false,changedRejected=false;
  try{await f.cache.confirmOperation(operation,structuredClone(proof),f.guard);}catch{copiedRejected=true;}
  const before=await f.current();f.cache.operations.hook('updating',()=>{f.expire();});try{await f.cache.confirmOperation(operation,proof,f.guard);}catch{changedRejected=true;}
  return {copiedRejected,changedRejected,profileRetained:JSON.stringify(await f.current())===JSON.stringify(before),pending:(await f.cache.pendingOperations(f.binding)).map(row=>row.id)};
 }finally{f.close();}
}
async function switchedAccount(source:BrowserSource){
 const f=await open();try{
  const [operation]=await f.cache.pendingOperations(f.binding),proof=await f.remote.register(await deskRegistrationPayload(operation,source)),otherId='00000000-0000-4000-8000-000000000002',otherScope=scope+'/other',accountHash=await operatorAccountHash(otherId),targetHash=await cloudConnectionTarget(config,otherScope,otherId),authKey=await cloudAuthStorageKey(config,otherScope),other:DeskBinding={...f.binding,actorId:id(4),role:'manager',connection:{...f.binding.connection,accountHash,targetHash,authKey}},guard=()=>{};
  const remote=createDeskRemote(config,{...f.account,scope:otherScope,accountHash,targetHash,getAuth:async()=>({jwt:'other.phone.signature',userId:otherId,generation:1}),assertCurrent:guard},deskProfileScope(other),async()=>Response.json({...deskPage([3]),access:deskProfileScope(other)}));
  const selected=await f.cache.activate((await f.current()).pointer,other,await remote.tasks(),guard);await f.cache.confirmOperation(operation,proof,f.guard);
  return {before:selected,after:await f.cache.read(other),earlierHidden:await f.cache.read(f.binding)===null,earlierRecorded:(await f.cache.operationHistory(f.binding))[0].receipt!==null};
 }finally{f.close();}
}
async function cleanup(){for(const cache of opened)cache.close();opened.clear();await new DeskCache(base).delete();}
window.miseDeskBrowserTest={prepare,inspect,confirm,disable,lateResult,queue,quota,proofAndAccount,switchedAccount,cleanup};
declare global {interface Window {miseDeskBrowserTest:{prepare:typeof prepare;inspect:typeof inspect;confirm:typeof confirm;disable:typeof disable;lateResult:typeof lateResult;queue:typeof queue;quota:typeof quota;proofAndAccount:typeof proofAndAccount;switchedAccount:typeof switchedAccount;cleanup:typeof cleanup}}}
