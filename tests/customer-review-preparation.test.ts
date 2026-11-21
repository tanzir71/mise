import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createBackup} from '../packages/core/backup';
import {emptyBackupTables} from '../packages/core/backup-tables';
import {prepareCloudMigration,encodeCommandRecord} from '../packages/core/cloud-records';
import {customerFingerprint} from '../packages/core/customer-commands';
import {customerReviewFacts} from '../packages/core/customer-review-source';
import {customerReviewFields} from '../supabase/functions/_shared/customer-review';
import {readCustomerReviewContext} from '../packages/core/customer-review-view';
import {customerWriteFields} from '../supabase/functions/_shared/customer-write';
import {id,literal,input,modes,fixture} from './customer-review-fixture';

import {createCustomerReviewDatabase,uid,type CustomerReviewDatabase} from './customer-review-sql-fixture';
let sql:CustomerReviewDatabase;
const insert=(...args:Parameters<CustomerReviewDatabase['insert']>)=>sql.insert(...args);
const asRole=(...args:Parameters<CustomerReviewDatabase['asRole']>)=>sql.asRole(...args);
const seed=(...args:Parameters<CustomerReviewDatabase['seed']>)=>sql.seed(...args);
const prepare=(...args:Parameters<CustomerReviewDatabase['prepare']>)=>sql.prepare(...args);
const read=(...args:Parameters<CustomerReviewDatabase['read']>)=>sql.read(...args);
const memberSource=(...args:Parameters<CustomerReviewDatabase['memberSource']>)=>sql.memberSource(...args);
const addCharge=(...args:Parameters<CustomerReviewDatabase['addCharge']>)=>sql.addCharge(...args);
const otherOutlet=(...args:Parameters<CustomerReviewDatabase['otherOutlet']>)=>sql.otherOutlet(...args);
let db:CustomerReviewDatabase['db'];
beforeAll(async()=>{sql=await createCustomerReviewDatabase();db=sql.db;},30000);
beforeEach(async()=>{await sql.reset();});
afterAll(async()=>{await db?.close();});

