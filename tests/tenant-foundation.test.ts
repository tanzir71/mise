import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

// Executes the actual migration and native PostgreSQL RLS, not a JS policy replica.
// Auth claim verification and the hosted Data API remain separate acceptance gates.
const id=(value:number)=>String(value).padStart(26,'0');
const user=(value:number)=>`00000000-0000-4000-8000-${String(value).padStart(12,'0')}`;
let db:PGlite;
const tables=['businesses','outlets','members','member_outlets'] as const;

beforeAll(async()=>{
  db=await PGlite.create();
  await db.exec(readFileSync(new URL('./fixtures/supabase-auth.sql',import.meta.url),'utf8'));
  await db.exec(readFileSync(new URL('../supabase/migrations/20261117081808_tenant_foundation.sql',import.meta.url),'utf8'));
},30_000);
afterAll(async()=>{await db?.close();});

beforeEach(async()=>{
  await db.exec('truncate public.member_outlets, public.members, public.outlets, public.businesses, auth.users cascade');
  for(const n of [1,2,3,4,5,6,7,8,9])await db.query(
    'insert into auth.users(id,phone,phone_confirmed_at) values ($1,$2,$3)',
    [user(n),n===7?null:'14155550100',n===7?null:'2026-11-17T00:00:00Z']);
  for(const n of [1,2])await db.query(
    'insert into public.businesses(id,name,business_type,market_code,created_at,updated_at) values ($1,$2,$3,$4,1,1)',
    [id(n),`Business ${n}`,'corner_shop','BD']);
  for(const [n,business] of [[11,1],[12,1],[21,2]])await db.query(
    'insert into public.outlets(id,business_id,name,timezone,currency,created_at,updated_at) values ($1,$2,$3,$4,$5,1,1)',
    [id(n),id(business),`Outlet ${n}`,'Asia/Dhaka','BDT']);
  const members:[number,number,number,string,boolean][]=[
    [101,1,1,'owner',true],[102,1,2,'manager',true],[103,1,3,'manager',true],
    [104,1,4,'staff',true],[201,2,5,'owner',true],[105,1,6,'manager',true],
    [106,1,7,'owner',true],[107,1,8,'owner',false],
  ];
  for(const [n,business,identity,role,active] of members)await db.query(
    'insert into public.members(id,business_id,auth_user_id,name,phone,role,active,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,1,1)',
    [id(n),id(business),user(identity),`Member ${n}`,'+14155550100',role,active]);
  for(const [member,outlet] of [[102,11],[103,12],[104,11]])await db.query(
    'insert into public.member_outlets(business_id,member_id,outlet_id) values ($1,$2,$3)',[id(1),id(member),id(outlet)]);
});

async function asUser<T=Record<string,unknown>>(identity:number|null,sql:string,params:unknown[]=[],claims:Record<string,unknown>={},role:'authenticated'|'anon'='authenticated'){
  return db.transaction(async tx=>{
    await tx.exec(`set local role ${role}`);
    await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role,...claims,...(identity===null?{}:{sub:user(identity)})})]);
    return (await tx.query<T>(sql,params)).rows;
  });
}
const rows=(identity:number,table:typeof tables[number])=>asUser<{id:string}>(identity,`select * from public.${table} order by ${table==='member_outlets'?'member_id':'id'}`);

