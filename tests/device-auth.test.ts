import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {newInboxId} from '../packages/core/inbox';
import {createStaffPin,deriveStaffPin,type PinCredential} from '../supabase/functions/_shared/staff-pin';
import {createDevicePinHandler} from '../supabase/functions/_shared/device-pin-handler';
import {createOwnerPinHandler,OwnerPinDenied,type OwnerPinStore} from '../supabase/functions/_shared/owner-pin-handler';

const id=(n:number)=>String(n).padStart(26,'0'),uid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const business=id(1),outlet=id(11),branch=id(12),staff=id(104),kitchen=id(105),foreignStaff=id(108),branchStaff=id(109);
const pepper=new Uint8Array(32).fill(37),permissions={'counter.sell':true,'orders.read':true,'orders.ready':true,'khata.read':'true','owner':true};
type Actor='anon'|'authenticated'|'service_role';
interface Device {id:string;token:string;businessId:string;outletId:string;mode:string;expiresAt:number;createdAt:number;revokedAt:number|null}
interface Attempt {allowed:boolean;attemptId:string;businessId:string;memberId:string;salt:string;pepperVersion:string;expiresAt:number;retryAt?:number}
interface Session {id:string;token:string;deviceId:string;memberId:string;createdAt:number;expiresAt:number}
let db:PGlite,credentials:Record<string,PinCredential>;
async function asRole<T>(n:number|null,actor:Actor,query:string,params:unknown[]=[]){
  return db.transaction(async sql=>{
    await sql.exec(`set local role ${actor}`);
    await sql.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:actor,...(n===null?{}:{sub:uid(n)}),user_metadata:{role:'owner'}})]);
    return (await sql.query<T>(query,params)).rows;
  });
}
async function enrol(n=1,target=outlet,mode='counter',event=newInboxId(),device=newInboxId()){
  return (await asRole<{data:Device}>(n,'authenticated','select public.enrol_device($1,$2,$3,$4,$5) as data',[device,event,target,'Shared screen',mode]))[0].data;
}
async function setPin(n=1,member=staff,target=outlet,credential=credentials[member],event=newInboxId()){
  return asRole(n,'authenticated','select public.set_staff_pin($1,$2,$3,$4,$5,$6)',[target,member,event,credential.salt,credential.verifier,credential.pepperVersion]);
}
async function begin(device:Device,member=staff){return (await asRole<{data:Attempt|null}>(null,'service_role','select public.begin_staff_pin($1,$2,$3) as data',[newInboxId(),device.token,member]))[0].data;}
async function finish(device:Device,attempt:Attempt,candidate:string,event=newInboxId(),session=newInboxId()){
  return (await asRole<{data:Session|null}>(null,'service_role','select public.finish_staff_pin($1,$2,$3,$4,$5) as data',[device.token,attempt.attemptId,candidate,session,event]))[0].data;
}
async function login(device:Device,member=staff,pin='0042'){
  const attempt=(await begin(device,member))!;
  if(!attempt.allowed)throw new Error('Test login rate limited');
  return (await finish(device,attempt,await deriveStaffPin(pin,attempt.salt,{businessId:attempt.businessId,memberId:member},pepper)))!;
}
async function read(device:Device,session:Session){return (await asRole<{data:Record<string,unknown>|null}>(null,'anon','select public.read_device_session($1,$2) as data',[device.token,session.token]))[0].data;}
beforeAll(async()=>{
  db=await PGlite.create();
  for(const path of ['./fixtures/supabase-auth.sql','../supabase/migrations/20261117081808_tenant_foundation.sql','../supabase/migrations/20261117085319_shop_records.sql','../supabase/migrations/20261117102312_public_capabilities.sql','../supabase/migrations/20261117114114_device_auth.sql','../supabase/migrations/20261117122734_owner_pin_admin.sql','../supabase/migrations/20261117130209_hosted_fk_indexes.sql'])
    await db.exec(readFileSync(new URL(path,import.meta.url),'utf8'));
  for(const n of [1,2,3,4,5])await db.query('insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,now())',[uid(n),`1415555010${n}`]);
  for(const b of [1,2])await db.query('insert into public.businesses(id,name,business_type,market_code,created_at,updated_at) values($1,$2,$3,$4,1,1)',[id(b),JSON.stringify(`Shop ${b}`),'corner_shop','BD']);
  for(const [o,b] of [[11,1],[12,1],[21,2]])await db.query('insert into public.outlets(id,business_id,name,timezone,currency,created_at,updated_at) values($1,$2,$3,$4,$5,1,1)',[id(o),id(b),JSON.stringify(`Outlet ${o}`),'Asia/Dhaka','BDT']);
  for(const [m,b,n,role] of [[101,1,1,'owner'],[102,1,2,'manager'],[103,1,3,'manager'],[104,1,null,'staff'],[105,1,null,'kitchen'],[106,1,null,'agent'],[107,2,4,'owner'],[108,2,null,'staff'],[109,1,null,'staff']] as const)
    await db.query('insert into public.members(id,business_id,auth_user_id,name,role,permissions,created_at,updated_at) values($1,$2,$3,$4,$5,$6,1,1)',[id(m),id(b),n===null?null:uid(n),JSON.stringify(`Member ${m}`),role,JSON.stringify(permissions)]);
  for(const [m,o,b] of [[102,11,1],[103,12,1],[104,11,1],[104,12,1],[105,11,1],[106,11,1],[107,21,2],[108,21,2],[109,12,1]])
    await db.query('insert into public.member_outlets values($1,$2,$3)',[id(b),id(m),id(o)]);
  credentials={};for(const [m,b] of [[104,1],[105,1],[108,2],[109,1]])credentials[id(m)]=await createStaffPin('0042',{businessId:id(b),memberId:id(m)},pepper);
},30_000);
beforeEach(async()=>{
  await db.exec('update public.members set active=true; update auth.users set banned_until=null,deleted_at=null,phone_confirmed_at=now()');
  for(const m of [104,105])await db.query('update public.members set role=$1,permissions=$2,auth_user_id=null where id=$3',[m===104?'staff':'kitchen',JSON.stringify(permissions),id(m)]);
  await db.query('insert into public.member_outlets values($1,$2,$3) on conflict do nothing',[business,staff,outlet]);
  await setPin();await setPin(1,kitchen);await setPin(4,foreignStaff,id(21));await setPin(1,branchStaff,branch);
});
afterAll(async()=>{await db?.close();});

