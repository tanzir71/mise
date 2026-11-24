import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createPairingDatabase,deviceId,deviceUid,type PairingDatabase} from './device-pairing-fixture';
import {newInboxId} from '../packages/core/inbox';
import {emptyStaffProfile,type StaffDraft} from '../packages/core/staff';
import {parseStaffOwnerContext,parseStaffOwnerAction,parseStaffOwnerOutcome} from '../packages/core/staff-protocol';
import {attendanceCommand,type AttendanceIntent} from '../packages/core/staff-attendance';
import {parseStaffDeviceView,parseStaffDeviceOutcome} from '../packages/core/staff-device';
import {parseStaffDeviceAccess,type DeviceMode} from '../packages/core/device-access';
import {createStaffPin,deriveStaffPin} from '../supabase/functions/_shared/staff-pin';
import {decodeCommandRecord} from '../packages/core/cloud-records';
import {createStaffDeviceHandler} from '../supabase/functions/_shared/staff-device-handler';
let f:PairingDatabase;
it('retains an eligible prior PIN member in the bounded directory after all work and attendance rights disappear',async()=>{
 const screen=await enrol(),session=await login(screen,deviceId(104));
 await f.asRole(null,'service_role','select public.end_device_session($1,$2,$3) data',[screen.secret,session.token,newInboxId()]);
 await f.db.query("update public.members set permissions='{}' where id=$1",[deviceId(104)]);await configure(deviceId(104),'staff',[],false);
 const directory=await f.directoryRead(screen.secret) as {members:{id:string}[]};expect(directory.members.map(row=>row.id)).toContain(deviceId(104));
 const fresh=await login(screen,deviceId(104));expect(parseStaffDeviceAccess(await access(screen,fresh)).permissions).toEqual([]);
 expect(await f.asRole(null,'service_role','select public.read_kitchen_page($1,$2,null,null,50) data',[screen.secret,fresh.token])).toBeNull();
 const sibling=await enrol();expect((await f.directoryRead(sibling.secret) as {members:{id:string}[]}).members.map(row=>row.id)).not.toContain(deviceId(104));
 const bounded=await f.directoryRead(screen.secret,null,1) as {members:{id:string}[];next:string|null};expect(bounded.members).toHaveLength(1);expect(bounded.next).toBe(deviceId(104));
 expect((await f.directoryRead(screen.secret,bounded.next,1) as {members:{id:string}[]}).members.every(row=>row.id!==deviceId(104))).toBe(true);
 await f.db.query('delete from public.member_outlets where member_id=$1 and outlet_id=$2',[deviceId(104),scope.outletId]);
 expect((await f.directoryRead(screen.secret) as {members:{id:string}[]}).members.map(row=>row.id)).not.toContain(deviceId(104));expect(await access(screen,fresh)).toBeNull();
});
it.each(['inactive','pin removed','revoked device'] as const)('prior PIN history does not bypass current %s eligibility',async kind=>{
 const screen=await enrol(),session=await login(screen,deviceId(104));await f.db.query("update public.members set permissions='{}' where id=$1",[deviceId(104)]);
 if(kind==='inactive')await f.db.query('update public.members set active=false where id=$1',[deviceId(104)]);
 else if(kind==='pin removed')await f.db.query('delete from private.staff_pins where member_id=$1',[deviceId(104)]);
 else await f.db.query('update private.devices set revoked_at=created_at where id=$1',[screen.device.id]);
 const directory=await f.directoryRead(screen.secret) as {members:{id:string}[]}|null;expect(directory?.members.map(row=>row.id)??[]).not.toContain(deviceId(104));expect(await access(screen,session)).toBeNull();
});
const scope={businessId:deviceId(1),outletId:deviceId(11),actorId:deviceId(101),actorRole:'owner' as const};
beforeAll(async()=>{f=await createPairingDatabase();},30000);beforeEach(async()=>{await f.seed();});afterAll(async()=>{await f?.db.close();});
async function configure(target=deviceId(105),role:StaffDraft['role']='kitchen',methods:StaffDraft['methods']=['order_phone'],confirmOrders=false){
 const c=parseStaffOwnerContext(await f.asRole(1,'authenticated','select public.read_staff_context($1,$2) data',[scope.outletId,target]),scope,target);
 const draft:StaffDraft={...emptyStaffProfile(),name:'Karim Uddin',nameLocal:'করিম উদ্দিন',phone:null,role,active:true,methods,permissions:{confirmOrders,updateStock:false,viewOwnPerformance:false}};
 const action=parseStaffOwnerAction({...scope,v:1,id:newInboxId(),eventId:newInboxId(),memberId:target,kind:'save',expected:c.current,latest:null,draft,checkIn:null});
 return parseStaffOwnerOutcome(await f.asRole(1,'authenticated','select public.change_staff_action($1,$2,$3) data',[scope.outletId,JSON.stringify(action),'submit']),action).member!;
}
async function enrol(mode:DeviceMode='kitchen',outlet=scope.outletId){const {pairing}=await f.start(1,outlet,mode),claim=await f.request(pairing.code,pairing.id),device=await f.approve(pairing.id,claim);return {device,secret:claim.secret};}
type Screen=Awaited<ReturnType<typeof enrol>>;
async function login(screen:Screen,memberId=deviceId(105)){
 const c=await f.asRole<{allowed:boolean;attemptId:string;businessId:string;salt:string}>(null,'service_role','select public.begin_staff_pin($1,$2,$3) data',[newInboxId(),screen.secret,memberId]);
 expect(c.allowed).toBe(true);const proof=await deriveStaffPin('0042',c.salt,{businessId:c.businessId,memberId},f.pepper);
 const session=await f.asRole<{id:string;token:string;deviceId:string;memberId:string;createdAt:number;expiresAt:number}|null>(null,'service_role','select public.finish_staff_pin($1,$2,$3,$4,$5) data',[screen.secret,c.attemptId,proof,newInboxId(),newInboxId()]);
 if(!session)throw Error('PIN session was denied');return session;
}
type Session=Awaited<ReturnType<typeof login>>;
const intent=(type:AttendanceIntent['type']='in',last:string|null=null,memberId=deviceId(105)):AttendanceIntent=>({v:1,id:newInboxId(),eventId:newInboxId(),memberId,outletId:scope.outletId,type,occurredAt:Date.now(),expectedLastId:last});
const visit=(screen:Screen,session:Session,operation='read',source:unknown=null,after:unknown=null,limit=600)=>f.asRole<Record<string,unknown>>(null,'service_role','select public.visit_staff_device($1,$2,$3,$4,$5,$6) data',[screen.secret,session.token,operation,source===null?null:JSON.stringify(source),after===null?null:JSON.stringify(after),limit]);
const access=(screen:Screen,session:Session)=>f.asRole(null,'service_role','select public.read_device_session($1,$2) data',[screen.secret,session.token]);

