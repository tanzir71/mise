import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createStaffDeviceFixture,staffDeviceOrigin} from './staff-device-fixture';
import {deviceId} from './device-pairing-fixture';
import {parseStaffDeviceBoard,parseStaffDeviceBoardRequest} from '../packages/core/staff-device-board';
import {parseStaffDeviceSession} from '../packages/core/device-access';
import {createStaffDeviceStore} from '../supabase/functions/_shared/staff-device-handler';
let f:Awaited<ReturnType<typeof createStaffDeviceFixture>>;
beforeAll(async()=>{f=await createStaffDeviceFixture();},30000);beforeEach(async()=>{await f.seed();await f.configure();});afterAll(async()=>{await f?.db.close();});
async function setup(limit=600){const {pairing}=await f.start(),claim=await f.request(pairing.code,pairing.id),device=await f.approve(pairing.id,claim),h=f.handlers(staffDeviceOrigin,limit),response=await h.pin(new Request('https://screen.test/device-pin',{method:'POST',headers:{Origin:staffDeviceOrigin,Authorization:'Bearer '+claim.secret,'Content-Type':'application/json'},body:JSON.stringify({memberId:deviceId(105),pin:'0042'})}));
 const raw=await response.json(),session=parseStaffDeviceSession(raw.session,{deviceId:device.id,memberId:deviceId(105)});
 const request=(after:string|null=null,extra:object={})=>new Request('https://screen.test/functions/v1/staff-device',{method:'POST',headers:{Origin:staffDeviceOrigin,Authorization:'Bearer '+claim.secret,'Content-Type':'application/json'},body:JSON.stringify({operation:'board',sessionToken:session.token,after,...extra})});
 return {device,claim,session,h,read:(after:string|null=null,extra:object={})=>h.staff(request(after,extra))};}
it('projects only actual assigned humans and no contact, Auth, PIN or other-outlet data over HTTP',async()=>{
 const t=await setup(),response=await t.read();expect(response.status).toBe(200);const raw=await response.json(),board=parseStaffDeviceBoard(raw,null,{device:t.device,session:t.session});expect(board.members.map(m=>m.id)).toEqual([102,104,105].map(deviceId));expect(board.members.find(m=>m.id===deviceId(105))).toMatchObject({name:'Karim Uddin',canSignIn:true,latest:null});
 for(const key of ['"phone":','auth_user_id','salt','verifier','token_hash',t.claim.secret,t.session.token])expect(JSON.stringify(raw)).not.toContain(key);expect(response.headers.get('Cache-Control')).toBe('no-store');
});
it('pages every real member once and preserves literal legacy name bytes',async()=>{
 for(let n=200;n<325;n++){await f.db.query('insert into public.members(id,business_id,name,role,permissions,created_at,updated_at) values($1,$2,$3,\'staff\',\'{}\',1,1)',[deviceId(n),deviceId(1),JSON.stringify('Crew '+n)]);await f.db.query('insert into public.member_outlets values($1,$2,$3)',[deviceId(1),deviceId(n),deviceId(11)]);}
 const name='Karim\u0000\ud800';await f.db.query('update public.members set name=$1 where id=$2',[JSON.stringify(name),deviceId(105)]);const t=await setup(),ids:string[]=[];let after:string|null=null;
 do{const b=parseStaffDeviceBoard(await(await t.read(after)).json(),after,{device:t.device,session:t.session});ids.push(...b.members.map(m=>m.id));if(after===null)expect(b.members.find(m=>m.id===deviceId(105))?.name).toBe(name);after=b.next;}while(after);expect(ids).toHaveLength(128);expect(new Set(ids).size).toBe(128);
});
it('shares the existing per-device budget and loses fresh access immediately when its method is removed',async()=>{
 const t=await setup(1);expect((await t.read()).status).toBe(200);const limited=await t.read();expect(limited.status).toBe(429);expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
 await f.db.exec('update private.staff_device_budget set window_at=0');await f.configure(deviceId(105),{methods:[]});expect((await t.read()).status).toBe(401);
});
it('rejects caller-selected scope, limits and extra fields before returning any roster',async()=>{
 const t=await setup();for(const extra of [{outletId:deviceId(12)},{memberId:deviceId(104)},{limit:1000},{permissions:['orders.read']},{intent:null}])expect((await t.read(null,extra)).status).toBe(400);
 expect(()=>parseStaffDeviceBoardRequest({operation:'board',sessionToken:t.session.token,after:'bad'})).toThrow();const raw=await(await t.read()).json();expect(()=>parseStaffDeviceBoard({...raw,members:[{...raw.members[0],phone:'hidden'}]})).toThrow();
});
it('keeps the fixed service RPC and its credential on the server',async()=>{
 let captured:Request|undefined;const store=createStaffDeviceStore('https://backend.example.invalid','sb_secret_test_only',async(u,o)=>{captured=new Request(u,o);return Response.json({v:1,state:'missing'});});
 await store.board!('D'.repeat(43),{operation:'board',sessionToken:'S'.repeat(43),after:null},123);expect(captured?.url).toBe('https://backend.example.invalid/rest/v1/rpc/read_staff_device_board');expect(captured?.headers.get('apikey')).toBe('sb_secret_test_only');expect(await captured!.json()).toEqual({p_device_token:'D'.repeat(43),p_session_token:'S'.repeat(43),p_after_member_id:null,p_request_limit:123});
});
it('denies direct ordinary and anonymous RPC access',async()=>{
 for(const role of ['anon','authenticated'] as const)await expect(f.asRole(1,role,'select public.read_staff_device_board($1,$2,null,600) data',['D'.repeat(43),'S'.repeat(43)])).rejects.toMatchObject({code:'42501'});
});
it('lists a new rider for owner PIN setup only in the explicitly enabled outlet, without treating old PINs as eligibility',async()=>{
 await f.configure(deviceId(111),{role:'rider',name:'Rider without PIN'});const read=async(outlet:string)=>f.asRole<{entries:{id:string;configured:boolean}[]}>(1,'authenticated','select public.read_device_admin($1,\'members\',null,100) data',[outlet]);
 expect((await read(deviceId(11))).entries.find(m=>m.id===deviceId(111))).toMatchObject({configured:false});expect((await read(deviceId(12))).entries.some(m=>m.id===deviceId(111))).toBe(false);
 expect(await f.asRole(1,'authenticated','select public.staff_pin_context($1,$2,\'set\') data',[deviceId(11),deviceId(111)])).toMatchObject({memberId:deviceId(111),configured:false});
 await f.configure(deviceId(111),{role:'rider',methods:[]});expect((await read(deviceId(11))).entries.some(m=>m.id===deviceId(111))).toBe(false);await expect(f.asRole(1,'authenticated','select public.staff_pin_context($1,$2,\'set\') data',[deviceId(11),deviceId(111)])).rejects.toMatchObject({code:'42501'});
 await expect(f.asRole(2,'authenticated','select public.read_device_admin($1,\'members\',null,100) data',[deviceId(11)])).rejects.toMatchObject({code:'42501'});
});
