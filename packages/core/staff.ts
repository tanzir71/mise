import type {AuditEvent,Member,MemberRole} from './models';

export const staffMethods=['order_phone','link','group'] as const;
export type StaffMethod=typeof staffMethods[number];
export interface StaffPermissions {confirmOrders:boolean;updateStock:boolean;viewOwnPerformance:boolean}
/** Sunday is 0. An end before the start belongs to the following calendar day. */
export interface UsualShift {days:number[];start:number;end:number}
export interface StaffProfile {
 nameLocal:string;station:string;language:'en'|'bn';whatsapp:boolean;
 methods:StaffMethod[];permissions:StaffPermissions;shift:UsualShift|null;
}
export interface StaffDraft extends StaffProfile {name:string;phone:string|null;role:MemberRole;active:boolean}
export interface StaffRecord {member:Member;profile:StaffProfile;revision:number;lastActionId:string|null}
export interface StaffScope {businessId:string;outletId:string;actorId:string;actorRole:'owner'|'manager'}
export interface StaffSaveContext extends StaffScope {current:StaffRecord|null;serverAt:number}
export interface StaffSaveCommand {member:Member;profile:StaffProfile;revision:number;event:AuditEvent}

export const staffId=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
export const staffTime=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
export const staffObject=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export const staffExact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const bad=()=>Error('Review this team member and the current outlet before saving.');
const roles=['owner','manager','staff','kitchen','rider','agent'] as const;
// Names go into the existing bounded member column as a JSON string. Reject
// control characters and malformed Unicode rather than silently changing it.
const label=(v:unknown,max:number):v is string=>typeof v==='string'&&v===v.trim()&&Array.from(v).length<=max&&
 !/[\u0000-\u001f\u007f]/.test(v)&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)&&JSON.stringify(v).length<=160;

export function emptyStaffProfile():StaffProfile {
 return {nameLocal:'',station:'',language:'en',whatsapp:false,methods:[],permissions:{confirmOrders:false,updateStock:false,viewOwnPerformance:false},shift:null};
}
export function parseUsualShift(v:unknown):UsualShift|null {
 if(v===null)return null;
 if(!staffObject(v)||!staffExact(v,'days,start,end')||!Array.isArray(v.days)||!v.days.length||v.days.length>7||
  !v.days.every((d,i,days)=>Number.isInteger(d)&&d>=0&&d<=6&&(i===0||d>days[i-1]))||
  !Number.isInteger(v.start)||!Number.isInteger(v.end)||(v.start as number)<0||(v.start as number)>1439||
  (v.end as number)<0||(v.end as number)>1439||v.start===v.end)throw bad();
 return {days:[...v.days] as number[],start:v.start as number,end:v.end as number};
}
export function parseStaffProfile(v:unknown):StaffProfile {
 if(!staffObject(v)||!staffExact(v,'nameLocal,station,language,whatsapp,methods,permissions,shift')||
  !label(v.nameLocal,80)||!label(v.station,60)||!['en','bn'].includes(v.language as string)||typeof v.whatsapp!=='boolean'||
  !Array.isArray(v.methods)||v.methods.length>3||!v.methods.every((m,i,methods)=>staffMethods.includes(m)&&
   (i===0||staffMethods.indexOf(m)>staffMethods.indexOf(methods[i-1])))||
  !staffObject(v.permissions)||!staffExact(v.permissions,'confirmOrders,updateStock,viewOwnPerformance')||
  !Object.values(v.permissions).every(x=>typeof x==='boolean'))throw bad();
 return {nameLocal:v.nameLocal,station:v.station,language:v.language as 'en'|'bn',whatsapp:v.whatsapp,
  methods:[...v.methods] as StaffMethod[],permissions:{...v.permissions} as unknown as StaffPermissions,shift:parseUsualShift(v.shift)};
}
export function parseStaffDraft(v:unknown):StaffDraft {
 if(!staffObject(v)||!staffExact(v,'name,nameLocal,phone,role,active,station,language,whatsapp,methods,permissions,shift')||
  !label(v.name,80)||!v.name||v.phone!==null&&(typeof v.phone!=='string'||!/^\+[1-9][0-9]{6,14}$/.test(v.phone))||
  !roles.includes(v.role as MemberRole)||typeof v.active!=='boolean')throw bad();
 const {nameLocal,station,language,whatsapp,methods,permissions,shift}=v;
 const profile=parseStaffProfile({nameLocal,station,language,whatsapp,methods,permissions,shift});
 if(profile.whatsapp&&v.phone===null)throw Error('Add this member’s number before using WhatsApp reminders.');
 return {...profile,name:v.name,phone:v.phone as string|null,role:v.role as MemberRole,active:v.active};
}
export function parseStaffRecord(v:unknown):StaffRecord {
 if(!staffObject(v)||!staffExact(v,'member,profile,revision,lastActionId')||!Number.isSafeInteger(v.revision)||(v.revision as number)<0||
  v.lastActionId!==null&&!staffId(v.lastActionId)||((v.revision===0)!==(v.lastActionId===null))||!staffObject(v.member))throw bad();
 const m=v.member;
 if(Object.keys(m).some(k=>!['id','createdAt','updatedAt','businessId','outletIds','name','phone','role','active'].includes(k))||
  !['id','createdAt','updatedAt','businessId','outletIds','name','role','active'].every(k=>Object.hasOwn(m,k))||
  !staffId(m.id)||!staffId(m.businessId)||!staffTime(m.createdAt)||!staffTime(m.updatedAt)||m.updatedAt<m.createdAt||
  !Array.isArray(m.outletIds)||m.outletIds.length>10000||!m.outletIds.every(staffId)||new Set(m.outletIds).size!==m.outletIds.length||
  typeof m.name!=='string'||!m.name||m.name.length>160||m.phone!==undefined&&(typeof m.phone!=='string'||!/^\+[1-9][0-9]{6,14}$/.test(m.phone))||
  !roles.includes(m.role as MemberRole)||typeof m.active!=='boolean')throw bad();
 // An older canonical name may contain literal controls or a lone surrogate.
 // Retain that original for an explicit rename; new input stays strict.
 if(!staffObject(v.profile)||typeof v.profile.nameLocal!=='string'||v.profile.nameLocal.length>160)throw bad();
 const profile=parseStaffProfile({...v.profile,nameLocal:''});profile.nameLocal=v.profile.nameLocal;
 return {member:{id:m.id,createdAt:m.createdAt,updatedAt:m.updatedAt,businessId:m.businessId,outletIds:[...m.outletIds] as string[],
  name:m.name,...(m.phone===undefined?{}:{phone:m.phone as string}),role:m.role as MemberRole,active:m.active},
  profile,revision:v.revision as number,lastActionId:v.lastActionId as string|null};
}

