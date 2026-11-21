import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {createPairingDatabase,deviceId,type PairingDatabase} from './device-pairing-fixture';
import {createDeviceAccessHandler,createDeviceAccessStore} from '../supabase/functions/_shared/device-access-handler';
import {createDevicePinHandler} from '../supabase/functions/_shared/device-pin-handler';
import {createDeviceOrdersHandler} from '../supabase/functions/_shared/device-orders-handler';
import {deviceSecretHash,newDeviceSecret,parseDeviceDirectory,parsePairingOutcome,parsePairingRequest,parseStaffDeviceAccess,parseStaffDeviceSession} from '../packages/core/device-access';
import {newInboxId} from '../packages/core/inbox';
let f:PairingDatabase;
beforeAll(async()=>{f=await createPairingDatabase();},30_000);beforeEach(async()=>{await f.seed();});afterAll(async()=>{await f?.db.close();});
const origin='https://shop.test';
const http=(path:string,secret:string,body:unknown)=>new Request('https://api.test/'+path,{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify(body)});
function handler(){
 // Exercise the production service adapter against the published SQL argument
 // names. Positional fixture callbacks cannot detect a broken PostgREST body.
 const allowed=new Set(['request_device_pairing','read_device_pairing','read_device_signin','read_device_session','end_device_session','reset_device_signins']);
 const send:typeof fetch=async(url,options)=>{
  const endpoint=new URL(String(url)),name=endpoint.pathname.split('/').at(-1)!;
  if(endpoint.origin!=='https://service.test'||!allowed.has(name)||typeof options?.body!=='string')throw Error('Use the fixed service RPC.');
  const args=JSON.parse(options.body) as Record<string,unknown>,rows=await f.db.query<{proargnames:string[]}>("select p.proargnames from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1",[name]);
  const parameters=rows.rows[0]?.proargnames;
  if(rows.rows.length!==1||!parameters||parameters.length!==Object.keys(args).length||!parameters.every(key=>/^[a-z_]+$/.test(key)&&Object.hasOwn(args,key)))return new Response('RPC arguments do not match the published function.',{status:404});
  const value=await f.asRole(null,'service_role',`select public.${name}(${parameters.map((key,index)=>`${key} => $${index+1}`).join(',')}) data`,parameters.map(key=>args[key]));
  return new Response(JSON.stringify(value));
 };
 const store=createDeviceAccessStore('https://service.test','sb_secret_test_only',send);
 return createDeviceAccessHandler({store,origins:new Set([origin])});
}
it('actual HTTP and SQL pair an empty screen, require a real PIN derivation, expose scoped access and revoke the session on logout',async()=>{
 const {pairing}=await f.start(),secret=newDeviceSecret(),id=newInboxId(),tokenHash=await deviceSecretHash(secret),access=handler();
 const requested=await access(http('device-access',secret,{action:'request',id,code:pairing.code,pairingId:pairing.id}));expect(requested.status).toBe(200);const claim=parsePairingRequest(await requested.json(),{id,tokenHash});
 expect((await access(http('device-access',secret,{action:'directory',after:null,limit:50}))).status).toBe(401);
 const approved=await f.approve(pairing.id,{id,secret,tokenHash,request:claim}),polled=await access(http('device-access',secret,{action:'poll',id}));expect(polled.status).toBe(200);expect(parsePairingOutcome(await polled.json(),{id,tokenHash})).toMatchObject({state:'approved',device:approved});
 const directory=await access(http('device-access',secret,{action:'directory',after:null,limit:50}));expect(parseDeviceDirectory(await directory.json(),approved).members.map(m=>m.id)).toEqual([deviceId(104),deviceId(105)]);
 const pin=createDevicePinHandler({origins:new Set([origin]),peppers:new Map([['v1',f.pepper]]),store:{begin:(attempt,device,member)=>f.asRole(null,'service_role','select public.begin_staff_pin($1,$2,$3) data',[attempt,device,member]),finish:(device,attempt,candidate,session,event)=>f.asRole(null,'service_role','select public.finish_staff_pin($1,$2,$3,$4,$5) data',[device,attempt,candidate,session,event])}});
 const signed=await pin(http('device-pin',secret,{memberId:deviceId(105),pin:'0042'}));expect(signed.status).toBe(200);const session=parseStaffDeviceSession((await signed.json()).session,{deviceId:id,memberId:deviceId(105)});
 const checked=await access(http('device-access',secret,{action:'session',sessionToken:session.token}));expect(checked.status).toBe(200);expect(parseStaffDeviceAccess(await checked.json(),{device:approved,session}).permissions).toEqual(['orders.acknowledge','orders.read','orders.ready']);
 const orders=createDeviceOrdersHandler({origins:new Set([origin]),store:{read:(device,session,after,limit)=>f.asRole(null,'service_role','select public.read_device_orders($1,$2,$3,$4,$5) data',[device,session,after?.createdAt??null,after?.id??null,limit])}}),empty=await orders(http('device-orders',secret,{sessionToken:session.token}));expect(empty.status).toBe(200);expect(await empty.json()).toMatchObject({mode:'kitchen',orders:[]});
 for(let n=0;n<2;n++){const signedOut=await access(http('device-access',secret,{action:'logout',sessionToken:session.token}));expect(signedOut.status).toBe(200);expect(await signedOut.json()).toEqual({sessionId:session.id,signedOut:true});}
 expect((await access(http('device-access',secret,{action:'session',sessionToken:session.token}))).status).toBe(401);expect((await orders(http('device-orders',secret,{sessionToken:session.token}))).status).toBe(401);
 expect((await f.db.query<{n:number}>('select count(*) n from public.events where command=\'device.session_end\'')).rows[0].n).toBe(1);
});
it('a cancelled or wrong verification never becomes HTTP access, even when the requester knows the short code',async()=>{
 const {pairing}=await f.start(),r=await f.request(pairing.code),access=handler();await expect(f.approve(pairing.id,r,1,newInboxId(),'0000-0000-0000-0000')).rejects.toThrow();
 expect((await access(http('device-access',r.secret,{action:'directory',after:null,limit:50}))).status).toBe(401);
 await f.asRole(1,'authenticated','select public.cancel_device_pairing($1,$2) data',[pairing.id,newInboxId()]);const poll=await access(http('device-access',r.secret,{action:'poll',id:r.id}));expect(poll.status).toBe(200);expect(parsePairingOutcome(await poll.json(),r).state).toBe('cancelled');
 expect((await access(http('device-access',r.secret,{action:'directory',after:null,limit:50}))).status).toBe(401);
});
