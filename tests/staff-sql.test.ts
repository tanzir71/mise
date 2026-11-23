import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createPairingDatabase,deviceId} from './device-pairing-fixture';
import {newInboxId} from '../packages/core/inbox';
import {emptyStaffProfile,saveStaffMember,type StaffDraft,type StaffScope} from '../packages/core/staff';
import {attendanceCommand,manualAttendanceContext,type AttendanceIntent} from '../packages/core/staff-attendance';
import {parseStaffBoardPage,parseStaffOwnerAction,parseStaffOwnerContext,parseStaffOwnerOutcome,type StaffOwnerAction} from '../packages/core/staff-protocol';
import {decodeCommandRecord} from '../packages/core/cloud-records';
let f:Awaited<ReturnType<typeof createPairingDatabase>>;
beforeAll(async()=>{f=await createPairingDatabase();},30000);
beforeEach(async()=>{await f.seed();});
afterAll(async()=>{await f?.db.close();});
const scope=(n=1,outlet=11):StaffScope=>({businessId:deviceId(1),outletId:deviceId(outlet),actorId:deviceId(100+n),actorRole:n===1?'owner':'manager'});
const draft=(change:Partial<StaffDraft>={}):StaffDraft=>({...emptyStaffProfile(),name:'Karim Uddin',nameLocal:'করিম উদ্দিন',phone:'+14155550150',role:'kitchen',active:true,...change});
const read=async(memberId:string,n=1,outlet=11)=>parseStaffOwnerContext(await f.asRole(n,'authenticated','select public.read_staff_context($1,$2) data',[deviceId(outlet),memberId]),scope(n,outlet),memberId);
const change=async(a:StaffOwnerAction,operation='submit',n=1)=>parseStaffOwnerOutcome(await f.asRole(n,'authenticated','select public.change_staff_action($1,$2,$3) data',[a.outletId,JSON.stringify(a),operation]),a);
async function save(value=draft(),memberId=newInboxId(),n=1){const c=await read(memberId,n);return parseStaffOwnerAction({...scope(n),v:1,id:newInboxId(),eventId:newInboxId(),memberId,kind:'save',expected:c.current,latest:null,draft:value,checkIn:null});}
async function check(memberId=deviceId(105),type:AttendanceIntent['type']='in',occurredAt=Date.now(),n=1){const c=await read(memberId,n),eventId=newInboxId();return parseStaffOwnerAction({...scope(n),v:1,id:newInboxId(),eventId,memberId,kind:'check-in',expected:c.current,latest:c.latest,draft:null,checkIn:{v:1,id:newInboxId(),eventId,memberId,outletId:c.outletId,type,occurredAt,expectedLastId:c.latest?.id??null}});}
async function event(id:string){const row=(await f.db.query<{data:Record<string,unknown>}>('select row_to_json(e) data from public.events e where id=$1',[id])).rows[0];return row?decodeCommandRecord('events',row.data):null;}

