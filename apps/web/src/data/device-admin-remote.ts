import {parseCloudConnection,type CloudConnection} from '@mise/core/cloud-connection';
import {deviceLabel,isDeviceId,parseDeviceAdminPage,parseDevicePairing,parseDevicePairingInspection,parseSharedDevice,type DeviceAdminKind,type DeviceMode,type DevicePairing,type DevicePairingApproval} from '@mise/core/device-access';
import {bindCommandReceipt,createDeviceAdminRequest,createOwnerPinRequest,CommandRequestError,type CommandAccount,type DeviceAdminRpc} from './command-request';
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
export function createDeviceAdminRemote(input:CloudConnection,account:CommandAccount,scope:{businessId:string;outletId:string;actorId:string},send:typeof fetch=fetch){
 const config=parseCloudConnection(input),expected={businessId:scope.businessId,outletId:scope.outletId,actorId:scope.actorId};if(!Object.values(expected).every(isDeviceId))throw new CommandRequestError('review');
 const requests=new Map<DeviceAdminRpc,ReturnType<typeof createDeviceAdminRequest>>(),pinRequest=createOwnerPinRequest(config,account,send);
 function call(name:DeviceAdminRpc,body:Record<string,unknown>,signal?:AbortSignal){let run=requests.get(name);if(!run){run=createDeviceAdminRequest(config,account,name,send);requests.set(name,run);}return run(JSON.stringify(body),{'Content-Type':'application/json'},30000,signal);}
 function checked<T extends object>(value:T,guard:()=>void):T{guard();return bindCommandReceipt(value,guard);}
 function pairing(value:unknown,id:string){const p=parseDevicePairing(value);if(p.id!==id||p.businessId!==expected.businessId||p.outletId!==expected.outletId)throw new CommandRequestError('review');return p;}
 return {
  async pinContext(memberId:string,signal?:AbortSignal){
   if(!isDeviceId(memberId))throw new CommandRequestError('review');const r=await call('staff_pin_context',{p_outlet_id:expected.outletId,p_member_id:memberId,p_action:'set'},signal),v=r.value;
   if(!object(v)||!exact(v,'businessId,outletId,memberId,configured')||v.businessId!==expected.businessId||v.outletId!==expected.outletId||v.memberId!==memberId||typeof v.configured!=='boolean')throw new CommandRequestError('review');return checked({memberId,configured:v.configured,allowed:true as const},r.guard);
  },
  async page(kind:DeviceAdminKind,after:string|null=null,limit=50,signal?:AbortSignal){
   if(!['devices','pairings','members'].includes(kind)||after!==null&&!isDeviceId(after)||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new CommandRequestError('review');
   const r=await call('read_device_admin',{p_outlet_id:expected.outletId,p_kind:kind,p_after_id:after,p_limit:limit},signal);return checked(parseDeviceAdminPage(r.value,expected,kind,after,limit),r.guard);
  },
  async start(value:{id:string;eventId:string;name:string;mode:DeviceMode},signal?:AbortSignal){
   const source={...value,name:deviceLabel(value.name)};if(!isDeviceId(source.id)||!isDeviceId(source.eventId)||source.id===source.eventId||!['kitchen','counter'].includes(source.mode))throw new CommandRequestError('review');
   const r=await call('start_device_pairing',{p_id:source.id,p_event_id:source.eventId,p_outlet_id:expected.outletId,p_name:source.name,p_mode:source.mode},signal),p=pairing(r.value,source.id);
   if(p.name!==source.name||p.mode!==source.mode)throw new CommandRequestError('review');return checked(p,r.guard);
  },
  async inspect(id:string,signal?:AbortSignal){if(!isDeviceId(id))throw new CommandRequestError('review');const r=await call('inspect_device_pairing',{p_id:id},signal);return checked(parseDevicePairingInspection(r.value,expected,id),r.guard);},
  async approve(value:DevicePairing,claim:DevicePairingApproval,eventId:string,signal?:AbortSignal){
   const p=pairing(value,value.id),selected={...claim};if(!isDeviceId(selected.id)||!isDeviceId(eventId)||![selected.id,eventId].every(id=>id!==p.id)||selected.id===eventId||!/^([0-9A-F]{4}-){3}[0-9A-F]{4}$/.test(selected.verification))throw new CommandRequestError('review');
   const r=await call('approve_device_pairing',{p_pairing_id:p.id,p_request_id:selected.id,p_verification:selected.verification,p_event_id:eventId},signal),device=parseSharedDevice(r.value);
   if(device.id!==selected.id||device.businessId!==expected.businessId||device.outletId!==expected.outletId||device.name!==p.name||device.mode!==p.mode)throw new CommandRequestError('review');return checked(device,r.guard);
  },
  async cancel(id:string,eventId:string,signal?:AbortSignal){
   if(!isDeviceId(id)||!isDeviceId(eventId)||id===eventId)throw new CommandRequestError('review');const r=await call('cancel_device_pairing',{p_id:id,p_event_id:eventId},signal),p=pairing(r.value,id);if(p.closedAt===null)throw new CommandRequestError('review');return checked(p,r.guard);
  },
  async revoke(id:string,eventId:string,signal?:AbortSignal){
   if(!isDeviceId(id)||!isDeviceId(eventId)||id===eventId)throw new CommandRequestError('review');const r=await call('revoke_device',{p_id:id,p_event_id:eventId},signal),device=parseSharedDevice(r.value);
   if(device.id!==id||device.businessId!==expected.businessId||device.outletId!==expected.outletId||device.revokedAt===null)throw new CommandRequestError('review');return checked(device,r.guard);
  },
  async pin(memberId:string,action:'set'|'clear',pin?:string,signal?:AbortSignal){
   if(!isDeviceId(memberId)||!['set','clear'].includes(action)||action==='set'&&(typeof pin!=='string'||!/^\d{4}$/.test(pin))||action==='clear'&&pin!==undefined)throw new CommandRequestError('review');
   const r=await pinRequest(JSON.stringify({action,outletId:expected.outletId,memberId,...(action==='set'?{pin}:{})}),{'Content-Type':'application/json'},30000,signal),v=r.value;
   if(!object(v)||v.memberId!==memberId)throw new CommandRequestError('review');
   if(action==='clear'){if(!exact(v,'memberId,cleared')||v.cleared!==true)throw new CommandRequestError('review');return checked({memberId,cleared:true as const},r.guard);}
   if(!exact(v,'memberId,revision,changedAt')||!isDeviceId(v.revision)||typeof v.changedAt!=='number'||!Number.isSafeInteger(v.changedAt)||v.changedAt<0||v.changedAt>8640000000000000)throw new CommandRequestError('review');
   return checked({memberId,revision:v.revision,changedAt:v.changedAt},r.guard);
  },
 };
}
