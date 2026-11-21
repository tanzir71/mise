import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createBackup} from '../packages/core/backup';
import {emptyBackupTables} from '../packages/core/backup-tables';
import {prepareCloudMigration,encodeCommandRecord,type CloudRecord} from '../packages/core/cloud-records';
import {closingFingerprint} from '../packages/core/closing-replay';
import {closingReviewFacts,closingReviewSourceAudits,type ClosingReviewRequest} from '../packages/core/closing-review-source';
import {id,fixture} from './closing-review-fixture';
import type {Member} from '../packages/core/models';
export const uid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export async function createClosingReviewDatabase(){
 const db=await PGlite.create();for(const name of ['supabase-auth.sql','supabase-storage.sql'])await db.exec(readFileSync(new URL('./fixtures/'+name,import.meta.url),'utf8'));
 const directory=new URL('../supabase/migrations/',import.meta.url);for(const name of readdirSync(directory).filter(n=>n.endsWith('.sql')).sort())await db.exec(readFileSync(new URL(name,directory),'utf8'));
 async function insert(records:CloudRecord[]){await db.transaction(async tx=>{for(const r of records){const keys=Object.keys(r.values);await tx.query(`insert into public.${r.table}(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(r.values));}});}
 async function asRole(n:number|null,role:'authenticated'|'anon'|'service_role',query:string,args:unknown[]=[]){return db.transaction(async tx=>{await tx.exec('set local role '+role);await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role,...(n?{sub:uid(n)}:{}),user_metadata:{role:'owner'}})]);return (await tx.query<{data:unknown}>(query,args)).rows[0]?.data;});}
 async function seed(f:ReturnType<typeof fixture>){
  for(const n of [1,2,3,4,5])await db.query('insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,now())',[uid(n),'1415555010'+n]);
  const {setup}=f.context,tables=emptyBackupTables();tables.businesses.push(setup.business);tables.outlets.push(setup.outlet);tables.members.push(setup.owner);tables.sales.push(f.initial.sale);tables.events.push(f.initial.event);
  if(f.command.type==='closing.undo'){tables.dayClosings.push(f.created.closing);if(f.created.sale)tables.sales.push(f.created.sale);tables.events.push(...f.created.events);}
  await insert((await prepareCloudMigration(createBackup(tables),uid(1))).records);
  for(const [n,role,assigned] of [[2,'manager',true],[3,'staff',true],[4,'agent',true],[5,'manager',false]] as const){
   const member:Member={...setup.owner,id:id(700000+n),name:'Person '+n,role,outletIds:assigned?[setup.outlet.id]:[]},record=encodeCommandRecord('members',member,setup.business.id);record.values.auth_user_id=uid(n);await insert([record]);
   if(assigned)await insert([{table:'member_outlets',values:{business_id:setup.business.id,outlet_id:setup.outlet.id,member_id:member.id}}]);
  }
 }
 async function prepare(f:ReturnType<typeof fixture>,n=1,patch:Partial<ClosingReviewRequest>={},extra:Record<string,unknown>={}){
  const input={...f.packet,...patch},c=input.command,values={p_id:input.id,p_replacement_id:input.replacementId,p_command_id:c.id,p_type:c.type,p_outlet_id:c.outletId,p_closing_id:c.closingId,p_sale_id:c.saleId,p_sale_event_id:c.saleEventId,p_occurred_at:c.occurredAt,p_hash:await closingFingerprint(c),p_intent_json:JSON.stringify(c),p_source_hash:input.sourceHash,p_source_json:input.sourceJson,p_facts:closingReviewFacts(input),...extra};
  const names=Object.keys(values);return asRole(n,'authenticated',`select public.prepare_closing_review(${names.map((_,i)=>'$'+(i+1)).join(',')}) data`,Object.entries(values).map(([k,v])=>k==='p_facts'?JSON.stringify(v):v));
 }
 async function read(value:unknown,n=1){const p=value as {id:string;token:string};return asRole(n,'authenticated','select public.read_closing_review($1,$2) data',[p.id,p.token]);}
 function memberSource(f:ReturnType<typeof fixture>,actorId:string){
  const events=structuredClone(f.change.events);for(const e of events){e.actor.id=actorId;if(f.command.type==='closing.record'){(e.after as {createdBy:string}).createdBy=actorId;if(e.command==='closing.record')(e.after as {createdByName:string}).createdByName='Person 2';}}
  const source=JSON.parse(f.packet.sourceJson);source.events=closingReviewSourceAudits(f.command,events);f.packet.sourceJson=JSON.stringify(source);
 }
 async function reset(){await db.exec('truncate public.businesses,auth.users cascade;truncate private.closing_review_tickets,private.closing_command_resolutions,private.closing_write_tickets,private.shop_command_receipts,private.command_receipts cascade');}
 return {db,insert,asRole,seed,prepare,read,memberSource,reset};
}
export type ClosingReviewDatabase=Awaited<ReturnType<typeof createClosingReviewDatabase>>;