describe('M30 tenant identity and outlet isolation',()=>{
  it('uses the same PostgreSQL major version as the target Supabase schema',async()=>{
    expect((await db.query("select current_setting('server_version_num')::integer / 10000 as major")).rows).toEqual([{major:17}]);
  });
  it('runs as a non-bypass database role with RLS active',async()=>{
    expect(await asUser(2,"select current_user, rolbypassrls, row_security_active('public.outlets') as enforced from pg_roles where rolname=current_user"))
      .toEqual([{current_user:'authenticated',rolbypassrls:false,enforced:true}]);
  });
  it.each([[1,[11,12],1],[5,[21],2]] as const)('owner %s reads every own outlet and no other business',async(identity,outlets,business)=>{
    expect((await rows(identity,'outlets')).map(row=>row.id)).toEqual(outlets.map(id));
    expect((await rows(identity,'businesses')).map(row=>row.id)).toEqual([id(business)]);
  });
  it.each([[2,11],[3,12]])('manager %s sees only assigned outlet %s',async(identity,outlet)=>{
    expect((await rows(identity,'outlets')).map(row=>row.id)).toEqual([id(outlet)]);
    expect(await asUser(identity,'select id from public.outlets where id=$1',[id(21)])).toEqual([]);
    expect((await rows(identity,'businesses')).map(row=>row.id)).toEqual([id(1)]);
  });
  it('a manager sees only people assigned to the same outlet and their assignments',async()=>{
    expect((await rows(2,'members')).map(row=>row.id)).toEqual([id(102),id(104)]);
    expect(await asUser(2,'select member_id,outlet_id from public.member_outlets order by member_id'))
      .toEqual([{member_id:id(102),outlet_id:id(11)},{member_id:id(104),outlet_id:id(11)}]);
  });
  it('owners can read all member records in their own business',async()=>{
    expect((await rows(1,'members')).map(row=>row.id)).toEqual([101,102,103,104,105,106,107].map(id));
  });
  it('staff can read their own profile and assignment, without enabling staff screen access',async()=>{
    expect((await rows(4,'members')).map(row=>row.id)).toEqual([id(104)]);
    expect(await rows(4,'outlets')).toEqual([]);
    expect(await rows(4,'businesses')).toEqual([]);
    expect(await asUser(4,'select member_id from public.member_outlets')).toEqual([{member_id:id(104)}]);
  });
  it.each([6,7,8,9])('unassigned, unconfirmed, inactive or unrelated identity %s has no outlet',async(identity)=>{
    expect(await rows(identity,'outlets')).toEqual([]);
    expect(await rows(identity,'businesses')).toEqual([]);
  });
  it.each(tables)('an identity without membership cannot read %s',async(table)=>{
    expect(await rows(9,table)).toEqual([]);
  });
  it('an authenticated request without an identity gets no rows',async()=>{
    expect(await asUser(null,'select * from public.outlets')).toEqual([]);
  });
  it('user metadata and claimed tenant/role hints cannot promote a manager',async()=>{
    await db.query('update auth.users set raw_user_meta_data=$1 where id=$2',[{role:'owner',business_id:id(2)},user(2)]);
    expect(await asUser(2,'select id from public.outlets',[],{
      user_metadata:{role:'owner',business_id:id(2),outlet_ids:[id(21)]},business_id:id(2),member_role:'owner',
    })).toEqual([{id:id(11)}]);
  });
  it('removing an assignment takes effect without refreshing the JWT',async()=>{
    await db.query('delete from public.member_outlets where member_id=$1',[id(102)]);
    expect(await rows(2,'outlets')).toEqual([]);
    expect(await rows(2,'businesses')).toEqual([]);
  });
  it('deactivating the membership takes effect without refreshing the JWT',async()=>{
    await db.query('update public.members set active=false where id=$1',[id(101)]);
    expect(await rows(1,'outlets')).toEqual([]);
    expect(await rows(1,'members')).toEqual([]);
  });
  it('a phone number without a confirmation cannot access the shop',async()=>{
    await db.query('update auth.users set phone_confirmed_at=null where id=$1',[user(1)]);
    expect(await rows(1,'outlets')).toEqual([]);
  });
  it('a confirmed timestamp without a phone number cannot access the shop',async()=>{
    await db.query("update auth.users set phone='' where id=$1",[user(1)]);
    expect(await rows(1,'outlets')).toEqual([]);
  });
  it('an active Auth ban denies existing tokens',async()=>{
    await db.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1",[user(1)]);
    expect(await rows(1,'outlets')).toEqual([]);
  });
  it('an expired Auth ban permits the active confirmed membership',async()=>{
    await db.query("update auth.users set banned_until=now()-interval '1 hour' where id=$1",[user(1)]);
    expect((await rows(1,'outlets')).map(row=>row.id)).toEqual([11,12].map(id));
  });
  it('soft-deleted Auth identities cannot use old tokens',async()=>{
    await db.query('update auth.users set deleted_at=now() where id=$1',[user(1)]);
    expect(await rows(1,'outlets')).toEqual([]);
  });
  it('deleting Auth preserves the member history and removes access',async()=>{
    await db.query('delete from auth.users where id=$1',[user(1)]);
    expect(await rows(1,'outlets')).toEqual([]);
    expect((await db.query('select auth_user_id from public.members where id=$1',[id(101)])).rows).toEqual([{auth_user_id:null}]);
  });
  it('one identity can hold separately authorized memberships in two businesses',async()=>{
    await db.query('insert into public.members(id,business_id,auth_user_id,name,role,created_at,updated_at) values ($1,$2,$3,$4,$5,1,1)',[id(202),id(2),user(2),'Second membership','manager']);
    await db.query('insert into public.member_outlets values ($1,$2,$3)',[id(2),id(202),id(21)]);
    expect((await rows(2,'outlets')).map(row=>row.id)).toEqual([11,21].map(id));
  });
});

