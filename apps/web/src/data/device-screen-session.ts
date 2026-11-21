import {parseCloudConnection,type CloudConnection} from '@mise/core/cloud-connection';
import {newInboxId} from '@mise/core/inbox';
import {deviceSecretHash,isDeviceId,newDeviceSecret,pairingCode} from '@mise/core/device-access';
import {parseScreenJournalRecord,type ScreenJournalRecord,type ScreenEnrollment,type ScreenState} from '@mise/core/device-screen-state';
import {createDeviceScreenRemote,DeviceScreenRequestError} from './device-screen-remote';
import {assertBlankScreenProfile,ScreenStorageError,type ScreenJournal} from './device-screen-journal';

/** One controller per mounted shared-screen route. Every effect is bound to the
 * complete original native record. Other tabs are serialized by IndexedDB CAS,
 * and session grants are never inferred from local metadata or owner sign-in. */
export function createDeviceScreenSession(journal:ScreenJournal,deps:{blank?:()=>Promise<void>;send?:typeof fetch}={}){
 const blank=deps.blank??assertBlankScreenProfile,send=deps.send??fetch;let disposed=false,busy=false,generation=0;
 const controller=new AbortController();
 function current(at:number){if(disposed||generation!==at)throw new ScreenStorageError('changed');}
 async function verify(original:ScreenJournalRecord,at:number,cleanup=false){current(at);if(!cleanup)await blank();current(at);await journal.assertCurrent(original);current(at);}
 function write(original:ScreenJournalRecord,next:ScreenState,at:number){return journal.replace(original,next,{assertCurrent:()=>current(at),signal:controller.signal});}
 function remote(original:ScreenJournalRecord,at:number){
  const state=original.state;
  const source=state.phase==='pairing'?state.source:state.phase==='empty'?null:{connection:state.credential.connection,requestId:state.credential.device.id,token:state.credential.token};
  if(!source)throw new ScreenStorageError('changed');return createDeviceScreenRemote(source,()=>current(at),send);
 }
 async function run<T>(input:ScreenJournalRecord,work:(original:ScreenJournalRecord,at:number)=>Promise<T>,cleanup=false):Promise<T>{
  const original=parseScreenJournalRecord(input);if(busy||disposed)throw new ScreenStorageError('changed');busy=true;const at=generation;
  try{await verify(original,at,cleanup);return await work(original,at);}finally{busy=false;}
 }
 function enrollment(original:ScreenJournalRecord):ScreenEnrollment{
  const s=original.state;if(s.phase==='empty'||s.phase==='pairing')throw new ScreenStorageError('changed');return {credential:s.credential,outletNameJson:s.outletNameJson};
 }
 return {
  async load(){const at=generation;current(at);await blank();const saved=await journal.read();current(at);return saved;},
  async loadForCleanup(){const at=generation;current(at);const saved=await journal.read();current(at);return saved;},
  async prepare(input:ScreenJournalRecord,connection:CloudConnection,code:string,pairingId:string|null=null){
   const source={connection:parseCloudConnection(connection),code:pairingCode(code),pairingId};if(pairingId!==null&&!isDeviceId(pairingId))throw new ScreenStorageError('changed');
   return run(input,async(original,at)=>{
    if(original.state.phase!=='empty')throw new ScreenStorageError('changed');
    const token=newDeviceSecret(),requestId=newInboxId(),tokenHash=await deviceSecretHash(token);await verify(original,at);
    // Completion of the native transaction precedes ALL network work.
    return write(original,{phase:'pairing',source:{...source,requestId,token,tokenHash},receipt:null},at);
   });
  },
  async pair(input:ScreenJournalRecord){return run(input,async(original,at)=>{
   const state=original.state;if(state.phase!=='pairing')throw new ScreenStorageError('changed');const api=remote(original,at);
   let outcome;
   try{outcome=await api.poll(controller.signal);}
   catch(error){
    if(!(error instanceof DeviceScreenRequestError)||error.kind!=='auth')throw error;
    // A missing first reply may already have been approved. Poll before ever
    // resubmitting, and retain the same request/secret/code on every retry.
    await verify(original,at);const receipt=await api.request(state.source.code,state.source.pairingId,controller.signal);await verify(original,at);
    return {saved:await write(original,{...state,receipt},at),outcome:'waiting' as const};
   }
   await verify(original,at);
   if(outcome.state==='approved'){
    return {saved:await write(original,{phase:'enrolled',credential:{v:1,connection:state.source.connection,device:outcome.device,token:state.source.token},outletNameJson:outcome.outletNameJson},at),outcome:'approved' as const};
   }
   if(outcome.state==='waiting'){
    const receipt={v:1 as const,id:outcome.id,verification:outcome.verification,expiresAt:outcome.expiresAt};return {saved:JSON.stringify(receipt)===JSON.stringify(state.receipt)?original:await write(original,{...state,receipt},at),outcome:'waiting' as const};
   }
   // Keep the original request for an explicit new-code choice. An expiry or
   // cancellation does not silently generate a new secret or target.
   return {saved:original,outcome:outcome.state};
  });},
  async forgetPairing(input:ScreenJournalRecord){return run(input,async(original,at)=>{if(original.state.phase!=='pairing')throw new ScreenStorageError('changed');return write(original,{phase:'empty'},at);},true);},
  async directory(input:ScreenJournalRecord,after:string|null=null,limit=50){return run(input,async(original,at)=>{
   if(original.state.phase!=='enrolled')throw new ScreenStorageError('changed');const page=await remote(original,at).directory(original.state.credential.device,after,limit,controller.signal);await verify(original,at);return page;
  });},
  async signIn(input:ScreenJournalRecord,memberId:string,pin:string){
   // The PIN remains only in this invocation and the HTTPS request. No journal
   // transition or error stores it, including failures before/after SQL finish.
   const member=memberId,digits=pin;if(!isDeviceId(member)||typeof digits!=='string'||!/^\d{4}$/.test(digits))throw new DeviceScreenRequestError('review');
   return run(input,async(original,at)=>{
    if(original.state.phase!=='enrolled')throw new ScreenStorageError('changed');const setup=enrollment(original),attemptId=newInboxId();
    const pending=await write(original,{phase:'signing-in',...setup,attemptId,memberId:member},at);
    await verify(pending,at);const session=await remote(pending,at).signIn(setup.credential.device,attemptId,member,digits,controller.signal);await verify(pending,at);
    return write(pending,{phase:'signed-in',...setup,attemptId,session},at);
   });
  },
  async access(input:ScreenJournalRecord){return run(input,async(original,at)=>{
   const state=original.state;if(state.phase!=='signed-in')throw new ScreenStorageError('changed');const access=await remote(original,at).access(state.credential.device,state.session,controller.signal);await verify(original,at);return access;
  });},
  async reset(input:ScreenJournalRecord,forget=false){return run(input,async(original,at)=>{
   const state=original.state,setup=enrollment(original);
   if(state.phase==='empty'||state.phase==='pairing')throw new ScreenStorageError('changed');
   // Drop the usable local session BEFORE the server request. A lost response
   // retains this exact sign-out ID and, if needed, the outstanding PIN attempt.
   const pending=state.phase==='resetting'?original:await write(original,{phase:'resetting',...setup,id:newInboxId(),attemptId:state.phase==='enrolled'?null:state.attemptId,forget},at);
   if(pending.state.phase!=='resetting'||pending.state.forget!==forget)throw new ScreenStorageError('changed');await verify(pending,at,true);
   await remote(pending,at).reset(pending.state.id,pending.state.attemptId,controller.signal);await verify(pending,at,true);
   return write(pending,pending.state.forget?{phase:'empty'}:{phase:'enrolled',...setup},at);
  },true);},
  dispose(){disposed=true;generation++;controller.abort();},
 };
}
