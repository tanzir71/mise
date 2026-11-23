import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createPairingDatabase,deviceId} from './device-pairing-fixture';
import {newInboxId} from '../packages/core/inbox';
import {emptyStaffProfile,type StaffDraft} from '../packages/core/staff';
import {parseStaffOwnerContext,parseStaffOwnerAction,parseStaffOwnerOutcome} from '../packages/core/staff-protocol';
import {parseStaffLinkAction,parseStaffLinkContext,parseStaffLinkOutcome,projectStaffView,parseStaffPublicOutcome,type StaffLinkAction} from '../packages/core/staff-links';
import {attendanceCommand,type AttendanceIntent} from '../packages/core/staff-attendance';
import {deviceSecretHash} from '../packages/core/device-access';
import {decodeCommandRecord} from '../packages/core/cloud-records';
let f:Awaited<ReturnType<typeof createPairingDatabase>>;
const scope={businessId:deviceId(1),outletId:deviceId(11),actorId:deviceId(101),actorRole:'owner' as const},token='J'.repeat(43);
beforeAll(async()=>{f=await createPairingDatabase();},30000);beforeEach(async()=>{await f.seed();});afterAll(async()=>{await f?.db.close();});
const context=async(target=deviceId(105))=>parseStaffLinkContext(await f.asRole(1,'authenticated','select public.read_staff_links($1,$2,null) data',[scope.outletId,target]),scope,target);
const owner=async(action:StaffLinkAction,operation='submit',n=1)=>parseStaffLinkOutcome(await f.asRole(n,'authenticated','select public.change_staff_link($1,$2,$3) data',[scope.outletId,JSON.stringify(action),operation]),action);
async function configure(target=deviceId(105)){
 const c=parseStaffOwnerContext(await f.asRole(1,'authenticated','select public.read_staff_context($1,$2) data',[scope.outletId,target]),scope,target);
 const draft:StaffDraft={...emptyStaffProfile(),name:'Karim Uddin',nameLocal:'করিম উদ্দিন',phone:null,role:'kitchen',active:true,methods:['link']};
 const action=parseStaffOwnerAction({...scope,v:1,id:newInboxId(),eventId:newInboxId(),memberId:target,kind:'save',expected:c.current,latest:null,draft,checkIn:null});
 return parseStaffOwnerOutcome(await f.asRole(1,'authenticated','select public.change_staff_action($1,$2,$3) data',[scope.outletId,JSON.stringify(action),'submit']),action).member!;
}
async function issue(target=deviceId(105),secret=token){await configure(target);const c=await context(target),a=parseStaffLinkAction({...scope,v:1,id:newInboxId(),eventId:newInboxId(),memberId:target,linkId:newInboxId(),kind:'issue',expected:c.current,tokenHash:await deviceSecretHash(secret),expiresAt:c.serverAt+30*86400000});return {action:a,result:await owner(a),member:c.current!};}
const visit=async(operation='read',source:AttendanceIntent|null=null,secret=token,after:unknown=null,global=1000,limit=60)=>f.asRole<Record<string,unknown>>(null,'service_role','select public.visit_staff_link($1,$2,$3,$4,$5,$6) data',[secret,operation,source===null?null:JSON.stringify(source),after===null?null:JSON.stringify(after),global,limit]);
const intent=(type:AttendanceIntent['type']='in',last:string|null=null):AttendanceIntent=>({v:1,id:newInboxId(),eventId:newInboxId(),memberId:deviceId(105),outletId:scope.outletId,type,occurredAt:Date.now(),expectedLastId:last});

