import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createBackup} from '../packages/core/backup';
import {emptyBackupTables} from '../packages/core/backup-tables';
import {prepareCloudMigration,type CloudRecord} from '../packages/core/cloud-records';
import {newInboxId} from '../packages/core/inbox';
import {saveCustomerCommand} from '../packages/core/customers';
import {defaultCreditTerms,openingBalanceCommand,saveCreditTermsCommand} from '../packages/core/khata';
import {saveOrderCommand} from '../packages/core/orders';
import {shopDataFixture} from './shop-data-fixture';
import {reportBackupFixture} from './report-backup-fixture';
import type {CustomerLinkRequest} from '../packages/core/customer-links';
import {createPublicCapabilityHandler,type PublicReadLimits} from '../supabase/functions/_shared/public-capability-handler';

const identity=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export async function createPublicReadDatabase(root=process.cwd()){
 const db=await PGlite.create();
 try{
  for(const path of ['tests/fixtures/supabase-auth.sql','supabase/migrations/20261117081808_tenant_foundation.sql','supabase/migrations/20261117085319_shop_records.sql','supabase/migrations/20261117102312_public_capabilities.sql','supabase/migrations/20261122164721_public_capability_http.sql'])await db.exec(readFileSync(resolve(root,path),'utf8'));
  const source=await shopDataFixture(),foreign=reportBackupFixture(),tables=emptyBackupTables(),at=Date.now();
  const setup={business:source.tables.businesses[0],outlet:{...source.tables.outlets[0],id:newInboxId()},owner:{...source.tables.members[0],outletIds:[] as string[]}};setup.owner.outletIds=[setup.outlet.id];
  const customer=saveCustomerCommand({name:'Branch customer',nickname:'',phone:'01712345486',address:'',notes:'PRIVATE BRANCH NOTE',tags:[]},setup,[],null,at);
  const terms=saveCreditTermsCommand({...defaultCreditTerms,allowed:true,limit:100000},customer.customer,setup,null,at),opening=openingBalanceCommand(1500,at,{setup,customer:customer.customer,account:terms.account,entries:[]},at);
  const order=saveOrderCommand({source:'phone',sourceText:'PRIVATE SOURCE',name:'Branch customer',phone:'01712345486',type:'pickup',address:'',table:'',lines:[{name:'Branch item',unit:'pcs',qty:1,unitPrice:3300}],deliveryFee:0,discount:0,payment:{method:'cash'}},{setup,items:[],sequence:1},null,0,at);
  tables.businesses.push(setup.business);tables.outlets.push(setup.outlet);tables.members.push(setup.owner);tables.customers.push(customer.customer);tables.creditAccounts.push(terms.account);tables.creditEntries.push(opening.entry);tables.orders.push(order.order);tables.events.push(customer.event,terms.event,opening.event,order.event);const branch=createBackup(tables,at);
  for(const n of [1,2,3,4])await db.query('insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,now())',[identity(n),`1415555010${n}`]);
  async function insert(sql:Pick<PGlite,'query'>,record:CloudRecord){const columns=Object.keys(record.values);await sql.query(`insert into public.${record.table}(${columns.join(',')}) values(${columns.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(record.values));}
  for(const [backup,n]of [[source,1],[branch,1],[foreign,4]]as const){const plan=await prepareCloudMigration(backup,identity(n));await db.transaction(async sql=>{for(const record of plan.records){if(backup===branch&&['businesses','members'].includes(record.table))continue;await insert(sql,record);}});}
  for(const [n,backup]of [[2,source],[3,branch]]as const){const member=newInboxId();await db.query("insert into public.members(id,business_id,auth_user_id,name,role,created_at,updated_at) values($1,$2,$3,$4,'manager',1,1)",[member,backup.tables.businesses[0].id,identity(n),JSON.stringify('Manager '+n)]);await db.query('insert into public.member_outlets values($1,$2,$3)',[backup.tables.businesses[0].id,member,backup.tables.outlets[0].id]);}
  async function asRole<T>(n:number|null,actor:'anon'|'authenticated'|'service_role',query:string,params:unknown[]=[]):Promise<T>{return db.transaction(async sql=>{await sql.exec('set local role '+actor);await sql.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:actor,...(n===null?{}:{sub:identity(n)})})]);return(await sql.query<{data:T}>(query,params)).rows[0]?.data;});}
  const issue=(n:number,kind:'order'|'khata',resource:string)=>asRole<{id:string;token:string;createdAt:number;expiresAt:number}>(n,'authenticated','select public.create_public_link($1,$2,$3,$4,null) data',[newInboxId(),newInboxId(),kind,resource]);
  const read=(request:CustomerLinkRequest,limits:PublicReadLimits={global:3000,link:60})=>asRole<unknown>(null,'service_role','select public.read_public_capability($1,$2,$3,$4,$5,$6) data',[request.token,request.kind,request.afterSequence,request.pageSize,limits.global,limits.link]);
  const handler=(limits?:PublicReadLimits)=>createPublicCapabilityHandler({store:{read},origins:new Set(['https://shop.example']),limits});
  const resetBudgets=async()=>{await db.exec('update private.public_read_budget set window_at=0,requests=0;update private.public_links set read_window_at=0,read_count=0;');};
  const fingerprint=async()=>{const hash=createHash('sha256');for(const name of ['orders','sales','credit_accounts','credit_entries','events']){const rows=(await db.query<{value:string}>(`select row_to_json(t)::text value from public.${name} t order by id`)).rows;for(const row of rows)hash.update(row.value+'\n');}return hash.digest('hex');};
  return {db,source,branch,foreign,asRole,issue,read,handler,resetBudgets,fingerprint};
 }catch(error){await db.close();throw error;}
}
export type PublicReadDatabase=Awaited<ReturnType<typeof createPublicReadDatabase>>;
