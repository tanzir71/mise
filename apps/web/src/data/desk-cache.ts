import Dexie,{type Table} from 'dexie';
import {newKitchenId} from '@mise/core/kitchen';
import {isDeviceId} from '@mise/core/device-access';
import {parseLocalOperatorState,type LocalOperatorState} from '@mise/core/operators';
import {parseDeskPushMetadata,type DeskPushContext,type DeskPushMetadata} from '@mise/core/desk-push';
import {parseDeskTaskList,deskTaskListWire,type DeskTaskList} from '@mise/core/desk-tasks';
import {assertDeskReceipt} from './desk-proof';
import {parseDeskOperation,parseDeskOperationRequest,parseDeskOperationReceipt,type DeskOperation,type DeskOperationRequest} from './desk-operation';
export type DeskBinding=LocalOperatorState&{phase:'active';connection:NonNullable<LocalOperatorState['connection']>};
export interface DeskPointer {v:1;id:'active';revision:string;profileId:string|null}
export interface DeskProfile {v:1;id:string;revision:string;binding:DeskBinding;enabled:boolean;subscription:DeskPushMetadata|null;tasks:DeskTaskList}
export interface DeskSnapshot {pointer:DeskPointer;profile:DeskProfile}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export class DeskCacheError extends Error {constructor(readonly kind:'changed'|'damaged'|'unavailable'){super(kind==='changed'?'This desk account changed. Open its current notification settings.':kind==='damaged'?'This desk notification profile needs review. Keep the shop records and open its current settings.':'This browser could not save desk notifications. Keep the current page and try again.');}}
export function parseDeskBinding(value:unknown):DeskBinding {
 const binding=parseLocalOperatorState(value);if(binding.phase!=='active'||!binding.connection)throw new DeskCacheError('changed');return binding as DeskBinding;
}
export function deskProfileScope(value:DeskBinding):DeskPushContext {const binding=parseDeskBinding(value);return {v:1,businessId:binding.businessId,outletId:binding.outletId,memberId:binding.actorId,role:binding.role};}
export function deskProfileId(value:DeskBinding):string {const binding=parseDeskBinding(value);return 'desk:'+binding.connection.targetHash+':'+binding.outletId+':'+binding.actorId;}
const identity=(binding:DeskBinding)=>({accountHash:binding.connection.accountHash,targetHash:binding.connection.targetHash,scope:deskProfileScope(binding)});
function validProfileId(value:unknown):value is string {if(typeof value!=='string')return false;const parts=value.split(':');return parts.length===4&&parts[0]==='desk'&&/^[a-f0-9]{64}$/.test(parts[1])&&isDeviceId(parts[2])&&isDeviceId(parts[3]);}
function pointer(value:unknown):DeskPointer {
 if(!object(value)||!exact(value,'v,id,revision,profileId')||value.v!==1||value.id!=='active'||!isDeviceId(value.revision)||value.profileId!==null&&!validProfileId(value.profileId))throw new DeskCacheError('damaged');
 return {v:1,id:'active',revision:value.revision,profileId:value.profileId as string|null};
}
function subscription(value:unknown,binding:DeskBinding):DeskPushMetadata|null {
 if(value===null)return null;const result=parseDeskPushMetadata(value);
 if(result.businessId!==binding.businessId||result.outletId!==binding.outletId||result.memberId!==binding.actorId)throw new DeskCacheError('changed');return result;
}
function profile(value:unknown):DeskProfile {
 if(!object(value)||!exact(value,'v,id,revision,binding,enabled,subscription,tasks')||value.v!==1||!isDeviceId(value.revision)||typeof value.enabled!=='boolean')throw new DeskCacheError('damaged');
 const binding=parseDeskBinding(value.binding);if(value.id!==deskProfileId(binding))throw new DeskCacheError('damaged');
 const saved=subscription(value.subscription,binding);if(value.enabled&&(!saved||saved.revokedAt!==null))throw new DeskCacheError('damaged');
 return {v:1,id:value.id as string,revision:value.revision,binding,enabled:value.enabled,subscription:saved,tasks:parseDeskTaskList(value.tasks,deskProfileScope(binding))};
}
const wire=(value:DeskProfile)=>({...value,tasks:deskTaskListWire(value.tasks)});
function advance(original:DeskTaskList,next:DeskTaskList){if(next.version<original.version||next.at<original.at||next.settings.revision<original.settings.revision)throw new DeskCacheError('changed');}
function syncGuard(guard?:()=>void){const result:unknown=guard?.();if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw new DeskCacheError('changed');}}
export function deskDatabaseName(base:string):string {
 if(typeof base!=='string'||!base.startsWith('/')||!base.endsWith('/')||base.length>2048||/[?#\u0000-\u0020\\]/.test(base)||base.includes('..'))throw new DeskCacheError('unavailable');
 return 'mise.desk.v1:'+base;
}
/** Private projection/capability metadata only. This database never enters shop
 * exports and contains no owner JWT, endpoint or browser encryption material. */
export class DeskCache extends Dexie {
 profiles!:Table<unknown,string>;active!:Table<unknown,string>;operations!:Table<unknown,string>;
 constructor(base:string,options?:ConstructorParameters<typeof Dexie>[1]){super(deskDatabaseName(base),options);this.version(1).stores({profiles:'&id',active:'&id'});this.version(2).stores({operations:'&id,profileId,&[profileId+sequence]'});}
 async pointer():Promise<DeskPointer>{
  return this.transaction('rw',this.active,async()=>{const saved=await this.active.get('active');if(saved!==undefined)return pointer(saved);const empty:DeskPointer={v:1,id:'active',revision:newKitchenId(),profileId:null};await this.active.add(empty);return empty;});
 }
 async read(value:DeskBinding):Promise<DeskSnapshot|null>{
  const binding=parseDeskBinding(value);return this.transaction('r',this.active,this.profiles,async()=>{
   const raw=await this.active.get('active');if(raw===undefined)return null;const selected=pointer(raw);
   if(selected.profileId!==deskProfileId(binding))return null;const saved=profile(await this.profiles.get(selected.profileId));
   if(!equal(saved.binding,binding))return null;return {pointer:selected,profile:saved};
  });
 }
 async activate(selected:DeskPointer,value:DeskBinding,list:DeskTaskList,guard?:()=>void):Promise<DeskSnapshot>{
  const expected=pointer(selected),binding=parseDeskBinding(value),tasks=parseDeskTaskList(deskTaskListWire(list),deskProfileScope(binding)),id=deskProfileId(binding);
  assertDeskReceipt(list,identity(binding));syncGuard(guard);
  const result=await this.transaction('rw',this.active,this.profiles,async()=>{
   if(!equal(pointer(await this.active.get('active')),expected))throw new DeskCacheError('changed');
   const previous=await this.profiles.get(id),old=previous===undefined?null:profile(previous);
   if(old&&old.binding.connection.epoch===binding.connection.epoch&&old.binding.connection.scopeVersion===binding.connection.scopeVersion)advance(old.tasks,tasks);
   const next:DeskProfile={v:1,id,revision:newKitchenId(),binding,tasks,subscription:old?.subscription??null,enabled:!!old?.enabled&&equal(old.binding,binding)};
   const current:DeskPointer={v:1,id:'active',revision:newKitchenId(),profileId:id};
   if(expected.profileId&&expected.profileId!==id){const earlier=profile(await this.profiles.get(expected.profileId));syncGuard(guard);assertDeskReceipt(list,identity(binding));await this.profiles.put(wire({...earlier,revision:newKitchenId(),enabled:false}));}
   syncGuard(guard);assertDeskReceipt(list,identity(binding));await this.profiles.put(wire(next));
   syncGuard(guard);assertDeskReceipt(list,identity(binding));await this.active.put(current);
   syncGuard(guard);assertDeskReceipt(list,identity(binding));return {pointer:current,profile:next};
  });syncGuard(guard);assertDeskReceipt(list,identity(binding));return result;
 }
 async replaceTasks(expected:DeskSnapshot,list:DeskTaskList,guard?:()=>void):Promise<DeskSnapshot>{
  const selected=pointer(expected.pointer),original=profile(wire(expected.profile)),tasks=parseDeskTaskList(deskTaskListWire(list),deskProfileScope(original.binding));
  if(selected.profileId!==original.id)throw new DeskCacheError('changed');
  advance(original.tasks,tasks);
  assertDeskReceipt(list,identity(original.binding));syncGuard(guard);
  const result=await this.transaction('rw',this.active,this.profiles,async()=>{
   if(!equal(pointer(await this.active.get('active')),selected)||!equal(profile(await this.profiles.get(original.id)),original))throw new DeskCacheError('changed');
   const next={...original,revision:newKitchenId(),tasks};syncGuard(guard);assertDeskReceipt(list,identity(original.binding));await this.profiles.put(wire(next));syncGuard(guard);assertDeskReceipt(list,identity(original.binding));return {pointer:selected,profile:next};
  });syncGuard(guard);assertDeskReceipt(list,identity(original.binding));return result;
 }
 async setSubscription(expected:DeskSnapshot,proof:DeskPushMetadata|{id:string;subscription:DeskPushMetadata|null},enabled:boolean,guard?:()=>void):Promise<DeskSnapshot>{
  if(typeof enabled!=='boolean')throw new DeskCacheError('changed');
  const selected=pointer(expected.pointer),original=profile(wire(expected.profile)),saved=subscription('subscription'in proof?proof.subscription:proof,original.binding);
  if(selected.profileId!==original.id)throw new DeskCacheError('changed');
  if(!isDeviceId(proof.id)||saved&&saved.id!==proof.id||!saved&&original.subscription&&original.subscription.id!==proof.id)throw new DeskCacheError('changed');
  if(enabled&&(!saved||saved.revokedAt!==null))throw new DeskCacheError('changed');assertDeskReceipt(proof,identity(original.binding));syncGuard(guard);
  const result=await this.transaction('rw',this.active,this.profiles,this.operations,async()=>{
   if(!equal(pointer(await this.active.get('active')),selected)||!equal(profile(await this.profiles.get(original.id)),original))throw new DeskCacheError('changed');
   // Once a durable user choice exists, only its original mutation receipt may
   // enable presentation. A later metadata refresh cannot bypass Disable.
   if(enabled&&await this.operations.where('profileId').equals(original.id).count())throw new DeskCacheError('changed');
   const next={...original,revision:newKitchenId(),subscription:saved,enabled};syncGuard(guard);assertDeskReceipt(proof,identity(original.binding));await this.profiles.put(wire(next));syncGuard(guard);assertDeskReceipt(proof,identity(original.binding));return {pointer:selected,profile:next};
  });syncGuard(guard);assertDeskReceipt(proof,identity(original.binding));return result;
 }
 /** Original inputs are saved before any HTTP. Browser capabilities themselves
  * stay in PushManager; registration rows contain only their canonical hashes. */
 async queueOperation(expected:DeskSnapshot,input:{eventId:string;request:Exclude<DeskOperationRequest,{kind:'revoke'}>},guard?:()=>void):Promise<DeskOperation>{
  const selected=pointer(expected.pointer),original=profile(wire(expected.profile)),request=parseDeskOperationRequest(input.request),eventId=input.eventId;
  if(selected.profileId!==original.id||!isDeviceId(eventId)||request.kind==='revoke'||request.kind==='register'&&request.subscriptionId===eventId)throw new DeskCacheError('changed');syncGuard(guard);
  return this.transaction('rw',this.active,this.profiles,this.operations,async()=>{
   const existing=await this.operations.get(eventId);
   if(existing!==undefined){const saved=parseDeskOperation(existing);if(saved.profileId!==original.id||!equal(saved.binding,original.binding)||saved.selectionRevision!==selected.revision||!equal(saved.request,request))throw new DeskCacheError('changed');syncGuard(guard);return saved;}
   if(!equal(pointer(await this.active.get('active')),selected)||!equal(profile(await this.profiles.get(original.id)),original))throw new DeskCacheError('changed');
   const all=(await this.operations.where('profileId').equals(original.id).toArray()).map(parseDeskOperation);
   if(request.kind==='register'&&(original.subscription?.id===request.subscriptionId||all.some(row=>row.request.kind!=='settings'&&row.request.subscriptionId===request.subscriptionId)))throw new DeskCacheError('changed');
   const sequence=Math.max(0,...all.map(row=>row.sequence))+1;
   const saved=parseDeskOperation({v:1,id:eventId,profileId:original.id,binding:original.binding,selectionRevision:selected.revision,sequence,request,receipt:null});
   syncGuard(guard);await this.operations.add(saved);
   if(request.kind==='register'){syncGuard(guard);await this.profiles.put(wire({...original,revision:newKitchenId(),enabled:false}));}
   syncGuard(guard);return saved;
  });
 }
 /** Disable is local and atomic even offline: keep the Inbox, mute this desk,
  * and retain a withdrawal for every original setup that might have reached SQL. */
 async disable(expected:DeskSnapshot,guard?:()=>void):Promise<DeskOperation[]>{
  const selected=pointer(expected.pointer),original=profile(wire(expected.profile));if(selected.profileId!==original.id)throw new DeskCacheError('changed');syncGuard(guard);
  return this.transaction('rw',this.active,this.profiles,this.operations,async()=>{
   if(!equal(pointer(await this.active.get('active')),selected)||!equal(profile(await this.profiles.get(original.id)),original))throw new DeskCacheError('changed');
   const all=(await this.operations.where('profileId').equals(original.id).toArray()).map(parseDeskOperation),own=(row:DeskOperation)=>row.binding.connection.accountHash===original.binding.connection.accountHash&&row.binding.connection.targetHash===original.binding.connection.targetHash;
   const candidates=new Map<string,{binding:DeskBinding;selectionRevision:string}>();
   for(const row of all)if(own(row)&&row.request.kind==='register')candidates.set(row.request.subscriptionId,row);
   if(original.subscription?.revokedAt===null&&!candidates.has(original.subscription.id))candidates.set(original.subscription.id,{binding:original.binding,selectionRevision:selected.revision});
   let sequence=Math.max(0,...all.map(row=>row.sequence));const withdrawals:DeskOperation[]=[];
   for(const [subscriptionId,source] of candidates){
    const earlier=all.find(row=>own(row)&&row.request.kind==='revoke'&&row.request.subscriptionId===subscriptionId);
    if(earlier){if(!earlier.receipt)withdrawals.push(earlier);continue;}
    let eventId=newKitchenId();while(eventId===subscriptionId)eventId=newKitchenId();
    const saved=parseDeskOperation({v:1,id:eventId,profileId:original.id,binding:source.binding,selectionRevision:source.selectionRevision,sequence:++sequence,request:{kind:'revoke',subscriptionId},receipt:null});
    syncGuard(guard);await this.operations.add(saved);withdrawals.push(saved);
   }
   syncGuard(guard);await this.profiles.put(wire({...original,revision:newKitchenId(),enabled:false}));syncGuard(guard);return withdrawals;
  });
 }
 /** This is recoverable history, never fresh authorization. Withdrawals precede
  * unclosed registrations; an explicitly withdrawn setup is never replayed. */
 async operationHistory(value:DeskBinding):Promise<DeskOperation[]>{
  const binding=parseDeskBinding(value);return (await this.operations.where('profileId').equals(deskProfileId(binding)).toArray()).map(parseDeskOperation).filter(row=>row.binding.connection.accountHash===binding.connection.accountHash&&row.binding.connection.targetHash===binding.connection.targetHash).sort((a,b)=>a.sequence-b.sequence);
 }
 async pendingOperations(value:DeskBinding):Promise<DeskOperation[]>{
  const all=await this.operationHistory(value),closed=new Set(all.flatMap(row=>row.request.kind==='revoke'?[row.request.subscriptionId]:[]));
  return all.filter(row=>!row.receipt&&(row.request.kind!=='register'||!closed.has(row.request.subscriptionId))).sort((a,b)=>Number(b.request.kind==='revoke')-Number(a.request.kind==='revoke')||a.sequence-b.sequence);
 }
 /** An inactive original account may record its actual outcome. Enabling also
  * requires the original active selection and a synchronous native scope guard. */
 async confirmOperation(value:DeskOperation,proof:object,guard?:()=>void):Promise<DeskOperation>{
  const original=parseDeskOperation(value),receipt=parseDeskOperationReceipt(proof,original);assertDeskReceipt(proof,identity(original.binding));syncGuard(guard);
  const result=await this.transaction('rw',this.active,this.profiles,this.operations,async()=>{
   const saved=parseDeskOperation(await this.operations.get(original.id));
   if(!equal({...saved,receipt:null},{...original,receipt:null})||saved.receipt&&!equal(saved.receipt,receipt))throw new DeskCacheError('changed');
   if(saved.receipt){assertDeskReceipt(proof,identity(original.binding));syncGuard(guard);return saved;}
   const confirmed={...saved,receipt},raw=await this.profiles.get(original.profileId),current=raw===undefined?null:profile(raw),selected=pointer(await this.active.get('active'));
   if(current&&current.binding.connection.accountHash===original.binding.connection.accountHash&&current.binding.connection.targetHash===original.binding.connection.targetHash){
    let next:DeskProfile|null=null;
    if(receipt.action==='revoke'&&current.subscription?.id===receipt.id)next={...current,revision:newKitchenId(),subscription:receipt.subscription,enabled:false};
    if(receipt.action==='register'&&guard&&selected.profileId===current.id&&selected.revision===original.selectionRevision&&equal(current.binding,original.binding)){
     const intents=(await this.operations.where('profileId').equals(current.id).toArray()).map(parseDeskOperation).filter(row=>row.request.kind!=='settings'),latest=intents.sort((a,b)=>b.sequence-a.sequence)[0];
     if(latest?.id===original.id&&!intents.some(row=>row.request.kind==='revoke'&&row.request.subscriptionId===receipt.id))next={...current,revision:newKitchenId(),subscription:receipt.subscription,enabled:true};
    }
    if(next){syncGuard(guard);assertDeskReceipt(proof,identity(original.binding));await this.profiles.put(wire(next));}
   }
   syncGuard(guard);assertDeskReceipt(proof,identity(original.binding));await this.operations.put(confirmed);syncGuard(guard);assertDeskReceipt(proof,identity(original.binding));return confirmed;
  });syncGuard(guard);assertDeskReceipt(proof,identity(original.binding));return result;
 }
 /** Local sign-out needs no network or still-valid phone token. The original
  * pointer fence prevents a late cleanup from retiring a newer account. */
 async retire(value:DeskPointer):Promise<DeskPointer>{
  const expected=pointer(value);return this.transaction('rw',this.active,this.profiles,async()=>{
   if(!equal(pointer(await this.active.get('active')),expected))throw new DeskCacheError('changed');
   if(expected.profileId){const old=profile(await this.profiles.get(expected.profileId));await this.profiles.put(wire({...old,revision:newKitchenId(),enabled:false}));}
   const empty:DeskPointer={v:1,id:'active',revision:newKitchenId(),profileId:null};await this.active.put(empty);return empty;
  });
 }
}
