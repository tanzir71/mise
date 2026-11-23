import type {AuditEvent} from './models';
import {parseStaffRecord,parseUsualShift,staffExact,staffId,staffObject,staffTime,type StaffRecord,type StaffScope,type UsualShift} from './staff';

export type CheckInType='in'|'out'|'break';
export type CheckInMethod='manual'|'order_phone'|'link'|'group';
export interface StaffCheckIn {id:string;outletId:string;memberId:string;at:number;type:CheckInType;method:CheckInMethod;recordedBy:string}
export interface AttendanceIntent {v:1;id:string;eventId:string;memberId:string;outletId:string;type:CheckInType;occurredAt:number;expectedLastId:string|null}
export interface AttendanceContext {
 businessId:string;outletId:string;member:StaffRecord;latest:StaffCheckIn|null;
 recorder:{memberId:string;method:CheckInMethod;kind:'member'|'system';id:string};serverAt:number;
}
export interface AttendanceCommand {checkIn:StaffCheckIn;event:AuditEvent}
const bad=()=>Error('Review the current check-in. Your original choice is retained.');
export function parseStaffCheckIn(v:unknown):StaffCheckIn {
 if(!staffObject(v)||!staffExact(v,'id,outletId,memberId,at,type,method,recordedBy')||
  ![v.id,v.outletId,v.memberId,v.recordedBy].every(staffId)||!staffTime(v.at)||
  !['in','out','break'].includes(v.type as string)||!['manual','order_phone','link','group'].includes(v.method as string))throw bad();
 return {id:v.id as string,outletId:v.outletId as string,memberId:v.memberId as string,at:v.at,
  type:v.type as CheckInType,method:v.method as CheckInMethod,recordedBy:v.recordedBy as string};
}
export function parseAttendanceIntent(v:unknown):AttendanceIntent {
 if(!staffObject(v)||!staffExact(v,'v,id,eventId,memberId,outletId,type,occurredAt,expectedLastId')||v.v!==1||
  ![v.id,v.eventId,v.memberId,v.outletId].every(staffId)||new Set([v.id,v.eventId,v.memberId,v.outletId]).size!==4||
  v.expectedLastId!==null&&(!staffId(v.expectedLastId)||[v.id,v.eventId,v.memberId,v.outletId].includes(v.expectedLastId))||
  !['in','out','break'].includes(v.type as string)||!staffTime(v.occurredAt))throw bad();
 return {v:1,id:v.id as string,eventId:v.eventId as string,memberId:v.memberId as string,outletId:v.outletId as string,
  type:v.type as CheckInType,occurredAt:v.occurredAt,expectedLastId:v.expectedLastId as string|null};
}
export function attendanceCommand(value:AttendanceIntent,context:AttendanceContext):AttendanceCommand {
 const intent=parseAttendanceIntent(value),record=parseStaffRecord(context.member),latest=context.latest===null?null:parseStaffCheckIn(context.latest),r=context.recorder;
 if(![context.businessId,context.outletId,r.memberId].every(staffId)||!staffTime(context.serverAt)||
  record.member.businessId!==context.businessId||record.member.id!==intent.memberId||context.outletId!==intent.outletId||
  !record.member.outletIds.includes(context.outletId)||!record.member.active||record.member.role==='agent'||
  latest&&(latest.memberId!==intent.memberId||latest.outletId!==intent.outletId)||
  intent.expectedLastId!==(latest?.id??null)||intent.occurredAt<record.member.createdAt||
  intent.occurredAt>context.serverAt+300000||latest&&(intent.occurredAt<latest.at||intent.occurredAt===latest.at&&intent.id<=latest.id)||
  !['manual','order_phone','link','group'].includes(r.method)||!['member','system'].includes(r.kind)||
  typeof r.id!=='string'||!r.id||r.id.length>160||/[\u0000-\u001f]/.test(r.id))throw bad();
 // The transport supplies the actual authorized method and recorder. A bearer
 // link records only its own member; manager and shared-device paths are separate.
 if(r.method!=='manual'&&!record.profile.methods.includes(r.method)||r.method==='link'&&r.memberId!==intent.memberId||
  r.kind==='member'&&r.id!==r.memberId||r.method==='manual'&&r.kind!=='member')throw bad();
 const state=latest?.type??'out';
 if(intent.type===state||intent.type==='break'&&state!=='in'||intent.type==='out'&&state==='out')throw Error('This member’s recorded presence has already changed. Review it before another tap.');
 const checkIn:StaffCheckIn={id:intent.id,outletId:intent.outletId,memberId:intent.memberId,at:intent.occurredAt,
  type:intent.type,method:r.method,recordedBy:r.memberId};
 return {checkIn,event:{id:intent.eventId,outletId:intent.outletId,actor:{type:r.kind,id:r.id},command:'staff.check-in',
  before:latest,after:checkIn,at:context.serverAt}};
}

