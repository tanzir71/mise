import {parseCloudConnection,type CloudConnection} from './cloud-connection';

export const deviceLifetime=90*86400000,pairingLifetime=600000,deviceSessionLifetime=43200000;
export type DeviceMode='kitchen'|'counter';
export interface SharedDevice {id:string;businessId:string;outletId:string;name:string;mode:DeviceMode;createdAt:number;expiresAt:number;revokedAt:number|null}
export interface DevicePairing {v:1;id:string;businessId:string;outletId:string;name:string;mode:DeviceMode;code:string;createdAt:number;expiresAt:number;closedAt:number|null;deviceId:string|null}
export interface PairingRequest {v:1;id:string;verification:string;expiresAt:number}
export type PairingOutcome={v:1;state:'waiting';id:string;verification:string;expiresAt:number}|{v:1;state:'expired'|'cancelled';id:string}|{v:1;state:'approved';id:string;device:SharedDevice;outletNameJson:string};
export interface DeviceDirectory {v:1;device:SharedDevice;outletNameJson:string;members:{id:string;nameJson:string}[];next:string|null}
export interface SharedDeviceCredential {v:1;connection:CloudConnection;device:SharedDevice;token:string}
export interface ScreenSetupLink {v:1;connection:CloudConnection;pairingId:string;code:string}
export interface StaffDeviceSession {id:string;token:string;deviceId:string;memberId:string;createdAt:number;expiresAt:number}
export interface StaffDeviceAccess {v:1;sessionId:string;deviceId:string;businessId:string;outletId:string;memberId:string;role:'staff'|'kitchen'|'rider';mode:DeviceMode;permissions:string[];expiresAt:number}
export interface DeviceAdminMember {id:string;nameJson:string;role:'owner'|'manager'|'staff'|'kitchen'|'rider'|'agent';active:boolean;assigned:boolean;configured:boolean}
export type DeviceAdminKind='devices'|'pairings'|'members';
export type DeviceAdminPage={v:1;businessId:string;outletId:string;actorId:string;actorRole:'owner'|'manager';next:string|null}&({kind:'devices';entries:SharedDevice[]}|{kind:'pairings';entries:DevicePairing[]}|{kind:'members';entries:DeviceAdminMember[]});
export interface DevicePairingApproval {id:string;verification:string;createdAt:number;approvedAt:number|null}
export interface DevicePairingInspection {v:1;businessId:string;outletId:string;actorId:string;actorRole:'owner'|'manager';pairing:DevicePairing;requests:DevicePairingApproval[]}

const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
export const isDeviceId=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
export const isDeviceToken=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
const mode=(v:unknown):v is DeviceMode=>v==='kitchen'||v==='counter';
const verification=(v:unknown):v is string=>typeof v==='string'&&/^[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/.test(v);
const literal=(v:unknown):v is string=>{if(typeof v!=='string')return false;try{return typeof JSON.parse(v)==='string';}catch{return false;}};
export function deviceLabel(value:unknown):string{
 if(typeof value!=='string'||!value.trim()||Array.from(value.trim()).length>80||/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value))throw Error('Name this screen using up to 80 characters.');
 return value.trim();
}
export function pairingCode(value:unknown):string{
 if(typeof value!=='string')throw Error('Enter the six-digit pairing code.');
 const code=value.replace(/[০-৯]/g,d=>String(d.charCodeAt(0)-0x09e6)).replace(/[\s-]/g,'');
 if(!/^\d{6}$/.test(code))throw Error('Enter the six-digit pairing code.');return code;
}
/** A verification value is compared on both screens; the short code alone is
 * never authority to issue a device credential. */