/** The server supplies the authorized scope and full current record. A caller's
 * role, phone claim or selected outlet never constitutes that authorization. */
export function saveStaffMember(input:StaffDraft,context:StaffSaveContext,ids:{memberId:string;eventId:string}):StaffSaveCommand {
 const draft=parseStaffDraft(input),current=context.current===null?null:parseStaffRecord(context.current);
 if(![context.businessId,context.outletId,context.actorId,ids.memberId,ids.eventId].every(staffId)||
  new Set([context.businessId,context.outletId,context.actorId,ids.eventId]).size!==4||ids.memberId===ids.eventId||
  !['owner','manager'].includes(context.actorRole)||!staffTime(context.serverAt))throw bad();
 if(current&&(current.member.id!==ids.memberId||current.member.businessId!==context.businessId||
  !current.member.outletIds.includes(context.outletId)||context.serverAt<current.member.updatedAt||current.revision>=Number.MAX_SAFE_INTEGER))throw bad();
 if(!current&&(ids.memberId===context.actorId||ids.memberId===context.businessId||ids.memberId===context.outletId||!draft.active))throw bad();
 if(draft.role==='agent'||current?.member.role==='agent'||draft.role==='owner'&&current?.member.role!=='owner'||
  current?.member.role==='owner'&&(draft.role!=='owner'||!draft.active)||
  current?.member.id===context.actorId&&(draft.role!==current.member.role||!draft.active))throw Error('Keep the current owner and sign-in access.');
 if(context.actorRole==='manager'&&(draft.role==='owner'||draft.role==='manager'||current&&
  (['owner','manager'].includes(current.member.role)||current.member.outletIds.some(id=>id!==context.outletId))))throw Error('Only the owner can change this member’s wider access.');
 const {name,phone,role,active,...profile}=draft;
 const member:Member={id:ids.memberId,createdAt:current?.member.createdAt??context.serverAt,updatedAt:context.serverAt,
  businessId:context.businessId,outletIds:current?[...current.member.outletIds]:[context.outletId],name,...(phone===null?{}:{phone}),role,active};
 const revision=(current?.revision??0)+1;
 return {member,profile,revision,event:{id:ids.eventId,outletId:context.outletId,actor:{type:'member',id:context.actorId},
  command:!current?'staff.create':!active&&current.member.active?'staff.remove':'staff.update',
  before:current,after:{member,profile,revision,lastActionId:ids.eventId},at:context.serverAt}};
}
