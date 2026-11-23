import {describe,expect,it} from 'vitest';
import {emptyStaffProfile,parseStaffDraft,parseStaffProfile,parseStaffRecord,parseUsualShift,saveStaffMember,type StaffDraft,type StaffRecord,type StaffSaveContext} from '../packages/core/staff';

const id=(n:number)=>String(n).padStart(26,'0');
const ids={memberId:id(4),eventId:id(5)};
const context:StaffSaveContext={businessId:id(1),outletId:id(2),actorId:id(3),actorRole:'owner',current:null,serverAt:2000};
const draft=(change:Partial<StaffDraft>={}):StaffDraft=>({...emptyStaffProfile(),name:'Karim Uddin',phone:null,role:'kitchen',active:true,...change});
const record=(change:Partial<StaffRecord['member']>={}):StaffRecord=>({member:{id:id(4),businessId:id(1),outletIds:[id(2)],name:'Karim',role:'kitchen',active:true,createdAt:1000,updatedAt:1500,...change},profile:emptyStaffProfile(),revision:0,lastActionId:null});

describe('actual team member changes',()=>{
 it('starts with no provider, receiving number, implicit permissions or automated check-in methods',()=>{
  const command=saveStaffMember(draft(),context,ids);
  expect(command.member).toEqual({id:id(4),businessId:id(1),outletIds:[id(2)],name:'Karim Uddin',role:'kitchen',active:true,createdAt:2000,updatedAt:2000});
  expect(command.profile).toEqual(emptyStaffProfile());expect(command.event.actor).toEqual({type:'member',id:id(3)});
  expect(command.event.command).toBe('staff.create');expect(command.revision).toBe(1);
 });
 it('allows an assigned manager to add a normal member while leaving sign-in identity outside the draft',()=>{
  expect(saveStaffMember(draft({role:'staff',phone:'+14155550100',whatsapp:true}),{...context,actorRole:'manager'},ids).member.phone).toBe('+14155550100');
  expect(()=>parseStaffDraft({...draft(),authUserId:'a claimed identity'})).toThrow();
  expect(()=>parseStaffDraft({...draft(),outletIds:[id(9)]})).toThrow();
 });
 it('cannot create an owner, AI account or inactive shell through team editing',()=>{
  for(const role of ['owner','agent'] as const)expect(()=>saveStaffMember(draft({role}),context,ids)).toThrow();
  expect(()=>saveStaffMember(draft({active:false}),context,ids)).toThrow();
 });
 it('reserves manager access changes for the actual owner',()=>{
  expect(()=>saveStaffMember(draft({role:'manager'}),{...context,actorRole:'manager'},ids)).toThrow();
  for(const role of ['owner','manager'] as const)expect(()=>saveStaffMember(draft({role:role==='owner'?'owner':'staff'}),{...context,actorRole:'manager',current:record({role})},ids)).toThrow();
  expect(saveStaffMember(draft({role:'manager'}),context,ids).member.role).toBe('manager');
 });
 it('does not let a manager change a member assigned to another outlet as well',()=>{
  expect(()=>saveStaffMember(draft(),{...context,actorRole:'manager',current:record({outletIds:[id(2),id(8)]})},ids)).toThrow();
  const command=saveStaffMember(draft(),{...context,current:record({outletIds:[id(2),id(8)]})},ids);
  expect(command.member.outletIds).toEqual([id(2),id(8)]);
 });
 it('requires the exact target business, outlet, original member and current clock',()=>{
  for(const current of [record({businessId:id(9)}),record({outletIds:[id(8)]}),record({id:id(8)}),record({updatedAt:3000})])
   expect(()=>saveStaffMember(draft(),{...context,current},ids)).toThrow();
 });
 it('preserves the owner and prevents self-demotion or self-removal',()=>{
  const current=record({id:id(3),role:'owner'}),self={memberId:id(3),eventId:id(5)};
  expect(saveStaffMember(draft({role:'owner'}),{...context,current},self).member.role).toBe('owner');
  for(const change of [{role:'manager' as const},{role:'owner' as const,active:false}])expect(()=>saveStaffMember(draft(change),{...context,current},self)).toThrow();
  expect(()=>saveStaffMember(draft({role:'staff'}),{...context,actorRole:'manager',current:record({id:id(3),role:'manager'})},self)).toThrow();
 });
 it('soft-removes a member and keeps their original identity, assignment and audit',()=>{
  const current=record(),command=saveStaffMember(draft({active:false}),{...context,current},ids);
  expect(command.event.command).toBe('staff.remove');expect(command.member.active).toBe(false);
  expect(command.member.createdAt).toBe(1000);expect(command.member.id).toBe(current.member.id);
  expect(command.event.before).toEqual(current);expect(current.member.active).toBe(true);
  command.member.outletIds.push(id(9));command.profile.permissions.updateStock=true;
  expect(current.member.outletIds).toEqual([id(2)]);expect(current.profile.permissions.updateStock).toBe(false);
 });
 it('retains revisions and makes a later edit a new audit event without replacing an earlier record',()=>{
  const first=saveStaffMember(draft(),context,ids),current:StaffRecord={member:first.member,profile:first.profile,revision:first.revision,lastActionId:first.event.id};
  const second=saveStaffMember(draft({nameLocal:'করিম উদ্দিন',language:'bn'}),{...context,current,serverAt:3000},{memberId:id(4),eventId:id(6)});
  expect(second.revision).toBe(2);expect(second.member.createdAt).toBe(2000);expect(second.event.before).toEqual(current);
  expect(second.event.after).toMatchObject({lastActionId:id(6),profile:{language:'bn',nameLocal:'করিম উদ্দিন'}});
 });
});