it.each(modes)('authorizes a genuine %s source, reads current state and formats the actual tentative result without shop writes',async mode=>{
 const f=fixture(mode);await seed(f);const before=(await db.query('select (select count(*) from public.events) events,(select count(*) from public.customers) customers,(select count(*) from public.credit_accounts) accounts,(select count(*) from public.credit_entries) entries')).rows;
 const p=await prepare(f),formatted=await customerReviewFields(p,f.packet);expect(formatted.view.proposal.enabled).toBe(true);expect(formatted.proposal).toMatchObject({id:f.packet.replacementId,customerId:f.command.customerId});expect(await read(p)).toEqual(p);
 expect((await db.query('select (select count(*) from public.events) events,(select count(*) from public.customers) customers,(select count(*) from public.credit_accounts) accounts,(select count(*) from public.credit_entries) entries')).rows).toEqual(before);
});
it.each(['anon','service_role'] as const)('denies direct %s preparation, admission, reading and outcome lookup',async role=>{
 const f=fixture('update-terms');await seed(f);
 const c=f.command,args=[f.packet.id,f.packet.replacementId,c.id,c.type,c.customerId,c.outletId,null,'ids'in c?JSON.stringify(c.ids):null,await customerFingerprint(c),JSON.stringify(c),f.packet.sourceHash,f.packet.sourceJson,JSON.stringify(customerReviewFacts(f.packet))];
 await expect(asRole(null,role,'select public.prepare_customer_review('+args.map((_,i)=>'$'+(i+1)).join(',')+') data',args)).rejects.toMatchObject({code:'42501'});
 for(const [sql,args] of [['select public.admit_customer_review($1) data',[f.command.outletId]],['select public.read_customer_review($1,$2) data',[f.packet.id,'x'.repeat(43)]],['select public.inspect_customer_outcome($1,$2,$3,$4,$5) data',[f.command.id,f.command.type,f.command.customerId,f.command.outletId,await customerFingerprint(f.command)]]] as const)await expect(asRole(null,role,sql,[...args])).rejects.toMatchObject({code:'42501'});
});
it.each([3,4,5])('ignores a forged owner claim for staff, agent or unassigned manager %s',async n=>{
 const f=fixture('update-terms');await seed(f);await expect(prepare(f,n)).rejects.toMatchObject({code:'42501'});expect((await db.query<{n:number}>('select count(*)::int n from private.customer_review_tickets')).rows[0].n).toBe(0);
});
it('permits an assigned manager to review only their original action and rechecks assignment on read',async()=>{
 const f=fixture('update-terms');await seed(f);memberSource(f,id(700002));const p=await prepare(f,2);expect((await customerReviewFields(p,f.packet)).view.actorId).toBe(id(700002));
 await expect(read(p,1)).rejects.toMatchObject({code:'42501'});await db.query('delete from public.member_outlets where member_id=$1',[id(700002)]);await expect(read(p,2)).rejects.toMatchObject({code:'42501'});
});
it.each(['inactive','identity','banned','phone'])('rechecks live %s authorization before reusing a comparison',async kind=>{
 const f=fixture('update-terms');await seed(f);const p=await prepare(f);
 if(kind==='inactive')await db.query('update public.members set active=false where id=$1',[f.setup.owner.id]);else if(kind==='identity')await db.query('update public.members set auth_user_id=null where id=$1',[f.setup.owner.id]);else if(kind==='banned')await db.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1",[uid(1)]);else await db.query('update auth.users set phone_confirmed_at=null where id=$1',[uid(1)]);
 await expect(read(p)).rejects.toMatchObject({code:'42501'});
});
it.each(['profile','terms','currency','balance','phone'])('invalidates consent after the checked %s changes',async kind=>{
 const f=fixture('update-terms');await seed(f);const p=await prepare(f);
 if(kind==='profile')await db.query('update public.customers set nickname=$1 where id=$2',[JSON.stringify('Changed'),f.command.customerId]);else if(kind==='terms')await db.query('update public.credit_accounts set credit_limit=credit_limit+1 where id=$1',[f.account.id]);else if(kind==='currency')await db.query("update public.outlets set currency='USD' where id=$1",[f.command.outletId]);else if(kind==='phone')await db.query('update public.customers set phone=$1 where id=$2',['+8801712345489',f.command.customerId]);else await addCharge(f);
 await expect(read(p)).rejects.toMatchObject({code:'PT409'});
});
it('can inspect a competing canonical khata and keep the original source without retargeting it',async()=>{
 const f=fixture('khata-create');await seed(f);await insert([encodeCommandRecord('creditAccounts',{...f.account,id:id(800000)},f.setup.business.id)]);
 const p=await prepare(f),{view,proposal}=await customerReviewFields(p,f.packet);expect(proposal).toBeNull();expect(view.proposal.enabled).toBe(false);expect(view.current.balances).toEqual([{accountId:id(800000),balance:0}]);expect(JSON.stringify(f.packet.command)).toContain('"accountId":null');
});
it('preserves current literal profile text without decoding the original intent in PostgreSQL',async()=>{
 const f=fixture('update-terms');await seed(f);await db.query('update public.customers set name=$1,notes=$1 where id=$2',[JSON.stringify(literal),f.command.customerId]);
 const p=await prepare(f),{view}=await customerReviewFields(p,f.packet),current=readCustomerReviewContext(view.current.contextJson,view.businessId,view.outletId,f.command.customerId);
 expect(current.customer).toMatchObject({name:literal,notes:literal});expect((await db.query<{text:string}>('select original_intent text from private.customer_review_tickets where id=$1',[f.packet.id])).rows[0].text).toBe(JSON.stringify(f.command));expect(JSON.stringify(p)).not.toContain(uid(1));
});
it('keeps another outlet ledger outside an ordinary profile review and its stale-state calculation',async()=>{
 const f=fixture('update-terms');await seed(f);const branch=await otherOutlet(f);await addCharge(f,branch.account,branch.outlet,800200);
 memberSource(f,id(700002));const p=await prepare(f,2),{view}=await customerReviewFields(p,f.packet),current=readCustomerReviewContext(view.current.contextJson,view.businessId,view.outletId,f.command.customerId);
 expect(current.accounts.map(a=>a.id)).toEqual([f.account.id]);expect(current.hasBalance).toBe(false);expect(JSON.stringify(view.current)).not.toContain(branch.account.id);expect(JSON.stringify(view.current)).not.toContain(branch.outlet.id);
 await addCharge(f,branch.account,branch.outlet,800210);expect(await read(p,2)).toEqual(p);
});
it('checks every shared-contact outlet for status while returning only scoped balances and an opaque status hash',async()=>{
 const f=fixture('archive');await seed(f);const branch=await otherOutlet(f);await addCharge(f,branch.account,branch.outlet,800200);memberSource(f,id(700002));
 await expect(prepare(f,2)).rejects.toMatchObject({code:'42501'});
 await insert([{table:'member_outlets',values:{business_id:f.setup.business.id,outlet_id:branch.outlet.id,member_id:id(700002)}}]);
 const p=await prepare(f,2),{view}=await customerReviewFields(p,f.packet),current=readCustomerReviewContext(view.current.contextJson,view.businessId,view.outletId,f.command.customerId);
 expect(current.hasBalance).toBe(true);expect(current.accounts.map(a=>a.id)).toEqual([f.account.id]);expect(view.proposal.enabled).toBe(false);expect(JSON.stringify(view.current)).not.toContain(branch.account.id);
 await addCharge(f,branch.account,branch.outlet,800210);await expect(read(p,2)).rejects.toMatchObject({code:'PT409'});
});
it('reveals only phone availability when the conflicting contact belongs to another outlet',async()=>{
 const f=fixture('create-default',{...input,phone:'+8801712345484'});await seed(f);const outlet={...f.setup.outlet,id:id(800100)},customer={...f.customer,phone:'+8801712345484',name:'Hidden other-outlet contact'};
 await insert([encodeCommandRecord('outlets',outlet,f.setup.business.id),encodeCommandRecord('customers',customer,f.setup.business.id),{table:'customer_outlets',values:{business_id:f.setup.business.id,outlet_id:outlet.id,customer_id:customer.id}}]);memberSource(f,id(700002));
 const p=await prepare(f,2),{view}=await customerReviewFields(p,f.packet);expect(view.current.phoneTaken).toBe(true);expect(view.proposal).toEqual({enabled:false,reason:'phone'});expect(JSON.stringify(p)).not.toContain(customer.name);expect(JSON.stringify(p)).not.toContain(customer.id);expect(JSON.stringify(p)).not.toContain(outlet.id);
});
it('denies another tenant even with a known valid preparation token',async()=>{
 const f=fixture('update-terms');await seed(f);const p=await prepare(f),foreign=fixture('update-contact'),tables=emptyBackupTables();
 await db.query('insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,now())',[uid(6),'14155550106']);tables.businesses.push(foreign.setup.business);tables.outlets.push(foreign.setup.outlet);tables.members.push(foreign.setup.owner);await insert((await prepareCloudMigration(createBackup(tables),uid(6))).records);
 await expect(read(p,6)).rejects.toMatchObject({code:'42501'});await expect(prepare(f,6)).rejects.toMatchObject({code:'42501'});
});
it.each(['command hash','source hash','source encoding','facts','actor','authority','current private field'])('refuses mismatched %s when formatting an admitted SQL response',async kind=>{
 const f=fixture('update-terms');await seed(f);const p=await prepare(f) as Record<string,unknown>;
 if(kind==='command hash')p.commandHash='f'.repeat(64);else if(kind==='source hash')p.sourceHash='f'.repeat(64);else if(kind==='source encoding')p.sourceJsonHash='f'.repeat(64);else if(kind==='facts')p.facts={...(p.facts as object),at:0};else if(kind==='actor')p.actorId=id(700002);else if(kind==='authority')p.role='owner';else{const state=JSON.parse(p.stateJson as string);state.auth_user_id=uid(1);p.stateJson=JSON.stringify(state);}
 await expect(customerReviewFields(p,f.packet)).rejects.toThrow();
});
it('rejects wrong and expired proof without exposing saved context',async()=>{
 const f=fixture('update-terms');await seed(f);const p=await prepare(f) as {id:string;token:string};await expect(read({...p,token:'w'.repeat(43)})).rejects.toMatchObject({code:'PT409'});await db.query('update private.customer_review_tickets set expires_at=0');await expect(read(p)).rejects.toMatchObject({code:'PT409'});
});
it('keeps actual text opaque and refuses a mismatched hash, companion plan or source actor',async()=>{
 const f=fixture('create-opening');await seed(f);expect(f.command).toMatchObject({input:{name:literal}});
 await expect(prepare(f,1,{}, {p_hash:'f'.repeat(64)})).rejects.toMatchObject({code:'22023'});
 if(!('ids'in f.command))throw Error();await expect(prepare(f,1,{}, {p_ids:{...f.command.ids,openingEntryId:id(800000)}})).rejects.toMatchObject({code:'22023'});
 await expect(prepare(f,1,{}, {p_facts:{...customerReviewFacts(f.packet),actorId:id(700002)}})).rejects.toMatchObject({code:'42501'});
 const p=await prepare(f);expect((await customerReviewFields(p,f.packet)).view.proposal).toMatchObject({enabled:true,customer:{name:literal,notes:literal}});
});
it('binds an immutable selected source and replaces only an identical preparation token',async()=>{
 const f=fixture('update-terms');await seed(f);const first=await prepare(f) as {token:string},second=await prepare(f) as {token:string};expect(second.token).not.toBe(first.token);await expect(read(first)).rejects.toMatchObject({code:'PT409'});expect(await read(second)).toEqual(second);
 await expect(prepare(f,1,{sourceHash:'f'.repeat(64)})).rejects.toMatchObject({code:'PT409'});await expect(prepare(f,1,{}, {p_source_json:f.packet.sourceJson+' '})).rejects.toMatchObject({code:'PT409'});
});
it('returns a genuine original command receipt before an expired review rather than applying it twice',async()=>{
 const f=fixture('update-terms');await seed(f);const p=await prepare(f),c=f.command,ticket=id(800000);
 const prepared=await asRole(1,'authenticated','select public.prepare_customer_intent($1,$2,$3,$4,$5,$6,$7,$8) data',[c.id,ticket,c.type,c.customerId,c.outletId,c.type==='khata.settings'?c.accountId:null,await customerFingerprint(c),'ids'in c?JSON.stringify(c.ids):null]);
 const fields=customerWriteFields(prepared,c,ticket),receipt=await asRole(null,'service_role','select public.finish_customer_write($1,$2,$3) data',[fields.p_ticket_id,fields.p_token,JSON.stringify(fields.p_records)]);
 await db.query('update private.customer_review_tickets set expires_at=0');expect(await read(p)).toEqual({done:true,receipt});expect(await prepare(f)).toEqual({done:true,receipt});
});
it('forces RLS, denies every direct table/sequence grant and exposes no public definer',async()=>{
 const tables=(await db.query<{name:string;forced:boolean;rls:boolean}>("select relname name,relforcerowsecurity forced,relrowsecurity rls from pg_class where oid in('private.customer_review_tickets'::regclass,'private.customer_command_resolutions'::regclass)")).rows;expect(tables).toHaveLength(2);expect(tables.every(t=>t.forced&&t.rls)).toBe(true);
 for(const role of ['anon','authenticated','service_role']){
  expect((await db.query<{allowed:boolean}>("select has_table_privilege($1,'private.customer_review_tickets','select,insert,update,delete') or has_table_privilege($1,'private.customer_command_resolutions','select,insert,update,delete') or has_sequence_privilege($1,'private.customer_command_resolutions_position_seq','usage,select,update') allowed",[role])).rows[0].allowed).toBe(false);
  await expect(asRole(role==='authenticated'?1:null,role as 'anon'|'authenticated'|'service_role','select row_to_json(r) data from private.customer_review_tickets r')).rejects.toMatchObject({code:'42501'});
 }
 expect((await db.query<{n:number}>("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef")).rows[0].n).toBe(0);
});