describe('M30 database boundaries',()=>{
  it.each(tables)('anonymous callers cannot read the private %s dataset',async(table)=>{
    await expect(asUser(null,`select * from public.${table}`,[],{},'anon')).rejects.toMatchObject({code:'42501'});
  });
  for(const identity of [1,2])for(const table of tables)it.each(['insert','update','delete'] as const)(`identity ${identity} cannot %s ${table} outside audited commands`,async(operation)=>{
    const sql=operation==='insert'?`insert into public.${table} default values`:
      operation==='update'?`update public.${table} set ${table==='member_outlets'?'outlet_id=outlet_id':'id=id'}`:`delete from public.${table}`;
    await expect(asUser(identity,sql)).rejects.toMatchObject({code:'42501'});
  });
  it('neither foreign members nor foreign outlets can be attached across businesses',async()=>{
    await expect(db.query('insert into public.member_outlets values ($1,$2,$3)',[id(1),id(201),id(11)])).rejects.toMatchObject({code:'23503'});
    await expect(db.query('insert into public.member_outlets values ($1,$2,$3)',[id(1),id(102),id(21)])).rejects.toMatchObject({code:'23503'});
  });
  it('a second profile cannot shadow the same identity within a business',async()=>{
    await expect(db.query('insert into public.members(id,business_id,auth_user_id,name,role,created_at,updated_at) values ($1,$2,$3,$4,$5,1,1)',[id(108),id(1),user(1),'Shadow','owner']))
      .rejects.toMatchObject({code:'23505'});
  });
  it.each(['80000000000000000000000000','0000000000000000000000000O','short','01j00000000000000000000000'])('rejects invalid ULID %s',async(value)=>{
    await expect(db.query('select $1::public.ulid',[value])).rejects.toMatchObject({code:'23514'});
  });
  it.each([-1,8640000000000001])('rejects out-of-range UTC milliseconds %s',async(value)=>{
    await expect(db.query('select $1::public.utc_ms',[value])).rejects.toMatchObject({code:'23514'});
  });
  it('rejects a backwards update timestamp',async()=>{
    await expect(db.query('update public.outlets set updated_at=0 where id=$1',[id(11)])).rejects.toMatchObject({code:'23514'});
  });
  it('rejects non-E.164 member phones and unknown roles',async()=>{
    await expect(db.query('update public.members set phone=$1 where id=$2',['01712345482',id(101)])).rejects.toMatchObject({code:'23514'});
    await expect(db.query('update public.members set role=$1 where id=$2',['superuser',id(101)])).rejects.toMatchObject({code:'23514'});
  });
  it('future tables and RPCs do not acquire implicit client grants',async()=>{
    await db.exec("create table public.future_data(secret text); create function public.future_rpc() returns text language sql as $$select 'private'::text$$");
    for(const role of ['anon','authenticated','service_role']){
      expect((await db.query('select has_table_privilege($1,$2,$3) as allowed',[role,'public.future_data','select'])).rows).toEqual([{allowed:false}]);
      expect((await db.query('select has_function_privilege($1,$2,$3) as allowed',[role,'public.future_rpc()','execute'])).rows).toEqual([{allowed:false}]);
    }
  });
  it('the privileged identity helper is private, path-pinned and not callable anonymously',async()=>{
    expect((await db.query("select n.nspname,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname='current_access'")).rows)
      .toEqual([{nspname:'private',prosecdef:true,proconfig:['search_path=""']}]);
    expect(await asUser(9,'select * from private.current_access()')).toEqual([]);
    await expect(asUser(null,'select * from private.current_access()',[],{},'anon')).rejects.toMatchObject({code:'42501'});
    expect((await db.query("select count(*)::integer as total from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef")).rows).toEqual([{total:0}]);
  });
  it('clients cannot add shadow objects to the exposed schema',async()=>{
    await expect(asUser(1,'create table public.shadow_access(id text)')).rejects.toMatchObject({code:'42501'});
  });
});
