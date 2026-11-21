import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createCustomerReviewDatabase,type CustomerReviewDatabase} from './customer-review-sql-fixture';
import {fixture,id,modes,literal,terms} from './customer-review-fixture';
import {customerReviewFields,createCustomerReviewHandler,createCustomerReviewStore} from '../supabase/functions/_shared/customer-review';
import {customerWriteFields} from '../supabase/functions/_shared/customer-write';
import {customerFingerprint,type CustomerCommand} from '../packages/core/customer-commands';
import {parseCustomerResolutionReceipt} from '../packages/core/customer-review';
import {customerReviewEffectsMatch} from '../packages/core/customer-review-effects';
import {customerReviewSourceAudits} from '../packages/core/customer-review-source';
import {encodeCommandRecord,decodeCommandRecord,type CloudRecord} from '../packages/core/cloud-records';
import {recordCreditPaymentCommand} from '../packages/core/khata';
import {createCommandStore,createCommandsHandler} from '../supabase/functions/_shared/commands-handler';
import type {Customer,CreditAccount,CreditEntry} from '../packages/core/models';
import {commandReviewHeader} from '../packages/core/command-resolution';
// @ts-expect-error Deployment packaging is a standalone Node module.
import {edgeBundle} from '../scripts/edge-bundle.mjs';

let sql:CustomerReviewDatabase;
beforeAll(async()=>{sql=await createCustomerReviewDatabase();},30000);
beforeEach(async()=>{await sql.reset();});
afterAll(async()=>{await sql?.db.close();});
async function candidate(f:ReturnType<typeof fixture>,original:unknown,n=1,change?:(c:CustomerCommand)=>CustomerCommand){
 const {proposal}=await customerReviewFields(original,f.packet);if(!proposal)throw Error('No reviewed replacement available.');
 const command=change?change(proposal):proposal,ticket=id(810000),hash=await customerFingerprint(command),
  p=await sql.asRole(n,'authenticated','select public.prepare_customer_intent($1,$2,$3,$4,$5,$6,$7,$8) data',[command.id,ticket,command.type,command.customerId,command.outletId,command.type==='khata.settings'?command.accountId:null,hash,'ids'in command?JSON.stringify(command.ids):null]),fields=customerWriteFields(p,command,ticket);
 const records=fields.p_records as CloudRecord[];
 if(!change)expect(customerReviewEffectsMatch(f.packet,records)).toBe(true);
 return {id:ticket,token:fields.p_token as string,hash,records,command};
}
async function finish(p:unknown,outcome:'withdrawn'|'replaced',replacement:Awaited<ReturnType<typeof candidate>>|null=null,role:'anon'|'authenticated'|'service_role'='service_role'){
 const review=p as {id:string;token:string};return sql.asRole(role==='authenticated'?1:null,role,'select public.finish_customer_review($1,$2,$3,$4,$5,$6,$7) data',[review.id,review.token,outcome,replacement?.id??null,replacement?.token??null,replacement?.hash??null,replacement?JSON.stringify(replacement.records):null]);
}
async function state(){return (await sql.db.query("select json_build_object('customers',(select coalesce(json_agg(row_to_json(c) order by id),'[]') from public.customers c),'accounts',(select coalesce(json_agg(row_to_json(a) order by id),'[]') from public.credit_accounts a),'entries',(select coalesce(json_agg(row_to_json(e) order by id),'[]') from public.credit_entries e)) data")).rows;}
async function counts(){return (await sql.db.query<{events:number;receipts:number;resolutions:number}>("select (select count(*)::int from public.events) events,(select count(*)::int from private.shop_command_receipts) receipts,(select count(*)::int from private.customer_command_resolutions) resolutions")).rows[0];}
function gateway(n=1,hook?:(name:string,args:Record<string,unknown>,result:unknown)=>Promise<void>){
 const calls:{name:string;service:boolean;args:Record<string,unknown>}[]=[];let nonce=840000;
 const names:Record<string,string[]>={admit_customer_review:['p_outlet_id'],inspect_customer_outcome:['p_command_id','p_type','p_customer_id','p_outlet_id','p_hash'],prepare_customer_review:['p_id','p_replacement_id','p_command_id','p_type','p_customer_id','p_outlet_id','p_account_id','p_ids','p_hash','p_intent_json','p_source_hash','p_source_json','p_facts'],read_customer_review:['p_id','p_token'],prepare_customer_intent:['p_id','p_ticket_id','p_type','p_customer_id','p_outlet_id','p_account_id','p_hash','p_ids'],finish_customer_review:['p_id','p_token','p_outcome','p_replacement_ticket','p_replacement_token','p_replacement_hash','p_replacement_records']};
 const send:typeof fetch=async(url,options)=>{
  const name=new URL(String(url)).pathname.split('/').at(-1)!,args=JSON.parse(options?.body as string),headers=new Headers(options?.headers),service=headers.get('apikey')==='sb_secret_test_only';
  expect(names[name]).toBeDefined();expect(options?.redirect).toBe('error');expect(service).toBe(name==='finish_customer_review');expect(headers.get('Authorization')).toBe(service?null:'Bearer user.'+n+'.signature');calls.push({name,service,args});
  let result:unknown;
  try{result=await sql.asRole(service?null:n,service?'service_role':'authenticated','select public.'+name+'('+names[name].map((_,i)=>'$'+(i+1)).join(',')+') data',names[name].map(k=>['p_ids','p_facts','p_replacement_records'].includes(k)&&args[k]!==null?JSON.stringify(args[k]):args[k]));}
  catch(error){const code=(error as {code:string}).code;return new Response(JSON.stringify({code}),{status:code==='42501'?403:['PT409','23505'].includes(code)?409:code==='PT429'?429:400});}
  await hook?.(name,args,result);return new Response(JSON.stringify(result));
 };
 const store=createCustomerReviewStore('https://database.test','sb_publishable_test_only','sb_secret_test_only',send,()=>id(nonce++)),handler=createCustomerReviewHandler({store,origins:new Set(['https://shop.test'])});
 return {calls,send,request:(mode:'customer-read'|'customer-resolve',body:unknown)=>handler(new Request('https://function.test/commands?review='+mode,{method:'POST',headers:{Origin:'https://shop.test',Authorization:'Bearer user.'+n+'.signature','Content-Type':'application/json',[commandReviewHeader]:(body as {command:{outletId:string}}).command.outletId},body:JSON.stringify(body)}))};
}

