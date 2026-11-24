import {newInboxId} from '@mise/core/inbox';
import {parseScreenJournalRecord,type ScreenJournalRecord} from '@mise/core/device-screen-state';
import {parseStaffStockCommand,parseStaffStockIntent,staffStockIntentHash,staffStockCapability,parseStaffStockReceipt,type StaffStockCommand,type StaffStockPrepared,type OwnStaffStockOutcome} from '@mise/core/staff-stock-actions';
import {parseStaffStockJournal,staffStockJournalId,staffStockOriginalLimit,type StaffStockJournal,type StaffStockReadStatus} from '@mise/core/staff-stock-journal';
import {stockWritePlan} from '@mise/core/stock-commands';
import type {StaffStockPage,StaffStockItem} from '@mise/core/staff-stock';
import {assertBlankScreenProfile,ScreenStorageError,type ScreenJournal} from './device-screen-journal';
import {createDeviceScreenRemote,DeviceScreenRequestError} from './device-screen-remote';
import {assertLiveCommandReceipt} from './command-request';

export async function createStaffStockSession(journal:ScreenJournal,input:ScreenJournalRecord,deps:{blank?:()=>Promise<void>;send?:typeof fetch;now?:()=>number}={}){
 const original=parseScreenJournalRecord(input);if(original.state.phase!=='signed-in')throw new ScreenStorageError('changed');
 const {credential,session}=original.state,device=credential.device,blank=deps.blank??assertBlankScreenProfile,now=deps.now??Date.now;
 const scope={businessId:device.businessId,outletId:device.outletId,deviceId:device.id,memberId:session.memberId},id=staffStockJournalId(scope),controller=new AbortController();
 let active=true,storageReady=true,snapshot:StaffStockJournal|null=null,local:Promise<unknown>=Promise.resolve(),generation=0;
 const pages=new WeakMap<StaffStockPage,{wire:string;generation:number}>();
 let quote:{packet:StaffStockPrepared;wire:string;actionId:string;revision:string;generation:number}|null=null;
 const current=()=>{if(!active)throw new ScreenStorageError('changed');};
 const api=createDeviceScreenRemote({connection:credential.connection,requestId:device.id,token:credential.token},current,deps.send??fetch);
 const verify=async()=>{current();await blank();current();await journal.assertCurrent(original);current();};
 const lifetime=(signal?:AbortSignal)=>signal?AbortSignal.any([controller.signal,signal]):controller.signal;
 const allowed=()=>{current();if(now()>=Math.min(device.expiresAt,session.expiresAt))throw new DeviceScreenRequestError('auth');};
 const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
 async function readNative(){await verify();snapshot=await journal.readStock(original);current();return snapshot;}
 function edit(change:(before:StaffStockJournal)=>StaffStockJournal,proof?:object){
  const saving=local.catch(()=>{}).then(async()=>{
   for(let attempt=0;attempt<4;attempt++){
    const before=await readNative(),base=before??{v:1 as const,id,revision:newInboxId(),readStatus:null,actions:[]};
    const next=await parseStaffStockJournal({...change(base),revision:newInboxId()},scope);
    try{snapshot=await journal.replaceStock(original,before,next,{signal:controller.signal,authorization:proof,assertCurrent:()=>{current();if(proof)assertLiveCommandReceipt(proof);}});storageReady=true;current();return snapshot;}
    catch(e){if(!(e instanceof ScreenStorageError)||e.kind!=='changed'||attempt===3)throw e;await verify();}
   }throw new ScreenStorageError('changed');
  }).catch(e=>{storageReady=false;throw e;});local=saving;return saving;
 }
 const status=():StaffStockReadStatus=>({sessionId:session.id,revision:newInboxId(),denied:false});
 function restore(before:StaffStockJournal,observed:StaffStockReadStatus|null){if(!same(before.readStatus,observed))throw new ScreenStorageError('changed');return {...before,readStatus:status()};}
 async function failed(error:unknown):Promise<never>{
  quote=null;
  if(error instanceof DeviceScreenRequestError&&error.kind==='auth'){
   generation++;try{await edit(before=>({...before,readStatus:{sessionId:session.id,revision:newInboxId(),denied:true}}));}catch{/* Retain the original and keep this controller stopped on native failure. */}
  }
  throw error;
 }
 await verify();try{await readNative();}catch{storageReady=false;await verify();}
 function saved(){current();return {actions:structuredClone(snapshot?.actions??[]),readDenied:snapshot?.readStatus?.sessionId===session.id&&snapshot.readStatus.denied,storageReady};}
 async function read(after:string|null=null,limit=100,signal?:AbortSignal){
  allowed();const observed=(await readNative())?.readStatus??null,started=generation;let result:StaffStockPage;
  try{result=await api.stockPage(device,session,after,limit,lifetime(signal));}catch(error){return failed(error);}
  await verify();assertLiveCommandReceipt(result);if(started!==generation)throw new ScreenStorageError('changed');
  await edit(before=>restore(before,observed),result);pages.set(result,{wire:JSON.stringify(result),generation});return result;
 }
 async function capture(inputCommand:StaffStockCommand,inputPages:readonly StaffStockPage[],undoId:string|null=null){
  allowed();const command=parseStaffStockCommand(inputCommand),selection=[...inputPages];
  if(!selection.length)throw new DeviceScreenRequestError('review');
  const items=new Map<string,StaffStockItem>(),captured:StaffStockPage[]=[];let readAt=0;
  for(const page of selection){const known=pages.get(page);if(!known||known.generation!==generation||known.wire!==JSON.stringify(page))throw new DeviceScreenRequestError('review');assertLiveCommandReceipt(page);
   const copy=JSON.parse(known.wire) as StaffStockPage;captured.push(copy);
   if(!copy.access.permissions.includes(staffStockCapability(command))||copy.access.expiresAt<=now())throw new DeviceScreenRequestError('auth');
   for(const row of copy.items){const previous=items.get(row.id);if(previous&&!same(previous,row))throw new DeviceScreenRequestError('review');items.set(row.id,row);}readAt=Math.max(readAt,copy.serverAt);
  }
  const before=await readNative(),undo=undoId===null?null:before?.actions.find(row=>row.intent.command.id===undoId)?.outcome?.receipt??null;
  if((command.type==='stock.undo')!==(undo!==null)||before?.readStatus?.sessionId!==session.id||before.readStatus.denied)throw new DeviceScreenRequestError('review');
  const selected=stockWritePlan(command).rows.map(row=>{const item=items.get(row.itemId);if(!item)throw new DeviceScreenRequestError('review');return item;});
  const intent=parseStaffStockIntent({v:1,origin:captured[0].access,screenRevision:original.revision,readAt,outletName:captured[0].outletName,command,items:selected,undo}),intentHash=await staffStockIntentHash(intent),observed=before.readStatus,started=generation;
  quote=null;
  await edit(latest=>{allowed();if(generation!==started||!same(latest.readStatus,observed)||latest.actions.length>=staffStockOriginalLimit||latest.actions.some(row=>!row.outcome||row.outcome.state==='pending'))throw new DeviceScreenRequestError('review');
   return {...latest,actions:[...latest.actions,{intent,intentHash,closeRequested:false,outcome:null}]};},selection[0]);return structuredClone(intent);
 }
 async function retain(actionId:string,outcome:OwnStaffStockOutcome){
  assertLiveCommandReceipt(outcome);
  await edit(before=>{const row=before.actions.find(r=>r.intent.command.id===actionId);if(!row||row.intentHash!==outcome.intentHash)throw new ScreenStorageError('changed');return {...before,actions:before.actions.map(r=>r===row?{...r,outcome}:r)};},outcome);
  return outcome;
 }
 async function recover(actionId:string,operation:'inspect'|'close'='inspect',signal?:AbortSignal):Promise<OwnStaffStockOutcome>{
  quote=null;
  if(operation==='close')await edit(before=>{const row=before.actions.find(r=>r.intent.command.id===actionId);if(!row)throw new ScreenStorageError('changed');return {...before,actions:before.actions.map(r=>r===row&&(!r.outcome||r.outcome.state==='pending')?{...r,closeRequested:true}:r)};});
  const row=(await readNative())?.actions.find(r=>r.intent.command.id===actionId);if(!row)throw new ScreenStorageError('changed');
  let outcome;try{outcome=await api.stockAction(device,session,row.intent,row.closeRequested?'close':operation,undefined,lifetime(signal));}catch(error){return failed(error);}
  await verify();if(outcome.state==='review')throw new DeviceScreenRequestError('review');return retain(actionId,outcome);
 }
 async function review(actionId:string,signal?:AbortSignal):Promise<StaffStockPrepared|OwnStaffStockOutcome>{
  quote=null;allowed();const before=await readNative(),row=before?.actions.find(r=>r.intent.command.id===actionId);if(!row)throw new ScreenStorageError('changed');
  if(row.closeRequested||row.outcome&&row.outcome.state!=='pending')return recover(actionId,row.closeRequested?'close':'inspect',signal);
  const observed=before!.readStatus,started=generation;let result;
  try{result=await api.stockAction(device,session,row.intent,'prepare',undefined,lifetime(signal));}catch(error){return failed(error);}
  await verify();assertLiveCommandReceipt(result);if(result.state!=='review')return retain(actionId,result);
  const next=await edit(latest=>{const saved=latest.actions.find(r=>r.intent.command.id===actionId);if(started!==generation||!saved||saved.closeRequested||saved.outcome&&saved.outcome.state!=='pending'||saved.intentHash!==row.intentHash)throw new ScreenStorageError('changed');return restore(latest,observed);},result);
  quote={packet:result,wire:JSON.stringify(result),actionId,revision:next.revision,generation};return result;
 }
 async function confirm(actionId:string,prepared:StaffStockPrepared,signal?:AbortSignal):Promise<OwnStaffStockOutcome>{
  allowed();const known=quote;quote=null;
  if(!known||known.packet!==prepared||known.actionId!==actionId||known.generation!==generation||known.wire!==JSON.stringify(prepared)||now()>=prepared.review.expiresAt)throw new DeviceScreenRequestError('review');assertLiveCommandReceipt(prepared);
  const chosen=JSON.parse(known.wire) as StaffStockPrepared;
  const before=await readNative(),row=before?.actions.find(r=>r.intent.command.id===actionId);
  if(!row||row.closeRequested||row.outcome&&row.outcome.state!=='pending'||before!.revision!==known.revision||before!.readStatus?.sessionId!==session.id||before!.readStatus.denied)throw new DeviceScreenRequestError('review');
  let result;try{result=await api.stockAction(device,session,row.intent,'commit',chosen,lifetime(signal));}catch(error){return failed(error);}
  await verify();if(result.state==='review'||result.state==='pending')throw new DeviceScreenRequestError('retry');
  if(result.receipt&&result.receipt.reviewHash===chosen.reviewHash)parseStaffStockReceipt(result.receipt,row.intent,row.intentHash,{value:chosen.review,hash:chosen.reviewHash});
  return retain(actionId,result);
 }
 return {saved,read,capture,review,confirm,recover,get storageReady(){return storageReady;},stop(){active=false;quote=null;generation++;controller.abort();}};
}
export type StaffStockSession=Awaited<ReturnType<typeof createStaffStockSession>>;
