import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {shopDataFixture} from './shop-data-fixture';
import {reportBackupFixture} from './report-backup-fixture';
import {prepareCloudMigration,type CloudRecord} from '../packages/core/cloud-records';
import {emptyBackupTables,type MiseBackup} from '../packages/core/backup-tables';
import {createBackup} from '../packages/core/backup';
import {saveOrderCommand} from '../packages/core/orders';
import {saveCustomerCommand} from '../packages/core/customers';
import {defaultCreditTerms,saveCreditTermsCommand,openingBalanceCommand,creditBalance,entryDelta} from '../packages/core/khata';
import {newInboxId} from '../packages/core/inbox';

type Sql=Pick<PGlite,'query'|'exec'>;
interface Link {id:string;kind:string;resourceId:string;createdAt:number;expiresAt:number;revokedAt:number|null;token:string}
let db:PGlite,source:MiseBackup,branch:MiseBackup,foreign:MiseBackup;
const identity=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function role<T>(sql:Sql,n:number|null,actor:'anon'|'authenticated',query:string,params:unknown[]=[],metadata:Record<string,unknown>={}){
  await sql.exec(`set local role ${actor}`);
  await sql.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:actor,...(n===null?{}:{sub:identity(n)}),user_metadata:metadata})]);
  return (await sql.query<T>(query,params)).rows;
}
async function asRole<T>(n:number|null,actor:'anon'|'authenticated',query:string,params:unknown[]=[],metadata:Record<string,unknown>={}){
  return db.transaction(sql=>role<T>(sql,n,actor,query,params,metadata));
}
async function insert(sql:Sql,record:CloudRecord){
  const keys=Object.keys(record.values);
  await sql.query(`insert into public.${record.table}(${keys.join(',')}) values(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(record.values));
}
async function rollback<T>(action:(sql:Sql)=>Promise<T>):Promise<T>{
  const marker=new Error('rollback test');let result:T;
  try{await db.transaction(async sql=>{result=await action(sql);throw marker;});}catch(error){if(error!==marker)throw error;}
  return result!;
}
async function issue(n:number,kind:'order'|'khata',resource:string,expiry:number|null=null,id=newInboxId(),event=newInboxId()){
  return (await asRole<{link:Link}>(n,'authenticated','select public.create_public_link($1,$2,$3,$4,$5) as link',[id,event,kind,resource,expiry]))[0].link;
}
async function readOrder(token:string|null){return (await asRole<{data:Record<string,unknown>|null}>(null,'anon','select public.read_order_link($1) as data',[token]))[0].data;}
async function readKhata(token:string|null,after=0,limit=50){return (await asRole<{data:Record<string,unknown>|null}>(null,'anon','select public.read_khata_link($1,$2,$3) as data',[token,after,limit]))[0].data;}
beforeAll(async()=>{
  db=await PGlite.create();
  for(const path of ['./fixtures/supabase-auth.sql','../supabase/migrations/20261117081808_tenant_foundation.sql','../supabase/migrations/20261117085319_shop_records.sql','../supabase/migrations/20261117102312_public_capabilities.sql'])
    await db.exec(readFileSync(new URL(path,import.meta.url),'utf8'));
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.UTC(2026,10,17,6));
  try{source=await shopDataFixture();foreign=reportBackupFixture();}finally{vi.useRealTimers();}
  const t=emptyBackupTables(),at=Date.now(),setup={business:source.tables.businesses[0],outlet:{...source.tables.outlets[0],id:newInboxId()},owner:{...source.tables.members[0],outletIds:[] as string[]}};
  setup.owner.outletIds=[setup.outlet.id];t.businesses.push(setup.business);t.outlets.push(setup.outlet);t.members.push(setup.owner);
  const customer=saveCustomerCommand({name:'Branch customer',nickname:'',phone:'01712345486',address:'',notes:'Private branch note',tags:[]},setup,[],null,at);
  const terms=saveCreditTermsCommand({...defaultCreditTerms,allowed:true,limit:100000},customer.customer,setup,null,at);
  const opening=openingBalanceCommand(1500,at,{setup,customer:customer.customer,account:terms.account,entries:[]},at);
  const order=saveOrderCommand({source:'phone',sourceText:'PRIVATE SOURCE',name:'Branch customer',phone:'01712345486',type:'pickup',address:'',table:'',lines:[{name:'Branch item',unit:'pcs',qty:1,unitPrice:3300}],deliveryFee:0,discount:0,payment:{method:'cash'}},{setup,items:[],sequence:1},null,0,at);
  t.customers.push(customer.customer);t.creditAccounts.push(terms.account);t.creditEntries.push(opening.entry);t.orders.push(order.order);t.events.push(customer.event,terms.event,opening.event,order.event);branch=createBackup(t,at);
  for(const n of [1,2,3,4,5,6,7])await db.query('insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,now())',[identity(n),`1415555010${n}`]);
  for(const [backup,n] of [[source,1],[branch,1],[foreign,4]] as const){
    const plan=await prepareCloudMigration(backup,identity(n));
    await db.transaction(async sql=>{for(const record of plan.records){if(backup===branch&&['businesses','members'].includes(record.table))continue;await insert(sql,record);}});
  }
  for(const [n,snapshot,memberRole] of [[2,source,'manager'],[3,branch,'manager'],[6,source,'staff'],[7,source,'agent']] as const){
    const member=newInboxId();await db.query('insert into public.members(id,business_id,auth_user_id,name,role,created_at,updated_at) values($1,$2,$3,$4,$5,1,1)',[member,snapshot.tables.businesses[0].id,identity(n),JSON.stringify(`Person ${n}`),memberRole]);
    await db.query('insert into public.member_outlets values($1,$2,$3)',[snapshot.tables.businesses[0].id,member,snapshot.tables.outlets[0].id]);
  }
},30_000);
afterAll(async()=>{await db?.close();});

it('issues a server-random, purpose-bound token and stores only its SHA-256, with a secret-free audit',async()=>{
  const link=await issue(1,'order',source.tables.orders[0].id);
  expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(link.expiresAt-link.createdAt).toBe(604800000);
  const stored=(await db.query<{hash:string;columns:unknown}>('select encode(token_hash,\'hex\') as hash from private.public_links where id=$1',[link.id])).rows[0];
  expect(stored.hash).toBe(createHash('sha256').update(link.token).digest('hex'));
  const audit=(await db.query<{after_data:unknown;actor_id:string}>('select after_data,actor_id from public.events where command=$1 and after_data->>\'id\'=$2',['public_link.create',link.id])).rows[0];
  expect(audit.actor_id).toBe(source.tables.members[0].id);expect(JSON.stringify(audit)).not.toContain(link.token);expect(JSON.stringify(audit)).not.toContain(stored.hash);
  const second=await issue(1,'order',source.tables.orders[0].id);expect(second.token).not.toBe(link.token);
});
it('an anonymous order token returns only its order projection and no merchant source, profile or audit data',async()=>{
  const order=source.tables.orders.find(row=>row.source==='paste')!,link=await issue(2,'order',order.id),value=(await readOrder(link.token))!;
  expect(value.kind).toBe('order');expect(value.order).toMatchObject({id:order.id,total:null,paymentStatus:'pending'});
  expect(Object.keys(value).sort()).toEqual(['kind','marketCode','order','outletNameJson','shopLink','shopNameJson','v']);
  expect(Object.keys(value.order as object).sort()).toEqual(['businessType','currency','deliveryFee','discount','id','linesJson','number','paymentStatus','scheduledFor','status','statusChangedAt','subtotal','timezone','total','type']);
  expect(JSON.parse((value.order as {linesJson:string}).linesJson)).toEqual(order.lines);
  expect(JSON.stringify(value)).not.toContain(order.sourceText);expect(value).not.toHaveProperty('token');
  expect(await readKhata(link.token)).toBeNull();
});
it.each(['order','khata'] as const)('%s tokens cannot switch outlet, business or purpose',async(kind)=>{
  const resources=(backup:MiseBackup)=>kind==='order'?backup.tables.orders[0].id:backup.tables.creditAccounts[0].id;
  const links=await Promise.all([issue(1,kind,resources(source)),issue(1,kind,resources(branch)),issue(4,kind,resources(foreign))]);
  for(const [index,backup] of [source,branch,foreign].entries()){
    const value=(kind==='order'?await readOrder(links[index].token):await readKhata(links[index].token))!;
    expect((value[kind==='order'?'order':'account'] as {id:string}).id).toBe(resources(backup));
    expect(kind==='order'?await readKhata(links[index].token):await readOrder(links[index].token)).toBeNull();
  }
});
it('khata projection matches core ledger rules, omits private notes/reminders and paginates without duplicates',async()=>{
  const account=source.tables.creditAccounts[0],link=await issue(2,'khata',account.id),collected:Record<string,unknown>[]=[];
  expect(link.expiresAt-link.createdAt).toBe(2592000000);
  let cursor=0,more=true;
  while(more){
    const response=(await readKhata(link.token,cursor,2))!,data=response.account as {id:string;balance:number;entries:Record<string,unknown>[];nextSequence:number;hasMore:boolean};
    expect(data.id).toBe(account.id);expect(data.balance).toBe(creditBalance(account,source.tables.creditEntries));
    expect(data.entries.length).toBeLessThanOrEqual(2);collected.push(...data.entries);cursor=data.nextSequence;more=data.hasMore;
    expect(JSON.stringify(response)).not.toContain('বাকি মনে করিয়ে');expect(data).not.toHaveProperty('limit');
  }
  const expected=source.tables.creditEntries.filter(row=>row.accountId===account.id&&row.type!=='reminder').sort((a,b)=>a.sequence-b.sequence);
  expect(collected.map(row=>row.id)).toEqual(expected.map(row=>row.id));
  for(const [i,row] of collected.entries()){expect(row.delta).toBe(entryDelta(expected[i]));expect(row).not.toHaveProperty('note');expect(row).not.toHaveProperty('createdBy');}
  const other=await issue(3,'khata',branch.tables.creditAccounts[0].id);
  expect((await readKhata(other.token))?.account).toMatchObject({balance:1500});
});
it.each([null,'','short',' '.repeat(43),'x'.repeat(44),'x'.repeat(43),'../'+('a'.repeat(40))])('invalid/unknown token %s reveals no resource',async(token)=>{
  expect(await readOrder(token)).toBeNull();expect(await readKhata(token)).toBeNull();
});
it.each([[-1,50],[0,0],[0,101],[9007199254740992,1]])('invalid cursor/page (%s,%s) fails before resource lookup',async(after,size)=>{
  await expect(readKhata('x'.repeat(43),after,size)).rejects.toMatchObject({code:'22023'});
});
it('expiry and revocation take effect on the next read, while another link to the same order survives',async()=>{
  const order=source.tables.orders[0].id,expired=await issue(1,'order',order),revoked=await issue(1,'order',order),other=await issue(1,'order',order);
  await rollback(async sql=>{
    await sql.query('update private.public_links set created_at=created_at-86400000,expires_at=created_at-1 where id=$1',[expired.id]);
    expect((await role<{data:unknown}>(sql,null,'anon','select public.read_order_link($1) as data',[expired.token]))[0].data).toBeNull();
  });
  const event=newInboxId();const result=(await asRole<{link:Link}>(2,'authenticated','select public.revoke_public_link($1,$2) as link',[revoked.id,event]))[0].link;
  expect(result.revokedAt).toBeGreaterThanOrEqual(revoked.createdAt);expect(result).not.toHaveProperty('token');
  expect(await readOrder(revoked.token)).toBeNull();expect((await readOrder(other.token))?.order).toMatchObject({id:order});
  await asRole(2,'authenticated','select public.revoke_public_link($1,$2)',[revoked.id,newInboxId()]);
  expect((await db.query<{n:number}>('select count(*)::integer as n from public.events where command=\'public_link.revoke\' and after_data->>\'id\'=$1',[revoked.id])).rows[0].n).toBe(1);
});
it.each([2,3,4,5,6,7])('operator %s cannot create a link beyond their assigned role/outlet',async(n)=>{
  const target=n===2?branch.tables.orders[0].id:source.tables.orders[0].id;
  await expect(issue(n,'order',target)).rejects.toMatchObject({code:'42501'});
});
it.each([2,3,4,5,6,7])('operator %s cannot revoke a link beyond their assigned role/outlet',async(n)=>{
  const target=n===2?branch.tables.orders[0].id:source.tables.orders[0].id,link=await issue(1,'order',target);
  await expect(asRole(n,'authenticated','select public.revoke_public_link($1,$2)',[link.id,newInboxId()])).rejects.toMatchObject({code:'42501'});
  expect(await readOrder(link.token)).not.toBeNull();
});
it('editable user metadata cannot promote a manager to another outlet',async()=>{
  await expect(asRole(2,'authenticated','select public.create_public_link($1,$2,$3,$4,$5)',[newInboxId(),newInboxId(),'order',branch.tables.orders[0].id,null],{role:'owner',outletIds:[branch.tables.outlets[0].id]})).rejects.toMatchObject({code:'42501'});
});
it.each(['orders','credit_accounts','credit_entries','customers','events','inbox_items','inbox_images'])('holding a token never grants anonymous raw-table access to %s',async(table)=>{
  await expect(asRole(null,'anon',`select * from public.${table}`)).rejects.toMatchObject({code:'42501'});
});
it('capability rows, helper functions and direct writes stay closed to both customer and operator roles',async()=>{
  for(const actor of ['anon','authenticated'] as const){
    await expect(asRole(actor==='anon'?null:1,actor,'select * from private.public_links')).rejects.toMatchObject({code:'42501'});
    await expect(asRole(actor==='anon'?null:1,actor,'delete from private.public_links')).rejects.toMatchObject({code:'42501'});
    await expect(asRole(actor==='anon'?null:1,actor,'insert into private.public_links default values')).rejects.toMatchObject({code:'42501'});
    await expect(asRole(actor==='anon'?null:1,actor,'update private.public_links set revoked_at=created_at')).rejects.toMatchObject({code:'42501'});
    await expect(asRole(actor==='anon'?null:1,actor,'select private.public_link_actor($1,$2)',[source.tables.businesses[0].id,source.tables.outlets[0].id])).rejects.toMatchObject({code:'42501'});
  }
  await expect(asRole(null,'anon','select public.create_public_link($1,$2,$3,$4,$5)',[newInboxId(),newInboxId(),'order',source.tables.orders[0].id,null])).rejects.toMatchObject({code:'42501'});
  expect((await db.query<{n:number}>("select count(*)::integer as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef")).rows).toEqual([{n:0}]);
});
it('a failed audit insert rolls back issuance and revocation',async()=>{
  const capId=newInboxId(),collision=source.tables.events[0].id;
  await expect(issue(1,'order',source.tables.orders[0].id,null,capId,collision)).rejects.toMatchObject({code:'23505'});
  expect((await db.query('select id from private.public_links where id=$1',[capId])).rows).toEqual([]);
  const link=await issue(1,'order',source.tables.orders[0].id);
  await expect(asRole(1,'authenticated','select public.revoke_public_link($1,$2)',[link.id,collision])).rejects.toMatchObject({code:'23505'});
  expect(await readOrder(link.token)).not.toBeNull();
});
it('deactivating an operator prevents new grants while existing business-owned customer links persist',async()=>{
  const link=await issue(2,'order',source.tables.orders[0].id);
  await rollback(async sql=>{
    await sql.query('update public.members set active=false where auth_user_id=$1',[identity(2)]);
    await sql.exec('savepoint attempt');
    await expect(role(sql,2,'authenticated','select public.create_public_link($1,$2,$3,$4,$5)',[newInboxId(),newInboxId(),'order',source.tables.orders[0].id,null])).rejects.toMatchObject({code:'42501'});
    await sql.exec('rollback to savepoint attempt');
    expect((await role<{data:unknown}>(sql,null,'anon','select public.read_order_link($1) as data',[link.token]))[0].data).not.toBeNull();
  });
});
it.each([0,Date.now()+91*86400000])('expiry %s must be in the allowed future window',async(expiry)=>{
  await expect(issue(1,'order',source.tables.orders[0].id,expiry)).rejects.toMatchObject({code:'22023'});
});
it.each(['phone_confirmed_at=null',"banned_until=now()+interval '1 hour'",'deleted_at=now()'])('live Auth state (%s) prevents issuing links with an old token',async(change)=>{
  await rollback(async sql=>{
    await sql.query(`update auth.users set ${change} where id=$1`,[identity(2)]);
    await sql.exec('savepoint attempt');
    await expect(role(sql,2,'authenticated','select public.create_public_link($1,$2,$3,$4,$5)',[newInboxId(),newInboxId(),'order',source.tables.orders[0].id,null])).rejects.toMatchObject({code:'42501'});
    await sql.exec('rollback to savepoint attempt');
  });
});
it('private merchant order notes, source messages, customer contact and audit identifiers stay outside the order projection',async()=>{
  const note=source.tables.orderNotes[0],order=source.tables.orders.find(row=>row.id===note.orderId)!,link=await issue(1,'order',order.id);
  const data=(await readOrder(link.token))!,view=data.order as Record<string,unknown>;
  expect(JSON.stringify(data)).not.toContain(note.text);
  for(const key of ['sourceText','customer','customerId','customerPhone','address','eventId','createdBy','handledBy','payment','notes'])expect(view).not.toHaveProperty(key);
});
it('turning off further credit does not hide a customer’s existing balance',async()=>{
  const account=branch.tables.creditAccounts[0],link=await issue(1,'khata',account.id);
  await rollback(async sql=>{
    await sql.query('update public.credit_accounts set allowed=false where id=$1',[account.id]);
    const data=(await role<{data:{account:{balance:number}}}>(sql,null,'anon','select public.read_khata_link($1,0,50) as data',[link.token]))[0].data;
    expect(data.account.balance).toBe(1500);
  });
});
it('an unsafe stored balance fails explicitly instead of returning rounded money',async()=>{
  const account=source.tables.creditAccounts[0],entry=source.tables.creditEntries[0],link=await issue(1,'khata',account.id);
  await rollback(async sql=>{
    const sequence=(await sql.query<{n:number}>('select max(sequence)::integer+1 as n from public.credit_entries where account_id=$1',[account.id])).rows[0].n;
    for(const [offset,amount] of [9007199254740991,1].entries())await sql.query(
      'insert into public.credit_entries(id,business_id,outlet_id,account_id,customer_id,currency,sequence,type,amount,note,created_by,event_id,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,1)',
      [newInboxId(),source.tables.businesses[0].id,account.outletId,account.id,account.customerId,account.currency,sequence+offset,'charge',amount,'"Fixture"',entry.createdBy,entry.eventId]);
    await sql.exec('savepoint read_balance');
    await expect(role(sql,null,'anon','select public.read_khata_link($1,0,50)',[link.token])).rejects.toMatchObject({code:'22003'});
    await sql.exec('rollback to savepoint read_balance');
  });
});
it('a repeated create ID cannot replace an existing token or create another audit event',async()=>{
  const link=await issue(1,'order',source.tables.orders[0].id);
  await expect(issue(1,'order',source.tables.orders[0].id,null,link.id)).rejects.toMatchObject({code:'23505'});
  expect(await readOrder(link.token)).not.toBeNull();
  expect((await db.query<{n:number}>('select count(*)::integer as n from public.events where command=\'public_link.create\' and after_data->>\'id\'=$1',[link.id])).rows[0].n).toBe(1);
});