it('issues an original hash-only capability once and exposes no other staff, contact or Auth identity',async()=>{
 const {action,result}=await issue();expect(result.state).toBe('applied');expect(await owner(action,'inspect')).toEqual(result);expect(await owner(action)).toEqual(result);
 const raw=await visit(),view=projectStaffView(raw.view,null);expect(view).toMatchObject({memberId:deviceId(105),name:'Karim Uddin',nameLocal:'করিম উদ্দিন',latest:null,entries:[]});
 for(const forbidden of ['auth_user_id','phone','permissions','token_hash',deviceId(104),deviceId(107)])expect(JSON.stringify(raw)).not.toContain(forbidden);
 expect(JSON.stringify((await context()).links)).not.toContain(token);expect((await f.db.query<{n:number}>('select count(*)::integer n from private.staff_links')).rows[0].n).toBe(1);
});
it('commits the same actual check-in and audit as Core and replays it after a lost completion without duplicate effects',async()=>{
 const {action,member}=await issue(),i=intent(),raw=await visit('submit',i),outcome=parseStaffPublicOutcome(raw,i);expect(outcome.state).toBe('applied');
 const core=attendanceCommand(i,{businessId:scope.businessId,outletId:scope.outletId,member,latest:null,recorder:{memberId:i.memberId,id:'staff-link:'+action.linkId,kind:'system',method:'link'},serverAt:outcome.at!});
 expect(outcome.checkIn).toEqual(core.checkIn);const event=decodeCommandRecord('events',(await f.db.query<{data:Record<string,unknown>}>('select row_to_json(e) data from public.events e where id=$1',[i.eventId])).rows[0].data);expect(event).toEqual(core.event);
 expect(await visit('submit',i)).toEqual(raw);expect(await visit('inspect',i)).toEqual(raw);expect(await visit('close',i)).toEqual(raw);
 expect(projectStaffView((await visit()).view,null).latest).toEqual(core.checkIn);
 expect((await f.db.query<{n:number}>('select count(*)::integer n from public.check_ins')).rows[0].n).toBe(1);
});
it('fences a delayed tap with an offline closure and does not treat a different original or another member as accepted',async()=>{
 await issue();const i=intent(),closed=parseStaffPublicOutcome(await visit('close',i),i);expect(closed.state).toBe('closed');expect(await visit('submit',i)).toEqual(closed);
 expect((await visit('inspect',{...i,type:'out'})).state).toBe('changed');expect((await visit('submit',{...intent(),memberId:deviceId(104)})).state).toBe('changed');
 expect(projectStaffView((await visit()).view,null).entries).toEqual([]);
});
it('revokes fresh reads and writes immediately while retaining only an exact earlier acknowledgement',async()=>{
 const {action}=await issue(),i=intent();const applied=await visit('submit',i);
 const revoke=parseStaffLinkAction({...scope,v:1,id:newInboxId(),eventId:newInboxId(),memberId:action.memberId,linkId:action.linkId,kind:'revoke',expected:null,tokenHash:null,expiresAt:null});await owner(revoke);
 expect((await visit()).state).toBe('missing');expect((await visit('submit',intent('out',i.id))).state).toBe('missing');expect(await visit('inspect',i)).toEqual(applied);
 const pending=intent('out',i.id);expect(parseStaffPublicOutcome(await visit('close',pending),pending).state).toBe('closed');
});
it.each(['target inactive','target unassigned','method removed','issuer inactive','issuer banned','issuer anonymous','expired'] as const)('checks the live %s before a new read or write',async(kind)=>{
 await issue();
 if(kind==='target inactive')await f.db.query('update public.members set active=false where id=$1',[deviceId(105)]);
 if(kind==='target unassigned')await f.db.query('delete from public.member_outlets where member_id=$1',[deviceId(105)]);
 if(kind==='method removed')await f.db.query("update private.staff_profiles set profile=jsonb_set(profile,'{methods}','[]') where member_id=$1",[deviceId(105)]);
 if(kind==='issuer inactive')await f.db.query('update public.members set active=false where id=$1',[deviceId(101)]);
 if(kind==='issuer banned')await f.db.exec("update auth.users set banned_until=now()+interval '1 hour'");
 if(kind==='issuer anonymous')await f.db.exec('update auth.users set is_anonymous=true');
 if(kind==='expired')await f.db.exec('update private.staff_links set created_at=1,expires_at=2');
 expect((await visit()).state).toBe('missing');expect((await visit('submit',intent())).state).toBe('missing');
});
it('preserves the latest departure against a stale arrival without changing financial records',async()=>{
 await issue();const first=intent(),original=intent();await visit('submit',first);const leave=intent('out',first.id);await visit('submit',leave);
 expect((await visit('submit',original)).state).toBe('changed');expect(projectStaffView((await visit()).view,null).latest).toMatchObject({id:leave.id,type:'out',method:'link'});
 expect((await f.db.query<{n:number}>('select count(*)::integer n from public.sales')).rows[0].n).toBe(0);
});
it('pages only the member’s real history and preserves literal legacy name bytes in the public projection',async()=>{
 await issue();const ids:string[]=[],at=Date.now();let previous:string|null=null;
 for(let index=0;index<45;index++){
  const source:AttendanceIntent={...intent(index%2===0?'in':'out',previous),occurredAt:at+index};
  expect((await visit('submit',source)).state).toBe('applied');ids.push(source.id);previous=source.id;
 }
 const name='Karim\u0000\ud800';await f.db.query('update public.members set name=$1 where id=$2',[JSON.stringify(name),deviceId(105)]);
 const first=projectStaffView((await visit()).view,null);expect(first.name).toBe(name);expect(first.entries).toHaveLength(40);expect(first.next).not.toBe(null);expect(first.latest?.id).toBe(ids.at(-1));
 const second=projectStaffView((await visit('read',null,token,first.next)).view,first.next);expect(second.entries).toHaveLength(5);expect(second.next).toBe(null);
 expect([...first.entries,...second.entries].map(row=>row.checkIn.id)).toEqual([...ids].reverse());expect(first.entries.every(row=>row.checkIn.memberId===deviceId(105)&&row.recordedByName===name)).toBe(true);
});
it('has independent per-link/global budgets and preserves closure originals when temporarily limited',async()=>{
 await issue();expect((await visit('read',null,token,null,1000,1)).state).toBe('view');expect((await visit('read',null,token,null,1000,1)).state).toBe('limited');
 await f.db.exec('update private.staff_links set window_at=0,requests=0;update private.staff_link_budget set window_at=0,requests=0');
 expect((await visit('read',null,'X'.repeat(43),null,1,60)).state).toBe('missing');const limited=await visit('close',intent(),token,null,1,60);expect(limited.state).toBe('limited');expect(limited.retryAfter).toBeGreaterThan(0);
});
it('cannot issue from a stale or disabled member and closes the original without creating a capability',async()=>{
 await configure();const c=await context(),a=parseStaffLinkAction({...scope,v:1,id:newInboxId(),eventId:newInboxId(),memberId:c.memberId,linkId:newInboxId(),kind:'issue',expected:c.current,tokenHash:await deviceSecretHash(token),expiresAt:c.serverAt+86400000});
 await f.db.query('update public.members set name=$1 where id=$2',[JSON.stringify('Changed'),c.memberId]);await expect(owner(a)).rejects.toThrow();expect((await owner(a,'close')).state).toBe('closed');expect((await owner(a)).state).toBe('closed');
 expect((await visit()).state).toBe('missing');
});
it('denies all direct private table reads and limits the anonymous RPC to the actual service role',async()=>{
 for(const role of ['anon','authenticated','service_role'] as const)for(const table of ['staff_links','staff_link_owner_actions','staff_link_actions','staff_link_budget'])
  await expect(f.asRole(null,role,`select count(*) data from private.${table}`)).rejects.toThrow();
 for(const role of ['anon','authenticated'] as const)await expect(f.asRole(1,role,'select public.visit_staff_link($1,$2,null,null,300,60) data',[token,'read'])).rejects.toThrow();
 await expect(f.asRole(3,'authenticated','select public.read_staff_links($1,$2,null) data',[scope.outletId,deviceId(105)])).rejects.toThrow();
});
