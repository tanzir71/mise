import {parseStaffDeviceAccess,isDeviceToken,type SharedDevice,type StaffDeviceSession,type StaffDeviceAccess} from './device-access';
import {parseAttendanceIntent,type AttendanceIntent,type OwnAttendanceOutcome,parseOwnAttendanceOutcome} from './staff-attendance';
import {parseStaffCursor,parseStaffView,projectStaffView,type StaffHistoryCursor,type StaffView} from './staff-links';
import {staffObject,staffExact} from './staff';
export interface StaffDeviceRequest {sessionToken:string;operation:'read'|'submit'|'inspect'|'close';intent:AttendanceIntent|null;after:StaffHistoryCursor|null}
export interface StaffDeviceView {v:1;state:'view';access:StaffDeviceAccess;view:StaffView}
const bad=()=>Error('Keep this member’s original check-in on its enrolled screen.');
export function parseStaffDeviceRequest(v:unknown):StaffDeviceRequest {
 if(!staffObject(v)||!staffExact(v,'sessionToken,operation,intent,after')||!isDeviceToken(v.sessionToken)||!['read','submit','inspect','close'].includes(v.operation as string))throw bad();
 const intent=v.intent===null?null:parseAttendanceIntent(v.intent),after=parseStaffCursor(v.after);
 if(v.operation==='read'?intent!==null:(!intent||after!==null))throw bad();
 return {sessionToken:v.sessionToken,operation:v.operation as StaffDeviceRequest['operation'],intent,after};
}
export function parseStaffDeviceView(v:unknown,after:StaffHistoryCursor|null,expected?:{device:SharedDevice;session:StaffDeviceSession},sql=false):StaffDeviceView {
 if(!staffObject(v)||!staffExact(v,'v,state,access,view')||v.v!==1||v.state!=='view')throw bad();
 const access=parseStaffDeviceAccess(v.access,expected),view=sql?projectStaffView(v.view,after):parseStaffView(v.view,after);
 if(!access.permissions.includes('staff.check-in')||access.memberId!==view.memberId||access.outletId!==view.outletId||access.role!==view.role)throw bad();
 return {v:1,state:'view',access,view};
}
export function parseStaffDeviceOutcome(v:unknown,intent:AttendanceIntent):OwnAttendanceOutcome {return parseOwnAttendanceOutcome(v,intent,'order_phone');}