export function manualAttendanceContext(scope:StaffScope,member:StaffRecord,latest:StaffCheckIn|null,serverAt:number):AttendanceContext {
 if(!['owner','manager'].includes(scope.actorRole)||!staffId(scope.actorId))throw bad();
 return {businessId:scope.businessId,outletId:scope.outletId,member,latest,serverAt,
  recorder:{memberId:scope.actorId,id:scope.actorId,method:'manual',kind:'member'}};
}

/** The reader must supply a complete, scoped window plus its actual predecessor.
 * Missing history must never be presented as zero hours or guessed wages. */
export function recordedAttendanceMs(input:{memberId:string;outletId:string;start:number;end:number;complete:boolean;before:StaffCheckIn|null;entries:StaffCheckIn[]}):number|null {
 if(!staffId(input.memberId)||!staffId(input.outletId)||!staffTime(input.start)||!staffTime(input.end)||input.end<input.start||
  typeof input.complete!=='boolean'||!Array.isArray(input.entries)||input.entries.length>10000)throw bad();
 const before=input.before===null?null:parseStaffCheckIn(input.before),entries=input.entries.map(parseStaffCheckIn),seen=new Set<string>(before?[before.id]:[]);
 const scoped=(c:StaffCheckIn)=>c.memberId===input.memberId&&c.outletId===input.outletId;
 if(before&&(!scoped(before)||before.at>=input.start))throw bad();
 let previous=before;
 for(const row of entries){if(!scoped(row)||row.at<input.start||row.at>input.end||seen.has(row.id)||
   previous&&(row.at<previous.at||row.at===previous.at&&row.id<=previous.id))throw bad();seen.add(row.id);previous=row;}
 if(!input.complete)return null;
 let state=before?.type??'out',at=input.start,total=0;
 for(const row of entries){if(state==='in')total+=row.at-at;state=row.type;at=row.at;}
 if(state==='in')total+=input.end-at;
 return total;
}

export interface ShiftExpectation {state:'due'|'upcoming'|'none';start:number|null;end:number|null;previousDay:boolean}
/** Compare the actual outlet-local clock, including an overnight shift's
 * preceding weekday. No device timezone, auto check-in or guessed roster. */
export function usualShiftExpectation(value:UsualShift|null,at:number,timeZone:string):ShiftExpectation {
 const shift=parseUsualShift(value);if(!staffTime(at)||typeof timeZone!=='string'||!timeZone)throw bad();
 let parts:Intl.DateTimeFormatPart[];
 try{parts=new Intl.DateTimeFormat('en-GB',{timeZone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at);}catch{throw bad();}
 if(!shift)return {state:'none',start:null,end:null,previousDay:false};
 const get=(key:string)=>parts.find(p=>p.type===key)?.value,day=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(get('weekday')??''),minute=Number(get('hour'))*60+Number(get('minute'));
 if(day<0||!Number.isInteger(minute)||minute<0||minute>1439)throw bad();
 const today=shift.days.includes(day),overnight=shift.end<shift.start,previousDay=overnight&&shift.days.includes((day+6)%7)&&minute<shift.end;
 const due=previousDay||today&&(minute>=shift.start&&(overnight||minute<shift.end));
 return {state:due?'due':today&&minute<shift.start?'upcoming':'none',start:shift.start,end:shift.end,previousDay};
}