it('enrols a scoped screen with a one-time random secret, hash-only storage and secret-free audit',async()=>{
  const d=await enrol();expect(d.token).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(d.expiresAt-d.createdAt).toBe(90*86400000);
  expect(d).toMatchObject({businessId:business,outletId:outlet,mode:'counter',revokedAt:null});
  expect((await db.query<{hash:string}>('select encode(token_hash,\'hex\') as hash from private.devices where id=$1',[d.id])).rows[0].hash).toBe(createHash('sha256').update(d.token).digest('hex'));
  const audit=(await db.query<{after_data:unknown}>('select after_data from public.events where command=\'device.enrol\' and after_data->>\'id\'=$1',[d.id])).rows[0];expect(JSON.stringify(audit)).not.toContain(d.token);expect(audit.after_data).not.toHaveProperty('token_hash');
});
it.each([[2,11],[3,12],[4,21]])('manager/owner %s can enrol assigned outlet %s',async(n,o)=>{expect((await enrol(n,id(o))).outletId).toBe(id(o));});
it.each([[2,12],[3,11],[4,11],[5,11]])('operator %s cannot enrol outlet %s beyond their scope',async(n,o)=>{await expect(enrol(n,id(o))).rejects.toMatchObject({code:'42501'});});
it('only a live confirmed owner can set a global staff PIN, and audit metadata omits the credential',async()=>{
  await expect(setPin(2)).rejects.toMatchObject({code:'42501'});await expect(setPin(4)).rejects.toMatchObject({code:'42501'});
  const rows=(await db.query<{after_data:unknown}>('select after_data from public.events where command=\'staff_pin.set\'' )).rows;
  for(const row of rows)for(const field of ['salt','verifier','pepperVersion','pin'])expect(row.after_data).not.toHaveProperty(field);
});
it('derives the PIN on the server and creates a separate, hashed 12-hour session without an Auth account',async()=>{
  const d=await enrol(),s=await login(d);expect(s.token).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(s.token).not.toBe(d.token);expect(s.expiresAt-s.createdAt).toBe(43200000);
  const actor=(await read(d,s))!;expect(actor).toMatchObject({businessId:business,outletId:outlet,deviceId:d.id,memberId:staff,role:'staff',mode:'counter'});
  expect(actor.permissions).toEqual(['counter.sell','orders.read']);expect(actor).not.toHaveProperty('token');
  expect((await db.query<{hash:string}>('select encode(token_hash,\'hex\') as hash from private.device_sessions where id=$1',[s.id])).rows[0].hash).toBe(createHash('sha256').update(s.token).digest('hex'));
});
it('a kitchen session receives only kitchen permissions, even when its member carries counter flags',async()=>{
  const d=await enrol(1,outlet,'kitchen'),s=await login(d,kitchen);expect((await read(d,s))?.permissions).toEqual(['orders.acknowledge','orders.read','orders.ready']);
  const counter=await enrol(),attempt=(await begin(counter,kitchen))!;expect(await finish(counter,attempt,credentials[kitchen].verifier)).toBeNull();
});
it('sessions are bound to their device and outlet, including two outlets of the same business',async()=>{
  const a=await enrol(),b=await enrol(1,branch),s=await login(a);expect(await read(b,s)).toBeNull();expect((await read(a,s))?.outletId).toBe(outlet);
});
it('explicit kitchen permission denials take effect on the next session read',async()=>{
  const d=await enrol(1,outlet,'kitchen'),s=await login(d,kitchen);
  await db.query('update public.members set permissions=$1 where id=$2',[JSON.stringify({'orders.ready':false,'counter.sell':true}),kitchen]);
  expect((await read(d,s))?.permissions).toEqual(['orders.acknowledge','orders.read']);
});
it.each([foreignStaff,branchStaff,id(999)])('an otherwise valid device cannot authenticate unassigned/foreign/unknown member %s',async member=>{
  const d=await enrol(),attempt=(await begin(d,member))!;expect(attempt.allowed).toBe(true);
  expect(await finish(d,attempt,credentials[member]?.verifier??'0'.repeat(64))).toBeNull();
});
it('a failed or unfinished attempt stays charged; five tries exhaust the device before another KDF',async()=>{
  const d=await enrol();for(let n=0;n<5;n++){const attempt=(await begin(d))!;expect(attempt.allowed).toBe(true);if(n<4)expect(await finish(d,attempt,'0'.repeat(64))).toBeNull();}
  const blocked=(await begin(d))!;expect(blocked.allowed).toBe(false);expect(blocked.retryAt).toBeGreaterThan(Date.now());
});
it('member limits apply across devices, and a successful login refunds only its own reservation',async()=>{
  const a=await enrol(),b=await enrol();for(let n=0;n<4;n++){const attempt=(await begin(a))!;await finish(a,attempt,'0'.repeat(64));}
  const s=await login(b);expect(await read(b,s)).not.toBeNull();const fifth=(await begin(b))!;await finish(b,fifth,'0'.repeat(64));
  expect((await begin(b))?.allowed).toBe(false);
});
it('unknown member guesses consume the device budget too',async()=>{
  const d=await enrol();for(let n=0;n<5;n++)expect((await begin(d,id(999)))?.allowed).toBe(true);expect((await begin(d))?.allowed).toBe(false);
});
it('wrong PIN proof consumes its one-time attempt and cannot be replayed with the correct proof',async()=>{
  const d=await enrol(),attempt=(await begin(d))!;expect(await finish(d,attempt,'0'.repeat(64))).toBeNull();expect(await finish(d,attempt,credentials[staff].verifier)).toBeNull();
});
it('an attempt cannot move to another device and a successful finish returns its secret only once',async()=>{
  const a=await enrol(),b=await enrol(),attempt=(await begin(a))!;expect(await finish(b,attempt,credentials[staff].verifier)).toBeNull();
  expect(await finish(a,attempt,credentials[staff].verifier)).not.toBeNull();expect(await finish(a,attempt,credentials[staff].verifier)).toBeNull();
});
it('PIN rotation, deactivation, assignment removal and live permission changes affect existing sessions',async()=>{
  const d=await enrol(),s=await login(d);await db.query('update public.members set permissions=$1 where id=$2',[JSON.stringify({'orders.read':true}),staff]);expect((await read(d,s))?.permissions).toEqual(['orders.read']);
  await db.query('update public.members set active=false where id=$1',[staff]);expect(await read(d,s)).toBeNull();await db.query('update public.members set active=true where id=$1',[staff]);
  await db.query('delete from public.member_outlets where member_id=$1 and outlet_id=$2',[staff,outlet]);expect(await read(d,s)).toBeNull();await db.query('insert into public.member_outlets values($1,$2,$3)',[business,staff,outlet]);
  await setPin();expect(await read(d,s)).toBeNull();
});
it('expired attempts and sessions fail closed',async()=>{
  const d=await enrol(),attempt=(await begin(d))!;await db.query('update private.staff_pin_attempts set created_at=created_at-60000,expires_at=expires_at-60000 where id=$1',[attempt.attemptId]);expect(await finish(d,attempt,credentials[staff].verifier)).toBeNull();
  const s=await login(d);await db.query('update private.device_sessions set created_at=created_at-43200000,expires_at=expires_at-43200000 where id=$1',[s.id]);expect(await read(d,s)).toBeNull();
});
it('revocation is audited/idempotent and immediately invalidates sessions and pending attempts',async()=>{
  const d=await enrol(),s=await login(d),attempt=(await begin(d))!;
  for(let n=0;n<2;n++)await asRole(2,'authenticated','select public.revoke_device($1,$2)',[d.id,newInboxId()]);
  expect(await read(d,s)).toBeNull();expect(await finish(d,attempt,credentials[staff].verifier)).toBeNull();expect(await begin(d)).toBeNull();
  expect((await db.query<{n:number}>('select count(*)::integer as n from public.events where command=\'device.revoke\' and after_data->>\'id\'=$1',[d.id])).rows[0].n).toBe(1);
});
it.each([3,4,5])('operator %s cannot revoke another outlet’s device',async n=>{
  const d=await enrol();await expect(asRole(n,'authenticated','select public.revoke_device($1,$2)',[d.id,newInboxId()])).rejects.toMatchObject({code:'42501'});
});
it('an audit collision rolls back enrolment, PIN rotation and session issuance',async()=>{
  const collision=(await db.query<{id:string}>('select id from public.events limit 1')).rows[0].id,deviceId=newInboxId();
  await expect(enrol(1,outlet,'counter',collision,deviceId)).rejects.toMatchObject({code:'23505'});expect((await db.query('select id from private.devices where id=$1',[deviceId])).rows).toEqual([]);
  const d=await enrol(),s=await login(d);await expect(setPin(1,staff,outlet,credentials[staff],collision)).rejects.toMatchObject({code:'23505'});expect(await read(d,s)).not.toBeNull();
  const attempt=(await begin(d))!,sessionId=newInboxId();await expect(finish(d,attempt,credentials[staff].verifier,collision,sessionId)).rejects.toMatchObject({code:'23505'});
  expect((await db.query('select id from private.device_sessions where id=$1',[sessionId])).rows).toEqual([]);expect(await finish(d,attempt,credentials[staff].verifier)).not.toBeNull();
});
it.each(['anon','authenticated'] as const)('%s cannot access verifiers, device hashes or the service-only PIN protocol',async actor=>{
  for(const table of ['devices','staff_pins','staff_pin_attempts','device_sessions'])for(const verb of ['select * from','delete from'])await expect(asRole(actor==='anon'?null:1,actor,`${verb} private.${table}`)).rejects.toMatchObject({code:'42501'});
  await expect(asRole(actor==='anon'?null:1,actor,'select public.begin_staff_pin($1,$2,$3)',[newInboxId(),'x'.repeat(43),staff])).rejects.toMatchObject({code:'42501'});
  await expect(asRole(actor==='anon'?null:1,actor,'select public.finish_staff_pin($1,$2,$3,$4,$5)',['x'.repeat(43),newInboxId(),'0'.repeat(64),newInboxId(),newInboxId()])).rejects.toMatchObject({code:'42501'});
});
it('staff tokens do not grant raw-table reads or public operator mutations',async()=>{
  const d=await enrol(),s=await login(d);expect(await read(d,s)).not.toBeNull();
  for(const table of ['orders','credit_accounts','customers','events'])await expect(asRole(null,'anon',`select * from public.${table}`)).rejects.toMatchObject({code:'42501'});
  await expect(asRole(null,'anon','select public.enrol_device($1,$2,$3,$4,$5)',[newInboxId(),newInboxId(),outlet,'Fake','counter'])).rejects.toMatchObject({code:'42501'});
  expect((await db.query<{n:number}>("select count(*)::integer as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef")).rows[0].n).toBe(0);
});
it('logout is bound to both secrets, audited once, and leaves the device available for another shift',async()=>{
  const d=await enrol(),other=await enrol(),s=await login(d);
  const end=async(device:Device)=>(await asRole<{data:unknown}>(null,'anon','select public.end_device_session($1,$2,$3) as data',[device.token,s.token,newInboxId()]))[0].data;
  expect(await end(other)).toBeNull();expect(await read(d,s)).not.toBeNull();
  expect(await end(d)).toEqual({sessionId:s.id,signedOut:true});expect(await end(d)).toEqual({sessionId:s.id,signedOut:true});expect(await read(d,s)).toBeNull();
  expect((await db.query<{n:number}>('select count(*)::integer as n from public.events where command=\'device.session_end\' and after_data->>\'sessionId\'=$1',[s.id])).rows[0].n).toBe(1);
  expect(await read(d,await login(d))).not.toBeNull();
});
it('only the owner can remove a PIN; removal invalidates sessions and repeated removal has one audit',async()=>{
  const d=await enrol(),s=await login(d),clear=(n:number)=>asRole(n,'authenticated','select public.clear_staff_pin($1,$2,$3)',[outlet,staff,newInboxId()]);
  await expect(clear(2)).rejects.toMatchObject({code:'42501'});await clear(1);await clear(1);expect(await read(d,s)).toBeNull();
  const attempt=(await begin(d))!;expect(await finish(d,attempt,credentials[staff].verifier)).toBeNull();
  expect((await db.query<{n:number}>('select count(*)::integer as n from public.events where command=\'staff_pin.clear\' and after_data->>\'memberId\'=$1',[staff])).rows[0].n).toBe(1);
});
it('an associated Auth ban, soft deletion or hard deletion cannot be bypassed by the staff PIN',async()=>{
  await db.query('insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,now())',[uid(6),'14155550106']);
  await db.query('update public.members set auth_user_id=$1 where id=$2',[uid(6),staff]);await setPin();
  const d=await enrol(),s=await login(d);expect(await read(d,s)).not.toBeNull();
  await db.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1",[uid(6)]);expect(await read(d,s)).toBeNull();
  await db.query('update auth.users set banned_until=null,deleted_at=now() where id=$1',[uid(6)]);expect(await read(d,s)).toBeNull();
  await db.query('delete from auth.users where id=$1',[uid(6)]);expect((await db.query<{auth_user_id:string|null}>('select auth_user_id from public.members where id=$1',[staff])).rows[0].auth_user_id).toBeNull();expect(await read(d,s)).toBeNull();
  const attempt=(await begin(d))!;expect(await finish(d,attempt,credentials[staff].verifier)).toBeNull();
});
it('expired devices cannot start or use a session',async()=>{
  const d=await enrol(),s=await login(d);await db.query('update private.devices set created_at=created_at-7776000000,expires_at=expires_at-7776000000 where id=$1',[d.id]);expect(await begin(d)).toBeNull();expect(await read(d,s)).toBeNull();
});
it('device and member attempt windows reopen after their server-side deadline',async()=>{
  const d=await enrol();for(let n=0;n<5;n++){const attempt=(await begin(d))!;await finish(d,attempt,'0'.repeat(64));}expect((await begin(d))?.allowed).toBe(false);
  await db.query('update private.devices set window_start=window_start-900000 where id=$1',[d.id]);await db.query('update private.staff_pins set window_start=window_start-900000 where member_id=$1',[staff]);
  expect(await read(d,await login(d))).not.toBeNull();
});
it('failed logout, PIN removal or device revocation audits preserve the original access',async()=>{
  const d=await enrol(),s=await login(d),collision=(await db.query<{id:string}>('select id from public.events limit 1')).rows[0].id;
  await expect(asRole(null,'anon','select public.end_device_session($1,$2,$3)',[d.token,s.token,collision])).rejects.toMatchObject({code:'23505'});expect(await read(d,s)).not.toBeNull();
  await expect(asRole(1,'authenticated','select public.clear_staff_pin($1,$2,$3)',[outlet,staff,collision])).rejects.toMatchObject({code:'23505'});expect(await read(d,s)).not.toBeNull();
  await expect(asRole(1,'authenticated','select public.revoke_device($1,$2)',[d.id,collision])).rejects.toMatchObject({code:'23505'});expect(await read(d,s)).not.toBeNull();
});

