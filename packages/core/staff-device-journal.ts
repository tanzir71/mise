import {parseStaffDeviceAccess,type StaffDeviceAccess} from './device-access';
import {parseStaffDeviceView,parseStaffDeviceOutcome,type StaffDeviceView} from './staff-device';
import {parseAttendanceIntent,type AttendanceIntent,type OwnAttendanceOutcome} from './staff-attendance';
import {staffObject,staffExact,staffId} from './staff';
export interface StaffDeviceOriginal {origin:StaffDeviceAccess;screenRevision:string;intent:AttendanceIntent;name:string;nameLocal:string;language:'en'|'bn';closeRequested:boolean;outcome:OwnAttendanceOutcome|null}
export interface StaffDeviceJournal {v:1;id:string;revision:string;view:StaffDeviceView|null;actions:StaffDeviceOriginal[]}
export interface StaffDeviceScope {businessId:string;outletId:string;deviceId:string;memberId:string}
export const staffDeviceJournalLimit=8*1024*1024;
const bad=()=>Error('Keep the complete original attendance on its own screen.');
export function staffDeviceJournalId(scope:StaffDeviceScope):string {
 if(!Object.values(scope).every(staffId)||Object.keys(scope).sort().join(',')!=='businessId,deviceId,memberId,outletId')throw bad();return scope.deviceId+':'+scope.memberId;
}
export function parseStaffDeviceJournal(value:unknown,scope:StaffDeviceScope):StaffDeviceJournal {
 const id=staffDeviceJournalId(scope);
 if(!staffObject(value)||!staffExact(value,'v,id,revision,view,actions')||value.v!==1||value.id!==id||!staffId(value.revision)||!Array.isArray(value.actions)||value.actions.length>200||new TextEncoder().encode(JSON.stringify(value)).byteLength>staffDeviceJournalLimit)throw bad();
 const scoped=(a:StaffDeviceAccess)=>a.businessId===scope.businessId&&a.outletId===scope.outletId&&a.deviceId===scope.deviceId&&a.memberId===scope.memberId;
 const view=value.view===null?null:parseStaffDeviceView(value.view,null);if(view&&!scoped(view.access))throw bad();
 const seen=new Set<string>(),actions=value.actions.map(raw=>{
  if(!staffObject(raw)||!staffExact(raw,'origin,screenRevision,intent,name,nameLocal,language,closeRequested,outcome')||!staffId(raw.screenRevision)||typeof raw.name!=='string'||raw.name.length>160||typeof raw.nameLocal!=='string'||raw.nameLocal.length>160||!['en','bn'].includes(raw.language as string)||typeof raw.closeRequested!=='boolean')throw bad();
  const origin=parseStaffDeviceAccess(raw.origin),intent=parseAttendanceIntent(raw.intent);
  if(!scoped(origin)||!origin.permissions.includes('staff.check-in')||intent.memberId!==scope.memberId||intent.outletId!==scope.outletId||seen.has(intent.id)||intent.occurredAt>=origin.expiresAt)throw bad();seen.add(intent.id);
  return {origin,screenRevision:raw.screenRevision,intent,name:raw.name,nameLocal:raw.nameLocal,language:raw.language as 'en'|'bn',closeRequested:raw.closeRequested,outcome:raw.outcome===null?null:parseStaffDeviceOutcome(raw.outcome,intent)};
 });
 if(actions.slice(0,-1).some(row=>!row.outcome||row.outcome.state==='pending'))throw bad();
 return {v:1,id,revision:value.revision,view,actions};
}
