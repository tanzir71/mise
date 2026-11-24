import {parseScreenJournalRecord,type ScreenJournalRecord} from '@mise/core/device-screen-state';
import {parseStaffDeviceAccess} from '@mise/core/device-access';
import {newKitchenId} from '@mise/core/kitchen';
import {beginOwnKitchenTapClose,finishKitchenTap,finishKitchenTapClose,sameKitchenSession,type KitchenScreenState,type KitchenTap} from '@mise/core/kitchen-screen';
import {retainedKitchenTap} from '@mise/core/kitchen-recovery';
import {assertCommandReceipt} from './command-request';
import {assertBlankScreenProfile,ScreenStorageError,type ScreenJournal} from './device-screen-journal';
import {createDeviceScreenRemote,DeviceScreenRequestError} from './device-screen-remote';

/** Recovery-only reader. Never fetches live tickets or sends preparation work. */
export function createKitchenSavedSession(journal:ScreenJournal,input:ScreenJournalRecord,
  deps:{blank?:()=>Promise<void>;send?:typeof fetch;now?:()=>number}={}){
  const original=parseScreenJournalRecord(input);
  if(original.state.phase!=='signed-in')throw new ScreenStorageError('changed');
  const {credential,session}=original.state,device=credential.device,now=deps.now??Date.now,blank=deps.blank??assertBlankScreenProfile;
  // This identity is local closure metadata, never a positive capability claim.
  const identity=parseStaffDeviceAccess({v:1,deviceId:device.id,businessId:device.businessId,outletId:device.outletId,
    sessionId:session.id,memberId:session.memberId,role:device.mode==='kitchen'?'kitchen':'staff',mode:device.mode,
    permissions:[],expiresAt:session.expiresAt},{device,session});
  let disposed=false,local:Promise<unknown>=Promise.resolve();
  const controller=new AbortController(),current=()=>{if(disposed)throw new ScreenStorageError('changed');};
  const api=createDeviceScreenRemote({connection:credential.connection,requestId:device.id,token:credential.token},current,deps.send??fetch);
  async function verify(){current();if(now()>=Math.min(device.expiresAt,session.expiresAt))throw new DeviceScreenRequestError('auth');await blank();current();await journal.assertCurrent(original);current();}
  async function read(){await verify();const state=await journal.readKitchen(original);await verify();
    if(state&&(state.id!==device.id||state.access.businessId!==device.businessId||state.access.outletId!==device.outletId||state.access.mode!==device.mode))throw new ScreenStorageError('changed');
    return state;
  }
  function own(tap:KitchenTap){if(tap.access.deviceId!==device.id||tap.access.businessId!==device.businessId||tap.access.outletId!==device.outletId||tap.access.memberId!==session.memberId)throw new DeviceScreenRequestError('auth');}
  async function load(){const state=await read();return structuredClone(state?.taps.filter(tap=>tap.access.memberId===session.memberId)??[]);}
  function edit(change:(state:KitchenScreenState)=>KitchenScreenState,proof?:object){
    const saving=local.catch(()=>{}).then(async()=>{
      for(let attempt=0;attempt<4;attempt++){
        const before=await read();if(!before)throw new ScreenStorageError('changed');const next=change(before);
        try{await journal.replaceKitchen(original,before,next,{signal:controller.signal,assertCurrent:()=>{current();if(proof)assertCommandReceipt(proof);}});await verify();return;}
        catch(e){if(!(e instanceof ScreenStorageError)||e.kind!=='changed'||attempt===3)throw e;await verify();}
      }
    });local=saving;return saving;
  }
  return {
    load,
    async close(input:KitchenTap){
      const tap=structuredClone(input),occurredAt=now(),id=newKitchenId(occurredAt);own(tap);
      await edit(state=>beginOwnKitchenTapClose(state,tap,{id,access:identity,occurredAt},newKitchenId()));
      return load();
    },
    async check(input:KitchenTap){
      const tap=structuredClone(input);own(tap);const state=await read(),saved=state?.taps.find(row=>row.action.id===tap.action.id);
      if(!saved||JSON.stringify(saved)!==JSON.stringify(tap))throw new ScreenStorageError('changed');
      // Only a closure explicitly saved by this PIN session may be sent.
      // Earlier-session closures are looked up; their actor/time never changes.
      const intent=saved.closeIntents?.find(row=>sameKitchenSession(row.access,identity))??null;
      const outcome=await api.recoverKitchenTap(device,session,retainedKitchenTap(saved),intent,controller.signal);await verify();
      if(outcome.outcome!=='pending')await edit(latest=>outcome.receipt?finishKitchenTap(latest,saved,outcome.receipt,newKitchenId()):finishKitchenTapClose(latest,saved,outcome.closure!,newKitchenId()),outcome);
      return load();
    },
    dispose(){disposed=true;controller.abort();},
  };
}
