import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createBackup} from '../packages/core/backup';
import {emptyBackupTables} from '../packages/core/backup-tables';
import {prepareCloudMigration,encodeCommandRecord,decodeCommandRecord,type CloudRecord} from '../packages/core/cloud-records';
import {customerFingerprint} from '../packages/core/customer-commands';
import {customerReviewFacts,customerReviewSourceAudits,type CustomerReviewRequest} from '../packages/core/customer-review-source';
import {chargeCreditCommand} from '../packages/core/khata';
import {id,fixture,replayContext} from './customer-review-fixture';
import type {Member,CreditAccount,Outlet,CreditEntry} from '../packages/core/models';
export const uid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export async function createCustomerReviewDatabase(){
 const db=await PGlite.create();for(const name of ['supabase-auth.sql','supabase-storage.sql'])await db.exec(readFileSync(new URL('./fixtures/'+name,import.meta.url),'utf8'));
 const directory=new URL('../supabase/migrations/',import.meta.url);for(const name of readdirSync(directory).filter(n=>n.endsWith('.sql')).sort())await db.exec(readFileSync(new URL(name,directory),'utf8'));
async function insert(records:CloudRecord[]){
 for(const r of records){const keys=Object.keys(r.values);await db.query(`insert into public.${r.table}(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(r.values));}
}
async function asRole(n:number|null,role:'authenticated'|'anon'|'service_role',sql:string,args:unknown[]=[]){
 return db.transaction(async tx=>{await tx.exec('set local role '+role);await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role,...(n?{sub:uid(n)}:{}),user_metadata:{role:'owner'}})]);return (await tx.query<{data:unknown}>(sql,args)).rows[0]?.data;});
}
async function seed(f:ReturnType<typeof fixture>){
 for(const n of [1,2,3,4,5])await db.query('insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,now())',[uid(n),'1415555010'+n]);
 const tables=emptyBackupTables();tables.businesses.push(f.setup.business);tables.outlets.push(f.setup.outlet);tables.members.push(f.setup.owner);
 await insert((await prepareCloudMigration(createBackup(tables),uid(1))).records);
 const current=JSON.parse(replayContext(f).contextJson);
 if(current.customer){const customer=decodeCommandRecord('customers',current.customer);await insert([encodeCommandRecord('customers',customer,f.setup.business.id),{table:'customer_outlets',values:{business_id:f.setup.business.id,outlet_id:f.setup.outlet.id,customer_id:f.command.customerId}}]);}
 for(const a of current.accounts)await insert([encodeCommandRecord('creditAccounts',decodeCommandRecord('creditAccounts',a),f.setup.business.id)]);
 for(const [n,role,assigned] of [[2,'manager',true],[3,'staff',true],[4,'agent',true],[5,'manager',false]] as const){
  const member:Member={...f.setup.owner,id:id(700000+n),name:'Person '+n,role,outletIds:assigned?[f.setup.outlet.id]:[]};
  const record=encodeCommandRecord('members',member,f.setup.business.id);record.values.auth_user_id=uid(n);await insert([record]);
  if(assigned)await insert([{table:'member_outlets',values:{business_id:f.setup.business.id,outlet_id:f.setup.outlet.id,member_id:member.id}}]);
 }
}
async function prepare(f:ReturnType<typeof fixture>,n=1,patch:Partial<CustomerReviewRequest>={},extra:Record<string,unknown>={}){
 const p={...f.packet,...patch},c=p.command,values={p_id:p.id,p_replacement_id:p.replacementId,p_command_id:c.id,p_type:c.type,p_customer_id:c.customerId,p_outlet_id:c.outletId,p_account_id:c.type==='khata.settings'?c.accountId:null,p_ids:'ids'in c?c.ids:null,p_hash:await customerFingerprint(c),p_intent_json:JSON.stringify(c),p_source_hash:p.sourceHash,p_source_json:p.sourceJson,p_facts:customerReviewFacts(p),...extra};
 const names=Object.keys(values);return asRole(n,'authenticated',`select public.prepare_customer_review(${names.map((_,i)=>'$'+(i+1)).join(',')}) data`,Object.entries(values).map(([k,v])=>['p_ids','p_facts'].includes(k)&&v!==null?JSON.stringify(v):v));
}
async function read(value:unknown,n=1){const p=value as {id:string;token:string};return asRole(n,'authenticated','select public.read_customer_review($1,$2) data',[p.id,p.token]);}
function memberSource(f:ReturnType<typeof fixture>,actorId:string){
 const events=structuredClone(f.events);for(const e of events){e.actor.id=actorId;if(e.command==='khata.opening-balance')(e.after as {createdBy:string}).createdBy=actorId;}
 const source=JSON.parse(f.packet.sourceJson);source.events=customerReviewSourceAudits(f.command,events,f.setup.business.id);f.packet.sourceJson=JSON.stringify(source);
}
async function addCharge(f:ReturnType<typeof fixture>,account=f.account,outlet=f.setup.outlet,n=800000){
 const entries=(await db.query<Record<string,unknown>>('select * from public.credit_entries where account_id=$1',[account.id])).rows.map(row=>decodeCommandRecord('creditEntries',row) as unknown as CreditEntry);
 const result=chargeCreditCommand(100,{setup:{...f.setup,outlet},customer:f.customer,account,entries},{},Date.now(),kind=>id(n+(kind==='event'?1:0)));
 await insert([encodeCommandRecord('events',result.event,f.setup.business.id),encodeCommandRecord('creditEntries',result.entry,f.setup.business.id)]);
}
async function otherOutlet(f:ReturnType<typeof fixture>){
 const outlet:Outlet={...f.setup.outlet,id:id(800100),name:'Other outlet'},account:CreditAccount={...f.account,id:id(800101),outletId:outlet.id};
 await insert([encodeCommandRecord('outlets',outlet,f.setup.business.id),{table:'customer_outlets',values:{business_id:f.setup.business.id,outlet_id:outlet.id,customer_id:f.command.customerId}},encodeCommandRecord('creditAccounts',account,f.setup.business.id)]);
 return {outlet,account};
}
async function reset(){await db.exec('truncate public.businesses,auth.users cascade;truncate private.customer_review_tickets,private.customer_command_resolutions,private.customer_write_tickets,private.shop_command_receipts,private.command_receipts cascade');}
return {db,insert,asRole,seed,prepare,read,memberSource,addCharge,otherOutlet,reset};
}
export type CustomerReviewDatabase=Awaited<ReturnType<typeof createCustomerReviewDatabase>>;