export function deviceVerification(tokenHash:string):string{
 if(!/^[a-f0-9]{64}$/.test(tokenHash))throw Error('Keep the complete screen verification.');
 return tokenHash.slice(0,16).toUpperCase().match(/.{4}/g)!.join('-');
}
export function newDeviceSecret():string{
 const bytes=crypto.getRandomValues(new Uint8Array(32));return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
export async function deviceSecretHash(secret:string):Promise<string>{
 if(!isDeviceToken(secret))throw Error('Keep the original screen credential.');
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret))),b=>b.toString(16).padStart(2,'0')).join('');
}
export function parseSharedDevice(value:unknown):SharedDevice{
 if(!object(value)||!exact(value,'id,businessId,outletId,name,mode,createdAt,expiresAt,revokedAt')||![value.id,value.businessId,value.outletId].every(isDeviceId)||!mode(value.mode)||!time(value.createdAt)||!time(value.expiresAt)||value.expiresAt-value.createdAt!==deviceLifetime||value.revokedAt!==null&&(!time(value.revokedAt)||value.revokedAt<value.createdAt))throw Error('Review this screen’s enrollment.');
 // Older enrollments allowed surrounding spaces and literal control text.
 // Retain that metadata; only new labels use the normalized input validator.
 if(typeof value.name!=='string'||!value.name.trim()||Array.from(value.name.trim()).length>80)throw Error('Keep the original screen name.');const name=value.name;
 return {id:value.id as string,businessId:value.businessId as string,outletId:value.outletId as string,name,mode:value.mode,createdAt:value.createdAt,expiresAt:value.expiresAt,revokedAt:value.revokedAt as number|null};
}
export function parseDevicePairing(value:unknown):DevicePairing{
 if(!object(value)||!exact(value,'v,id,businessId,outletId,name,mode,code,createdAt,expiresAt,closedAt,deviceId')||value.v!==1||![value.id,value.businessId,value.outletId].every(isDeviceId)||!mode(value.mode)||typeof value.code!=='string'||!/^\d{6}$/.test(value.code)||!time(value.createdAt)||!time(value.expiresAt)||value.expiresAt-value.createdAt!==pairingLifetime||value.closedAt!==null&&(!time(value.closedAt)||value.closedAt<value.createdAt)||value.deviceId!==null&&!isDeviceId(value.deviceId)||value.deviceId!==null&&value.closedAt===null)throw Error('Keep the original pairing request.');
 const name=deviceLabel(value.name);if(name!==value.name)throw Error('Keep the original screen name.');
 return {v:1,id:value.id as string,businessId:value.businessId as string,outletId:value.outletId as string,name,mode:value.mode,code:value.code,createdAt:value.createdAt,expiresAt:value.expiresAt,closedAt:value.closedAt as number|null,deviceId:value.deviceId as string|null};
}
export function parsePairingRequest(value:unknown,expected:{id:string;tokenHash:string}):PairingRequest{
 if(!object(value)||!exact(value,'v,id,verification,expiresAt')||value.v!==1||!isDeviceId(value.id)||value.id!==expected.id||!verification(value.verification)||value.verification!==deviceVerification(expected.tokenHash)||!time(value.expiresAt))throw Error('Keep the original screen verification.');
 return {v:1,id:value.id,verification:value.verification,expiresAt:value.expiresAt};
}
export function parsePairingOutcome(value:unknown,expected:{id:string;tokenHash:string}):PairingOutcome{
 if(!object(value)||value.v!==1||!isDeviceId(value.id)||value.id!==expected.id)throw Error('Keep the original screen request.');
 if(value.state==='waiting'){
  if(!exact(value,'v,state,id,verification,expiresAt'))throw Error('Keep the original screen verification.');
  return {...parsePairingRequest({v:1,id:value.id,verification:value.verification,expiresAt:value.expiresAt},expected),state:'waiting'};
 }
 if(value.state==='expired'||value.state==='cancelled'){
  if(!exact(value,'v,state,id'))throw Error('Review this screen’s pairing status.');return {v:1,state:value.state,id:value.id};
 }
 if(value.state==='approved'&&exact(value,'v,state,id,device,outletNameJson')&&literal(value.outletNameJson)){
  const device=parseSharedDevice(value.device);if(device.id!==expected.id||device.revokedAt!==null)throw Error('Keep the approved screen identity.');
  return {v:1,state:'approved',id:value.id,device,outletNameJson:value.outletNameJson};
 }
 throw Error('Review this screen’s pairing status.');
}
export function parseDeviceDirectory(value:unknown,expected:SharedDevice,after:string|null=null,limit=50):DeviceDirectory{
 if(!Number.isSafeInteger(limit)||limit<1||limit>100||after!==null&&!isDeviceId(after)||!object(value)||!exact(value,'v,device,outletNameJson,members,next')||value.v!==1||!literal(value.outletNameJson)||!Array.isArray(value.members)||value.members.length>limit||value.next!==null&&!isDeviceId(value.next))throw Error('Check the current screen access.');
 const device=parseSharedDevice(value.device);if(device.revokedAt!==null||[device.id,device.businessId,device.outletId,device.mode].join(',')!==[expected.id,expected.businessId,expected.outletId,expected.mode].join(','))throw Error('Keep the original screen and outlet.');
 let previous=after??'';const members=value.members.map(member=>{
  if(!object(member)||!exact(member,'id,nameJson')||!isDeviceId(member.id)||member.id<=previous||!literal(member.nameJson))throw Error('Check the current staff list.');previous=member.id;return {id:member.id,nameJson:member.nameJson};
 });
 if(value.next!==null&&(members.length!==limit||value.next!==members.at(-1)?.id))throw Error('Keep the complete staff page.');
 return {v:1,device,outletNameJson:value.outletNameJson,members,next:value.next as string|null};
}
/** Runtime-only state, separate from the shop and its portable backup. */
export function parseSharedDeviceCredential(value:unknown):SharedDeviceCredential{
 if(!object(value)||!exact(value,'v,connection,device,token')||value.v!==1||!isDeviceToken(value.token))throw Error('Review this screen’s saved enrollment.');
 return {v:1,connection:parseCloudConnection(value.connection),device:parseSharedDevice(value.device),token:value.token};
}
/** Setup links contain connection/pairing details, never a device/session secret. */
export function parseScreenSetupLink(value:unknown):ScreenSetupLink{
 if(!object(value)||!exact(value,'v,connection,pairingId,code')||value.v!==1||!isDeviceId(value.pairingId)||typeof value.code!=='string'||value.code!==pairingCode(value.code))throw Error('Use the complete screen setup link.');
 return {v:1,connection:parseCloudConnection(value.connection),pairingId:value.pairingId,code:value.code};
}
export function parseStaffDeviceSession(value:unknown,expected:{deviceId:string;memberId:string}):StaffDeviceSession{
 if(!object(value)||!exact(value,'id,token,deviceId,memberId,createdAt,expiresAt')||![value.id,value.deviceId,value.memberId].every(isDeviceId)||!isDeviceToken(value.token)||value.deviceId!==expected.deviceId||value.memberId!==expected.memberId||!time(value.createdAt)||!time(value.expiresAt)||value.expiresAt-value.createdAt!==deviceSessionLifetime)throw Error('Keep the verified staff session on its original screen.');
 return {id:value.id as string,token:value.token,deviceId:value.deviceId as string,memberId:value.memberId as string,createdAt:value.createdAt,expiresAt:value.expiresAt};
}
/** Structural transport validation is not authority; SQL checks live access on
 * every call, and the browser also pins its original device/member/session. */
