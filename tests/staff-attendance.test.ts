import {describe,expect,it} from 'vitest';
import {emptyStaffProfile,type StaffRecord} from '../packages/core/staff';
import {attendanceCommand,manualAttendanceContext,parseAttendanceIntent,recordedAttendanceMs,usualShiftExpectation,type AttendanceContext,type AttendanceIntent,type StaffCheckIn} from '../packages/core/staff-attendance';

const id=(n:number)=>String(n).padStart(26,'0');
const member:StaffRecord={member:{id:id(4),businessId:id(1),outletIds:[id(2)],name:'Karim',role:'kitchen',active:true,createdAt:1000,updatedAt:1000},profile:emptyStaffProfile(),revision:0,lastActionId:null};
const context:AttendanceContext=manualAttendanceContext({businessId:id(1),outletId:id(2),actorId:id(3),actorRole:'owner'},member,null,2000);
const intent=(change:Partial<AttendanceIntent>={}):AttendanceIntent=>({v:1,id:id(5),eventId:id(6),memberId:id(4),outletId:id(2),type:'in',occurredAt:1500,expectedLastId:null,...change});
const check=(change:Partial<StaffCheckIn>={}):StaffCheckIn=>({id:id(7),outletId:id(2),memberId:id(4),at:1200,type:'in',method:'link',recordedBy:id(4),...change});

describe('real attendance and its method',()=>{
 it('records an offline manual occurrence with the actual manager and separate server audit time',()=>{
  const command=attendanceCommand(intent(),context);
  expect(command.checkIn).toEqual({id:id(5),outletId:id(2),memberId:id(4),at:1500,type:'in',method:'manual',recordedBy:id(3)});
  expect(command.event).toMatchObject({id:id(6),actor:{type:'member',id:id(3)},command:'staff.check-in',before:null,at:2000});
 });
 it('requires the own-link method and its actual member; a payload cannot choose a different recorder',()=>{
  const own:AttendanceContext={...context,member:{...member,profile:{...emptyStaffProfile(),methods:['link']}},recorder:{memberId:id(4),id:'staff-link:'+id(9),kind:'system',method:'link'}};
  expect(attendanceCommand(intent(),own).checkIn.recordedBy).toBe(id(4));
  expect(()=>attendanceCommand(intent(),{...own,recorder:{...own.recorder,memberId:id(8)}})).toThrow();
  expect(()=>attendanceCommand(intent(),{...own,member})).toThrow();
  expect(()=>parseAttendanceIntent({...intent(),recordedBy:id(8)})).toThrow();
  expect(()=>attendanceCommand(intent(),{...context,recorder:{...context.recorder,kind:'system'}})).toThrow();
 });
 it('does not convert disabled methods, inactive members or other-outlet records into attendance',()=>{
  expect(()=>attendanceCommand(intent(),{...context,recorder:{...context.recorder,method:'group'}})).toThrow();
  for(const change of [{active:false},{role:'agent' as const},{businessId:id(9)},{outletIds:[id(8)]}])
   expect(()=>attendanceCommand(intent(),{...context,member:{...member,member:{...member.member,...change}}})).toThrow();
  expect(()=>attendanceCommand(intent(),{...context,latest:check({outletId:id(8)})})).toThrow();
 });
 it('keeps an older offline tap from replacing a newer recorded departure',()=>{
  const original=intent(),latest=check({at:1800,type:'out'});
  expect(()=>attendanceCommand(original,{...context,latest})).toThrow();
  expect(()=>attendanceCommand({...original,expectedLastId:latest.id},{...context,latest})).toThrow();
  expect(original).toEqual(intent());
 });
 it('supports break, return and leaving without treating a repeated tap as a fresh shift',()=>{
  let latest=attendanceCommand(intent(),context).checkIn;
  expect(()=>attendanceCommand(intent({id:id(10),eventId:id(11),expectedLastId:latest.id}),{...context,latest})).toThrow();
  for(const [type,at,n] of [['break',1600,10],['in',1700,12],['out',1800,14]] as const){
   latest=attendanceCommand(intent({id:id(n),eventId:id(n+1),type,occurredAt:at,expectedLastId:latest.id}),{...context,latest}).checkIn;
   expect(latest.type).toBe(type);
  }
  expect(()=>attendanceCommand(intent({id:id(16),eventId:id(17),type:'out',occurredAt:1900,expectedLastId:latest.id}),{...context,latest})).toThrow();
  expect(()=>attendanceCommand(intent({type:'break'}),context)).toThrow();
 });
 it('rejects a pre-membership time, future clock, aliased IDs or missing original predecessor',()=>{
  for(const change of [{occurredAt:999},{occurredAt:302001},{id:id(6)},{id:id(4)},{expectedLastId:id(5)}])
   expect(()=>attendanceCommand(intent(change),context)).toThrow();
  expect(()=>attendanceCommand(intent({expectedLastId:id(8)}),{...context,latest:check()})).toThrow();
 });
 it('keeps equal-millisecond transitions in the same order used by the actual reader',()=>{
  const latest=check({at:1500});
  expect(()=>attendanceCommand(intent({type:'break',expectedLastId:latest.id}),{...context,latest})).toThrow();
  expect(attendanceCommand(intent({id:id(8),eventId:id(9),type:'break',expectedLastId:latest.id}),{...context,latest}).checkIn.type).toBe('break');
 });
});