describe('explicit staff settings',()=>{
 it('requires complete E.164 numbers and a real number before enabling WhatsApp',()=>{
  for(const phone of ['01712345678','+012345678','+88017 123456',''])expect(()=>parseStaffDraft(draft({phone}))).toThrow();
  expect(()=>parseStaffDraft(draft({whatsapp:true}))).toThrow();
  expect(parseStaffDraft(draft({phone:'+8801712345678',whatsapp:true})).phone).toBe('+8801712345678');
 });
 it('retains Bangla and emoji while rejecting altered labels and malformed text',()=>{
  expect(parseStaffDraft(draft({name:'করিম 🧑‍🍳',nameLocal:'করিম'})).name).toBe('করিম 🧑‍🍳');
  for(const name of ['', ' Karim','Karim\nUddin','Karim\u0000','\ud800','\udfff','x'.repeat(81)])expect(()=>parseStaffDraft(draft({name}))).toThrow();
 });
 it('rejects unknown or repeated methods, permissions, languages and fields',()=>{
  for(const value of [{...emptyStaffProfile(),methods:['link','link']},{...emptyStaffProfile(),methods:['manual']},
   {...emptyStaffProfile(),methods:['group','link']},{...emptyStaffProfile(),language:'email'},
   {...emptyStaffProfile(),permissions:{...emptyStaffProfile().permissions,manageBusiness:true}},
   {...emptyStaffProfile(),permissions:{confirmOrders:1,updateStock:false,viewOwnPerformance:false}},
   {...emptyStaffProfile(),tracking:true}])expect(()=>parseStaffProfile(value)).toThrow();
  expect(parseStaffProfile({...emptyStaffProfile(),methods:['order_phone','link','group']})).toMatchObject({methods:['order_phone','link','group']});
 });
 it('keeps a selected weekly and overnight shift explicit, with no full-day inference',()=>{
  expect(parseUsualShift({days:[0,1,6],start:23*60,end:7*60})).toEqual({days:[0,1,6],start:1380,end:420});
  expect(parseUsualShift(null)).toBe(null);
  for(const shift of [{days:[],start:660,end:1140},{days:[1,1],start:660,end:1140},{days:[6,0],start:660,end:1140},
   {days:[7],start:660,end:1140},{days:[1],start:1440,end:0},{days:[1],start:1.5,end:2},{days:[1],start:660,end:660}])expect(()=>parseUsualShift(shift)).toThrow();
 });
 it('does not accept a detached revision or shared assignment in a stored record',()=>{
  expect(()=>parseStaffRecord({...record(),revision:1,lastActionId:null})).toThrow();
  expect(()=>parseStaffRecord({...record(),member:{...record().member,outletIds:[id(2),id(2)]}})).toThrow();
  expect(()=>parseStaffRecord({...record(),member:{...record().member,authUserId:'hidden'}})).toThrow();
 });
});