const request=(device:Device,pin='0042',member=staff,origin='https://shop.test')=>new Request('https://functions.test/device-pin',{method:'POST',headers:{Authorization:`Bearer ${device.token}`,'Content-Type':'application/json',Origin:origin},body:JSON.stringify({memberId:member,pin})});
function handler(peppers:ReadonlyMap<string,Uint8Array>=new Map([['v1',pepper]])){
  return createDevicePinHandler({peppers,origins:new Set(['https://shop.test']),newId:()=>newInboxId(),store:{
    begin:async(attemptId,deviceToken,memberId)=>(await asRole<{data:unknown}>(null,'service_role','select public.begin_staff_pin($1,$2,$3) as data',[attemptId,deviceToken,memberId]))[0].data,
    finish:async(deviceToken,attemptId,candidate,sessionId,eventId)=>(await asRole<{data:unknown}>(null,'service_role','select public.finish_staff_pin($1,$2,$3,$4,$5) as data',[deviceToken,attemptId,candidate,sessionId,eventId]))[0].data,
  }});
}
it('HTTP login runs the real KDF and SQL and returns only the new short session',async()=>{
  const d=await enrol(),response=await handler()(request(d));expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.get('access-control-allow-origin')).toBe('https://shop.test');
  const data=await response.json() as {session:Session};expect(Object.keys(data)).toEqual(['session']);expect(Object.keys(data.session).sort()).toEqual(['createdAt','deviceId','expiresAt','id','memberId','token']);expect(await read(d,data.session)).not.toBeNull();
});
it('HTTP failures are indistinguishable for a wrong PIN, unknown member and unknown device',async()=>{
  const d=await enrol(),handle=handler(),responses=await Promise.all([handle(request(d,'9999')),handle(request(d,'0042',id(999))),handle(request({...d,token:'x'.repeat(43)}))]);
  for(const response of responses){expect(response.status).toBe(401);expect(await response.json()).toEqual({error:'Check the device and PIN, then try again.'});}
});
it('HTTP charges failed attempts and returns an authoritative retry time without computing another PIN',async()=>{
  const d=await enrol(),handle=handler();for(let n=0;n<5;n++)expect((await handle(request(d,'9999'))).status).toBe(401);
  const blocked=await handle(request(d));expect(blocked.status).toBe(429);expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);expect(Number(blocked.headers.get('retry-after'))).toBeLessThanOrEqual(900);
});
it('HTTP rejects foreign origins, extra proof fields and oversized chunked bodies before any attempt',async()=>{
  const d=await enrol(),handle=handler();expect((await handle(request(d,'0042',staff,'https://evil.test'))).status).toBe(403);
  const extra=new Request('https://functions.test/device-pin',{method:'POST',headers:{Authorization:`Bearer ${d.token}`,'Content-Type':'application/json'},body:JSON.stringify({memberId:staff,pin:'0042',candidate:credentials[staff].verifier})});expect((await handle(extra)).status).toBe(400);
  const large=new Request('https://functions.test/device-pin',{method:'POST',headers:{Authorization:`Bearer ${d.token}`,'Content-Type':'application/json'},body:new ReadableStream({start(controller){controller.enqueue(new Uint8Array(2049));controller.close();}}),duplex:'half'} as RequestInit);expect((await handle(large)).status).toBe(413);
  expect((await db.query<{n:number}>('select count(*)::integer as n from private.staff_pin_attempts where device_id=$1',[d.id])).rows[0].n).toBe(0);
});
it('missing pepper configuration fails closed without disclosing credential material',async()=>{
  const d=await enrol(),response=await handler(new Map())(request(d));expect(response.status).toBe(503);const text=await response.text();expect(text).not.toContain(d.token);expect(text).not.toContain(credentials[staff].salt);expect(text).not.toContain(credentials[staff].verifier);
});

