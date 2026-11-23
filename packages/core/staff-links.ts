import {customerApiOrigin} from './customer-link-url';
import {parseStaffRecord,parseUsualShift,staffExact,staffId,staffObject,staffTime,type StaffRecord,type StaffScope,type UsualShift} from './staff';
import {parseAttendanceIntent,parseStaffCheckIn,parseOwnAttendanceOutcome,type OwnAttendanceOutcome,type AttendanceIntent,type StaffCheckIn} from './staff-attendance';
import type {MemberRole} from './models';

export const staffToken=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v);
export interface StaffLinkMeta {id:string;memberId:string;createdAt:number;expiresAt:number;revokedAt:number|null}
export interface StaffLinkAction extends StaffScope {v:1;id:string;eventId:string;memberId:string;linkId:string;kind:'issue'|'revoke';expected:StaffRecord|null;tokenHash:string|null;expiresAt:number|null}
export interface StaffLinkContext extends StaffScope {v:1;serverAt:number;memberId:string;current:StaffRecord|null;links:StaffLinkMeta[];next:string|null}
export interface StaffLinkOutcome {v:1;actionId:string;state:'pending'|'closed'|'applied';link:StaffLinkMeta|null;serverAt:number}
export interface StaffViewerLink {v:1;apiUrl:string;token:string}
export interface StaffHistoryCursor {at:number;id:string}
export interface StaffHistoryEntry {checkIn:StaffCheckIn;recordedByName:string}
export interface StaffView {
 v:1;memberId:string;outletId:string;shopName:string;outletName:string;timeZone:string;name:string;nameLocal:string;
 role:Exclude<MemberRole,'agent'>;language:'en'|'bn';shift:UsualShift|null;latest:StaffCheckIn|null;entries:StaffHistoryEntry[];next:StaffHistoryCursor|null;serverAt:number;
}
export interface StaffPublicRequest {token:string;operation:'read'|'submit'|'inspect'|'close';intent:AttendanceIntent|null;after:StaffHistoryCursor|null}
export type StaffPublicOutcome=OwnAttendanceOutcome;
const bad=()=>Error('Keep the complete original staff link and check-in.');
const literal=(v:unknown):string=>{if(typeof v!=='string'||v.length>4096)throw bad();const value:unknown=JSON.parse(v);if(typeof value!=='string'||value.length>160)throw bad();return value;};
const sameScope=(a:StaffScope,b:StaffScope)=>a.businessId===b.businessId&&a.outletId===b.outletId&&a.actorId===b.actorId&&a.actorRole===b.actorRole;
function scope(v:Record<string,unknown>):StaffScope {
 if(![v.businessId,v.outletId,v.actorId].every(staffId)||!['owner','manager'].includes(v.actorRole as string))throw bad();
 return {businessId:v.businessId as string,outletId:v.outletId as string,actorId:v.actorId as string,actorRole:v.actorRole as StaffScope['actorRole']};
}
export function parseStaffLinkMeta(v:unknown,memberId:string):StaffLinkMeta {
 if(!staffObject(v)||!staffExact(v,'id,memberId,createdAt,expiresAt,revokedAt')||!staffId(v.id)||v.memberId!==memberId||
  !staffTime(v.createdAt)||!staffTime(v.expiresAt)||v.expiresAt<=v.createdAt||v.expiresAt-v.createdAt>90*86400000||
  v.revokedAt!==null&&(!staffTime(v.revokedAt)||v.revokedAt<v.createdAt))throw bad();
 return {id:v.id,memberId,createdAt:v.createdAt,expiresAt:v.expiresAt,revokedAt:v.revokedAt as number|null};
}
export function parseStaffLinkAction(v:unknown):StaffLinkAction {
 if(!staffObject(v)||!staffExact(v,'v,id,eventId,memberId,linkId,kind,expected,tokenHash,expiresAt,businessId,outletId,actorId,actorRole')||v.v!==1||
  ![v.id,v.eventId,v.memberId,v.linkId].every(staffId)||new Set([v.id,v.eventId,v.memberId,v.linkId]).size!==4||!['issue','revoke'].includes(v.kind as string))throw bad();
 const s=scope(v),expected=v.expected===null?null:parseStaffRecord(v.expected);
 if([v.id,v.eventId,v.linkId].some(value=>[s.businessId,s.outletId,s.actorId].includes(value as string))||expected&&
  (expected.member.businessId!==s.businessId||expected.member.id!==v.memberId||!expected.member.outletIds.includes(s.outletId))||
  v.kind==='issue'&&(!expected||!expected.member.active||expected.member.role==='agent'||!expected.profile.methods.includes('link')||
   typeof v.tokenHash!=='string'||!/^[a-f0-9]{64}$/.test(v.tokenHash)||!staffTime(v.expiresAt))||
  v.kind==='revoke'&&(v.tokenHash!==null||v.expiresAt!==null))throw bad();
 return {...s,v:1,id:v.id as string,eventId:v.eventId as string,memberId:v.memberId as string,linkId:v.linkId as string,
  kind:v.kind as StaffLinkAction['kind'],expected,tokenHash:v.tokenHash as string|null,expiresAt:v.expiresAt as number|null};
}
export function parseStaffLinkContext(v:unknown,expected:StaffScope,memberId:string,after:string|null=null):StaffLinkContext {
 if(!staffObject(v)||!staffExact(v,'v,businessId,outletId,actorId,actorRole,serverAt,memberId,current,links,next')||v.v!==1||
  !staffTime(v.serverAt)||v.memberId!==memberId||!staffId(memberId)||!Array.isArray(v.links)||v.links.length>40||v.next!==null&&!staffId(v.next))throw bad();
 const s=scope(v);if(!sameScope(s,expected))throw bad();const current=v.current===null?null:parseStaffRecord(v.current);
 if(current&&(current.member.id!==memberId||current.member.businessId!==s.businessId||!current.member.outletIds.includes(s.outletId)))throw bad();
 let previous=after;const links=v.links.map(raw=>{const value=parseStaffLinkMeta(raw,memberId);if(previous!==null&&value.id<=previous)throw bad();previous=value.id;return value;});
 if(v.next!==null&&(links.length!==40||previous!==v.next))throw bad();
 return {...s,v:1,serverAt:v.serverAt,memberId,current,links,next:v.next as string|null};
}
export function parseStaffLinkOutcome(v:unknown,action:StaffLinkAction):StaffLinkOutcome {
 if(!staffObject(v)||!staffExact(v,'v,actionId,state,link,serverAt')||v.v!==1||v.actionId!==action.id||!staffTime(v.serverAt)||!['pending','closed','applied'].includes(v.state as string))throw bad();
 const link=v.link===null?null:parseStaffLinkMeta(v.link,action.memberId);
 if(v.state==='applied'?(!link||link.id!==action.linkId||action.kind==='issue'&&(link.createdAt!==v.serverAt||link.expiresAt!==action.expiresAt||link.revokedAt!==null)||
   action.kind==='revoke'&&(link.revokedAt===null||link.revokedAt>v.serverAt)):(link!==null))throw bad();
 return {v:1,actionId:action.id,state:v.state as StaffLinkOutcome['state'],link,serverAt:v.serverAt};
}
export function staffViewerUrl(origin:string,base:string,source:StaffViewerLink):string {
 const site=customerApiOrigin(origin),apiUrl=customerApiOrigin(source.apiUrl);
 if(!base.startsWith('/')||base.startsWith('//')||!base.endsWith('/app/')||base.includes('..')||/[?#\\\s]/.test(base)||!staffToken(source.token)||source.v!==1)throw bad();
 const url=new URL(base+'me/'+source.token,site);url.searchParams.set('flags','staffTeam');url.hash='mise-staff='+encodeURIComponent(JSON.stringify({v:1,apiUrl}));return url.href;
}
export function decodeStaffViewer(pathname:string,hash:string,base:string):StaffViewerLink {
 if(!base.startsWith('/')||base.startsWith('//')||!base.endsWith('/app/')||base.includes('..')||/[?#\\\s]/.test(base)||!pathname.startsWith(base)||hash.length>8192||!hash.startsWith('#mise-staff='))throw bad();
 const match=/^me\/([A-Za-z0-9_-]{43})\/?$/.exec(pathname.slice(base.length));if(!match)throw bad();
 const v:unknown=JSON.parse(decodeURIComponent(hash.slice(12)));if(!staffObject(v)||!staffExact(v,'v,apiUrl')||v.v!==1)throw bad();
 return {v:1,apiUrl:customerApiOrigin(v.apiUrl),token:match[1]};
}
export function parseStaffCursor(v:unknown):StaffHistoryCursor|null {
 if(v===null)return null;if(!staffObject(v)||!staffExact(v,'at,id')||!staffTime(v.at)||!staffId(v.id))throw bad();return {at:v.at,id:v.id};
}
export function parseStaffPublicRequest(v:unknown):StaffPublicRequest {
 if(!staffObject(v)||!staffExact(v,'token,operation,intent,after')||!staffToken(v.token)||!['read','submit','inspect','close'].includes(v.operation as string))throw bad();
 const intent=v.intent===null?null:parseAttendanceIntent(v.intent),after=parseStaffCursor(v.after);
 if(v.operation==='read'?intent!==null:(!intent||after!==null))throw bad();
 return {token:v.token,operation:v.operation as StaffPublicRequest['operation'],intent,after};
}
export function projectStaffView(v:unknown,after:StaffHistoryCursor|null):StaffView {
 if(!staffObject(v)||!staffExact(v,'v,memberId,outletId,shopNameJson,outletNameJson,timeZone,nameJson,nameLocalJson,role,language,shift,latest,entries,next,serverAt')||v.v!==1||
  ![v.memberId,v.outletId].every(staffId)||!staffTime(v.serverAt)||typeof v.timeZone!=='string'||!v.timeZone||
  !['owner','manager','staff','kitchen','rider'].includes(v.role as string)||!['en','bn'].includes(v.language as string)||!Array.isArray(v.entries)||v.entries.length>40)throw bad();
 new Intl.DateTimeFormat('en',{timeZone:v.timeZone});const latest=v.latest===null?null:parseStaffCheckIn(v.latest),next=parseStaffCursor(v.next);
 const scoped=(c:StaffCheckIn)=>c.memberId===v.memberId&&c.outletId===v.outletId;
 if(latest&&!scoped(latest))throw bad();let previous=after;
 const entries=v.entries.map(raw=>{if(!staffObject(raw)||!staffExact(raw,'checkIn,recordedByNameJson'))throw bad();const checkIn=parseStaffCheckIn(raw.checkIn);
  if(!scoped(checkIn)||previous&&(checkIn.at>previous.at||checkIn.at===previous.at&&checkIn.id>=previous.id))throw bad();previous={at:checkIn.at,id:checkIn.id};
  return {checkIn,recordedByName:literal(raw.recordedByNameJson)};
 });
 if(next&&(entries.length!==40||next.at!==previous?.at||next.id!==previous?.id))throw bad();
 return {v:1,memberId:v.memberId as string,outletId:v.outletId as string,shopName:literal(v.shopNameJson),outletName:literal(v.outletNameJson),timeZone:v.timeZone,
  name:literal(v.nameJson),nameLocal:literal(v.nameLocalJson),role:v.role as StaffView['role'],language:v.language as StaffView['language'],shift:parseUsualShift(v.shift),latest,entries,next,serverAt:v.serverAt};
}
export function parseStaffPublicOutcome(v:unknown,intent:AttendanceIntent):StaffPublicOutcome {
 return parseOwnAttendanceOutcome(v,intent,'link');
}
/** Decode the named HTTP projection again without importing owner Auth or DB. */
export function parseStaffView(v:unknown,after:StaffHistoryCursor|null):StaffView {
 if(!staffObject(v)||!staffExact(v,'v,memberId,outletId,shopName,outletName,timeZone,name,nameLocal,role,language,shift,latest,entries,next,serverAt')||!Array.isArray(v.entries))throw bad();
 return projectStaffView({v:v.v,memberId:v.memberId,outletId:v.outletId,shopNameJson:JSON.stringify(v.shopName),outletNameJson:JSON.stringify(v.outletName),
  timeZone:v.timeZone,nameJson:JSON.stringify(v.name),nameLocalJson:JSON.stringify(v.nameLocal),role:v.role,language:v.language,shift:v.shift,latest:v.latest,
  entries:v.entries.map(entry=>{if(!staffObject(entry)||!staffExact(entry,'checkIn,recordedByName'))throw bad();return {checkIn:entry.checkIn,recordedByNameJson:JSON.stringify(entry.recordedByName)};}),next:v.next,serverAt:v.serverAt},after);
}
