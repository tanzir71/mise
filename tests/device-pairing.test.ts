import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {createPairingDatabase,deviceId,deviceUid,type PairingDatabase} from './device-pairing-fixture';
import {newInboxId} from '../packages/core/inbox';
import {deviceLifetime,deviceSecretHash,newDeviceSecret,parseDeviceDirectory,parsePairingOutcome,deviceVerification,parseDeviceAdminPage} from '../packages/core/device-access';
let f:PairingDatabase;
beforeAll(async()=>{f=await createPairingDatabase();},30_000);
beforeEach(async()=>{await f.seed();});afterAll(async()=>{await f?.db.close();});
const count=async(table:string)=>Number((await f.db.query<{n:number}>(`select count(*) n from ${table}`)).rows[0].n);
it('a six-digit code creates only a request; even its correct secret grants no device before approval',async()=>{
 const {pairing}=await f.start(),r=await f.request(pairing.code,pairing.id);expect(r.request?.verification).toBe(deviceVerification(r.tokenHash));expect(await count('private.devices')).toBe(0);
 expect(parsePairingOutcome(await f.poll(r),r)).toMatchObject({state:'waiting',verification:r.request?.verification});expect(await f.directoryRead(r.secret)).toBeNull();
});
it('the live owner approves the exact verification; only a hash persists and lost replies recover the original device',async()=>{
 const start=await f.start(),r=await f.request(start.pairing.code,start.pairing.id),d=await f.approve(start.pairing.id,r);expect(d).toMatchObject({id:r.id,mode:'kitchen',outletId:deviceId(11)});expect(d.expiresAt-d.createdAt).toBe(deviceLifetime);
 expect(await f.approve(start.pairing.id,r,1,newInboxId())).toEqual(d);expect(parsePairingOutcome(await f.poll(r),r)).toMatchObject({state:'approved',device:d});expect(await count('private.devices')).toBe(1);
 expect((await f.db.query<{hash:string}>('select encode(token_hash,\'hex\') hash from private.devices where id=$1',[d.id])).rows[0].hash).toBe(r.tokenHash);
 const events=(await f.db.query<{after:string}>('select after_data::text after from public.events where command like \'device.%\'')).rows;
 for(const event of events){const value=JSON.parse(event.after);expect(value).not.toHaveProperty('token');expect(value).not.toHaveProperty('code');expect(value).not.toHaveProperty('tokenHash');expect(event.after).not.toContain(r.secret);}
 expect((await f.db.query<{n:number}>('select count(*) n from public.events where command=\'device.enrol\'')).rows[0].n).toBe(1);
});
it('a changed verification cannot grant any screen, even when the short code is correct',async()=>{
 const {pairing}=await f.start(),r=await f.request(pairing.code);await expect(f.approve(pairing.id,r,1,newInboxId(),'0000-0000-0000-0000')).rejects.toThrow();expect(await count('private.devices')).toBe(0);expect(parsePairingOutcome(await f.poll(r),r).state).toBe('waiting');
});
it('replaying the original create returns the same code, expiry and audit rather than making a new invitation',async()=>{
 const first=await f.start(),again=await f.asRole(1,'authenticated','select public.start_device_pairing($1,$2,$3,$4,$5) data',first.args);expect(again).toEqual(first.pairing);expect(await count('private.device_pairings')).toBe(1);
 const changed=[...first.args];changed[3]='A different screen';await expect(f.asRole(1,'authenticated','select public.start_device_pairing($1,$2,$3,$4,$5) data',changed)).rejects.toThrow();
});
it('only one requested screen can be approved from an invitation',async()=>{
 const {pairing}=await f.start(),a=await f.request(pairing.code),b=await f.request(pairing.code);await f.approve(pairing.id,a);await expect(f.approve(pairing.id,b)).rejects.toThrow();expect(await count('private.devices')).toBe(1);expect(parsePairingOutcome(await f.poll(b),b).state).toBe('cancelled');
});
it('request retry is idempotent and a different secret cannot replace the original request or poll its outcome',async()=>{
 const {pairing}=await f.start(),r=await f.request(pairing.code);expect((await f.request(pairing.code,null,r.id,r.secret)).request).toEqual(r.request);expect((await f.request(pairing.code,null,r.id,newDeviceSecret())).request).toBeNull();expect(await f.poll(r,newDeviceSecret())).toBeNull();expect(await count('private.device_pairing_requests')).toBe(1);
});
it('unknown codes, foreign invitation selectors and exhausted requests never create devices',async()=>{
 const {pairing}=await f.start();expect((await f.request(pairing.code,newInboxId())).request).toBeNull();
 for(let n=0;n<5;n++)expect((await f.request(pairing.code)).request).not.toBeNull();expect((await f.request(pairing.code)).request).toBeNull();expect(await count('private.device_pairing_requests')).toBe(5);expect(await count('private.devices')).toBe(0);
});
it('an assigned manager can approve its screen while an unassigned manager and foreign owner cannot inspect it',async()=>{
 const {pairing}=await f.start(2),r=await f.request(pairing.code);expect((await f.approve(pairing.id,r,2)).outletId).toBe(deviceId(11));
 for(const n of [3,4]){await expect(f.asRole(n,'authenticated','select public.inspect_device_pairing($1) data',[pairing.id])).rejects.toThrow();await expect(f.start(n)).rejects.toThrow();}
});
it.each(['ban','unconfirmed','inactive','anonymous'] as const)('live %s revocation blocks approval of an already prepared screen',async kind=>{
 const {pairing}=await f.start(),r=await f.request(pairing.code);
 if(kind==='ban')await f.db.query('update auth.users set banned_until=now()+interval \'1 hour\' where id=$1',[deviceUid(1)]);
 if(kind==='unconfirmed')await f.db.query('update auth.users set phone_confirmed_at=null where id=$1',[deviceUid(1)]);
 if(kind==='anonymous')await f.db.query('update auth.users set is_anonymous=true where id=$1',[deviceUid(1)]);
 if(kind==='inactive')await f.db.query('update public.members set active=false where id=$1',[deviceId(101)]);
 await expect(f.approve(pairing.id,r)).rejects.toThrow();expect(await count('private.devices')).toBe(0);
});
it('a confirmed anonymous account with forged owner metadata cannot create an invitation',async()=>{await expect(f.start(5)).rejects.toThrow();});
it('expiry cannot be extended by a replay, and expired codes cannot approve a device',async()=>{
 const start=await f.start(),r=await f.request(start.pairing.code);await f.db.query('update private.device_pairings set created_at=created_at-600001,expires_at=expires_at-600001 where id=$1',[start.pairing.id]);
 expect(parsePairingOutcome(await f.poll(r),r).state).toBe('expired');await expect(f.approve(start.pairing.id,r)).rejects.toThrow();expect((await f.request(start.pairing.code)).request).toBeNull();
 const again=await f.asRole<{expiresAt:number}>(1,'authenticated','select public.start_device_pairing($1,$2,$3,$4,$5) data',start.args);expect(again.expiresAt).toBe(start.pairing.expiresAt-600001);
});
it('cancel is audited once and leaves the waiting screen without a credential',async()=>{
 const {pairing}=await f.start(),r=await f.request(pairing.code),event=newInboxId();const first=await f.asRole(1,'authenticated','select public.cancel_device_pairing($1,$2) data',[pairing.id,event]);
 expect(await f.asRole(1,'authenticated','select public.cancel_device_pairing($1,$2) data',[pairing.id,newInboxId()])).toEqual(first);expect(parsePairingOutcome(await f.poll(r),r).state).toBe('cancelled');expect(await count('private.devices')).toBe(0);
});
it('a staff directory is outlet/mode/PIN scoped, paginated, literal and free of contact or Auth data',async()=>{
 const {pairing}=await f.start(),r=await f.request(pairing.code),d=await f.approve(pairing.id,r),name='Kitchen · বাংলা'+String.fromCharCode(0,0xd800);await f.db.query('update public.members set name=$1 where id=$2',[JSON.stringify(name),deviceId(105)]);
 const first=parseDeviceDirectory(await f.directoryRead(r.secret,null,1),d,null,1);expect(first.members.map(m=>m.id)).toEqual([deviceId(104)]);expect(first.next).toBe(deviceId(104));
 const last=parseDeviceDirectory(await f.directoryRead(r.secret,first.next,1),d,first.next,1);expect(last.members).toEqual([{id:deviceId(105),nameJson:JSON.stringify(name)}]);expect(last.next).toBeNull();expect(JSON.stringify(first)).not.toContain('auth_user_id');expect(JSON.stringify(last)).not.toContain('phone');
 await f.db.query('delete from public.member_outlets where member_id=$1 and outlet_id=$2',[deviceId(104),deviceId(11)]);expect(parseDeviceDirectory(await f.directoryRead(r.secret),d).members.map(m=>m.id)).toEqual([deviceId(105)]);
});
it('counter discovery cannot reveal a kitchen-only member and immediate permission/PIN changes remove members',async()=>{
 const {pairing}=await f.start(1,deviceId(11),'counter'),r=await f.request(pairing.code),d=await f.approve(pairing.id,r);expect(parseDeviceDirectory(await f.directoryRead(r.secret),d).members.map(m=>m.id)).toEqual([deviceId(104)]);
 await f.db.query('update public.members set permissions=\'{}\' where id=$1',[deviceId(104)]);expect(parseDeviceDirectory(await f.directoryRead(r.secret),d).members).toEqual([]);
});
it('device revocation takes effect on both recovery and staff discovery without disclosing an old token',async()=>{
 const {pairing}=await f.start(),r=await f.request(pairing.code),d=await f.approve(pairing.id,r);await f.asRole(1,'authenticated','select public.revoke_device($1,$2) data',[d.id,newInboxId()]);expect(parsePairingOutcome(await f.poll(r),r).state).toBe('cancelled');expect(await f.directoryRead(r.secret)).toBeNull();
});
it.each(['anon','authenticated','service_role'] as const)('%s cannot directly inspect pairing secrets or request hashes',async role=>{
 await expect(f.asRole(role==='authenticated'?1:null,role,'select to_jsonb(p) data from private.device_pairings p')).rejects.toThrow();await expect(f.asRole(role==='authenticated'?1:null,role,'select to_jsonb(p) data from private.device_pairing_requests p')).rejects.toThrow();
});
it.each(['anon','authenticated'] as const)('%s cannot call service-only pairing or directory RPCs',async role=>{
 await expect(f.asRole(role==='authenticated'?1:null,role,'select public.request_device_pairing($1,$2,null,$3) data',[newInboxId(),'123456',await deviceSecretHash(newDeviceSecret())])).rejects.toThrow();await expect(f.asRole(role==='authenticated'?1:null,role,'select public.read_device_signin($1,null,10) data',[newDeviceSecret()])).rejects.toThrow();
});
it('the admin lists only the selected outlet devices/pairings and checks the live original operator',async()=>{
 const a=await f.start(),b=await f.start(1,deviceId(12)),r=await f.request(a.pairing.code);await f.approve(a.pairing.id,r);
 const expected={businessId:deviceId(1),outletId:deviceId(11),actorId:deviceId(102)},raw=await f.asRole(2,'authenticated','select public.read_device_admin($1,$2,null,50) data',[deviceId(11),'devices']);
 expect(parseDeviceAdminPage(raw,expected,'devices').entries.map(value=>value.id)).toEqual([r.id]);
 await expect(f.asRole(2,'authenticated','select public.read_device_admin($1,$2,null,50) data',[deviceId(12),'devices'])).rejects.toThrow();
 const branch=await f.asRole(1,'authenticated','select public.read_device_admin($1,$2,null,50) data',[deviceId(12),'pairings']);expect(parseDeviceAdminPage(branch,{businessId:deviceId(1),outletId:deviceId(12),actorId:deviceId(101)},'pairings').entries.map(value=>value.id)).toEqual([b.pairing.id]);
});
it('PIN administration lists inactive/unassigned staff for clearing, without granting a manager global PIN metadata',async()=>{
 await f.db.query('update public.members set active=false where id=$1',[deviceId(104)]);await f.db.query('delete from public.member_outlets where member_id=$1',[deviceId(104)]);
 const raw=await f.asRole(1,'authenticated','select public.read_device_admin($1,$2,null,50) data',[deviceId(11),'members']),page=parseDeviceAdminPage(raw,{businessId:deviceId(1),outletId:deviceId(11),actorId:deviceId(101)},'members');if(page.kind!=='members')throw Error('Wrong admin page');
 expect(page.entries.find(value=>value.id===deviceId(104))).toMatchObject({active:false,assigned:false,configured:true});expect(page.entries.some(value=>value.id===deviceId(108))).toBe(false);expect(JSON.stringify(raw)).not.toContain('auth_user_id');expect(JSON.stringify(raw)).not.toContain('verifier');
 await expect(f.asRole(2,'authenticated','select public.read_device_admin($1,$2,null,50) data',[deviceId(11),'members'])).rejects.toThrow();
});
it('device admin pagination preserves all original invitations without returning foreign or repeated IDs',async()=>{
 const a=await f.start(),b=await f.start(),expected={businessId:deviceId(1),outletId:deviceId(11),actorId:deviceId(101)},ids=[a.pairing.id,b.pairing.id].sort();
 const first=parseDeviceAdminPage(await f.asRole(1,'authenticated','select public.read_device_admin($1,$2,null,1) data',[deviceId(11),'pairings']),expected,'pairings',null,1);expect(first.entries.map(value=>value.id)).toEqual([ids[0]]);expect(first.next).toBe(ids[0]);
 const last=parseDeviceAdminPage(await f.asRole(1,'authenticated','select public.read_device_admin($1,$2,$3,1) data',[deviceId(11),'pairings',first.next]),expected,'pairings',first.next,1);expect(last.entries.map(value=>value.id)).toEqual([ids[1]]);expect(last.next).toBeNull();
});
it('PIN administration retains a former staff PIN after a role change to rider for owner removal, without making the rider eligible for device sign-in',async()=>{
 await f.db.query("update public.members set role='rider' where id=$1",[deviceId(104)]);
 const page=parseDeviceAdminPage(await f.asRole(1,'authenticated','select public.read_device_admin($1,$2,null,50) data',[deviceId(11),'members']),{businessId:deviceId(1),outletId:deviceId(11),actorId:deviceId(101)},'members');if(page.kind!=='members')throw Error();expect(page.entries.find(m=>m.id===deviceId(104))).toMatchObject({role:'rider',configured:true});
 const {pairing}=await f.start(),claim=await f.request(pairing.code),device=await f.approve(pairing.id,claim),directory=parseDeviceDirectory(await f.directoryRead(claim.secret),device);expect(directory.members.some(m=>m.id===deviceId(104))).toBe(false);
 expect(await f.asRole(1,'authenticated','select public.staff_pin_context($1,$2,$3) data',[deviceId(11),deviceId(104),'clear'])).toMatchObject({configured:true});expect(await f.asRole(1,'authenticated','select public.clear_staff_pin($1,$2,$3) data',[deviceId(11),deviceId(104),newInboxId()])).toMatchObject({cleared:true});
});