it('creates an actual member, assignment, scoped profile and the same Core audit without creating an Auth user',async()=>{
 const original=await save(),result=await change(original);expect(result.state).toBe('applied');
 const core=saveStaffMember(original.draft!,{...scope(),serverAt:result.serverAt,current:null},{memberId:original.memberId,eventId:original.eventId});
 expect(result.member).toEqual({member:core.member,profile:core.profile,revision:core.revision,lastActionId:core.event.id});
 expect(await event(original.eventId)).toEqual(core.event);
 expect((await f.db.query<{n:number}>('select count(*)::integer n from auth.users')).rows[0].n).toBe(5);
 expect((await f.db.query<{auth_user_id:unknown;permissions:unknown}>('select auth_user_id,permissions from public.members where id=$1',[original.memberId])).rows[0]).toEqual({auth_user_id:null,permissions:{}});
 expect((await read(original.memberId)).current).toEqual(result.member);
});
it('retains an applied original after a lost reply and fences a delayed submit with its original closure',async()=>{
 const a=await save(),result=await change(a);expect(await change(a,'inspect')).toEqual(result);expect(await change(a)).toEqual(result);expect(await change(a,'close')).toEqual(result);
 await expect(change({...a,draft:{...a.draft!,name:'Different original'}})).rejects.toThrow();
 expect((await f.db.query<{n:number}>('select count(*)::integer n from public.events where id=$1',[a.eventId])).rows[0].n).toBe(1);
 const pending=await save();expect((await change(pending,'inspect')).state).toBe('pending');const closed=await change(pending,'close');expect(closed.state).toBe('closed');expect(await change(pending)).toEqual(closed);
 expect((await read(pending.memberId)).current).toBe(null);expect(await event(pending.eventId)).toBe(null);
});
it('gives a manager only their actual outlet and denies promotion, wider edits and forged owner metadata',async()=>{
 const a=await save(draft({role:'staff'}),newInboxId(),2);expect((await change(a,'submit',2)).state).toBe('applied');
 const promotion=await save(draft({role:'manager'}),a.memberId,2);await expect(change(promotion,'submit',2)).rejects.toThrow();
 const shared=await save(draft(),deviceId(104),2);await expect(change(shared,'submit',2)).rejects.toThrow();
 await expect(read(deviceId(105),3)).rejects.toThrow();await expect(read(deviceId(105),4)).rejects.toThrow();
 await expect(change({...a,id:newInboxId(),eventId:newInboxId(),actorRole:'owner'},'submit',2)).rejects.toThrow();
 await expect(f.asRole(5,'authenticated','select public.read_staff_board($1,null,40) data',[deviceId(11)])).rejects.toThrow();
});
it('does not let a stale profile or another outlet update replace the original member snapshot',async()=>{
 const a=await save(),first=await change(a),one=await save(draft({name:'First edit'}),a.memberId),two=await save(draft({name:'Stale edit'}),a.memberId);
 expect((await change(one)).member?.revision).toBe(2);await expect(change(two)).rejects.toThrow();
 expect((await read(a.memberId)).current?.member.name).toBe('First edit');expect(await event(two.eventId)).toBe(null);
 expect(first.member?.member.name).toBe('Karim Uddin');
 const owner=await save(draft({role:'owner',active:false}),deviceId(101));await expect(change(owner)).rejects.toThrow();
});
it('uses indexed complete keyset pages without including another outlet’s manager or a foreign business',async()=>{
 let after:string|null=null;const found:string[]=[];
 do{const raw=await f.asRole(2,'authenticated','select public.read_staff_board($1,$2,2) data',[deviceId(11),after]),page=parseStaffBoardPage(raw,scope(2),after,2);found.push(...page.entries.map(e=>e.staff.member.id));after=page.next;}while(after);
 expect(found).toEqual([101,102,104,105,106,110].map(deviceId));expect(new Set(found).size).toBe(found.length);
 expect((await read(deviceId(108))).current).toBe(null);
 await expect(f.asRole(1,'authenticated','select public.read_staff_board($1,null,0) data',[deviceId(11)])).rejects.toThrow();
});
it('records the same manual check-in and audit as Core, with no sale, charge or order write',async()=>{
 const a=await check(),result=await change(a);expect(result.state).toBe('applied');
 const core=attendanceCommand(a.checkIn!,manualAttendanceContext(scope(),a.expected!,a.latest,result.serverAt));
 expect(result.checkIn).toEqual(core.checkIn);expect(await event(a.eventId)).toEqual(core.event);
 expect((await read(a.memberId)).latest).toEqual(core.checkIn);expect(await change(a)).toEqual(result);
 const counts=(await f.db.query<{sales:number;entries:number;orders:number}>("select (select count(*)::integer from public.sales) sales,(select count(*)::integer from public.credit_entries) entries,(select count(*)::integer from public.orders) orders")).rows[0];
 expect(counts).toEqual({sales:0,entries:0,orders:0});
});
it('retains an older offline original instead of overwriting a later departure or inventing a repeated arrival',async()=>{
 const at=Date.now()-10000,arrival=await check(deviceId(105),'in',at),older=await check(deviceId(105),'in',at-1000);await change(arrival);
 await expect(change(older)).rejects.toThrow();const repeated=await check(deviceId(105),'in',at+1000);await expect(change(repeated)).rejects.toThrow();
 const departure=await check(deviceId(105),'out',at+2000);await change(departure);
 expect((await read(deviceId(105))).latest?.type).toBe('out');expect(await event(older.eventId)).toBe(null);
 expect((await change(older,'close')).state).toBe('closed');expect((await change(older)).state).toBe('closed');
});
it('soft-removes a member but keeps their check-in and original audit, denying another attendance write',async()=>{
 const arrival=await check(deviceId(105),'in',Date.now()-2000);await change(arrival);
 const removal=await save(draft({active:false}),deviceId(105)),result=await change(removal);expect(result.member?.member.active).toBe(false);
 expect((await read(deviceId(105))).latest?.id).toBe(arrival.checkIn?.id);expect((await event(removal.eventId))?.command).toBe('staff.remove');
 await expect(change(await check(deviceId(105),'out',Date.now()-1000))).rejects.toThrow();expect(await event(arrival.eventId)).not.toBe(null);
});
it('can rename a legacy literal NUL/surrogate name without losing the original audit bytes',async()=>{
 const name='Original \u0000 \ud800';await f.db.query('update public.members set name=$1,name_local=$1 where id=$2',[JSON.stringify(name),deviceId(105)]);
 const a=await save(draft(),deviceId(105));expect(a.expected?.member.name).toBe(name);expect(a.expected?.profile.nameLocal).toBe(name);
 const result=await change(a);expect(result.member?.member.name).toBe('Karim Uddin');
 expect((await event(a.eventId))?.before).toEqual(a.expected);
});
it('rejects forged primitive types, extra manual-method fields and duplicate original keys before any effect',async()=>{
 const a=await save();
 const raw=(body:string)=>f.asRole(1,'authenticated','select public.change_staff_action($1,$2,$3) data',[a.outletId,body,'submit']);
 for(const body of [JSON.stringify({...a,v:'1'}),JSON.stringify({...a,extraPermission:true}),
  JSON.stringify({...a,draft:{...a.draft!,permissions:{...a.draft!.permissions,manageBusiness:true}}}),
  JSON.stringify(a).replace('"v":1','"v":1,"v":1')])await expect(raw(body)).rejects.toThrow();
 expect((await read(a.memberId)).current).toBe(null);
 const manual=await check();await expect(raw(JSON.stringify({...manual,checkIn:{...manual.checkIn!,method:'link'}}))).rejects.toThrow();
 expect((await read(manual.memberId)).latest).toBe(null);
});
it('enforces the same bounded labels, overnight shift and explicit settings at the SQL boundary',async()=>{
 const valid=draft({name:'করিম 🧑‍🍳',shift:{days:[0,6],start:1380,end:420},methods:['order_phone','link'],whatsapp:true});
 expect((await change(await save(valid))).member?.profile.shift).toEqual(valid.shift);
 for(const patch of [{name:'\u00a0Karim'},{name:'Karim\nUddin'},{name:'😀'.repeat(80)},
  {shift:{days:[0,0],start:660,end:1140}},{shift:{days:[0],start:660,end:660}},{methods:['link','link']},{whatsapp:true,phone:null}]){
  const original=await save(),malformed={...original,draft:{...original.draft!,...patch}};
  await expect(f.asRole(1,'authenticated','select public.change_staff_action($1,$2,$3) data',[original.outletId,JSON.stringify(malformed),'submit'])).rejects.toThrow();
  expect((await read(original.memberId)).current).toBe(null);
 }
});
it('keeps private profiles and original actions behind denied direct API grants and forces RLS',async()=>{
 const rows=(await f.db.query<{name:string;forced:boolean;rls:boolean}>("select relname name,relforcerowsecurity forced,relrowsecurity rls from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and relname in('staff_profiles','staff_owner_actions') order by relname")).rows;
 expect(rows).toEqual([{name:'staff_owner_actions',forced:true,rls:true},{name:'staff_profiles',forced:true,rls:true}]);
 for(const role of ['anon','authenticated','service_role'] as const){for(const table of ['staff_profiles','staff_owner_actions'])await expect(f.asRole(null,role,`select count(*) data from private.${table}`)).rejects.toThrow();}
 for(const role of ['anon','service_role'] as const)await expect(f.asRole(null,role,'select public.read_staff_board($1,null,40) data',[deviceId(11)])).rejects.toThrow();
});
