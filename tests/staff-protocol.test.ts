import {expect,it} from 'vitest';
import {emptyStaffProfile,saveStaffMember,type StaffDraft,type StaffScope} from '../packages/core/staff';
import {parseStaffBoardPage,parseStaffOwnerAction,parseStaffOwnerContext,parseStaffOwnerOutcome} from '../packages/core/staff-protocol';
const id=(n:number)=>String(n).padStart(26,'0');
const scope:StaffScope={businessId:id(1),outletId:id(2),actorId:id(3),actorRole:'owner'};
const draft:StaffDraft={...emptyStaffProfile(),name:'Nadia',phone:null,role:'staff',active:true};
const original=()=>parseStaffOwnerAction({...scope,v:1,id:id(4),eventId:id(5),memberId:id(6),kind:'save',expected:null,latest:null,draft,checkIn:null});
const receipt=()=>{const a=original(),c=saveStaffMember(draft,{...scope,current:null,serverAt:1000},{memberId:a.memberId,eventId:a.eventId});return {v:1,actionId:a.id,state:'applied',member:{member:c.member,profile:c.profile,revision:1,lastActionId:c.event.id},checkIn:null,serverAt:1000};};
it('binds the complete member result to its original fields, audit, revision and actual timestamp',()=>{
 const a=original(),r=receipt();expect(parseStaffOwnerOutcome(r,a)).toEqual(r);
 for(const change of [{name:'Another member'},{phone:'+14155550199'},{role:'manager'},{active:false},{createdAt:999},{updatedAt:1001},{outletIds:[id(2),id(9)]}])
  expect(()=>parseStaffOwnerOutcome({...r,member:{...r.member,member:{...r.member.member,...change}}},a)).toThrow();
 expect(()=>parseStaffOwnerOutcome({...r,member:{...r.member,revision:2}},a)).toThrow();
 expect(()=>parseStaffOwnerOutcome({...r,member:{...r.member,profile:{...r.member.profile,permissions:{...r.member.profile.permissions,updateStock:true}}}},a)).toThrow();
});
it('does not infer application from a pending/closed response or another original action',()=>{
 const a=original(),r=receipt();expect(()=>parseStaffOwnerOutcome({...r,state:'pending'},a)).toThrow();expect(()=>parseStaffOwnerOutcome({...r,state:'closed'},a)).toThrow();
 expect(()=>parseStaffOwnerOutcome({...r,actionId:id(9)},a)).toThrow();
 expect(parseStaffOwnerOutcome({...r,state:'closed',member:null},a).state).toBe('closed');
});
it('requires the real requested member, original outlet and phone-actor context',()=>{
 const c={...scope,v:1,serverAt:1000,memberId:id(6),current:receipt().member,latest:null};expect(parseStaffOwnerContext(c,scope,id(6)).current).not.toBe(null);
 for(const value of [{...c,actorId:id(8)},{...c,outletId:id(8)},{...c,memberId:id(8)},{...c,authUserId:'hidden'}])expect(()=>parseStaffOwnerContext(value,scope,id(6))).toThrow();
});
it('refuses missing, repeated or foreign pagination boundaries instead of claiming the board is complete',()=>{
 const r=receipt().member,page={...scope,v:1,serverAt:1000,entries:[{staff:r,latest:null}],next:r.member.id};
 expect(parseStaffBoardPage(page,scope,null,1).next).toBe(r.member.id);
 expect(()=>parseStaffBoardPage(page,scope,null,2)).toThrow();
 expect(()=>parseStaffBoardPage(page,scope,r.member.id,1)).toThrow();
 expect(()=>parseStaffBoardPage({...page,next:id(9)},scope,null,1)).toThrow();
 expect(()=>parseStaffBoardPage({...page,entries:[...page.entries,...page.entries]},scope,null,2)).toThrow();
});
