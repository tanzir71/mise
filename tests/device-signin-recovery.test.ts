import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {createPairingDatabase,deviceId,type PairingDatabase} from './device-pairing-fixture';
import {newInboxId} from '../packages/core/inbox';
import {createDevicePinHandler} from '../supabase/functions/_shared/device-pin-handler';
import {createDeviceAccessHandler,type DeviceAccessStore} from '../supabase/functions/_shared/device-access-handler';
let f:PairingDatabase;
beforeAll(async()=>{f=await createPairingDatabase();},30_000);beforeEach(async()=>{await f.seed();});afterAll(async()=>{await f?.db.close();});
async function enroll(){const {pairing}=await f.start(),claim=await f.request(pairing.code);await f.approve(pairing.id,claim);return claim;}
const reset=(secret:string,id=newInboxId(),attemptId:string|null=null)=>f.asRole(null,'service_role','select public.reset_device_signins($1,$2,$3) data',[secret,id,attemptId]);
function pin(){return createDevicePinHandler({origins:new Set(['https://shop.test']),peppers:new Map([['v1',f.pepper]]),store:{begin:(id,secret,member)=>f.asRole(null,'service_role','select public.begin_staff_pin($1,$2,$3) data',[id,secret,member]),finish:(secret,id,proof,session,event)=>f.asRole(null,'service_role','select public.finish_staff_pin($1,$2,$3,$4,$5) data',[secret,id,proof,session,event])}});}
const request=(secret:string,body:unknown)=>new Request('https://api.test/device-pin',{method:'POST',headers:{Origin:'https://shop.test',Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify(body)});
async function login(secret:string,member=deviceId(105),attemptId=newInboxId()){
 const response=await pin()(request(secret,{attemptId,memberId:member,pin:'0042'}));expect(response.status).toBe(200);return (await response.json()).session as {id:string;token:string};
}
const access=(secret:string,token:string)=>f.asRole(null,'service_role','select public.read_device_session($1,$2) data',[secret,token]);
it('screen recovery ends every existing sign-in on only that screen, retaining PIN counters and enrollment',async()=>{
 const a=await enroll(),b=await enroll(),sa=await login(a.secret),sa2=await login(a.secret,deviceId(104)),sb=await login(b.secret),before=(await f.db.query('select attempts,window_start,token_hash from private.devices where id=$1',[a.id])).rows;
 const id=newInboxId();expect(await reset(a.secret,id)).toEqual({id,deviceId:a.id,signedOut:true});expect(await access(a.secret,sa.token)).toBeNull();expect(await access(a.secret,sa2.token)).toBeNull();expect(await access(b.secret,sb.token)).not.toBeNull();
 expect((await f.db.query('select attempts,window_start,token_hash from private.devices where id=$1',[a.id])).rows).toEqual(before);expect(await f.directoryRead(a.secret)).not.toBeNull();
 const audits=(await f.db.query<{command:string;after_data:unknown}>('select command,after_data from public.events where id=$1',[id])).rows;expect(audits).toEqual([{command:'device.signins_reset',after_data:{id,deviceId:a.id,signedOut:true,attemptId:null}}]);expect(JSON.stringify(audits)).not.toContain(a.secret);expect(JSON.stringify(audits)).not.toContain(sa.token);
});
it('a reset before delayed PIN begin retires the durable attempt ID and prevents a later session',async()=>{
 const a=await enroll(),attemptId=newInboxId();await reset(a.secret,newInboxId(),attemptId);
 const response=await pin()(request(a.secret,{attemptId,memberId:deviceId(105),pin:'0042'}));expect(response.status).toBe(503);expect((await f.db.query<{n:number}>('select count(*)::integer n from private.device_sessions where device_id=$1',[a.id])).rows[0].n).toBe(0);
 const used=(await f.db.query<{used_at:number}>('select used_at from private.staff_pin_attempts where id=$1',[attemptId])).rows[0];expect(used.used_at).not.toBeNull();
});
it('a reset after PIN begin rejects the original finish and does not reopen the guessing budget',async()=>{
 const a=await enroll(),attemptId=newInboxId();await f.asRole(null,'service_role','select public.begin_staff_pin($1,$2,$3) data',[attemptId,a.secret,deviceId(105)]);
 const before=(await f.db.query('select attempts,window_start from private.devices where id=$1',[a.id])).rows;await reset(a.secret,newInboxId(),attemptId);
 expect(await f.asRole(null,'service_role','select public.finish_staff_pin($1,$2,$3,$4,$5) data',[a.secret,attemptId,'0'.repeat(64),newInboxId(),newInboxId()])).toBeNull();expect((await f.db.query('select attempts,window_start from private.devices where id=$1',[a.id])).rows).toEqual(before);
});
it('lost reset replies retry the same receipt without terminating a newer explicit sign-in',async()=>{
 const a=await enroll(),attemptId=newInboxId(),first=await login(a.secret,deviceId(105),attemptId),id=newInboxId(),receipt=await reset(a.secret,id,attemptId),second=await login(a.secret);
 expect(await reset(a.secret,id,attemptId)).toEqual(receipt);expect(await access(a.secret,first.token)).toBeNull();expect(await access(a.secret,second.token)).not.toBeNull();await expect(reset(a.secret,id,null)).rejects.toThrow();
 expect((await f.db.query<{n:number}>('select count(*)::integer n from public.events where id=$1',[id])).rows[0].n).toBe(1);
});
it('foreign credentials, attempts and roles cannot clear another screen or reuse its receipt',async()=>{
 const a=await enroll(),b=await enroll(),attemptId=newInboxId(),sb=await login(b.secret,deviceId(105),attemptId),id=newInboxId();expect(await reset(a.secret,id,attemptId)).toBeNull();expect(await access(b.secret,sb.token)).not.toBeNull();
 expect(await reset('Z'.repeat(43))).toBeNull();await reset(b.secret,id,attemptId);await expect(reset(a.secret,id,attemptId)).rejects.toThrow();
 for(const role of ['anon','authenticated'] as const)await expect(f.asRole(role==='authenticated'?1:null,role,'select public.reset_device_signins($1,$2,$3) data',[a.secret,newInboxId(),null])).rejects.toThrow();
 expect((await f.db.query<{n:number}>("select count(*)::integer n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef")).rows[0].n).toBe(0);
});
it('recovery can close a revoked or expired screen session without restoring device access',async()=>{
 const a=await enroll(),session=await login(a.secret);await f.asRole(1,'authenticated','select public.revoke_device($1,$2) data',[a.id,newInboxId()]);expect(await reset(a.secret)).toMatchObject({deviceId:a.id,signedOut:true});expect(await access(a.secret,session.token)).toBeNull();expect(await f.directoryRead(a.secret)).toBeNull();
});
it('the recovery HTTP boundary returns only the scoped receipt and rejects caller-selected devices or extras',async()=>{
 const a=await enroll(),session=await login(a.secret),id=newInboxId(),store:DeviceAccessStore={request:async()=>null,poll:async()=>null,directory:async()=>null,session:async()=>null,logout:async()=>null,reset},handler=createDeviceAccessHandler({store,origins:new Set(['https://shop.test'])});
 expect((await handler(request(a.secret,{action:'reset',id,attemptId:null,deviceId:a.id}))).status).toBe(400);
 const response=await handler(request(a.secret,{action:'reset',id,attemptId:null}));expect(response.status).toBe(200);expect(await response.json()).toEqual({id,deviceId:a.id,signedOut:true});expect(await access(a.secret,session.token)).toBeNull();
});
