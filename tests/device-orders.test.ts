import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {orderFixture,ORDER_AT} from './order-fixture';
import {emptyBackupTables,type MiseBackup} from '../packages/core/backup-tables';
import {createBackup} from '../packages/core/backup';
import {prepareCloudMigration} from '../packages/core/cloud-records';
import {saveOrderCommand,changeOrderStatusCommand} from '../packages/core/orders';
import {newInboxId} from '../packages/core/inbox';
import {createStaffPin} from '../supabase/functions/_shared/staff-pin';
import {createDeviceOrdersHandler} from '../supabase/functions/_shared/device-orders-handler';
import type {BusinessType} from '../packages/core/packs';

type Sql=Pick<PGlite,'query'|'exec'>;
interface Device {id:string;token:string}
interface Session {id:string;token:string}
interface Ticket {id:string;status:string;linesJson:string;createdAt:number;[key:string]:unknown}
interface Page {businessId:string;outletId:string;mode:string;orders:Ticket[];next:{createdAt:number;id:string}|null}
interface Shop {backup:MiseBackup;ownerUid:string;staff:string;kitchen:string;branch:string;counter:Device;kitchenDevice:Device;session:Session;kitchenSession:Session}
let db:PGlite;const shops:Shop[]=[],uid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const literal='বাংলা\u0000'+String.fromCharCode(0xd800),pepper=new Uint8Array(32).fill(23);
async function actor<T>(sql:Sql,role:'anon'|'authenticated'|'service_role',identity:string|null,query:string,args:unknown[]=[]){
  await sql.exec(`set local role ${role}`);
  await sql.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role,...(identity?{sub:identity}:{}),user_metadata:{role:'owner',businessId:'spoofed'}})]);
  return (await sql.query<T>(query,args)).rows;
}
async function asRole<T>(role:'anon'|'authenticated'|'service_role',identity:string|null,query:string,args:unknown[]=[]){return db.transaction(sql=>actor<T>(sql,role,identity,query,args));}
async function pageQuery(sql:Sql,device:Device,session:Session,after:Page['next']=null,limit:number|null=50){
  const handler=createDeviceOrdersHandler({origins:new Set(['https://shop.test']),store:{read:async(d,s,c,n)=>(await actor<{data:unknown}>(sql,'service_role',null,'select public.read_device_orders($1,$2,$3,$4,$5) as data',[d,s,c?.createdAt??null,c?.id??null,n]))[0].data}});
  const response=await handler(new Request('https://api.test/device-orders',{method:'POST',headers:{authorization:`Bearer ${device.token}`,'content-type':'application/json',origin:'https://shop.test'},body:JSON.stringify({sessionToken:session.token,after,limit})}));
  if(response.status===400||response.status===401)return null;
  if(!response.ok)throw new Error(`Device order HTTP ${response.status}`);return response.json() as Promise<Page>;
}
async function page(shop=shops[0],after:Page['next']=null,limit:number|null=50,kitchen=false){return db.transaction(sql=>pageQuery(sql,kitchen?shop.kitchenDevice:shop.counter,kitchen?shop.kitchenSession:shop.session,after,limit));}
async function rollback(action:(sql:Sql)=>Promise<void>){const marker=new Error('rollback');try{await db.transaction(async sql=>{await action(sql);throw marker;});}catch(error){if(error!==marker)throw error;}}
beforeAll(async()=>{
  db=await PGlite.create();for(const name of ['supabase-auth.sql','supabase-storage.sql'])await db.exec(readFileSync(new URL('./fixtures/'+name,import.meta.url),'utf8'));
  const migrationDir=new URL('../supabase/migrations/',import.meta.url);
  for(const name of readdirSync(migrationDir).filter(n=>n.endsWith('.sql')).sort())await db.exec(readFileSync(new URL(name,migrationDir),'utf8'));
  for(const [index,businessType] of (['corner_shop','restaurant','online_shop','food_stall'] as BusinessType[]).entries()){
    const fixture=orderFixture(businessType),setup=fixture.context.setup,t=emptyBackupTables(),branch=newInboxId(),ownerUid=uid(index+1),staff=newInboxId(),kitchen=newInboxId();
    t.businesses.push(setup.business);t.outlets.push(setup.outlet);t.members.push(setup.owner);
    for(let i=0;i<(index===0?103:3);i++){
      const created=saveOrderCommand({...fixture.input,sourceText:'PRIVATE SOURCE',name:literal,lines:[{name:literal,unit:'pc',qty:1.125,unitPrice:i===1?null:1200,note:literal,substitution:i===2?{from:literal,accepted:false}:undefined}]},
        {...fixture.context,sequence:i+1},null,0,ORDER_AT+Math.floor(i/3));
      if(i===0){const closed=changeOrderStatusCommand(created.order,'cancelled',setup,created.order.revision,ORDER_AT+20);created.order=closed.order;t.events.push(closed.event);}
      t.orders.push(created.order);t.events.push(created.event);
    }
    const branchSetup={...setup,outlet:{...setup.outlet,id:branch,name:'Other outlet'},owner:{...setup.owner,outletIds:[branch]}};
    const other=saveOrderCommand(fixture.input,{...fixture.context,setup:branchSetup,sequence:1},null,0,ORDER_AT);
    const branchTables=emptyBackupTables();branchTables.businesses.push(setup.business);branchTables.outlets.push(branchSetup.outlet);branchTables.members.push(branchSetup.owner);branchTables.orders.push(other.order);branchTables.events.push(other.event);
    const backup=createBackup(t,Date.now()),plan=await prepareCloudMigration(backup,ownerUid),branchPlan=await prepareCloudMigration(createBackup(branchTables,Date.now()),ownerUid);
    await db.query('insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,now())',[ownerUid,`1415555010${index+1}`]);
    await db.transaction(async sql=>{for(const record of plan.records){const keys=Object.keys(record.values);await sql.query(`insert into public.${record.table}(${keys.join(',')}) values(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(record.values));}});
    await db.transaction(async sql=>{for(const record of branchPlan.records){if(['businesses','members'].includes(record.table))continue;const keys=Object.keys(record.values);await sql.query(`insert into public.${record.table}(${keys.join(',')}) values(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(record.values));}});
    for(const [member,role] of [[staff,'staff'],[kitchen,'kitchen']]){
      await db.query('insert into public.members(id,business_id,name,role,permissions,created_at,updated_at) values($1,$2,$3,$4,$5,1,1)',[member,setup.business.id,'"Staff"',role,JSON.stringify({'orders.read':true,'counter.sell':true})]);
      await db.query('insert into public.member_outlets values($1,$2,$3)',[setup.business.id,member,setup.outlet.id]);
    }
    const sessions:Session[]=[],devices:Device[]=[];
    for(const [member,mode] of [[staff,'counter'],[kitchen,'kitchen']]){
      const credential=await createStaffPin('0042',{businessId:setup.business.id,memberId:member},pepper);
      await asRole('authenticated',ownerUid,'select public.set_staff_pin($1,$2,$3,$4,$5,$6)',[setup.outlet.id,member,newInboxId(),credential.salt,credential.verifier,credential.pepperVersion]);
      const device=(await asRole<{data:Device}>('authenticated',ownerUid,'select public.enrol_device($1,$2,$3,$4,$5) as data',[newInboxId(),newInboxId(),setup.outlet.id,'Test screen',mode]))[0].data;
      const attempt=(await asRole<{data:{attemptId:string}}>('service_role',null,'select public.begin_staff_pin($1,$2,$3) as data',[newInboxId(),device.token,member]))[0].data;
      const session=(await asRole<{data:Session}>('service_role',null,'select public.finish_staff_pin($1,$2,$3,$4,$5) as data',[device.token,attempt.attemptId,credential.verifier,newInboxId(),newInboxId()]))[0].data;
      devices.push(device);sessions.push(session);
    }
    shops.push({backup,ownerUid,staff,kitchen,branch,counter:devices[0],kitchenDevice:devices[1],session:sessions[0],kitchenSession:sessions[1]});
  }
},30_000);
afterAll(async()=>{await db?.close();});

it.each([0,1,2,3])('reads actual core-generated orders for business pack %s in the enrolled outlet only',async index=>{
  const shop=shops[index],result=(await page(shop,null,100))!,outlet=shop.backup.tables.outlets[0].id;
  expect(result).toMatchObject({businessId:shop.backup.tables.businesses[0].id,outletId:outlet,mode:'counter'});
  const allowed=new Set(shop.backup.tables.orders.filter(o=>o.outletId===outlet).map(o=>o.id));
  expect(result.orders.length).toBe(index===0?100:3);for(const order of result.orders)expect(allowed.has(order.id)).toBe(true);
  expect(result.orders.some(o=>o.status==='cancelled')).toBe(true);
});
it('paginates identical creation times by ID without omission, duplication or a false final cursor',async()=>{
  const all:Ticket[]=[];let next:Page['next']=null;
  do{const result:Page=(await page(shops[0],next,2))!;all.push(...result.orders);next=result.next;}while(next);
  expect(all).toHaveLength(103);expect(new Set(all.map(o=>o.id)).size).toBe(103);
  expect(all.map(o=>[o.createdAt,o.id])).toEqual([...all].sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id)).map(o=>[o.createdAt,o.id]));
  const end=(await page(shops[0],{createdAt:8640000000000000,id:'7ZZZZZZZZZZZZZZZZZZZZZZZZZ'}))!;expect(end.orders).toEqual([]);expect(end.next).toBeNull();
});
it('kitchen tickets preserve literal names/instructions and remove customer, money and audit fields',async()=>{
  const result=(await page(shops[0],null,100,true))!;expect(result.mode).toBe('kitchen');
  for(const order of result.orders){
    for(const key of ['customerNameJson','customerPhone','address','customerId','sourceText','payment','paymentStatusJson','currency','subtotal','deliveryFee','discount','total','createdBy','handledBy','eventId','notes'])expect(order).not.toHaveProperty(key);
    for(const line of JSON.parse(order.linesJson)){expect(line).toMatchObject({name:literal,note:literal,qty:1.125});expect(line).not.toHaveProperty('unitPrice');expect(line).not.toHaveProperty('lineTotal');}
  }
  expect(JSON.stringify(result)).not.toContain('PRIVATE SOURCE');
});
it('counter tickets retain exact money, unknown prices, swaps and literal customer names without linked private records',async()=>{
  const result=(await page())!;for(const order of result.orders){
    const source=shops[0].backup.tables.orders.find(o=>o.id===order.id)!;
    expect(JSON.parse(order.customerNameJson as string)).toBe(literal);expect(order.total).toBe(source.total);expect(order.subtotal).toBe(source.subtotal);
    const lines=JSON.parse(order.linesJson);expect(lines[0].unitPrice).toBe(source.lines[0].unitPrice);expect(lines[0].lineTotal).toBe(source.lines[0].lineTotal);
    if(source.lines[0].substitution)expect(lines[0].substitution).toMatchObject(source.lines[0].substitution);
    for(const field of ['customerId','customerPhone','address','sourceText','payment','createdBy','handledBy','eventId','notes'])expect(order).not.toHaveProperty(field);
  }
});
it('line and swap projections cannot smuggle unknown private fields into either mode',async()=>{
  const shop=shops[0],source=shop.backup.tables.orders[0],line={...source.lines[0],privateKey:'SECRET-LINE',substitution:{from:literal,accepted:false,privateKey:'SECRET-SWAP'}};
  await rollback(async sql=>{
    await sql.query('update public.orders set lines=$1 where id=$2',[JSON.stringify([line]),source.id]);
    for(const [d,s] of [[shop.counter,shop.session],[shop.kitchenDevice,shop.kitchenSession]]){const result=await pageQuery(sql,d,s);expect(JSON.stringify(result)).not.toContain('SECRET-');await sql.exec('reset role');}
  });
});
it.each([null,'','bad','A'.repeat(43)])('invalid device secret %s reveals no orders',async token=>{expect(await db.transaction(sql=>pageQuery(sql,{id:'',token:token!},shops[0].session))).toBeNull();});
it.each([null,'','bad','A'.repeat(43)])('invalid short session %s reveals no orders',async token=>{expect(await db.transaction(sql=>pageQuery(sql,shops[0].counter,{id:'',token:token!}))).toBeNull();});
it('neither a different business device nor another enrolled mode can reuse a short session',async()=>{
  expect(await db.transaction(sql=>pageQuery(sql,shops[1].counter,shops[0].session))).toBeNull();
  expect(await db.transaction(sql=>pageQuery(sql,shops[0].kitchenDevice,shops[0].session))).toBeNull();
});
it.each([{}, {'orders.read':false},{'orders.read':'true'},{'owner':true}])('live counter permissions %j cannot replace orders.read',async permissions=>{
  await rollback(async sql=>{await sql.query('update public.members set permissions=$1 where id=$2',[JSON.stringify(permissions),shops[0].staff]);expect(await pageQuery(sql,shops[0].counter,shops[0].session)).toBeNull();});
});
it.each([
  ['deactivated member','update public.members set active=false where id=$1','member'],
  ['removed assignment','delete from public.member_outlets where member_id=$1','member'],
  ['changed role',"update public.members set role='agent' where id=$1",'member'],
  ['revoked device','update private.devices set revoked_at=created_at where id=$1','device'],
  ['expired device','update private.devices set expires_at=created_at+1 where id=$1','device'],
  ['revoked session','update private.device_sessions set revoked_at=created_at where id=$1','session'],
  ['expired session','update private.device_sessions set created_at=0,expires_at=43200000 where id=$1','session'],
  ['removed PIN','delete from private.staff_pins where member_id=$1','member'],
])('%s invalidates the next order read',async(_label,query,target)=>{
  const shop=shops[0];await rollback(async sql=>{await sql.query(query,[target==='member'?shop.staff:target==='device'?shop.counter.id:shop.session.id]);expect(await pageQuery(sql,shop.counter,shop.session)).toBeNull();});
});
it.each([0,101,null])('rejects database page size %s rather than widening access',async limit=>{await expect(asRole('service_role',null,'select public.read_device_orders($1,$2,null,null,$3)',[shops[0].counter.token,shops[0].session.token,limit])).rejects.toMatchObject({code:'22023'});});
it.each([[0,null],[null,'00000000000000000000000000']])('rejects half-cursor %s / %s',async(time,id)=>{
  await expect(asRole('service_role',null,'select public.read_device_orders($1,$2,$3,$4,50)',[shops[0].counter.token,shops[0].session.token,time,id])).rejects.toMatchObject({code:'22023'});
});
it('keeps raw tables and projection helpers denied, and pins the POST-only invoker wrapper',async()=>{
  await expect(asRole('anon',null,'select * from public.orders')).rejects.toMatchObject({code:'42501'});
  for(const role of ['anon','authenticated'] as const){await expect(asRole(role,null,'select public.read_device_orders($1,$2)',[shops[0].counter.token,shops[0].session.token])).rejects.toMatchObject({code:'42501'});await expect(asRole(role,null,'select private.read_device_orders($1,$2,null,null,50)',[shops[0].counter.token,shops[0].session.token])).rejects.toMatchObject({code:'42501'});}
  const fn=(await db.query<{provolatile:string;prosecdef:boolean;proconfig:string[]}>('select provolatile,prosecdef,proconfig from pg_proc where oid=\'public.read_device_orders(text,text,public.utc_ms,public.ulid,integer)\'::regprocedure')).rows[0];
  expect(fn.provolatile).toBe('v');expect(fn.prosecdef).toBe(false);expect(fn.proconfig).toContain('search_path=""');
  await db.transaction(async sql=>{await pageQuery(sql,shops[0].counter,shops[0].session);const headers=(await sql.query<{headers:string}>("select current_setting('response.headers') as headers")).rows[0].headers;expect(JSON.parse(headers)).toContainEqual({'Cache-Control':'no-store'});});
});
