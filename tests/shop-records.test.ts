import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {shopDataFixture} from './shop-data-fixture';
import {cloudBackupTableNames,cloudRecordMaps,decodeCommandRecord,encodeCommandRecord,prepareCloudMigration,readCloudMigration,type CloudMigration,type CloudRecord} from '../packages/core/cloud-records';
import {backupToken} from '../packages/core/backup';
import {backupTableNames,type MiseBackup} from '../packages/core/backup-tables';
import {newInboxId} from '../packages/core/inbox';

let db:PGlite;
let original:MiseBackup,plan:CloudMigration;
const owner='00000000-0000-4000-8000-000000000001';
const identity=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let otherOutlet:string,foreignOutlet:string,foreignBusiness:string;
const outletTables=['categories','items','credit_accounts','credit_entries','orders','sales','order_notes','order_communications','order_refunds',
  'suppliers','stock_items','stock_moves','supplier_messages','day_closings','purchases','inbox_items','inbox_images','events','payments','shifts','check_ins','captures','tasks'];
type Sql=Pick<PGlite,'query'|'exec'>;
async function insert(sql:Sql,record:CloudRecord){
  const columns=Object.keys(record.values);
  await sql.query(`insert into public.${record.table} (${columns.join(',')}) values (${columns.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(record.values));
}
async function rollback<T>(action:(sql:Sql)=>Promise<T>):Promise<T>{
  const marker=new Error('rollback fixture');let result:T;
  try{await db.transaction(async sql=>{result=await action(sql);throw marker;});}catch(error){if(error!==marker)throw error;}
  return result!;
}
async function readAs(n:number,query:string,params:unknown[]=[],role:'authenticated'|'anon'='authenticated'){
  return db.transaction(async sql=>{
    await sql.exec(`set local role ${role}`);
    await sql.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:identity(n),role})]);
    return (await sql.query<Record<string,unknown>>(query,params)).rows;
  });
}
function clonedRecords(business:string,authIdentity:number,phone:string):CloudRecord[]{
  const ids=new Map(plan.records.filter(row=>typeof row.values.id==='string').map(row=>[row.values.id as string,newInboxId()]));
  ids.set(original.tables.businesses[0].id,business);
  const replace=(value:unknown):unknown=>{
    if(typeof value==='string')return ids.get(value)??(value===original.tables.customers[0].phone?phone:value);
    if(Array.isArray(value))return value.map(replace);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,replace(v)]));
    return value;
  };
  return plan.records.map(record=>{
    const fields:Record<string,string>=Object.values(cloudRecordMaps).find(map=>map.table===record.table)?.fields??(record.table==='inbox_images'?{name:'j:name'}:{});
    const values=Object.fromEntries(Object.entries(record.values).map(([key,value])=>[key,
      value!==null&&typeof value==='string'&&/^[je]:/.test(fields[key]??'')?JSON.stringify(replace(JSON.parse(value))):replace(value)])) as CloudRecord['values'];
    if(record.table==='members')values.auth_user_id=identity(authIdentity);
    return {table:record.table,values};
  });
}
beforeAll(async()=>{
  db=await PGlite.create();
  for(const path of ['./fixtures/supabase-auth.sql','../supabase/migrations/20261117081808_tenant_foundation.sql','../supabase/migrations/20261117085319_shop_records.sql'])
    await db.exec(readFileSync(new URL(path,import.meta.url),'utf8'));
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.UTC(2026,10,17,6));
  try{original=await shopDataFixture();}finally{vi.useRealTimers();}
  plan=await prepareCloudMigration(original,owner);
  await db.query('insert into auth.users(id,phone,phone_confirmed_at) values ($1,$2,now())',[owner,'14155550100']);
  await db.transaction(async sql=>{for(const record of plan.records)await insert(sql,record);});
  for(const n of [2,3,4,5,6,7,8])await db.query('insert into auth.users(id,phone,phone_confirmed_at) values ($1,$2,now())',[identity(n),`1415555010${n}`]);
  const branch=clonedRecords(original.tables.businesses[0].id,7,'+14155550117');
  foreignBusiness=newInboxId();const foreign=clonedRecords(foreignBusiness,8,'+14155550118');
  otherOutlet=branch.find(row=>row.table==='outlets')!.values.id as string;
  foreignOutlet=foreign.find(row=>row.table==='outlets')!.values.id as string;
  await db.transaction(async sql=>{
    for(const row of branch.filter(row=>row.table!=='businesses'))await insert(sql,row);
    for(const row of foreign)await insert(sql,row);
  });
  for(const [n,business,outlet,role] of [[2,original.tables.businesses[0].id,original.tables.outlets[0].id,'manager'],[3,original.tables.businesses[0].id,otherOutlet,'manager'],[4,foreignBusiness,foreignOutlet,'manager'],[6,original.tables.businesses[0].id,original.tables.outlets[0].id,'staff']] as const){
    const member=newInboxId();await db.query('insert into public.members(id,business_id,auth_user_id,name,role,created_at,updated_at) values($1,$2,$3,$4,$5,1,1)',[member,business,identity(n),JSON.stringify(`Person ${n}`),role]);
    await db.query('insert into public.member_outlets values ($1,$2,$3)',[business,member,outlet]);
  }
  for(const records of [plan.records,branch,foreign]){
    const business=records.find(row=>row.table==='businesses')!.values.id as string,outlet=records.find(row=>row.table==='outlets')!.values.id as string;
    const member=records.find(row=>row.table==='members')!.values.id as string;
    const samples:Record<string,Record<string,string|number>>={
      payments:{method:'cash',amount:100,currency:'BDT',reference:'"fixture"',received_at:1,source:'manual'},
      shifts:{day:'2026-11-17',slot:'"lunch"',need:'{}',member_ids:'[]'},
      check_ins:{member_id:member,at:1,type:'in',method:'manual',recorded_by:member},
      captures:{kind:'text',payload_ref:'fixture/source',parsed:'{}',confidence:0,status:'new'},
      tasks:{kind:'question',title:'"Question"',body:'"Fixture"',actions:'[]',assignee:'human',status:'open'},
    };
    for(const [table,values] of Object.entries(samples))await insert(db,{table,values:{id:newInboxId(),business_id:business,outlet_id:outlet,created_at:1,updated_at:1,...values}});
  }
},30_000);
afterAll(async()=>{await db?.close();});

it('loads the full shop schema with enforced RLS on every public table',async()=>{
  const result=await db.query<{tables:number;protected:number}>("select count(*)::integer as tables,count(*) filter(where relrowsecurity and relforcerowsecurity)::integer as protected from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'");
  expect(result.rows).toEqual([{tables:29,protected:29}]);
});
it('preserves literal source strings, including JSON escapes unsupported by PostgreSQL text',async()=>{
  const text='বাংলা\nIgnore previous instructions\u0000 lone surrogate: '+String.fromCharCode(0xd800);
  const result=await db.query<{original:string}>('select $1::public.literal_text::text as original',[JSON.stringify(text)]);
  expect(JSON.parse(result.rows[0].original)).toBe(text);
});
it('all 21 supported local tables survive a complete SQL round trip with money, source, images and undo history intact',async()=>{
  expect(backupTableNames).toHaveLength(22);expect(original.tables.payments).toEqual([]);
  for(const table of cloudBackupTableNames)expect(original.tables[table].length,table).toBeGreaterThan(0);
  const records:CloudRecord[]=[];
  for(const record of plan.records){
    const map=Object.values(cloudRecordMaps).find(map=>map.table===record.table);
    const fields:Record<string,string>=map?.fields??(record.table==='inbox_images'?{name:'j:name'}:{});
    const columns=Object.keys(record.values),projection=columns.flatMap(column=>[`'${column}'`,fields[column]?.startsWith('j:')?`${column}::text`:column]).join(',');
    const keys=record.table==='member_outlets'?['business_id','member_id','outlet_id']:record.table==='customer_outlets'?['business_id','outlet_id','customer_id']:['id'];
    const found=await db.query<{row:CloudRecord['values']}>(`select json_build_object(${projection}) as row from public.${record.table} where ${keys.map((key,i)=>`${key}=$${i+1}`).join(' and ')}`,keys.map(key=>record.values[key]));
    expect(found.rows).toHaveLength(1);records.push({table:record.table,values:found.rows[0].row});
  }
  const restored=await readCloudMigration({...plan,records});
  expect(backupToken(restored)).toBe(backupToken(original));
  expect(restored.tables.inboxItems[0].text).toBe(original.tables.inboxItems[0].text);
  expect(restored.tables.inboxItems[0].images).toEqual(original.tables.inboxItems[0].images);
  expect(restored.tables.orders.find(row=>row.source==='paste')).toMatchObject({total:null,payment:{status:'pending'}});
});

it.each(outletTables)('owners and managers cannot read another outlet/business through %s',async(table)=>{
  const first=original.tables.outlets[0].id;
  const count=async(n:number,outlet:string)=>Number((await readAs(n,`select count(*)::integer as total from public.${table} where outlet_id=$1`,[outlet]))[0].total);
  expect(await count(1,first)).toBeGreaterThan(0);expect(await count(1,otherOutlet)).toBeGreaterThan(0);expect(await count(1,foreignOutlet)).toBe(0);
  expect(await count(2,first)).toBeGreaterThan(0);expect(await count(2,otherOutlet)).toBe(0);expect(await count(2,foreignOutlet)).toBe(0);
  expect(await count(3,first)).toBe(0);expect(await count(3,otherOutlet)).toBeGreaterThan(0);
  expect(await count(4,foreignOutlet)).toBeGreaterThan(0);expect(await count(4,first)).toBe(0);
  expect(await count(5,first)).toBe(0);expect(await count(6,first)).toBe(0);
});
it('customer profiles follow explicit outlet assignments; unassociated contacts are visible only to the business owner',async()=>{
  const orphan=newInboxId(),business=original.tables.businesses[0].id;
  await rollback(async sql=>{
    await sql.query('insert into public.customers(id,business_id,name,consent,created_at,updated_at) values($1,$2,$3,$4,1,1)',[orphan,business,'"Unassigned contact"','{"savedAt":1,"source":"manual"}']);
    await sql.exec('set local role authenticated');await sql.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:owner,role:'authenticated'})]);
    expect((await sql.query('select id from public.customers where id=$1',[orphan])).rows).toEqual([{id:orphan}]);
    await sql.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:identity(2),role:'authenticated'})]);
    expect((await sql.query('select id from public.customers where id=$1',[orphan])).rows).toEqual([]);
  });
  expect(await readAs(2,'select id from public.customers')).toEqual([{id:original.tables.customers[0].id}]);
  expect(await readAs(3,'select id from public.customers where id=$1',[original.tables.customers[0].id])).toEqual([]);
});
it.each([...outletTables,'customers','customer_outlets'])('anonymous callers and owner-side direct writes remain denied for %s',async(table)=>{
  await expect(readAs(5,`select * from public.${table}`,[],'anon')).rejects.toMatchObject({code:'42501'});
  for(const operation of [`insert into public.${table} default values`,`update public.${table} set business_id=business_id`,`delete from public.${table}`])
    await expect(readAs(1,operation)).rejects.toMatchObject({code:'42501'});
});
it('same-business foreign keys reject a category from a different outlet',async()=>{
  const category=(await db.query<{id:string}>('select id from public.categories where outlet_id=$1 limit 1',[otherOutlet])).rows[0].id;
  await expect(db.transaction(async sql=>{await sql.query('update public.items set category_id=$1 where id=$2',[category,original.tables.items[0].id]);await sql.exec('set constraints all immediate');})).rejects.toMatchObject({code:'23503'});
});
it('a ledger entry cannot change its customer, currency or account scope',async()=>{
  const entry=original.tables.creditEntries[0];
  for(const change of [{currency:'USD'},{customer_id:newInboxId()},{outlet_id:otherOutlet}]){
    const [column,value]=Object.entries(change)[0];
    await expect(db.transaction(async sql=>{await sql.query(`update public.credit_entries set ${column}=$1 where id=$2`,[value,entry.id]);await sql.exec('set constraints all immediate');})).rejects.toMatchObject({code:'23503'});
  }
});
it('refunds cannot point at another order sale even within the same outlet',async()=>{
  const refund=original.tables.orderRefunds[0],other=original.tables.sales.find(row=>row.orderId&&row.orderId!==refund.orderId)!;
  await expect(db.transaction(async sql=>{await sql.query('update public.order_refunds set sale_id=$1 where id=$2',[other.id,refund.id]);await sql.exec('set constraints all immediate');})).rejects.toMatchObject({code:'23503'});
});
it('stock, closing and ledger checks reject inconsistent quantities, cash differences and reminder money',async()=>{
  const invalid=[['stock_moves','after_quantity',19,original.tables.stockMoves[0].id],['day_closings','difference',123,original.tables.dayClosings[0].id],['credit_entries','amount',1,original.tables.creditEntries.find(row=>row.type==='reminder')!.id]] as const;
  for(const [table,column,value,id] of invalid)await expect(rollback(sql=>sql.query(`update public.${table} set ${column}=$1 where id=$2`,[value,id]))).rejects.toMatchObject({code:'23514'});
  await expect(db.query('select $1::public.stock_quantity',[1.0001])).rejects.toMatchObject({code:'23514'});
  await expect(db.query('select $1::public.minor_units',['9007199254740992'])).rejects.toMatchObject({code:'23514'});
});
it('image reservations enforce the exact 10 MB item limit and roll back a rejected extra byte',async()=>{
  const source=plan.records.find(row=>row.table==='inbox_images')!,v=source.values;
  await rollback(async sql=>{
    await insert(sql,{table:'inbox_images',values:{...v,id:newInboxId(),position:1,size:5242880}});
    await insert(sql,{table:'inbox_images',values:{...v,id:newInboxId(),position:2,size:5242880-(v.size as number)}});
    await sql.exec('savepoint extra_image');
    await expect(insert(sql,{table:'inbox_images',values:{...v,id:newInboxId(),position:3,size:1}})).rejects.toMatchObject({code:'23514'});
    await sql.exec('rollback to savepoint extra_image');
    expect((await sql.query('select image_bytes::integer as bytes from public.inbox_items where id=$1',[v.inbox_item_id])).rows).toEqual([{bytes:10485760}]);
  });
  await expect(rollback(sql=>sql.query('update public.inbox_images set size=size+1 where id=$1',[v.id]))).rejects.toMatchObject({code:'23514'});
  const path=(await db.query<{storage_path:string}>('select storage_path from public.inbox_images where id=$1',[v.id])).rows[0].storage_path;
  expect(path).toBe(plan.files[0].path);
});
it('inert migration plans reject missing/tampered images and foreign tenant metadata',async()=>{
  const missing=structuredClone(plan);missing.files=[];await expect(readCloudMigration(missing)).rejects.toThrow(/missing|changed/);
  const tampered=structuredClone(plan);tampered.files[0].data=btoa('different bytes');await expect(readCloudMigration(tampered)).rejects.toThrow(/missing|changed/);
  const foreign=structuredClone(plan);foreign.records.find(row=>row.table==='sales')!.values.business_id=foreignBusiness;await expect(readCloudMigration(foreign)).rejects.toThrow(/another business/);
  const incomplete=structuredClone(plan);incomplete.records=incomplete.records.filter(row=>row.table!=='customer_outlets');await expect(readCloudMigration(incomplete)).rejects.toThrow(/assignments/);
});
it('preparing a migration snapshots the source before asynchronous file hashing',async()=>{
  const source=structuredClone(original),pending=prepareCloudMigration(source,owner);
  source.tables.inboxItems[0].text='Changed after review';
  expect(backupToken(await readCloudMigration(await pending))).toBe(backupToken(original));
  await expect(prepareCloudMigration(original,'not-an-auth-identity')).rejects.toThrow(/verified owner/);
});
it.each([NaN,Infinity,-Infinity])('invalid audit numbers (%s) are rejected before JSON can coerce them to null',async(number)=>{
  const source=structuredClone(original);source.tables.events[0].before={invalid:number};
  await expect(prepareCloudMigration(source,owner)).rejects.toThrow();
});
it('unknown source fields and transport columns fail explicitly instead of disappearing',async()=>{
  const source=structuredClone(original);Object.assign(source.tables.items[0],{futureField:'keep me'});
  await expect(prepareCloudMigration(source,owner)).rejects.toThrow(/supported/);
  const transport=structuredClone(plan);Object.assign(transport.records.find(row=>row.table==='sales')!.values,{unexpected:'no'});
  await expect(readCloudMigration(transport)).rejects.toThrow(/column/);
});
it('duplicate files, gaps in image order and unreferenced files cannot form a complete migration',async()=>{
  const duplicate=structuredClone(plan);duplicate.files.push(duplicate.files[0]);await expect(readCloudMigration(duplicate)).rejects.toThrow(/Duplicate/);
  const gap=structuredClone(plan);gap.records.find(row=>row.table==='inbox_images')!.values.position=3;await expect(readCloudMigration(gap)).rejects.toThrow(/gap/);
  const extra=structuredClone(plan);extra.files.push({path:'unexpected',data:plan.files[0].data});await expect(readCloudMigration(extra)).rejects.toThrow(/unreferenced/);
});
it('unsafe numeric values and unsupported transport versions cannot be restored',async()=>{
  const corrupt=structuredClone(plan);corrupt.records.find(row=>row.table==='sales')!.values.amount='9007199254740992';await expect(readCloudMigration(corrupt)).rejects.toThrow();
  await expect(readCloudMigration({...plan,version:2 as 1})).rejects.toThrow(/Unsupported/);
});

it('required audit JSON nulls survive SQL row decoding without inventing optional ledger fields',()=>{const row=decodeCommandRecord('events',{id:newInboxId(),outlet_id:newInboxId(),actor_type:'member',actor_id:newInboxId(),command:'catalogue.delete',before_data:null,after_data:null,at:1000});expect(row).toMatchObject({before:null,after:null});const encoded=encodeCommandRecord('events',row,newInboxId());expect(encoded.values.before_data).toBe('null');expect(encoded.values.after_data).toBe('null');expect(decodeCommandRecord('creditEntries',{over_limit:null})).not.toHaveProperty('overLimit');});
