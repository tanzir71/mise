import {isDeviceToken,parseStaffDeviceAccess,type SharedDevice,type StaffDeviceSession,type StaffDeviceAccess} from './device-access';
import {staffObject,staffExact,staffId,staffTime,parseUsualShift,type UsualShift} from './staff';
import type {CheckInMethod,CheckInType} from './staff-attendance';
export interface StaffDeviceBoardRequest {operation:'board';sessionToken:string;after:string|null}
export interface StaffDeviceBoardMember {id:string;name:string;nameLocal:string;role:'owner'|'manager'|'staff'|'kitchen'|'rider';station:string;shift:UsualShift|null;canSignIn:boolean;latest:{at:number;type:CheckInType;method:CheckInMethod;recordedByName:string}|null}
export interface StaffDeviceBoard {v:1;state:'board';access:StaffDeviceAccess;outletName:string;timeZone:string;serverAt:number;members:StaffDeviceBoardMember[];next:string|null}
const bad=()=>Error('Check the current outlet and your own PIN before using this board.');
function literal(v:unknown):string {if(typeof v!=='string')throw bad();const s:unknown=JSON.parse(v);if(typeof s!=='string')throw bad();return s;}
export function parseStaffDeviceBoardRequest(v:unknown):StaffDeviceBoardRequest {
 if(!staffObject(v)||!staffExact(v,'operation,sessionToken,after')||v.operation!=='board'||!isDeviceToken(v.sessionToken)||v.after!==null&&!staffId(v.after))throw bad();
 return {operation:'board',sessionToken:v.sessionToken,after:v.after as string|null};
}
export function parseStaffDeviceBoard(v:unknown,after:string|null=null,expected?:{device:SharedDevice;session:StaffDeviceSession},sql=false):StaffDeviceBoard {
 if(after!==null&&!staffId(after)||!staffObject(v)||!staffExact(v,sql?'v,state,access,outletNameJson,timeZone,serverAt,members,next':'v,state,access,outletName,timeZone,serverAt,members,next')||v.v!==1||v.state!=='board'||!staffTime(v.serverAt)||typeof v.timeZone!=='string'||!v.timeZone||!Array.isArray(v.members)||v.members.length>50||v.next!==null&&!staffId(v.next))throw bad();
 const access=parseStaffDeviceAccess(v.access,expected);if(!access.permissions.includes('staff.check-in')||access.expiresAt<=v.serverAt)throw bad();new Intl.DateTimeFormat('en',{timeZone:v.timeZone});
 const outletName=sql?literal(v.outletNameJson):v.outletName;if(typeof outletName!=='string')throw bad();let previous=after??'';
 const members=v.members.map(raw=>{
  if(!staffObject(raw)||!staffExact(raw,sql?'id,nameJson,nameLocalJson,role,stationJson,shift,canSignIn,latest':'id,name,nameLocal,role,station,shift,canSignIn,latest')||!staffId(raw.id)||raw.id<=previous||!['owner','manager','staff','kitchen','rider'].includes(raw.role as string)||typeof raw.canSignIn!=='boolean')throw bad();previous=raw.id;
  const name=sql?literal(raw.nameJson):raw.name,nameLocal=sql?literal(raw.nameLocalJson):raw.nameLocal,station=sql?literal(raw.stationJson):raw.station;
  if(typeof name!=='string'||typeof nameLocal!=='string'||typeof station!=='string')throw bad();
  let latest:StaffDeviceBoardMember['latest']=null;
  if(raw.latest!==null){const l=raw.latest;if(!staffObject(l)||!staffExact(l,sql?'at,type,method,recordedByNameJson':'at,type,method,recordedByName')||!staffTime(l.at)||!['in','out','break'].includes(l.type as string)||!['manual','order_phone','link','group'].includes(l.method as string))throw bad();const recordedByName=sql?literal(l.recordedByNameJson):l.recordedByName;if(typeof recordedByName!=='string')throw bad();latest={at:l.at,type:l.type as CheckInType,method:l.method as CheckInMethod,recordedByName};}
  return {id:raw.id,name,nameLocal,station,role:raw.role as StaffDeviceBoardMember['role'],shift:parseUsualShift(raw.shift),canSignIn:raw.canSignIn,latest};
 });
 if(v.next!==null&&(members.length!==50||v.next!==previous))throw bad();
 return {v:1,state:'board',access,outletName,timeZone:v.timeZone,serverAt:v.serverAt,members,next:v.next as string|null};
}
