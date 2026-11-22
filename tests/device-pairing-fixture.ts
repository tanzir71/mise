import {readFileSync,readdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {createStaffPin} from '../supabase/functions/_shared/staff-pin';
import {newInboxId} from '../packages/core/inbox';
import {deviceSecretHash,newDeviceSecret,parseDevicePairing,parsePairingRequest,parseSharedDevice,type DeviceMode} from '../packages/core/device-access';
export const deviceId=(n:number)=>String(n).padStart(26,'0'),deviceUid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export async function createPairingDatabase(root?:string,withCrypto=false){
 const fixtureRoot=root?pathToFileURL(resolve(root,'tests')+'/'):new URL('./',import.meta.url);
 const db=await PGlite.create(withCrypto?{extensions:{pgcrypto}}:{});if(withCrypto)await db.exec('create schema extensions;create extension pgcrypto with schema extensions');for(const name of ['supabase-auth.sql','supabase-storage.sql'])await db.exec(readFileSync(new URL('./fixtures/'+name,fixtureRoot),'utf8'));
 const directory=root?pathToFileURL(resolve(root,'supabase/migrations')+'/'):new URL('../supabase/migrations/',import.meta.url);for(const name of readdirSync(directory).filter(name=>name.endsWith('.sql')).sort())await db.exec(readFileSync(new URL(name,directory),'utf8'));
 const pepper=new Uint8Array(32).fill(19),credentials=await Promise.all([104,105].map(n=>createStaffPin('0042',{businessId:deviceId(1),memberId:deviceId(n)},pepper)));
 async function asRole<T=unknown>(n:number|null,role:'anon'|'authenticated'|'service_role',query:string,args:unknown[]=[]):Promise<T>{return db.transaction(async tx=>{await tx.exec('set local role '+role);await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role,...(n===null?{}:{sub:deviceUid(n)}),user_metadata:{role:'owner'}})]);return (await tx.query<{data:T}>(query,args)).rows[0]?.data;});}
 async function seed(){
  await db.exec('truncate public.businesses,auth.users cascade');
  for(const n of [1,2,3,4,5])await db.query('insert into auth.users(id,phone,phone_confirmed_at,is_anonymous) values($1,$2,now(),$3)',[deviceUid(n),'1415555010'+n,n===5]);
  for(const b of [1,2])await db.query('insert into public.businesses(id,name,business_type,market_code,created_at,updated_at) values($1,$2,\'corner_shop\',\'BD\',1,1)',[deviceId(b),JSON.stringify('Shop '+b)]);
  for(const [o,b] of [[11,1],[12,1],[21,2]])await db.query('insert into public.outlets(id,business_id,name,timezone,currency,created_at,updated_at) values($1,$2,$3,\'Asia/Dhaka\',\'BDT\',1,1)',[deviceId(o),deviceId(b),JSON.stringify('Outlet '+o)]);
  for(const [m,b,n,role] of [[101,1,1,'owner'],[102,1,2,'manager'],[103,1,3,'manager'],[104,1,null,'staff'],[105,1,null,'kitchen'],[106,1,null,'agent'],[107,2,4,'owner'],[108,2,null,'staff'],[110,1,5,'owner']] as const)
   await db.query('insert into public.members(id,business_id,auth_user_id,name,role,permissions,created_at,updated_at) values($1,$2,$3,$4,$5,$6,1,1)',[deviceId(m),deviceId(b),n===null?null:deviceUid(n),JSON.stringify('Member '+m),role,JSON.stringify({'orders.read':true,'orders.ready':true,'counter.sell':true})]);
  for(const [m,o,b] of [[102,11,1],[103,12,1],[104,11,1],[104,12,1],[105,11,1],[106,11,1],[108,21,2]])await db.query('insert into public.member_outlets values($1,$2,$3)',[deviceId(b),deviceId(m),deviceId(o)]);
  for(let i=0;i<credentials.length;i++){const c=credentials[i];await asRole(1,'authenticated','select public.set_staff_pin($1,$2,$3,$4,$5,$6) data',[deviceId(11),deviceId(104+i),newInboxId(),c.salt,c.verifier,c.pepperVersion]);}
 }
 async function start(n=1,outlet=deviceId(11),mode:DeviceMode='kitchen',id=newInboxId(),eventId=newInboxId()){
  const args=[id,eventId,outlet,'Kitchen tablet',mode];return {args,pairing:parseDevicePairing(await asRole(n,'authenticated','select public.start_device_pairing($1,$2,$3,$4,$5) data',args))};
 }
 async function request(code:string,pairingId:string|null=null,id=newInboxId(),secret=newDeviceSecret()){
  const tokenHash=await deviceSecretHash(secret),value=await asRole(null,'service_role','select public.request_device_pairing($1,$2,$3,$4) data',[id,code,pairingId,tokenHash]);
  return {id,secret,tokenHash,request:value===null?null:parsePairingRequest(value,{id,tokenHash})};
 }
 async function approve(pairingId:string,claim:Awaited<ReturnType<typeof request>>,n=1,eventId=newInboxId(),verification=claim.request!.verification){return parseSharedDevice(await asRole(n,'authenticated','select public.approve_device_pairing($1,$2,$3,$4) data',[pairingId,claim.id,verification,eventId]));}
 const poll=(claim:Awaited<ReturnType<typeof request>>,secret=claim.secret)=>asRole(null,'service_role','select public.read_device_pairing($1,$2) data',[claim.id,secret]);
 const directoryRead=(secret:string,after:string|null=null,limit=50)=>asRole(null,'service_role','select public.read_device_signin($1,$2,$3) data',[secret,after,limit]);
 return {db,asRole,seed,start,request,approve,poll,directoryRead,pepper};
}
export type PairingDatabase=Awaited<ReturnType<typeof createPairingDatabase>>;