export function parseStaffDeviceAccess(value:unknown,expected?:{device:SharedDevice;session:StaffDeviceSession}):StaffDeviceAccess{
 if(!object(value)||!exact(value,'v,sessionId,deviceId,businessId,outletId,memberId,role,mode,permissions,expiresAt')||value.v!==1||![value.sessionId,value.deviceId,value.businessId,value.outletId,value.memberId].every(isDeviceId)||!['staff','kitchen','rider'].includes(value.role as string)||!mode(value.mode)||!time(value.expiresAt)||!Array.isArray(value.permissions))throw Error('Check the current staff access.');
 const attendanceOnly=value.role==='rider'||value.role==='kitchen'&&value.mode==='counter';
 const allowed=attendanceOnly?['staff.check-in']:['staff.check-in',...(value.mode==='kitchen'?['orders.read','orders.acknowledge','orders.ready']:['counter.sell','orders.read','orders.create','orders.price','orders.acknowledge','orders.ready','khata.read','khata.collect'])];
 let last='';const permissions=value.permissions.map(p=>{if(typeof p!=='string'||!allowed.includes(p)||p<=last)throw Error('Check the current screen permissions.');last=p;return p;});
 if(attendanceOnly&&(permissions.length!==1||permissions[0]!=='staff.check-in'))throw Error('Check this member’s attendance-only access.');
 if(expected&&([value.deviceId,value.businessId,value.outletId,value.mode,value.sessionId,value.memberId,value.expiresAt].join(',')!==[expected.device.id,expected.device.businessId,expected.device.outletId,expected.device.mode,expected.session.id,expected.session.memberId,expected.session.expiresAt].join(',')))throw Error('Keep the original screen, outlet and staff session.');
 return {v:1,sessionId:value.sessionId as string,deviceId:value.deviceId as string,businessId:value.businessId as string,outletId:value.outletId as string,memberId:value.memberId as string,role:value.role as StaffDeviceAccess['role'],mode:value.mode,permissions,expiresAt:value.expiresAt};
}
export function parseDeviceAdminPage(value:unknown,expected:{businessId:string;outletId:string;actorId:string},kind:DeviceAdminKind,after:string|null=null,limit=50):DeviceAdminPage{
 if(!object(value)||!exact(value,'v,businessId,outletId,actorId,actorRole,kind,entries,next')||value.v!==1||value.kind!==kind||!['owner','manager'].includes(value.actorRole as string)||![value.businessId,value.outletId,value.actorId].every(isDeviceId)||[value.businessId,value.outletId,value.actorId].join(',')!==[expected.businessId,expected.outletId,expected.actorId].join(',')||!Number.isSafeInteger(limit)||limit<1||limit>100||after!==null&&!isDeviceId(after)||!Array.isArray(value.entries)||value.entries.length>limit||value.next!==null&&!isDeviceId(value.next)||kind==='members'&&value.actorRole!=='owner')throw Error('Check the original outlet and operator before managing screens.');
 let previous=after??'';
 const entries=value.entries.map(entry=>{
  if(!object(entry)||!isDeviceId(entry.id)||entry.id<=previous)throw Error('Keep the complete device settings page.');previous=entry.id;
  if(kind==='devices'||kind==='pairings'){
   const parsed=kind==='devices'?parseSharedDevice(entry):parseDevicePairing(entry);if(parsed.businessId!==expected.businessId||parsed.outletId!==expected.outletId)throw Error('Keep each screen in its original outlet.');return parsed;
  }
  if(!exact(entry,'id,nameJson,role,active,assigned,configured')||!literal(entry.nameJson)||!['owner','manager','staff','kitchen','rider','agent'].includes(entry.role as string)||typeof entry.active!=='boolean'||typeof entry.assigned!=='boolean'||typeof entry.configured!=='boolean')throw Error('Check the current staff PIN settings.');
  return {id:entry.id,nameJson:entry.nameJson,role:entry.role,active:entry.active,assigned:entry.assigned,configured:entry.configured} as DeviceAdminMember;
 });
 if(value.next!==null&&(entries.length!==limit||value.next!==entries.at(-1)?.id))throw Error('Keep the complete device settings continuation.');
 return {v:1,businessId:expected.businessId,outletId:expected.outletId,actorId:expected.actorId,actorRole:value.actorRole,next:value.next,kind,entries} as DeviceAdminPage;
}
export function parseDevicePairingInspection(value:unknown,expected:{businessId:string;outletId:string;actorId:string},pairingId:string):DevicePairingInspection{
 if(!object(value)||!exact(value,'v,businessId,outletId,actorId,actorRole,pairing,requests')||value.v!==1||![value.businessId,value.outletId,value.actorId].every(isDeviceId)||!['owner','manager'].includes(value.actorRole as string)||[value.businessId,value.outletId,value.actorId].join(',')!==[expected.businessId,expected.outletId,expected.actorId].join(',')||!Array.isArray(value.requests)||value.requests.length>5)throw Error('Check the original pairing and outlet.');
 const pairing=parseDevicePairing(value.pairing);if(pairing.id!==pairingId||pairing.businessId!==expected.businessId||pairing.outletId!==expected.outletId)throw Error('Keep the original pairing identity.');
 let previous:{id:string;createdAt:number}|null=null;const requests=value.requests.map(row=>{
  if(!object(row)||!exact(row,'id,verification,createdAt,approvedAt')||!isDeviceId(row.id)||!verification(row.verification)||!time(row.createdAt)||row.createdAt<pairing.createdAt||row.createdAt>=pairing.expiresAt||row.approvedAt!==null&&(!time(row.approvedAt)||row.approvedAt<row.createdAt||row.approvedAt>=pairing.expiresAt)||previous&&(row.createdAt<previous.createdAt||row.createdAt===previous.createdAt&&row.id<=previous.id))throw Error('Keep each original screen verification.');
  previous={id:row.id,createdAt:row.createdAt};return {id:row.id,verification:row.verification,createdAt:row.createdAt,approvedAt:row.approvedAt as number|null};
 });
 if(new Set(requests.map(row=>row.id)).size!==requests.length||requests.filter(row=>row.approvedAt!==null).length>1)throw Error('Keep distinct original screen requests.');
 const approved=requests.find(row=>row.approvedAt!==null);if(pairing.deviceId!==null?approved?.id!==pairing.deviceId||approved.approvedAt!==pairing.closedAt:approved!==undefined)throw Error('Keep the actual approved screen and its original outcome.');
 return {v:1,...expected,actorRole:value.actorRole as 'owner'|'manager',pairing,requests};
}
