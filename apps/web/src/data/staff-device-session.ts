import {newInboxId} from '@mise/core/inbox';
import {parseScreenJournalRecord,type ScreenJournalRecord} from '@mise/core/device-screen-state';
import {parseAttendanceIntent,type CheckInType,type OwnAttendanceOutcome} from '@mise/core/staff-attendance';
import {parseStaffView,type StaffView,type StaffHistoryCursor} from '@mise/core/staff-links';
import type {StaffDeviceView} from '@mise/core/staff-device';
import {parseStaffDeviceJournal,staffDeviceJournalId,type StaffDeviceJournal,type StaffDeviceOriginal} from '@mise/core/staff-device-journal';
import {assertBlankScreenProfile,ScreenStorageError,type ScreenJournal} from './device-screen-journal';
import {createDeviceScreenRemote,DeviceScreenRequestError} from './device-screen-remote';
import {assertCommandReceipt} from './command-request';

export async function createStaffDeviceSession(journal:ScreenJournal,input:ScreenJournalRecord,deps:{blank?:()=>Promise<void>;send?:typeof fetch;now?:()=>number}={}){
 const original=parseScreenJournalRecord(input);if(original.state.phase!=='signed-in')throw new ScreenStorageError('changed');
 const {credential,session}=original.state,device=credential.device,blank=deps.blank??assertBlankScreenProfile,now=deps.now??Date.now;
 const scope={businessId:device.businessId,outletId:device.outletId,deviceId:device.id,memberId:session.memberId},id=staffDeviceJournalId(scope);
 const controller=new AbortController();let active=true,storageReady=true,local:Promise<unknown>=Promise.resolve(),snapshot:StaffDeviceJournal|null=null,packet:StaffDeviceView|null=null;
 const current=()=>{if(!active)throw new ScreenStorageError('changed');};
 const api=createDeviceScreenRemote({connection:credential.connection,requestId:device.id,token:credential.token},current,deps.send??fetch);
 const verify=async()=>{current();await blank();current();await journal.assertCurrent(original);current();};
 const fresh=()=>{current();if(!packet||now()>=Math.min(device.expiresAt,session.expiresAt))throw new DeviceScreenRequestError('auth');assertCommandReceipt(packet);return packet;};
 async function readNative(){await verify();snapshot=await journal.readAttendance(original);current();return snapshot;}
 function edit(change:(before:StaffDeviceJournal)=>StaffDeviceJournal,proof?:object){
  const saving=local.catch(()=>{}).then(async()=>{
   for(let attempt=0;attempt<4;attempt++){
    const before=await readNative(),base=before??{v:1 as const,id,revision:newInboxId(),view:null,actions:[]},next=parseStaffDeviceJournal({...change(base),revision:newInboxId()},scope);
    try{snapshot=await journal.replaceAttendance(original,before,next,{signal:controller.signal,assertCurrent:()=>{current();if(proof)assertCommandReceipt(proof);}});current();return snapshot;}
    catch(e){if(!(e instanceof ScreenStorageError)||e.kind!=='changed'||attempt===3)throw e;await verify();}
   }throw new ScreenStorageError('changed');
  });local=saving;return saving;
 }
 await verify();try{await readNative();}catch{storageReady=false;await verify();}
 function saved(){current();const visible=snapshot?.view?.access.sessionId===session.id?snapshot.view.view:null;return {v:1 as const,view:visible?structuredClone(visible):null,actions:structuredClone(snapshot?.actions??[])};}
 async function read(after:StaffHistoryCursor|null=null,signal?:AbortSignal):Promise<StaffView>{
  await verify();let result:StaffDeviceView;try{result=await api.staffView(device,session,after,signal?AbortSignal.any([controller.signal,signal]):controller.signal);}catch(e){if(e instanceof DeviceScreenRequestError&&e.kind==='auth')packet=null;throw e;}await verify();assertCommandReceipt(result);
  if(after!==null)return result.view;
  if(packet&&packet.view.serverAt>result.view.serverAt)return packet.view;packet=result;
  try{await edit(before=>before.view&&before.view.access.sessionId===session.id&&before.view.view.serverAt>result.view.serverAt?before:{...before,view:result},result);storageReady=true;}
  catch{storageReady=false;await verify();}return result.view;
 }
 async function prepare(value:StaffView,type:CheckInType,occurredAt=now()){
  const view=parseStaffView(value,null),known=fresh();if(JSON.stringify(view)!==JSON.stringify(known.view)||view.latest&&(occurredAt<view.latest.at)||occurredAt>=Math.min(session.expiresAt,device.expiresAt))throw new DeviceScreenRequestError('review');
  const state=view.latest?.type??'out';if(type===state||type==='break'&&state!=='in')throw new DeviceScreenRequestError('review');
  const intent=parseAttendanceIntent({v:1,id:newInboxId(),eventId:newInboxId(),memberId:scope.memberId,outletId:scope.outletId,type,occurredAt,expectedLastId:view.latest?.id??null});
  await edit(before=>{
   fresh();if(before.actions.length>=200||before.actions.some(row=>!row.outcome||row.outcome.state==='pending')||before.view?.access.sessionId===session.id&&JSON.stringify(before.view.view.latest)!==JSON.stringify(view.latest))throw new DeviceScreenRequestError('review');
   const row:StaffDeviceOriginal={origin:known.access,screenRevision:original.revision,intent,name:view.name,nameLocal:view.nameLocal,language:view.language,closeRequested:false,outcome:null};
   return {...before,actions:[...before.actions,row]};
  },known);return intent;
 }
 async function call(actionId:string,operation:'submit'|'inspect'|'close',signal?:AbortSignal){
  // Closure is a native choice first. It survives offline, quota errors before
  // HTTP, late replies and a later PIN for this same member/device.
  if(operation==='close')await edit(before=>{const row=before.actions.at(-1);if(!row||row.intent.id!==actionId)throw new ScreenStorageError('changed');return {...before,actions:before.actions.map(r=>r===row?{...r,closeRequested:true}:r)};});
  const before=await readNative(),row=before?.actions.at(-1);if(!row||row.intent.id!==actionId)throw new ScreenStorageError('changed');
  const effect=row.closeRequested&&operation==='submit'?'close':operation;
  if(effect==='submit'&&row.origin.sessionId!==session.id)throw new DeviceScreenRequestError('review');
  await verify();let outcome:OwnAttendanceOutcome;try{outcome=await api.staffAttendance(device,session,effect,row.intent,signal?AbortSignal.any([signal,controller.signal]):controller.signal);}catch(e){if(e instanceof DeviceScreenRequestError&&e.kind==='auth')packet=null;throw e;}await verify();assertCommandReceipt(outcome);
  await edit(latest=>{
   const originalRow=latest.actions.at(-1);if(!originalRow||JSON.stringify(originalRow.intent)!==JSON.stringify(row.intent)||JSON.stringify(originalRow.origin)!==JSON.stringify(row.origin))throw new ScreenStorageError('changed');
   if(originalRow.outcome&&originalRow.outcome.state!=='pending'&&JSON.stringify(originalRow.outcome)!==JSON.stringify(outcome))throw new ScreenStorageError('changed');
   return {...latest,actions:latest.actions.map(r=>r===originalRow?{...r,outcome}:r)};
  },outcome);if(outcome.state!=='pending')packet=null;return outcome;
 }
 return {saved,read,prepare,call,async access(){await verify();const result=await api.access(device,session,controller.signal);await verify();if(!result.permissions.includes('staff.check-in'))packet=null;return result;},async board(after:string|null=null){await verify();try{const result=await api.staffBoard(device,session,after,controller.signal);await verify();return result;}catch(e){if(e instanceof DeviceScreenRequestError&&e.kind==='auth')packet=null;throw e;}},
  get storageReady(){return storageReady;},get canPrepare(){try{fresh();return storageReady;}catch{return false;}},
  canRetry(actionId:string){return snapshot?.actions.find(row=>row.intent.id===actionId)?.origin.sessionId===session.id;},stop(){active=false;packet=null;controller.abort();}};
}
export type StaffDeviceSession=Awaited<ReturnType<typeof createStaffDeviceSession>>;