it.each(modes)('withdraws the complete original %s with no substitute or business-row loss',async mode=>{
 const f=fixture(mode);await sql.seed(f);const before=await state(),p=await sql.prepare(f),receipt=parseCustomerResolutionReceipt(await finish(p,'withdrawn'),f.command);
 expect(receipt).toMatchObject({id:f.packet.id,type:'command.resolved',commandId:f.command.id,outcome:'withdrawn',replacement:null});expect(await state()).toEqual(before);expect(await counts()).toEqual({events:1,receipts:1,resolutions:1});
 expect(await sql.read(p)).toEqual({done:true,receipt});expect(await finish(p,'withdrawn')).toEqual(receipt);expect(await counts()).toEqual({events:1,receipts:1,resolutions:1});
 const audit=(await sql.db.query<{original:string;source:string}>("select before_data->>'originalCommandJson' original,before_data->>'sourceJson' source from public.events where id=$1",[f.command.id])).rows[0];expect(audit.original).toBe(JSON.stringify(f.command));expect(audit.source).toBe(f.packet.sourceJson);
});
it.each(modes)('atomically replaces %s with the exact original parent, companions, inputs and real receipt',async mode=>{
 const f=fixture(mode);await sql.seed(f);const p=await sql.prepare(f),next=await candidate(f,p),receipt=parseCustomerResolutionReceipt(await finish(p,'replaced',next),f.command);
 expect(receipt).toMatchObject({outcome:'replaced',replacement:{id:f.packet.replacementId,commandHash:next.hash,receipt:{id:f.packet.replacementId,type:f.command.type,customerId:f.command.customerId}}});
 if('ids'in f.command)expect(receipt.replacement?.receipt.accountId).toBe(f.command.ids.accountId);
 expect(await finish(p,'replaced',next)).toEqual(receipt);expect(await sql.read(p)).toEqual({done:true,receipt});expect((await counts()).resolutions).toBe(1);
 const stored=(await sql.db.query<{intent:string}>('select original_intent intent from private.customer_command_resolutions where command_id=$1',[f.command.id])).rows[0];expect(stored.intent).toBe(JSON.stringify(f.command));
});
it.each(['anon','authenticated'] as const)('denies %s callers even with a genuine review and exact replacement proof',async role=>{
 const f=fixture('update-terms');await sql.seed(f);const p=await sql.prepare(f),next=await candidate(f,p),before=await state();await expect(finish(p,'replaced',next,role)).rejects.toMatchObject({code:'42501'});expect(await state()).toEqual(before);expect((await counts()).resolutions).toBe(0);
});
it('retains an existing BDT khata after an outlet currency change and keeps SQL-only account notes',async()=>{
 const f=fixture('update-terms');await sql.seed(f);await sql.db.query("update public.outlets set currency='USD' where id=$1",[f.command.outletId]);await sql.db.query('update public.credit_accounts set notes=$1 where id=$2',[JSON.stringify(literal),f.account.id]);
 const p=await sql.prepare(f),next=await candidate(f,p),receipt=parseCustomerResolutionReceipt(await finish(p,'replaced',next),f.command);expect(receipt.replacement?.receipt.accountId).toBe(f.account.id);
 const after=(await sql.db.query<{id:string;currency:string;notes:string}>('select id,currency,notes from public.credit_accounts where id=$1',[f.account.id])).rows[0];expect(after).toEqual({id:f.account.id,currency:'BDT',notes:literal});
});
it('preserves future legacy parent clocks while recording opening entries at their actual admission time',async()=>{
 const f=fixture('update-terms');await sql.seed(f);const future=Date.now()+60000;await sql.db.query('update public.customers set created_at=$1,updated_at=$1 where id=$2',[future,f.command.customerId]);await sql.db.query('update public.credit_accounts set created_at=$1,updated_at=$1 where id=$2',[future,f.account.id]);
 const p=await sql.prepare(f),next=await candidate(f,p),r=parseCustomerResolutionReceipt(await finish(p,'replaced',next),f.command);expect(r.replacement?.receipt.customerUpdatedAt).toBe(future);expect(r.replacement?.receipt.accountUpdatedAt).toBe(future);
});
it('preserves repeated original ID text in literal notes when deriving the replacement hash',async()=>{
 const f=fixture('update-contact');if(!('credit'in f.command))throw Error();f.command.input.notes=literal+' '+f.command.id+' '+f.command.id;Object.assign(f.events[0].after as object,{notes:f.command.input.notes});f.packet.command=f.command;
 const source=JSON.parse(f.packet.sourceJson);source.events=customerReviewSourceAudits(f.command,f.events,f.setup.business.id);f.packet.sourceJson=JSON.stringify(source);
 await sql.seed(f);const p=await sql.prepare(f),next=await candidate(f,p);await finish(p,'replaced',next);expect((await sql.db.query<{notes:string}>('select notes from public.customers where id=$1',[f.command.customerId])).rows[0].notes).toBe(f.command.input.notes);
});
const forged=['name','nickname','address','notes','tags','phone','consent','archive','account identity','unit','limit','permission','reminder','opening amount','opening date','opening note','customer clock','account clock','entry clock','member','foreign field'] as const;
it.each(forged)('rejects a forged %s inside an otherwise genuine service replacement, with complete rollback',async kind=>{
 const f=fixture('create-opening');await sql.seed(f);const p=await sql.prepare(f),next=await candidate(f,p),before=await state(),customer=next.records.find(r=>r.table==='customers')!.values,account=next.records.find(r=>r.table==='credit_accounts')!.values,entry=next.records.find(r=>r.table==='credit_entries')!.values,event=next.records.find(r=>r.table==='events')!.values;
 if(['name','nickname','address','notes'].includes(kind))customer[kind]=JSON.stringify('Forged');else if(kind==='tags')customer.tags=JSON.stringify(['Forged']);else if(kind==='phone')customer.phone='+8801712345489';else if(kind==='consent')customer.consent=JSON.stringify({savedAt:0,source:'manual'});else if(kind==='archive')customer.archived_at=1;else if(kind==='account identity')account.id=id(800000);else if(kind==='unit')account.currency='USD';else if(kind==='limit')account.credit_limit=999;else if(kind==='permission')account.allowed=true;else if(kind==='reminder')account.reminder=JSON.stringify({...terms.reminder,dayOfMonth:31});else if(kind==='opening amount')entry.amount=999;else if(kind==='opening date')entry.occurred_at=1;else if(kind==='opening note')entry.note=JSON.stringify('Changed');else if(kind==='customer clock')customer.created_at=1;else if(kind==='account clock')account.updated_at=1;else if(kind==='entry clock')entry.created_at=1;else if(kind==='member')event.actor_id=id(700002);else event.role='owner';
 await expect(finish(p,'replaced',next)).rejects.toMatchObject({code:'22023'});expect(await state()).toEqual(before);expect(await counts()).toEqual({events:0,receipts:0,resolutions:0});
});
it('rejects another normalized intent with the right primary ID but changed customer inputs',async()=>{
 const f=fixture('update-contact');await sql.seed(f);const p=await sql.prepare(f),next=await candidate(f,p,1,c=>'credit'in c?{...c,input:{...c.input,notes:'Another intent'}}:c);await expect(finish(p,'replaced',next)).rejects.toMatchObject({code:'22023'});expect((await counts()).resolutions).toBe(0);
});
it.each(['profile','account','balance','unit','expiry','admission expiry','revocation'])('refuses a %s change between review, ordinary admission and final commit',async kind=>{
 const f=fixture('update-terms');await sql.seed(f);const p=await sql.prepare(f),next=await candidate(f,p),before=await counts();
 if(kind==='profile')await sql.db.query('update public.customers set nickname=$1 where id=$2',[JSON.stringify('Later'),f.command.customerId]);else if(kind==='account')await sql.db.query('update public.credit_accounts set credit_limit=credit_limit+1 where id=$1',[f.account.id]);else if(kind==='balance')await sql.addCharge(f);else if(kind==='unit')await sql.db.query("update public.outlets set currency='USD' where id=$1",[f.command.outletId]);else if(kind==='expiry')await sql.db.query('update private.customer_review_tickets set expires_at=0');else if(kind==='admission expiry')await sql.db.query('update private.customer_write_tickets set expires_at=0');else await sql.db.query('update public.members set active=false where id=$1',[f.setup.owner.id]);
 const afterChange=await state();await expect(finish(p,'replaced',next)).rejects.toMatchObject({code:kind==='revocation'?'42501':'PT409'});expect(await state()).toEqual(afterChange);expect((await counts()).resolutions).toBe(before.resolutions);
});
it('rolls back the ordinary write, financial companions and receipts if its final resolution audit fails',async()=>{
 const f=fixture('create-opening');await sql.seed(f);const p=await sql.prepare(f),next=await candidate(f,p),before=await state();
 await sql.db.exec("create function private.fail_customer_review_audit_test() returns trigger language plpgsql as $$begin if new.command='sync.resolve' then raise invalid_parameter_value using message='Synthetic audit failure';end if;return new;end$$;create trigger fail_customer_review_audit_test before insert on public.events for each row execute function private.fail_customer_review_audit_test()");
 try{await expect(finish(p,'replaced',next)).rejects.toMatchObject({code:'22023'});expect(await state()).toEqual(before);expect(await counts()).toEqual({events:0,receipts:0,resolutions:0});}
 finally{await sql.db.exec('drop trigger fail_customer_review_audit_test on public.events;drop function private.fail_customer_review_audit_test()');}
 expect(parseCustomerResolutionReceipt(await finish(p,'replaced',next),f.command).outcome).toBe('replaced');
});
it('recovers an accepted resolution before expired proofs and changed current data',async()=>{
 const f=fixture('update-contact');await sql.seed(f);const p=await sql.prepare(f),next=await candidate(f,p),receipt=await finish(p,'replaced',next);await sql.db.exec('update private.customer_review_tickets set expires_at=0');await sql.db.query('update public.customers set nickname=$1 where id=$2',[JSON.stringify('Later value'),f.command.customerId]);
 expect(await finish(p,'replaced',next)).toEqual(receipt);expect(await sql.read(p)).toEqual({done:true,receipt});expect((await counts()).resolutions).toBe(1);
});
it('returns an ordinary original receipt when it wins the race against withdrawal',async()=>{
 const f=fixture('update-terms');await sql.seed(f);const p=await sql.prepare(f),c=f.command,ticket=id(820000),prepared=await sql.asRole(1,'authenticated','select public.prepare_customer_intent($1,$2,$3,$4,$5,$6,$7,$8) data',[c.id,ticket,c.type,c.customerId,c.outletId,null,await customerFingerprint(c),'ids'in c?JSON.stringify(c.ids):null]),fields=customerWriteFields(prepared,c,ticket);
 const receipt=await sql.asRole(null,'service_role','select public.finish_customer_write($1,$2,$3) data',[ticket,fields.p_token,JSON.stringify(fields.p_records)]);await sql.db.exec('update private.customer_review_tickets set expires_at=0');expect(await finish(p,'withdrawn')).toEqual(receipt);expect((await counts()).resolutions).toBe(0);
});
it('blocks a withdrawn new account ID while preserving its existing customer and permitting a fresh account',async()=>{
 const f=fixture('khata-create');await sql.seed(f);const p=await sql.prepare(f);await finish(p,'withdrawn');if(!('ids'in f.command))throw Error();
 await expect(sql.insert([encodeCommandRecord('creditAccounts',{...f.account,id:f.command.ids.accountId},f.setup.business.id)])).rejects.toMatchObject({code:'PT409'});
 await sql.insert([encodeCommandRecord('creditAccounts',{...f.account,id:id(800000)},f.setup.business.id)]);expect((await sql.db.query<{n:number}>('select count(*)::int n from public.credit_accounts')).rows[0].n).toBe(1);expect((await sql.db.query<{n:number}>('select count(*)::int n from public.customers')).rows[0].n).toBe(1);
});
it('does not reserve an existing parent or unused planned slot when withdrawing a contact-only edit',async()=>{
 const f=fixture('update-contact');await sql.seed(f);const p=await sql.prepare(f);await finish(p,'withdrawn');if(!('ids'in f.command))throw Error();
 const reserved=(await sql.db.query<{ids:string[]}>('select to_json(reserved_ids) ids from private.customer_command_resolutions')).rows[0].ids;expect(reserved).toEqual([f.command.id]);
 await sql.addCharge(f);await sql.insert([encodeCommandRecord('events',{id:f.command.ids.accountEventId,outletId:f.command.outletId,customerId:f.command.customerId,actor:{type:'member',id:f.setup.owner.id},command:'manual.audit',before:null,after:null,at:1},f.setup.business.id)]);expect((await counts()).events).toBe(3);
});
it('keeps replaced parents usable for future edits and payments while protecting original ledger and audit IDs',async()=>{
 const f=fixture('create-opening');await sql.seed(f);const p=await sql.prepare(f),next=await candidate(f,p);await finish(p,'replaced',next);if(!('ids'in f.command))throw Error();
 const customer=next.records.find(r=>r.table==='customers')!,account=next.records.find(r=>r.table==='credit_accounts')!;
 await sql.db.query('update public.customers set nickname=$1 where id=$2',[JSON.stringify('Fresh'),f.command.customerId]);
 const copy={...account,values:{...account.values,credit_limit:50000}};const cols=Object.keys(copy.values);await sql.db.query('insert into public.credit_accounts('+cols.join(',')+') values('+cols.map((_,i)=>'$'+(i+1)).join(',')+') on conflict(id) do update set credit_limit=excluded.credit_limit',Object.values(copy.values));
 expect((await sql.db.query<{id:string}>('select id from public.customers where id=$1',[customer.values.id])).rows[0].id).toBe(f.command.customerId);
 const currentCustomer=decodeCommandRecord('customers',(await sql.db.query<Record<string,unknown>>('select * from public.customers where id=$1',[f.command.customerId])).rows[0]) as unknown as Customer,
  currentAccount=decodeCommandRecord('creditAccounts',(await sql.db.query<Record<string,unknown>>('select * from public.credit_accounts where id=$1',[f.command.ids.accountId])).rows[0]) as unknown as CreditAccount,
  entries=(await sql.db.query<Record<string,unknown>>('select * from public.credit_entries where account_id=$1',[currentAccount.id])).rows.map(row=>decodeCommandRecord('creditEntries',row) as unknown as CreditEntry),
  payment=recordCreditPaymentCommand(1000,'cash',undefined,{setup:f.setup,customer:currentCustomer,account:currentAccount,entries},['Cash'],'Collected after review',Date.now(),kind=>id(kind==='event'?830001:830000));
 await sql.insert([encodeCommandRecord('events',payment.event,f.setup.business.id),encodeCommandRecord('creditEntries',payment.entry,f.setup.business.id)]);
 expect((await sql.db.query<{balance:number}>("select sum(case when type='payment' then -amount else amount end)::int balance from public.credit_entries where account_id=$1",[currentAccount.id])).rows[0].balance).toBe(11345);
 await expect(sql.insert([next.records.find(r=>r.table==='credit_entries')!])).rejects.toMatchObject({code:'PT409'});
});
it('grants only the service role execution of completion and leaves both private tables inaccessible',async()=>{
 for(const role of ['anon','authenticated','service_role']){
  const rows=(await sql.db.query<{public:boolean;private:boolean}>("select has_function_privilege($1,'public.finish_customer_review(public.ulid,text,text,public.ulid,text,text,jsonb)','execute') public,has_function_privilege($1,'private.finish_customer_review(public.ulid,text,text,public.ulid,text,text,jsonb)','execute') private",[role])).rows[0];expect(rows).toEqual({public:role==='service_role',private:role==='service_role'});
 }
});
it('returns a genuine customer resolution through ordinary HTTP delivery before any obsolete currency assertion',async()=>{
 const f=fixture('create-opening');await sql.seed(f);const p=await sql.prepare(f),next=await candidate(f,p),receipt=await finish(p,'replaced',next);await sql.db.query("update public.outlets set currency='USD' where id=$1",[f.command.outletId]);let serviceCalls=0;
 const store=createCommandStore('https://database.test','sb_publishable_test_only',async(url,options)=>{
  const name=new URL(String(url)).pathname.split('/').at(-1),body=JSON.parse(options?.body as string),headers=new Headers(options?.headers),service=headers.get('apikey')==='sb_secret_test_only';
  const names:Record<string,string[]>={prepare_customer_intent:['p_id','p_ticket_id','p_type','p_customer_id','p_outlet_id','p_account_id','p_hash','p_ids'],finish_customer_write:['p_ticket_id','p_token','p_records']};if(!name||!names[name])throw Error('Unexpected command RPC');if(service)serviceCalls++;
  try{return new Response(JSON.stringify(await sql.asRole(service?null:1,service?'service_role':'authenticated','select public.'+name+'('+names[name].map((_,i)=>'$'+(i+1)).join(',')+') data',names[name].map(k=>['p_ids','p_records'].includes(k)&&body[k]!==null?JSON.stringify(body[k]):body[k]))));}
  catch(error){const code=(error as {code:string}).code;return new Response(JSON.stringify({code}),{status:code==='42501'?403:code==='PT409'?409:400});}
 },{serviceKey:'sb_secret_test_only'});
 const handler=createCommandsHandler({origins:new Set(['https://shop.test']),store}),response=await handler(new Request('https://function.test/commands',{method:'POST',headers:{Origin:'https://shop.test',Authorization:'Bearer user.1.signature','Content-Type':'application/json'},body:JSON.stringify(f.command)}));
 expect(response.status).toBe(200);expect(await response.json()).toEqual(receipt);expect(serviceCalls).toBe(0);expect((await counts()).resolutions).toBe(1);
});
it.each(modes)('runs the real %s HTTP review, replay and atomic completion through PostgreSQL roles',async mode=>{
 const f=fixture(mode);await sql.seed(f);const http=gateway(),prepared=await http.request('customer-read',f.packet);expect(prepared.status).toBe(200);const body=await prepared.json();expect(body.done).toBe(false);expect(body.review.proposal.enabled).toBe(true);
 const response=await http.request('customer-resolve',{...f.packet,token:body.review.token,outcome:'replaced'});expect(response.status).toBe(200);expect(parseCustomerResolutionReceipt(await response.json(),f.command).outcome).toBe('replaced');
 expect(http.calls.filter(c=>c.service).map(c=>c.name)).toEqual(['finish_customer_review']);expect(http.calls.some(c=>c.name==='finish_customer_write')).toBe(false);
 const normal=http.calls.find(c=>c.name==='prepare_customer_intent')!;expect(normal.args.p_id).toBe(f.packet.replacementId);if('ids'in f.command)expect(normal.args.p_ids).toEqual(f.command.ids);
});
it('withdraws over HTTP with no ordinary mutation admission and no replacement fields',async()=>{
 const f=fixture('khata-create');await sql.seed(f);const http=gateway(),prepared=await(await http.request('customer-read',f.packet)).json(),before=await state(),response=await http.request('customer-resolve',{...f.packet,token:prepared.review.token,outcome:'withdrawn'});
 expect(response.status).toBe(200);expect(parseCustomerResolutionReceipt(await response.json(),f.command).outcome).toBe('withdrawn');expect(await state()).toEqual(before);expect(http.calls.some(c=>c.name==='prepare_customer_intent')).toBe(false);const args=http.calls.find(c=>c.name==='finish_customer_review')!.args;expect(args.p_replacement_records).toBeNull();expect(args.p_replacement_hash).toBeNull();
});
it('recovers a lost HTTP completion reply before the old token and without another admission',async()=>{
 const f=fixture('create-opening');await sql.seed(f);let lost=false;const http=gateway(1,async name=>{if(name==='finish_customer_review'&&!lost){lost=true;throw Error('Synthetic reply lost after atomic commit');}}),prepared=await(await http.request('customer-read',f.packet)).json(),decision={...f.packet,token:prepared.review.token,outcome:'replaced'};
 expect((await http.request('customer-resolve',decision)).status).toBe(503);expect((await counts()).resolutions).toBe(1);const calls=http.calls.length,response=await http.request('customer-resolve',{...decision,token:'w'.repeat(43)});expect(response.status).toBe(200);expect(parseCustomerResolutionReceipt(await response.json(),f.command).outcome).toBe('replaced');expect(http.calls.slice(calls).map(c=>c.name)).toEqual(['admit_customer_review','inspect_customer_outcome']);expect((await counts()).resolutions).toBe(1);
});
it('does not renew consent when live data changes between HTTP admission and service completion',async()=>{
 const f=fixture('update-terms');await sql.seed(f);const http=gateway(1,async name=>{if(name==='prepare_customer_intent')await sql.db.query('update public.customers set nickname=$1 where id=$2',[JSON.stringify('Later live name'),f.command.customerId]);}),prepared=await(await http.request('customer-read',f.packet)).json(),response=await http.request('customer-resolve',{...f.packet,token:prepared.review.token,outcome:'replaced'});
 expect(response.status).toBe(409);expect((await counts()).resolutions).toBe(0);expect(http.calls.filter(c=>c.name==='prepare_customer_review')).toHaveLength(1);expect((await sql.db.query<{nickname:string}>('select nickname from public.customers where id=$1',[f.command.customerId])).rows[0].nickname).toBe('Later live name');
});
it('cannot force a blocked competing account through HTTP and keeps the original source recoverable',async()=>{
 const f=fixture('khata-create');await sql.seed(f);await sql.insert([encodeCommandRecord('creditAccounts',{...f.account,id:id(850000)},f.setup.business.id)]);const http=gateway(),prepared=await(await http.request('customer-read',f.packet)).json();expect(prepared.review.proposal.enabled).toBe(false);
 expect((await http.request('customer-resolve',{...f.packet,token:prepared.review.token,outcome:'replaced'})).status).toBe(409);expect(http.calls.some(c=>c.service)).toBe(false);expect((await counts()).resolutions).toBe(0);expect((await http.request('customer-resolve',{...f.packet,token:prepared.review.token,outcome:'withdrawn'})).status).toBe(200);expect((await sql.db.query<{id:string}>('select id from public.credit_accounts')).rows).toEqual([{id:id(850000)}]);
});
it('replaces a current maximum imported note with a complete audited before-image and the unchanged command limit',async()=>{
 const f=fixture('update-contact'),note='\\'.repeat(1_000_000);await sql.seed(f);await sql.db.query('update public.customers set notes=$1 where id=$2',[JSON.stringify(note),f.command.customerId]);
 const p=await sql.prepare(f),next=await candidate(f,p);expect(new TextEncoder().encode(JSON.stringify(f.command)).length).toBeLessThan(32000);expect(new TextEncoder().encode(JSON.stringify(next.records)).length).toBeGreaterThan(512000);
 const receipt=parseCustomerResolutionReceipt(await finish(p,'replaced',next),f.command);expect(receipt.outcome).toBe('replaced');
 const audit=(await sql.db.query<{before:Record<string,unknown>;after:Record<string,unknown>}>('select before_data before,after_data after from public.events where id=$1',[f.packet.replacementId])).rows[0];expect(audit.before.notes).toBe(note);expect(audit.after.notes).toBe(literal);expect((await sql.db.query<{notes:string}>('select notes from public.customers where id=$1',[f.command.customerId])).rows[0].notes).toBe(literal);
});
it('boots the exact deployment bundle and routes a real customer review through atomic PostgreSQL completion',async()=>{
 const f=fixture('create-opening');await sql.seed(f);const http=gateway(),bundle=await edgeBundle('commands');expect(bundle.sourceHashes).toHaveProperty('packages/core/customer-review-effects.ts');expect(bundle.sourceHashes).toHaveProperty('supabase/functions/_shared/customer-review.ts');
 const runtime=globalThis as unknown as {Deno?:unknown},oldDeno=runtime.Deno,oldFetch=globalThis.fetch;let handler:((request:Request)=>Promise<Response>)|undefined;
 try{
  runtime.Deno={env:{get:(name:string)=>({SUPABASE_URL:'https://database.test',MISE_PUBLISHABLE_API_KEY:'sb_publishable_test_only',MISE_SERVICE_API_KEY:'sb_secret_test_only',MISE_ALLOWED_ORIGINS:'https://shop.test'} as Record<string,string>)[name]},serve:(value:typeof handler)=>{handler=value;}};globalThis.fetch=http.send;
  await import('data:text/javascript;base64,'+Buffer.from(bundle.files[0].content).toString('base64'));expect(handler).toBeTypeOf('function');
  const request=(mode:string,body:unknown)=>new Request('https://function.test/commands?review='+mode,{method:'POST',headers:{Origin:'https://shop.test',Authorization:'Bearer user.1.signature','Content-Type':'application/json',[commandReviewHeader]:f.command.outletId},body:JSON.stringify(body)});
  const prepared=await handler!(request('customer-read',f.packet));expect(prepared.status).toBe(200);const body=await prepared.json(),response=await handler!(request('customer-resolve',{...f.packet,token:body.review.token,outcome:'replaced'}));expect(response.status).toBe(200);expect(parseCustomerResolutionReceipt(await response.json(),f.command).outcome).toBe('replaced');expect((await counts()).resolutions).toBe(1);
 }finally{runtime.Deno=oldDeno;globalThis.fetch=oldFetch;}
},30000);