describe('recorded time, with complete history',()=>{
 const window={memberId:id(4),outletId:id(2),start:2000,end:6000,complete:true,before:null,entries:[]};
 it('counts the actual preceding in-state and excludes breaks and gaps',()=>{
  expect(recordedAttendanceMs({...window,before:check({at:1000}),entries:[check({id:id(8),at:3000,type:'break'}),check({id:id(9),at:4000,type:'in'}),check({id:id(10),at:5000,type:'out'})]})).toBe(2000);
  expect(recordedAttendanceMs({...window,before:check({at:1000,type:'break'}),entries:[check({id:id(8),at:4000,type:'in'})]})).toBe(2000);
 });
 it('does not present incomplete history as zero hours',()=>{
  expect(recordedAttendanceMs({...window,complete:false})).toBe(null);
  expect(recordedAttendanceMs(window)).toBe(0);
 });
 it('refuses mixed people, outlets, repeated IDs and incomplete chronological ordering',()=>{
  for(const entries of [[check({at:3000,memberId:id(9)})],[check({at:3000,outletId:id(9)})],
   [check({at:3000}),check({at:4000})],[check({id:id(9),at:4000}),check({id:id(8),at:3000})],
   [check({id:id(9),at:3000}),check({id:id(8),at:3000})]])expect(()=>recordedAttendanceMs({...window,entries})).toThrow();
  expect(()=>recordedAttendanceMs({...window,before:check({at:1000}),entries:[check({at:3000})]})).toThrow();
  expect(()=>recordedAttendanceMs({...window,before:check({at:2000})})).toThrow();
 });
});

describe('installation-local usual shifts',()=>{
 it('uses the outlet clock and the preceding weekday for an overnight shift',()=>{
  const shift={days:[6],start:23*60,end:7*60};
  expect(usualShiftExpectation(shift,Date.parse('2026-11-21T16:00:00Z'),'Asia/Dhaka').state).toBe('upcoming');
  expect(usualShiftExpectation(shift,Date.parse('2026-11-21T18:00:00Z'),'Asia/Dhaka')).toMatchObject({state:'due',previousDay:true});
  expect(usualShiftExpectation(shift,Date.parse('2026-11-22T01:00:00Z'),'Asia/Dhaka').state).toBe('none');
  expect(usualShiftExpectation(shift,Date.parse('2026-11-21T18:00:00Z'),'UTC').state).toBe('upcoming');
 });
 it('handles both repeated daylight-saving clocks without manufacturing a check-in',()=>{
  const shift={days:[0],start:90,end:210};
  for(const at of ['2026-11-01T05:30:00Z','2026-11-01T06:30:00Z'])expect(usualShiftExpectation(shift,Date.parse(at),'America/New_York').state).toBe('due');
  expect(usualShiftExpectation(shift,Date.parse('2026-11-01T08:30:00Z'),'America/New_York').state).toBe('none');
 });
 it('has no invented expectation for an unconfigured shift and rejects an unknown timezone',()=>{
  expect(usualShiftExpectation(null,2000,'Asia/Dhaka')).toEqual({state:'none',start:null,end:null,previousDay:false});
  expect(()=>usualShiftExpectation(null,2000,'not/an_outlet_zone')).toThrow();
  expect(()=>usualShiftExpectation(null,NaN,'UTC')).toThrow();
 });
});
