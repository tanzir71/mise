import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createStaffDeviceFixture} from './staff-device-fixture';
import {deviceId as id} from './device-pairing-fixture';
import {newInboxId} from '../packages/core/inbox';
import {deriveStaffPin} from '../supabase/functions/_shared/staff-pin';
import {parseStaffStockPage,type StaffStockRequest} from '../packages/core/staff-stock';
import {parseStaffDeviceAccess,type DeviceMode,type StaffDeviceSession} from '../packages/core/device-access';
import {createStaffStockHandler} from '../supabase/functions/_shared/staff-stock-handler';
let f:Awaited<ReturnType<typeof createStaffDeviceFixture>>;
beforeAll(async()=>{f=await createStaffDeviceFixture();},30000);beforeEach(async()=>{await f.seed();});afterAll(async()=>{await f?.db.close();});
const permissions={confirmOrders:false,updateStock:true,viewOwnPerformance:false};
async function screen(mode:DeviceMode='kitchen',member=id(105),outlet=id(11)){
 const {pairing}=await f.start(1,outlet,mode),claim=await f.request(pairing.code,pairing.id),device=await f.approve(pairing.id,claim);
 return {device,session:await login(claim.secret,member),secret:claim.secret};
}
async function login(secret:string,member=id(105)){
 const challenge=await f.asRole<{allowed:boolean;attemptId:string;businessId:string;salt:string}>(null,'service_role','select public.begin_staff_pin($1,$2,$3) data',[newInboxId(),secret,member]);
 expect(challenge.allowed).toBe(true);const proof=await deriveStaffPin('0042',challenge.salt,{businessId:challenge.businessId,memberId:member},f.pepper);
 return f.asRole<StaffDeviceSession>(null,'service_role','select public.finish_staff_pin($1,$2,$3,$4,$5) data',[secret,challenge.attemptId,proof,newInboxId(),newInboxId()]);
}
type Screen=Awaited<ReturnType<typeof screen>>;
const read=(s:Screen,after:string|null=null,limit=50,budget=600)=>f.asRole<unknown>(null,'service_role','select public.read_staff_stock_page($1,$2,$3,$4,$5) data',[s.secret,s.session.token,after,limit,budget]);
async function seedStock(n=1,outlet=id(11),business=id(1),base=300){
 for(let i=0;i<n;i++)await f.db.transaction(async tx=>{
  await tx.query("insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at) values($1,$2,$3,'system',$4,'fixture.stock','null','null',2)",[id(base+10000+i),business,outlet,id(999)]);
  await tx.query(`insert into public.stock_items(id,business_id,outlet_id,revision,name,name_local,unit,category,aliases,on_hand,target,pack_size,low_at,event_id,created_at,updated_at)
   values($1,$2,$3,1,$4,'"চাল"','"kg"','"Dry goods"','["rice"]',1.005,20,1,2,$5,1,2)`,[id(base+i),business,outlet,JSON.stringify('Rice\u0000\ud800 '+i),id(base+10000+i)]);
 });
}
it('uses actual Team stock permission, keeps preparation/attendance separate, and infers no legacy stock grant',async()=>{
 const s=await screen();await seedStock();expect(await read(s)).toEqual({v:1,state:'missing'});
 await f.db.query('update public.members set permissions=$1 where id=$2',[JSON.stringify({'stock.read':true,'orders.read':false}),id(105)]);expect(await read(s)).toEqual({v:1,state:'missing'});
 await f.configure(id(105),{methods:[],permissions});const page=parseStaffStockPage(await read(s),null,50,s);expect(page.items).toHaveLength(1);expect(page.access.permissions).toEqual(['stock.read']);
 expect((await f.directoryRead(s.secret) as {members:{id:string}[]}).members.some(m=>m.id===id(105))).toBe(true);
 await f.configure(id(105),{methods:[],permissions:{...permissions,updateStock:false}});expect(await read(s)).toEqual({v:1,state:'missing'});
});
it.each([false,null,'yes',0])('preserves an explicit non-true legacy stock.read value %j',async deny=>{
 await f.configure(id(105),{permissions});const s=await screen();await f.db.query('update public.members set permissions=$1 where id=$2',[JSON.stringify({'stock.read':deny}),id(105)]);
 expect(await read(s)).toEqual({v:1,state:'missing'});expect(parseStaffDeviceAccess(await f.asRole(null,'service_role','select public.read_device_session($1,$2) data',[s.secret,s.session.token])).permissions).not.toContain('stock.read');
});
it('pages all actual active stock once and excludes archives, other outlets, businesses and commercial records',async()=>{
 await f.configure(id(105),{permissions});const s=await screen();await seedStock(125);await seedStock(1,id(12),id(1),600);await seedStock(1,id(21),id(2),601);
 await f.db.query('update public.stock_items set archived_at=2 where id=$1',[id(310)]);
 const pages=[];let after:string|null=null;do{const page=parseStaffStockPage(await read(s,after),after,50,s);pages.push(page);after=page.next;}while(after!==null);
 expect(pages.map(p=>p.items.length)).toEqual([50,50,24]);const items=pages.flatMap(p=>p.items);expect(new Set(items.map(i=>i.id)).size).toBe(124);expect(items.map(i=>i.id)).not.toContain(id(310));expect(items.every(i=>i.outletId===id(11))).toBe(true);expect(items[0]).toMatchObject({name:'Rice\u0000\ud800 0',onHand:1.005});
 for(const key of ['supplier_id','supplierId','phone','price','payments','customers','auth_user_id','token'])expect(JSON.stringify(pages)).not.toContain('"'+key+'":');
});
it('pages complete maximum imported labels by bytes without losing an item or decoding literal source through JSONB',async()=>{
 await f.configure(id(105),{permissions});const s=await screen();await seedStock(5);
 const label='\0'.repeat(999998)+'\ud800ক';expect(label.length).toBe(1_000_000);
 await f.db.query('update public.stock_items set name=$1,name_local=$1 where business_id=$2 and outlet_id=$3',[JSON.stringify(label),id(1),id(11)]);
 const first=parseStaffStockPage(await read(s),null,50,s);expect(first.items).toHaveLength(4);expect(first.next).toBe(id(303));
 const second=parseStaffStockPage(await read(s,first.next),first.next,50,s);expect(second.items).toHaveLength(1);expect(second.next).toBeNull();
 const items=[...first.items,...second.items];expect(items.map(i=>i.id)).toEqual([300,301,302,303,304].map(id));
 for(const row of items){expect(row.name).toBe(label);expect(row.nameLocal).toBe(label);expect(row.onHand).toBe(1.005);expect(row.revision).toBe(1);}
},30000);
it.each(['staff kitchen','staff counter','kitchen counter','rider kitchen','rider counter'] as const)('keeps %s rights within the existing screen-role boundary',async kind=>{
 const [role,mode]=kind.split(' ') as ['staff'|'kitchen'|'rider',DeviceMode];await f.configure(id(105),{role,permissions});const s=await screen(mode);await seedStock();
 if(role==='staff')expect(parseStaffStockPage(await read(s),null,50,s).items).toHaveLength(1);else expect(await read(s)).toEqual({v:1,state:'missing'});
});
it.each(['unassigned','inactive','pin changed','pin removed','session revoked','screen revoked','session expired','screen expired'] as const)('denies current reads after %s without changing stock',async kind=>{
 await f.configure(id(105),{permissions});const s=await screen();await seedStock();
 if(kind==='unassigned')await f.db.query('delete from public.member_outlets where member_id=$1',[id(105)]);
 else if(kind==='inactive')await f.db.query('update public.members set active=false where id=$1',[id(105)]);
 else if(kind==='pin changed')await f.db.query('update private.staff_pins set revision=$1 where member_id=$2',[newInboxId(),id(105)]);
 else if(kind==='pin removed')await f.db.query('delete from private.staff_pins where member_id=$1',[id(105)]);
 else if(kind.startsWith('session'))await f.db.query('update private.device_sessions set '+(kind==='session revoked'?'revoked_at=created_at':'created_at=1,expires_at=43200001')+' where id=$1',[s.session.id]);
 else await f.db.query('update private.devices set '+(kind==='screen revoked'?'revoked_at=created_at':'created_at=1,expires_at=7776000001')+' where id=$1',[s.device.id]);
 expect(await read(s)).toEqual({v:1,state:'missing'});expect((await f.db.query<{on_hand:string}>('select on_hand from public.stock_items where id=$1',[id(300)])).rows[0].on_hand).toBe('1.005');expect((await f.db.query<{n:number}>('select count(*)::integer n from public.stock_moves')).rows[0].n).toBe(0);
});
it('separates stock permission by outlet and cannot use another screen/member PIN token',async()=>{
 await f.configure(id(104),{role:'staff',permissions});const a=await screen('counter',id(104)),b=await screen('counter',id(104),id(12));await seedStock();
 expect(parseStaffStockPage(await read(a),null,50,a).items).toHaveLength(1);expect(await read(b)).toEqual({v:1,state:'missing'});
 expect(await read({...a,session:b.session})).toEqual({v:1,state:'missing'});
});
it('shares one bounded server-minute budget across PIN sessions on a device and rolls to the next window',async()=>{
 await f.configure(id(105),{permissions});const s=await screen();expect(parseStaffStockPage(await read(s,null,1,1),null,1,s).items).toEqual([]);
 const second={...s,session:await login(s.secret)};expect(second.session.id).not.toBe(s.session.id);
 expect(await read(second,null,1,1)).toMatchObject({state:'limited'});await f.db.exec('update private.staff_stock_budget set window_at=0');expect(parseStaffStockPage(await read(s,null,1,1),null,1,s).items).toEqual([]);
 for(const limit of [0,101])await expect(read(s,null,limit)).rejects.toMatchObject({code:'22023'});for(const budget of [0,60001])await expect(read(s,null,50,budget)).rejects.toMatchObject({code:'22023'});
});
it.each(['device','session'] as const)('rechecks the actual clock when the %s expires within the calling statement',async kind=>{
 await f.configure(id(105),{permissions});const s=await screen();await seedStock();
 await f.db.transaction(async tx=>{
  await tx.query("select set_config('mise.staff_stock_clock_test',$1,true)",[JSON.stringify({kind,device:s.device.id,session:s.session.id,deviceToken:s.secret,sessionToken:s.session.token})]);
  await tx.exec(`do $clock$ declare c jsonb:=current_setting('mise.staff_stock_clock_test')::jsonb;deadline bigint:=floor(extract(epoch from clock_timestamp())*1000)::bigint+50;r jsonb;begin
   if c->>'kind'='session' then update private.device_sessions set created_at=deadline-43200000,expires_at=deadline where id=(c->>'session')::public.ulid;
   else update private.devices set created_at=deadline-7776000000,expires_at=deadline where id=(c->>'device')::public.ulid;end if;
   perform pg_sleep(0.1);set local role service_role;
   r:=public.read_staff_stock_page(c->>'deviceToken',c->>'sessionToken',null,50,600);
   if r->>'state'<>'missing' then raise exception 'Expired within this statement but fresh stock was served';end if;
   reset role;end $clock$;`);
 });
});
it('closes direct table/RPC admission for client roles and returns safe data through the real handler and SQL',async()=>{
 await f.configure(id(105),{permissions});const s=await screen();await seedStock();
 for(const role of ['anon','authenticated','service_role'] as const)await expect(f.asRole(null,role,'select count(*) data from private.staff_stock_budget')).rejects.toMatchObject({code:'42501'});
 for(const role of ['anon','authenticated'] as const)await expect(f.asRole(1,role,'select public.read_staff_stock_page($1,$2,null,50,600) data',[s.secret,s.session.token])).rejects.toMatchObject({code:'42501'});
 expect((await f.db.query<{relforcerowsecurity:boolean}>("select relforcerowsecurity from pg_class where relname='staff_stock_budget'")).rows[0].relforcerowsecurity).toBe(true);
 const handler=createStaffStockHandler({origins:new Set(['https://shop.test']),store:{read:(_token,input:StaffStockRequest,budget)=>read(s,input.after,input.limit,budget)}});
 const response=await handler(new Request('https://backend.test/functions/v1/staff-stock',{method:'POST',headers:{Origin:'https://shop.test',Authorization:'Bearer '+s.secret,'Content-Type':'application/json'},body:JSON.stringify({operation:'read',sessionToken:s.session.token,after:null,limit:50})}));expect(response.status).toBe(200);expect(parseStaffStockPage(await response.json(),null,50,s).items[0].name).toBe('Rice\u0000\ud800 0');
});