it('uses the actual paired screen and PIN member for the same Core attendance and audit, once',async()=>{
 const member=await configure(),screen=await enrol(),session=await login(screen),source=intent();
 const send=createStaffDeviceHandler({store:{visit:(secret,input,limit)=>visit({...screen,secret},{...session,token:input.sessionToken},input.operation,input.intent,input.after,limit)},origins:new Set(['https://shop.example.invalid'])});
 const request=(operation='read',intent:AttendanceIntent|null=null)=>new Request('https://backend.example.invalid/functions/v1/staff-device',{method:'POST',headers:{Origin:'https://shop.example.invalid',Authorization:'Bearer '+screen.secret,'Content-Type':'application/json'},body:JSON.stringify({sessionToken:session.token,operation,intent,after:null})});
 const read=await send(request());expect(read.status).toBe(200);expect(read.headers.get('Cache-Control')).toBe('no-store');expect(read.headers.get('Referrer-Policy')).toBe('no-referrer');
 const first=parseStaffDeviceView(await read.json(),null);expect(first.access.permissions).toContain('staff.check-in');expect(first.view).toMatchObject({memberId:source.memberId,name:'Karim Uddin',latest:null,entries:[]});
 const wrongSession=new Request(request(),{body:JSON.stringify({sessionToken:'X'.repeat(43),operation:'read',intent:null,after:null})});expect((await send(wrongSession)).status).toBe(401);
 const response=await send(request('submit',source));expect(response.status).toBe(200);const applied=await response.json(),outcome=parseStaffDeviceOutcome(applied,source);
 const core=attendanceCommand(source,{...scope,member,latest:null,recorder:{memberId:source.memberId,id:source.memberId,kind:'member',method:'order_phone'},serverAt:outcome.at!});
 expect(outcome.checkIn).toEqual(core.checkIn);const row=(await f.db.query<{data:Record<string,unknown>}>('select row_to_json(e) data from public.events e where id=$1',[source.eventId])).rows[0];expect(decodeCommandRecord('events',row.data)).toEqual(core.event);
 for(const op of ['submit','inspect','close'])expect(await visit(screen,session,op,source)).toEqual(applied);
 const live=parseStaffDeviceView(await visit(screen,session),null,undefined,true);expect(live.view.latest).toEqual(core.checkIn);expect(live.view.entries).toHaveLength(1);
 for(const key of ['"phone":','auth_user_id','token_hash','verifier'])expect(JSON.stringify(live)).not.toContain(key);
 expect((await f.db.query<{n:number}>('select count(*)::integer n from public.check_ins')).rows[0].n).toBe(1);
 expect((await f.db.query<{n:number}>('select count(*)::integer n from public.sales')).rows[0].n).toBe(0);
});
it('keeps unprofiled kitchen rights and applies the explicit Team No independently of attendance',async()=>{
 const screen=await enrol(),session=await login(screen);
 expect(parseStaffDeviceAccess(await access(screen,session)).permissions).toEqual(['orders.acknowledge','orders.read','orders.ready']);expect((await visit(screen,session)).state).toBe('missing');
 await configure();expect(parseStaffDeviceAccess(await access(screen,session)).permissions).toEqual(['orders.read','staff.check-in']);
 await configure(deviceId(105),'kitchen',[]);expect((await visit(screen,session)).state).toBe('missing');
});
it.each([['staff','kitchen'],['staff','counter'],['kitchen','kitchen']] as const)('actual Team Yes grants bounded preparation to %s on %s without legacy grants',async(role,mode)=>{
 const member=role==='staff'?deviceId(104):deviceId(105);await f.db.query("update public.members set permissions='{}' where id=$1",[member]);await configure(member,role,['order_phone'],true);
 const screen=await enrol(mode),session=await login(screen,member),current=parseStaffDeviceAccess(await access(screen,session));
 expect(current.permissions).toEqual(['orders.acknowledge','orders.read','orders.ready','staff.check-in']);
 expect(current.permissions).not.toContain('counter.sell');expect(current.permissions).not.toContain('stock.update');
 await configure(member,role,['order_phone'],false);const no=parseStaffDeviceAccess(await access(screen,session));
 expect(no.permissions).toEqual(role==='kitchen'?['orders.read','staff.check-in']:['staff.check-in']);
 expect(parseStaffDeviceView(await visit(screen,session),null,undefined,true).access.permissions).toEqual(no.permissions);
});
it.each(['orders.read','orders.acknowledge','orders.ready'] as const)('preserves an explicit legacy %s denial when the Team switch is Yes',async denied=>{
 await f.db.query('update public.members set permissions=$1 where id=$2',[JSON.stringify({[denied]:false}),deviceId(104)]);await configure(deviceId(104),'staff',['order_phone'],true);
 const screen=await enrol(),session=await login(screen,deviceId(104)),current=parseStaffDeviceAccess(await access(screen,session));expect(current.permissions).not.toContain(denied);
 if(denied==='orders.read')expect(current.permissions).toEqual(['staff.check-in']);
});
it('does not project an outlet Team grant into another assigned outlet',async()=>{
 const first=await enrol(),second=await enrol('kitchen',deviceId(12)),a=await login(first,deviceId(104)),b=await login(second,deviceId(104));
 await f.db.query("update public.members set permissions='{}' where id=$1",[deviceId(104)]);await configure(deviceId(104),'staff',['order_phone'],true);
 expect(parseStaffDeviceAccess(await access(first,a)).permissions).toContain('orders.acknowledge');expect(parseStaffDeviceAccess(await access(second,b)).permissions).toEqual([]);
});
it.each(['kitchen','counter'] as const)('gives a rider only own attendance on a %s screen despite forged work flags',async mode=>{
 await configure(deviceId(104),'rider',['order_phone'],true);const c=await createStaffPin('0042',{businessId:scope.businessId,memberId:deviceId(104)},f.pepper);
 await f.asRole(1,'authenticated','select public.set_staff_pin($1,$2,$3,$4,$5,$6) data',[scope.outletId,deviceId(104),newInboxId(),c.salt,c.verifier,c.pepperVersion]);
 await f.db.query('update public.members set permissions=$1 where id=$2',[JSON.stringify({'orders.read':true,'orders.ready':true,'counter.sell':true,'owner':true,'staff.check-in':true}),deviceId(104)]);
 const screen=await enrol(mode),session=await login(screen,deviceId(104)),a=parseStaffDeviceAccess(await access(screen,session));expect(a).toMatchObject({role:'rider',mode,permissions:['staff.check-in']});
 const directory=await f.directoryRead(screen.secret) as {members:{id:string}[]};expect(directory.members.map(m=>m.id)).toContain(deviceId(104));
 expect(await f.asRole(null,'service_role','select public.read_device_orders($1,$2,null,null,50) data',[screen.secret,session.token])).toBeNull();
 expect(()=>parseStaffDeviceAccess({...a,permissions:['staff.check-in','orders.read']})).toThrow();
 const source=intent('in',null,deviceId(104));expect(parseStaffDeviceOutcome(await visit(screen,session,'submit',source),source).state).toBe('applied');
});
it('allows a kitchen member on a counter only when own attendance is explicitly enabled',async()=>{
 await configure();const screen=await enrol('counter'),session=await login(screen);expect(parseStaffDeviceAccess(await access(screen,session))).toMatchObject({role:'kitchen',mode:'counter',permissions:['staff.check-in']});
 await configure(deviceId(105),'kitchen',[]);expect(await access(screen,session)).toBeNull();expect((await visit(screen,session)).state).toBe('missing');
});
it('fences an original closed before delivery and preserves the exact source across a fresh PIN',async()=>{
 await configure();const screen=await enrol(),session=await login(screen),source=intent(),closed=parseStaffDeviceOutcome(await visit(screen,session,'close',source),source);expect(closed.state).toBe('closed');
 const renewed=await login(screen);expect(await visit(screen,renewed,'submit',source)).toEqual(closed);expect((await visit(screen,renewed,'inspect',{...source,type:'out'})).state).toBe('changed');
 const next=intent();const applied=await visit(screen,renewed,'submit',next);expect(await visit(screen,session,'inspect',next)).toEqual(applied);
 expect((await f.db.query<{n:number}>('select count(*)::integer n from public.check_ins')).rows[0].n).toBe(1);
});
it('never moves receipts to a different actual device or PIN member',async()=>{
 await configure();await configure(deviceId(104),'staff');const a=await enrol(),b=await enrol(),s=await login(a),other=await login(a,deviceId(104)),foreign=await login(b),source=intent();
 await visit(a,s,'submit',source);expect((await visit(a,other,'inspect',source)).state).toBe('changed');expect((await visit(b,foreign,'inspect',source)).state).toBe('changed');
 expect((await visit(b,s,'inspect',source)).state).toBe('missing');expect((await visit(a,s,'submit',{...intent(),outletId:deviceId(12)})).state).toBe('changed');
});
it.each(['device revoked','device expired','session revoked','session expired','member inactive','assignment removed','PIN rotated','Auth banned','Auth anonymous','Auth soft deleted','Auth deleted','Auth identity replaced'] as const)('rechecks %s before fresh access or attendance',async kind=>{
 await f.db.query('update public.members set auth_user_id=$1 where id=$2',[deviceUid(4),deviceId(105)]);const c=await createStaffPin('0042',{businessId:scope.businessId,memberId:deviceId(105)},f.pepper);
 await f.asRole(1,'authenticated','select public.set_staff_pin($1,$2,$3,$4,$5,$6) data',[scope.outletId,deviceId(105),newInboxId(),c.salt,c.verifier,c.pepperVersion]);
 await configure();const screen=await enrol(),session=await login(screen);
 if(kind==='device revoked')await f.db.exec('update private.devices set revoked_at=created_at');
 if(kind==='device expired')await f.db.exec('update private.devices set created_at=1,expires_at=2');
 if(kind==='session revoked')await f.db.exec('update private.device_sessions set revoked_at=created_at');
 if(kind==='session expired')await f.db.exec('update private.device_sessions set created_at=created_at-43200000,expires_at=expires_at-43200000');
 if(kind==='member inactive')await f.db.query('update public.members set active=false where id=$1',[deviceId(105)]);
 if(kind==='assignment removed')await f.db.query('delete from public.member_outlets where member_id=$1',[deviceId(105)]);
 if(kind==='PIN rotated')await f.asRole(1,'authenticated','select public.set_staff_pin($1,$2,$3,$4,$5,$6) data',[scope.outletId,deviceId(105),newInboxId(),c.salt,c.verifier,c.pepperVersion]);
 if(kind==='Auth banned')await f.db.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1",[deviceUid(4)]);
 if(kind==='Auth anonymous')await f.db.query('update auth.users set is_anonymous=true where id=$1',[deviceUid(4)]);
 if(kind==='Auth soft deleted')await f.db.query('update auth.users set deleted_at=now() where id=$1',[deviceUid(4)]);
 if(kind==='Auth deleted')await f.db.query('delete from auth.users where id=$1',[deviceUid(4)]);
 if(kind==='Auth identity replaced'){await f.db.query('insert into auth.users(id,phone,phone_confirmed_at) values($1,\'14155550106\',now())',[deviceUid(6)]);await f.db.query('update public.members set auth_user_id=$1 where id=$2',[deviceUid(6),deviceId(105)]);}
 expect((await visit(screen,session)).state).toBe('missing');expect((await visit(screen,session,'submit',intent())).state).toBe('missing');
 expect((await f.db.query<{n:number}>('select count(*)::integer n from public.check_ins')).rows[0].n).toBe(0);
});
it('requires current source predecessor, valid transition and clock, and rolls back an audit collision',async()=>{
 await configure();const screen=await enrol(),session=await login(screen),source=intent();
 expect((await visit(screen,session,'submit',intent('break'))).state).toBe('changed');expect((await visit(screen,session,'submit',{...intent(),occurredAt:Date.now()+600001})).state).toBe('changed');
 await visit(screen,session,'submit',source);expect((await visit(screen,session,'submit',intent('out'))).state).toBe('changed');
 const collision={...intent('out',source.id),eventId:source.eventId};await expect(visit(screen,session,'submit',collision)).rejects.toMatchObject({code:'23505'});
 expect(parseStaffDeviceOutcome(await visit(screen,session,'inspect',collision),collision).state).toBe('pending');expect((await f.db.query<{n:number}>('select count(*)::integer n from public.check_ins')).rows[0].n).toBe(1);
});
it('keeps a per-device budget and bounds unconfirmed closures without evicting originals',async()=>{
 await configure();const screen=await enrol(),session=await login(screen);expect((await visit(screen,session,'read',null,null,1)).state).toBe('view');expect(await visit(screen,session,'read',null,null,1)).toMatchObject({state:'limited'});
 await f.db.exec('update private.staff_device_budget set window_at=0');
 for(let n=0;n<200;n++)expect((await visit(screen,session,'close',intent())).state).toBe('closed');expect((await visit(screen,session,'close',intent())).state).toBe('limited');
 expect((await f.db.query<{n:number}>('select count(*)::integer n from private.staff_device_actions')).rows[0].n).toBe(200);
});
it('grants no direct receipt/budget table access and no caller-controlled or anonymous attendance RPC',async()=>{
 for(const role of ['anon','authenticated','service_role'] as const)for(const table of ['staff_device_actions','staff_device_budget'])await expect(f.asRole(null,role,`select count(*) data from private.${table}`)).rejects.toMatchObject({code:'42501'});
 for(const role of ['anon','authenticated'] as const)await expect(f.asRole(1,role,'select public.visit_staff_device($1,$2,\'read\',null,null,600) data',['D'.repeat(43),'S'.repeat(43)])).rejects.toMatchObject({code:'42501'});
 const tables=(await f.db.query<{relforcerowsecurity:boolean}>('select relforcerowsecurity from pg_class where relname in(\'staff_device_actions\',\'staff_device_budget\')')).rows;expect(tables).toHaveLength(2);expect(tables.every(t=>t.relforcerowsecurity)).toBe(true);
});
it('requires a verified real owner for PIN settings and only enables rider PINs at the configured outlet',async()=>{
 await configure(deviceId(104),'rider');
 for(const n of [2,3,4,5])await expect(f.asRole(n,'authenticated','select public.staff_pin_context($1,$2,\'set\') data',[scope.outletId,deviceId(104)])).rejects.toMatchObject({code:'42501'});
 expect(await f.asRole(1,'authenticated','select public.staff_pin_context($1,$2,\'set\') data',[scope.outletId,deviceId(104)])).toMatchObject({memberId:deviceId(104),configured:true});
 await expect(f.asRole(1,'authenticated','select public.staff_pin_context($1,$2,\'set\') data',[deviceId(12),deviceId(104)])).rejects.toMatchObject({code:'42501'});
 const other=await enrol('counter',deviceId(12));expect((await f.directoryRead(other.secret) as {members:unknown[]}).members).toEqual([]);
 await configure(deviceId(104),'rider',[]);await expect(f.asRole(1,'authenticated','select public.staff_pin_context($1,$2,\'set\') data',[scope.outletId,deviceId(104)])).rejects.toMatchObject({code:'42501'});
});
it('removes fresh method access while retaining only genuine original acknowledgements or closures',async()=>{
 await configure();const screen=await enrol(),session=await login(screen),source=intent(),applied=await visit(screen,session,'submit',source),pending=intent('out',source.id);
 await configure(deviceId(105),'kitchen',[]);expect((await visit(screen,session)).state).toBe('missing');expect((await visit(screen,session,'submit',pending)).state).toBe('missing');
 expect(await visit(screen,session,'inspect',source)).toEqual(applied);expect(parseStaffDeviceOutcome(await visit(screen,session,'close',pending),pending).state).toBe('closed');
 const unseen=intent('out',source.id);expect(parseStaffDeviceOutcome(await visit(screen,session,'inspect',unseen),unseen).state).toBe('pending');
});
it('reads only this member’s paged actual history and keeps manual recorder names in the same projection',async()=>{
 await configure();const screen=await enrol(),session=await login(screen),ids:string[]=[],start=Date.now();let previous:string|null=null;
 for(let n=0;n<43;n++){const source:AttendanceIntent={...intent(n%2===0?'in':'out',previous),occurredAt:start+n};expect((await visit(screen,session,'submit',source)).state).toBe('applied');previous=source.id;ids.push(source.id);}
 const name='Karim\u0000\ud800';await f.db.query('update public.members set name=$1 where id=$2',[JSON.stringify(name),deviceId(105)]);
 const first=parseStaffDeviceView(await visit(screen,session),null,undefined,true).view;expect(first.name).toBe(name);expect(first.entries).toHaveLength(40);expect(first.next).not.toBeNull();
 const next=parseStaffDeviceView(await visit(screen,session,'read',null,first.next),first.next,undefined,true).view;expect(next.entries).toHaveLength(3);expect(next.next).toBeNull();expect([...first.entries,...next.entries].map(r=>r.checkIn.id)).toEqual([...ids].reverse());
 const c=parseStaffOwnerContext(await f.asRole(1,'authenticated','select public.read_staff_context($1,$2) data',[scope.outletId,deviceId(105)]),scope,deviceId(105));expect(c.latest?.id).toBe(previous);
 const checkIn={...intent('out',previous),occurredAt:start+44},action=parseStaffOwnerAction({...scope,v:1,id:newInboxId(),eventId:checkIn.eventId,memberId:checkIn.memberId,kind:'check-in',expected:c.current,latest:c.latest,draft:null,checkIn});
 expect(parseStaffOwnerOutcome(await f.asRole(1,'authenticated','select public.change_staff_action($1,$2,$3) data',[scope.outletId,JSON.stringify(action),'submit']),action).state).toBe('applied');
 const updated=parseStaffDeviceView(await visit(screen,session),null,undefined,true).view;expect(updated.entries[0]).toMatchObject({recordedByName:'Member 101',checkIn:{method:'manual',recordedBy:scope.actorId}});
 expect((await visit(screen,session,'submit',intent('out',previous))).state).toBe('changed');
});
it('validates the closed intent and cursor again at SQL and accepts no method or recorder selector',async()=>{
 await configure();const screen=await enrol(),session=await login(screen),source=intent();
 for(const altered of [{...source,method:'manual'},{...source,recordedBy:scope.actorId},{...source,occurredAt:1.5},{...source,id:source.eventId},{...source,memberId:null},{...source,expectedLastId:source.id}])expect((await visit(screen,session,'submit',altered)).state).toBe('changed');
 for(const after of [{at:0,id:'bad'},{at:-1,id:newInboxId()},{at:1.5,id:newInboxId()},{at:0,id:newInboxId(),memberId:deviceId(104)}])expect((await visit(screen,session,'read',null,after)).state).toBe('changed');
 expect((await f.db.query<{n:number}>('select count(*)::integer n from public.check_ins')).rows[0].n).toBe(0);
});
it.each(['device','session'] as const)('rechecks the actual clock when the %s expires during the calling statement',async kind=>{
 await configure();const screen=await enrol(),session=await login(screen);
 await f.db.transaction(async tx=>{
  await tx.query("select set_config('mise.staff_device_clock_test',$1,true)",[JSON.stringify({kind,device:screen.device.id,session:session.id,deviceToken:screen.secret,sessionToken:session.token})]);
  await tx.exec(`do $clock$ declare c jsonb:=current_setting('mise.staff_device_clock_test')::jsonb;deadline bigint:=floor(extract(epoch from clock_timestamp())*1000)::bigint+50;r jsonb;begin
   if c->>'kind'='session' then update private.device_sessions set created_at=deadline-43200000,expires_at=deadline where id=(c->>'session')::public.ulid;
   else update private.devices set created_at=deadline-7776000000,expires_at=deadline where id=(c->>'device')::public.ulid;end if;
   perform pg_sleep(0.1);set local role service_role;
   r:=public.visit_staff_device(c->>'deviceToken',c->>'sessionToken','read',null,null,600);
   if r->>'state'<>'missing' then raise exception 'Expired during the same statement but fresh attendance was served';end if;
   reset role;end $clock$;`);
 });
});