// Test-only verified-identity boundary; production forwards the original JWT.
const ownerJwt=(n:number)=>`fixture.owner_${n}.signature`;
function ownerStore():OwnerPinStore{
  async function rpc(jwt:string,query:string,params:unknown[]){
    const n=[1,2,3,4,5].find(n=>ownerJwt(n)===jwt);if(n===undefined)throw new OwnerPinDenied(401);
    try{return (await asRole<{data:unknown}>(n,'authenticated',query,params))[0].data;}
    catch(error){if((error as {code?:string}).code==='42501')throw new OwnerPinDenied();throw error;}
  }
  return {context:(jwt,o,m,action)=>rpc(jwt,'select public.staff_pin_context($1,$2,$3) as data',[o,m,action]),
    set:(jwt,o,m,e,c)=>rpc(jwt,'select public.set_staff_pin($1,$2,$3,$4,$5,$6) as data',[o,m,e,c.salt,c.verifier,c.pepperVersion]),
    clear:(jwt,o,m,e)=>rpc(jwt,'select public.clear_staff_pin($1,$2,$3) as data',[o,m,e])};
}
const ownerRequest=(n=1,action='set',pin='9876',target=outlet,member=staff)=>new Request('https://functions.test/staff-pin',{method:'POST',headers:{Authorization:`Bearer ${ownerJwt(n)}`,'Content-Type':'application/json',Origin:'https://shop.test'},body:JSON.stringify({action,outletId:target,memberId:member,...(action==='set'?{pin}:{})})});
const ownerHandler=(store=ownerStore(),key:Uint8Array|undefined=pepper)=>createOwnerPinHandler({store,pepper:key,origins:new Set(['https://shop.test']),newId:()=>newInboxId()});
it('owner context returns only authorized scope/configuration and never a salt or verifier',async()=>{
  const context=await ownerStore().context(ownerJwt(1),outlet,staff,'set');expect(context).toEqual({businessId:business,outletId:outlet,memberId:staff,configured:true});
  for(const actor of ['anon','service_role'] as const)await expect(asRole(null,actor,'select public.staff_pin_context($1,$2,$3)',[outlet,staff,'set'])).rejects.toMatchObject({code:'42501'});
});
it.each([2,3,4,5])('owner PIN HTTP rejects non-owner/foreign operator %s without changing the credential',async n=>{
  const previous=(await db.query('select revision from private.staff_pins where member_id=$1',[staff])).rows;
  expect((await ownerHandler()(ownerRequest(n))).status).toBe(403);expect((await db.query('select revision from private.staff_pins where member_id=$1',[staff])).rows).toEqual(previous);
});
it('owner PIN HTTP rejects a same-business staff member not assigned to the selected outlet',async()=>{
  expect((await ownerHandler()(ownerRequest(1,'set','9876',outlet,branchStaff))).status).toBe(403);
});
it('owner PIN HTTP sets a usable new PIN, invalidates prior sessions and returns only audit metadata',async()=>{
  const d=await enrol(),old=await login(d),response=await ownerHandler()(ownerRequest());expect(response.status).toBe(200);
  const result=await response.json() as Record<string,unknown>;expect(Object.keys(result).sort()).toEqual(['changedAt','memberId','revision']);expect(result.memberId).toBe(staff);expect(await read(d,old)).toBeNull();
  expect(await login(d,staff,'0042')).toBeNull();expect(await read(d,await login(d,staff,'9876'))).not.toBeNull();
});
it('PIN removal works for inactive/unassigned staff and remains available without the pepper',async()=>{
  const d=await enrol(),s=await login(d);await db.query('update public.members set active=false where id=$1',[staff]);await db.query('delete from public.member_outlets where member_id=$1 and outlet_id=$2',[staff,outlet]);
  const handle=createOwnerPinHandler({store:ownerStore(),origins:new Set(['https://shop.test'])}),response=await handle(ownerRequest(1,'clear'));expect(response.status).toBe(200);expect(await response.json()).toEqual({memberId:staff,cleared:true});expect(await read(d,s)).toBeNull();
});
it('owner authorization is checked again after the KDF before a PIN changes',async()=>{
  const store=ownerStore(),previous=(await db.query('select revision from private.staff_pins where member_id=$1',[staff])).rows;
  const handle=ownerHandler({...store,set:async(...args)=>{await db.query('update public.members set active=false where id=$1',[id(101)]);return store.set(...args);}});
  expect((await handle(ownerRequest())).status).toBe(403);expect((await db.query('select revision from private.staff_pins where member_id=$1',[staff])).rows).toEqual(previous);
});
it('owner PIN HTTP audit failure preserves the existing PIN and session',async()=>{
  const d=await enrol(),s=await login(d),collision=(await db.query<{id:string}>('select id from public.events limit 1')).rows[0].id;
  const handle=createOwnerPinHandler({store:ownerStore(),pepper,origins:new Set(['https://shop.test']),newId:()=>collision});
  expect((await handle(ownerRequest())).status).toBe(503);expect(await read(d,s)).not.toBeNull();expect(await login(d,staff,'0042')).not.toBeNull();
});
