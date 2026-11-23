import {parseStaffDraft,parseStaffRecord,saveStaffMember,staffExact,staffId,staffObject,staffTime,type StaffDraft,type StaffRecord,type StaffScope} from './staff';
import {parseAttendanceIntent,parseStaffCheckIn,type AttendanceIntent,type StaffCheckIn} from './staff-attendance';

export interface StaffOwnerAction extends StaffScope {
 v:1;id:string;eventId:string;memberId:string;kind:'save'|'check-in';
 expected:StaffRecord|null;latest:StaffCheckIn|null;draft:StaffDraft|null;checkIn:AttendanceIntent|null;
}
export interface StaffOwnerContext extends StaffScope {v:1;serverAt:number;memberId:string;current:StaffRecord|null;latest:StaffCheckIn|null}
export interface StaffBoardEntry {staff:StaffRecord;latest:StaffCheckIn|null}
export interface StaffBoardPage extends StaffScope {v:1;serverAt:number;entries:StaffBoardEntry[];next:string|null}
export interface StaffOwnerOutcome {v:1;actionId:string;state:'pending'|'closed'|'applied';member:StaffRecord|null;checkIn:StaffCheckIn|null;serverAt:number}
const bad=()=>Error('Keep the original team action and check its current account and outlet.');
const source=(value:unknown):string=>JSON.stringify(value,(_key,row)=>staffObject(row)?Object.fromEntries(Object.entries(row).sort(([a],[b])=>a<b?-1:a>b?1:0)):row);
function scope(v:Record<string,unknown>,expected?:StaffScope):StaffScope {
 if(![v.businessId,v.outletId,v.actorId].every(staffId)||!['owner','manager'].includes(v.actorRole as string))throw bad();
 const result:StaffScope={businessId:v.businessId as string,outletId:v.outletId as string,actorId:v.actorId as string,actorRole:v.actorRole as StaffScope['actorRole']};
 if(expected&&Object.keys(result).some(key=>result[key as keyof StaffScope]!==expected[key as keyof StaffScope]))throw bad();
 return result;
}
function entry(staff:StaffRecord,latest:StaffCheckIn|null,outletId:string):StaffBoardEntry {
 if(!staff.member.outletIds.includes(outletId)||latest&&(latest.memberId!==staff.member.id||latest.outletId!==outletId))throw bad();
 return {staff,latest};
}
export function parseStaffOwnerAction(v:unknown):StaffOwnerAction {
 if(!staffObject(v)||!staffExact(v,'v,id,eventId,memberId,businessId,outletId,actorId,actorRole,kind,expected,latest,draft,checkIn')||v.v!==1||
  ![v.id,v.eventId,v.memberId].every(staffId)||!['save','check-in'].includes(v.kind as string))throw bad();
 const s=scope(v),expected=v.expected===null?null:parseStaffRecord(v.expected),latest=v.latest===null?null:parseStaffCheckIn(v.latest),
  draft=v.draft===null?null:parseStaffDraft(v.draft),checkIn=v.checkIn===null?null:parseAttendanceIntent(v.checkIn);
 if(new Set([v.id,v.eventId,v.memberId,s.businessId,s.outletId]).size!==5||v.id===s.actorId||v.eventId===s.actorId||
  expected&&(expected.member.id!==v.memberId||expected.member.businessId!==s.businessId)||latest&&(!expected||latest.memberId!==v.memberId||latest.outletId!==s.outletId)||
  v.kind==='save'&&(!draft||latest!==null||checkIn!==null)||v.kind==='check-in'&&(!expected||draft!==null||!checkIn||
   checkIn.memberId!==v.memberId||checkIn.outletId!==s.outletId||checkIn.eventId!==v.eventId||checkIn.id===v.id||checkIn.expectedLastId!==(latest?.id??null)))throw bad();
 if(expected)entry(expected,latest,s.outletId);
 return {...s,v:1,id:v.id as string,eventId:v.eventId as string,memberId:v.memberId as string,kind:v.kind as StaffOwnerAction['kind'],expected,latest,draft,checkIn};
}
export function parseStaffOwnerContext(v:unknown,expected:StaffScope,memberId:string):StaffOwnerContext {
 if(!staffObject(v)||!staffExact(v,'v,businessId,outletId,actorId,actorRole,serverAt,memberId,current,latest')||v.v!==1||!staffTime(v.serverAt)||
  !staffId(memberId)||v.memberId!==memberId)throw bad();
 const s=scope(v,expected),current=v.current===null?null:parseStaffRecord(v.current),latest=v.latest===null?null:parseStaffCheckIn(v.latest);
 if(current&&(current.member.id!==memberId||current.member.businessId!==s.businessId)||!current&&latest)throw bad();
 if(current)entry(current,latest,s.outletId);
 return {...s,v:1,serverAt:v.serverAt,memberId,current,latest};
}
export function parseStaffBoardPage(v:unknown,expected:StaffScope,after:string|null,limit:number):StaffBoardPage {
 if(!staffObject(v)||!staffExact(v,'v,businessId,outletId,actorId,actorRole,serverAt,entries,next')||v.v!==1||!staffTime(v.serverAt)||
  !Number.isSafeInteger(limit)||limit<1||limit>100||after!==null&&!staffId(after)||!Array.isArray(v.entries)||v.entries.length>limit||v.next!==null&&!staffId(v.next))throw bad();
 const s=scope(v,expected);let previous=after;
 const entries=v.entries.map(value=>{if(!staffObject(value)||!staffExact(value,'staff,latest'))throw bad();
  const staff=parseStaffRecord(value.staff),latest=value.latest===null?null:parseStaffCheckIn(value.latest);
  if(staff.member.businessId!==s.businessId||previous!==null&&staff.member.id<=previous)throw bad();previous=staff.member.id;
  return entry(staff,latest,s.outletId);
 });
 if(v.next!==null&&(!entries.length||entries.length!==limit||v.next!==previous))throw bad();
 return {...s,v:1,serverAt:v.serverAt,entries,next:v.next as string|null};
}
export function parseStaffOwnerOutcome(v:unknown,original:StaffOwnerAction):StaffOwnerOutcome {
 if(!staffObject(v)||!staffExact(v,'v,actionId,state,member,checkIn,serverAt')||v.v!==1||v.actionId!==original.id||
  !['pending','closed','applied'].includes(v.state as string)||!staffTime(v.serverAt))throw bad();
 const member=v.member===null?null:parseStaffRecord(v.member),checkIn=v.checkIn===null?null:parseStaffCheckIn(v.checkIn);
 if(v.state!=='applied'&&(member!==null||checkIn!==null)||v.state==='applied'&&(!member||
  member.member.id!==original.memberId||member.member.businessId!==original.businessId||!member.member.outletIds.includes(original.outletId)||
  original.kind==='save'&&(checkIn!==null||member.lastActionId!==original.eventId)||original.kind==='check-in'&&(!checkIn||
   checkIn.id!==original.checkIn?.id||checkIn.memberId!==original.memberId||checkIn.outletId!==original.outletId||
   checkIn.type!==original.checkIn.type||checkIn.at!==original.checkIn.occurredAt||checkIn.method!=='manual'||checkIn.recordedBy!==original.actorId)))throw bad();
 if(v.state==='applied'){
  if(original.kind==='save'){
   const command=saveStaffMember(original.draft!,{...original,current:original.expected,serverAt:v.serverAt},{memberId:original.memberId,eventId:original.eventId});
   if(source(member)!==source({member:command.member,profile:command.profile,revision:command.revision,lastActionId:original.eventId}))throw bad();
  }else if(source(member)!==source(original.expected))throw bad();
 }
 return {v:1,actionId:original.id,state:v.state as StaffOwnerOutcome['state'],member,checkIn,serverAt:v.serverAt};
}
