import {parseCloudConnection,type CloudConnection} from '@mise/core/cloud-connection';
import {isDeviceId} from '@mise/core/device-access';
import {parseDeskPushContext,parseDeskPushMetadata,parseDeskPushSubscription,parseDeskApplicationKey,type DeskPushContext} from '@mise/core/desk-push';
import {parseDeskTaskPage,appendDeskTaskPage,completeDeskTaskList,parseDeskAlarmSettings,type DeskTaskPage,type DeskTaskList} from '@mise/core/desk-tasks';
import {CommandRequestError,createDeskAlarmRequest,createDeskNotificationsRequest,type CommandAccount} from './command-request';
import {bindDeskReceipt} from './desk-proof';
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
export function createDeskRemote(input:CloudConnection,account:CommandAccount,scope:DeskPushContext,send:typeof fetch=fetch){
 const config=parseCloudConnection(input),expected=parseDeskPushContext(scope),notifications=createDeskNotificationsRequest(config,account,send),
  pages=createDeskAlarmRequest(config,account,'read_kitchen_alarm_task_page',send),settings=createDeskAlarmRequest(config,account,'set_kitchen_alarm_settings',send);
 const identity={accountHash:account.accountHash,targetHash:account.targetHash,scope:expected};
 const checked=<T extends object>(value:T,guard:()=>void)=>bindDeskReceipt(value,guard,identity);
 const metadata=(value:unknown,id:string)=>{
  const result=parseDeskPushMetadata(value);if(result.id!==id||result.businessId!==expected.businessId||result.outletId!==expected.outletId||result.memberId!==expected.memberId)throw new CommandRequestError('review');return result;
 };
 const call=(body:unknown,signal?:AbortSignal)=>notifications(JSON.stringify(body),{'Content-Type':'application/json'},10000,signal);
 return {
  async configuration(signal?:AbortSignal){
   const response=await call({action:'configuration',outletId:expected.outletId},signal),value=response.value;
   if(!object(value)||!exact(value,'v,context,applicationKey')||value.v!==1)throw new CommandRequestError('review');
   const context=parseDeskPushContext(value.context);if(JSON.stringify(context)!==JSON.stringify(expected))throw new CommandRequestError('review');
   return checked({v:1 as const,context,applicationKey:parseDeskApplicationKey(value.applicationKey)},response.guard);
  },
  async register(input:{id:string;eventId:string;applicationKey:string;subscription:unknown},signal?:AbortSignal){
   const source={id:input.id,eventId:input.eventId,applicationKey:parseDeskApplicationKey(input.applicationKey),subscription:parseDeskPushSubscription(input.subscription)};
   if(!isDeviceId(source.id)||!isDeviceId(source.eventId)||source.id===source.eventId)throw new CommandRequestError('review');
   const response=await call({action:'register',...source,outletId:expected.outletId},signal),result=metadata(response.value,source.id);
   if(result.revokedAt!==null)throw new CommandRequestError('review');return checked({action:'register' as const,id:source.id,eventId:source.eventId,subscription:result},response.guard);
  },
  async read(id:string,signal?:AbortSignal){
   if(!isDeviceId(id))throw new CommandRequestError('review');const response=await call({action:'read',id},signal);
   return checked({action:'read' as const,id,subscription:response.value===null?null:metadata(response.value,id)},response.guard);
  },
  async revoke(id:string,eventId:string,signal?:AbortSignal){
   if(!isDeviceId(id)||!isDeviceId(eventId)||id===eventId)throw new CommandRequestError('review');const response=await call({action:'revoke',id,eventId},signal),result=response.value===null?null:metadata(response.value,id);
   if(result&&result.revokedAt===null)throw new CommandRequestError('review');return checked({action:'revoke' as const,id,eventId,subscription:result},response.guard);
  },
  async tasks(signal?:AbortSignal):Promise<DeskTaskList>{
   let current:DeskTaskPage|null=null,guard:(()=>void)|null=null;
   do{
    const response=await pages(JSON.stringify({p_outlet_id:expected.outletId,p_after_due:current?.next?.dueAt??null,p_after_id:current?.next?.id??null,p_version:current?.version??null,p_limit:50}),{'Content-Type':'application/json'},10000,signal);
    response.guard();const page=parseDeskTaskPage(response.value,expected,current?.next??null);current=current?appendDeskTaskPage(current,page):page;guard=response.guard;
   }while(current.next!==null);
   return checked(completeDeskTaskList(current),guard!);
  },
  async setSettings(input:{enabled:boolean;minutes:number;revision:number;eventId:string},signal?:AbortSignal){
   const source={...parseDeskAlarmSettings({enabled:input.enabled,minutes:input.minutes,revision:input.revision}),eventId:input.eventId};
   if(!isDeviceId(source.eventId)||source.revision===Number.MAX_SAFE_INTEGER)throw new CommandRequestError('review');
   const response=await settings(JSON.stringify({p_outlet_id:expected.outletId,p_expected_revision:source.revision,p_enabled:source.enabled,p_minutes:source.minutes,p_event_id:source.eventId}),{'Content-Type':'application/json'},10000,signal),value=response.value;
   if(!object(value)||!exact(value,'enabled,minutes,revision,expectedRevision,updatedAt')||value.enabled!==source.enabled||value.minutes!==source.minutes||value.revision!==source.revision+1||value.expectedRevision!==source.revision||!time(value.updatedAt))throw new CommandRequestError('review');
   const result={action:'settings' as const,outletId:expected.outletId,eventId:source.eventId,...parseDeskAlarmSettings({enabled:value.enabled,minutes:value.minutes,revision:value.revision}),expectedRevision:source.revision,updatedAt:value.updatedAt};return checked(result,response.guard);
  },
 };
}
export type DeskRemote=ReturnType<typeof createDeskRemote>;
