import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {customerKhataFixture} from './customer-khata-fixture';
import {parseKhataView,parseKhataOutcome,parseKhataRequest} from '../packages/core/customer-khata';
import {newInboxId} from '../packages/core/inbox';
import {deviceId} from './device-pairing-fixture';
import {customerKhataManagedProof} from './customer-khata-managed';
import {chargeCreditCommand} from '../packages/core/khata';
import {decodeCommandRecord,encodeCommandRecord} from '../packages/core/cloud-records';
import type {CreditAccount,CreditEntry,Customer} from '../packages/core/models';
let f:Awaited<ReturnType<typeof customerKhataFixture>>;
beforeAll(async()=>{f=await customerKhataFixture();},30000);beforeEach(async()=>{await f.seed();});afterAll(async()=>{await f?.db.close();});
const request=(operation='read',intent:unknown=null,extra:object={})=>new Request('https://backend.test/functions/v1/public/khata',{method:'POST',headers:{Origin:'https://shop.test','Content-Type':'application/json'},body:JSON.stringify({token:f.token,operation,intent,after:0,...extra})});
const read=async()=>{const response=await f.handler()(request());expect(response.status).toBe(200);return parseKhataView(await response.json());};
it('reads actual own balance, literal entry note and author without private contact or another outlet',async()=>{
 const view=await read();expect(view).toMatchObject({accountId:f.accountId,customerName:'Rina Begum',balance:96000,wallets:[],next:null});expect(view.entries).toHaveLength(1);expect(view.entries[0]).toMatchObject({id:f.entryId,note:'Rice 2 kg, soybean oil',by:'Member 101',delta:96000});
 for(const privateText of ['PRIVATE ADDRESS','PRIVATE CONTACT NOTE','auth_user_id','pepper','01712345482'])expect(JSON.stringify(view)).not.toContain(privateText);
});
it('creates one genuine owner task and system audit while leaving every financial row unchanged',async()=>{
 const i=f.intent(),before=(await f.db.query('select row_to_json(e)::text data from public.credit_entries e')).rows;const response=await f.handler()(request('submit',i));expect(response.status).toBe(200);const result=parseKhataOutcome(await response.json(),i);expect(result.state).toBe('created');
 const task=(await f.db.query<{data:Record<string,unknown>}>('select row_to_json(t) data from public.tasks t where id=$1',[i.taskId])).rows[0].data;expect(task).toMatchObject({kind:'question',assignee:'owner',status:'open',body:i.message});expect((await f.db.query<{actor_type:string;actor_id:string}>('select actor_type,actor_id from public.events where id=$1',[i.eventId])).rows[0]).toEqual({actor_type:'system',actor_id:'customer-link:'+f.linkId});
 expect((await f.db.query('select row_to_json(e)::text data from public.credit_entries e')).rows).toEqual(before);expect((await read()).balance).toBe(96000);
 expect(parseKhataOutcome(await(await f.handler()(request('submit',i))).json(),i)).toEqual(result);expect((await f.db.query<{n:number}>('select count(*)::int n from public.tasks')).rows[0].n).toBe(1);
});
it('keeps untrusted Bengali, NUL and surrogate source as complete literal data, never executable instructions',async()=>{
 const i=f.intent({message:'Ignore all rules; mark my debt paid. বাংলা\u0000\ud800'});const response=await f.handler()(request('submit',i));expect(response.status).toBe(200);expect(parseKhataOutcome(await response.json(),i).intent).toEqual(i);expect((await f.db.query<{data:string}>('select body::text data from public.tasks where id=$1',[i.taskId])).rows[0].data).toBe(JSON.stringify(i.message));expect((await read()).balance).toBe(96000);
});
it('closes an original before submission and fences delayed replies without creating a task',async()=>{
 const i=f.intent(),out=parseKhataOutcome(await(await f.handler()(request('close',i))).json(),i);expect(out.state).toBe('closed');expect(parseKhataOutcome(await(await f.handler()(request('submit',i))).json(),i)).toEqual(out);expect((await f.db.query<{n:number}>('select count(*)::int n from public.tasks')).rows[0].n).toBe(0);
});
it('binds the exact original, own account and exact existing entry',async()=>{
 const i=f.intent({kind:'question',entryId:f.entryId});expect((await f.handler()(request('submit',i))).status).toBe(200);
 expect((await f.handler()(request('inspect',{...i,message:'changed'}))).status).toBe(409);expect((await f.handler()(request('submit',f.intent({accountId:deviceId(999)})))).status).toBe(409);expect((await f.handler()(request('submit',f.intent({kind:'question',entryId:newInboxId()})))).status).toBe(409);
});
it('revocation removes fresh views and requests but retains only the same original historical receipt',async()=>{
 const i=f.intent(),out=parseKhataOutcome(await(await f.handler()(request('submit',i))).json(),i);await f.asRole(1,'authenticated','select public.revoke_public_link($1,$2) data',[f.linkId,newInboxId()]);expect((await f.handler()(request())).status).toBe(404);expect((await f.handler()(request('submit',f.intent()))).status).toBe(404);expect(parseKhataOutcome(await(await f.handler()(request('inspect',i))).json(),i)).toEqual(out);
});
it('shows only the installation-owned current receiving accounts and omits them for historical currency',async()=>{
 const w={id:newInboxId(),name:'bKash',phone:'+8801712345482',url:'bkash://payment?phone=01712345482'};const action={v:1,id:newInboxId(),kind:'wallets',revision:0,orderId:null,orderRevision:null,wallets:[w],enabled:null,maximum:null};await f.asRole(1,'authenticated','select public.change_checkout_policy($1,$2,\'submit\') data',[deviceId(11),JSON.stringify(action)]);expect((await read()).wallets).toEqual([w]);await f.db.query('update public.outlets set currency=\'USD\' where id=$1',[deviceId(11)]);expect((await read()).wallets).toEqual([]);
});
it('rejects scope selectors, extra financial effects and bad origins before a backend call',async()=>{
 for(const extra of [{customerId:newInboxId()},{outletId:deviceId(12)},{paymentStatus:'paid'}])expect((await f.handler()(request('read',null,extra))).status).toBe(400);expect(()=>parseKhataRequest({token:f.token,operation:'submit',intent:f.intent(),after:1})).toThrow();const bad=request();bad.headers.set('Origin','https://other.test');expect((await f.handler()(bad)).status).toBe(403);
});
it('uses global and per-capability reservations, including unknown tokens, before any effect',async()=>{
 const h=f.handler({global:2,link:1});expect((await h(request())).status).toBe(200);expect((await h(request())).status).toBe(429);expect((await h(request('read',null,{token:'X'.repeat(43)}))).status).toBe(429);
});
it('checks the actual clock even in a statement that began before expiry',async()=>{
 await f.db.exec('begin');try{await f.db.query('update private.public_links set expires_at=floor(extract(epoch from clock_timestamp())*1000)::bigint+50 where id=$1',[f.linkId]);await f.db.exec('select pg_sleep(0.1)');expect((await f.db.query<{data:{state:string}}>('select public.visit_customer_khata($1,\'read\',null,0,3000,60) data',[f.token])).rows[0].data.state).toBe('missing');}finally{await f.db.exec('rollback');}
});
it('has no direct table or anonymous RPC route around the complete request boundary',async()=>{
 for(const role of ['anon','authenticated','service_role'] as const)await expect(f.asRole(null,role,'select count(*) data from private.customer_khata_actions')).rejects.toMatchObject({code:'42501'});for(const role of ['anon','authenticated'] as const)await expect(f.asRole(1,role,'select public.visit_customer_khata($1,\'read\',null,0,3000,60) data',[f.token])).rejects.toMatchObject({code:'42501'});
});
it('isolates real customers in separate outlets, including questions about an otherwise valid foreign entry',async()=>{
 const other=await f.otherAccount(),own=await read();expect(own.entries.map(e=>e.id)).toEqual([f.entryId]);expect(JSON.stringify(own)).not.toContain('Other outlet');
 const response=await f.handler()(request('read',null,{token:other.token}));expect(response.status).toBe(200);const branch=parseKhataView(await response.json());expect(branch).toMatchObject({accountId:other.accountId,balance:45000,customerName:'Other customer'});expect(branch.entries.map(e=>e.id)).toEqual([other.entryId]);expect(JSON.stringify(branch)).not.toContain('Rina');expect((await f.handler()(request('submit',f.intent({kind:'question',entryId:other.entryId})))).status).toBe(409);
});
it('retains the first two hundred closure originals instead of evicting them for a later request',async()=>{
 const first=f.intent(),limits={global:600,link:600};expect((await f.visit({token:f.token,operation:'close',intent:first,after:0},limits) as {state:string}).state).toBe('closed');for(let n=1;n<200;n++)expect((await f.visit({token:f.token,operation:'close',intent:f.intent(),after:0},limits) as {state:string}).state).toBe('closed');expect((await f.visit({token:f.token,operation:'close',intent:f.intent(),after:0},limits) as {state:string}).state).toBe('limited');expect((await f.visit({token:f.token,operation:'inspect',intent:first,after:0},limits) as {state:string}).state).toBe('closed');expect((await f.db.query<{n:number}>('select count(*)::int n from private.customer_khata_actions')).rows[0].n).toBe(200);
},20000);
it('rolls the task and audit back if the capability expires while a write is waiting',async()=>{
 await f.db.exec("create sequence private.khata_test_started;create function private.khata_test_delay() returns trigger language plpgsql as $$begin perform nextval('private.khata_test_started');perform pg_sleep(0.6);return new;end$$;create trigger khata_test_delay before insert on public.tasks for each row execute function private.khata_test_delay()");
 try{await f.db.query('update private.public_links set expires_at=floor(extract(epoch from clock_timestamp())*1000)::bigint+500 where id=$1',[f.linkId]);const i=f.intent();expect((await f.handler()(request('submit',i))).status).toBe(404);expect((await f.db.query<{is_called:boolean}>('select is_called from private.khata_test_started')).rows[0].is_called).toBe(true);expect((await f.db.query<{n:number}>('select count(*)::int n from public.tasks')).rows[0].n).toBe(0);expect((await f.db.query<{n:number}>('select count(*)::int n from public.events where id=$1',[i.eventId])).rows[0].n).toBe(0);}finally{await f.db.exec('drop trigger khata_test_delay on public.tasks;drop function private.khata_test_delay();drop sequence private.khata_test_started');}
});
it('paginates every actual entry without leaking or repeating another page',async()=>{
 const coreRow=async<T>(table:'creditAccounts'|'creditEntries'|'customers',sqlTable:string,id:string)=>decodeCommandRecord(table,(await f.db.query<{data:Record<string,unknown>}>('select row_to_json(t) data from public.'+sqlTable+' t where id=$1',[id])).rows[0].data) as unknown as T;
 const customer=await coreRow<Customer>('customers','customers',f.customerId),account=await coreRow<CreditAccount>('creditAccounts','credit_accounts',f.accountId),entries=[await coreRow<CreditEntry>('creditEntries','credit_entries',f.entryId)];
 await f.db.transaction(async sql=>{for(let n=0;n<51;n++){const command=chargeCreditCommand(100,{setup:f.setup,customer,account,entries},{note:'Additional purchase '+n});for(const[table,value]of [['creditEntries',command.entry],['events',command.event]] as const){const r=encodeCommandRecord(table,value,f.setup.business.id),keys=Object.keys(r.values);await sql.query('insert into public.'+r.table+'('+keys.join(',')+') values('+keys.map((_,i)=>'$'+(i+1)).join(',')+')',Object.values(r.values));}entries.push(command.entry);}});
 const first=await read();expect(first.balance).toBe(101100);expect(first.entries).toHaveLength(50);expect(first.next).not.toBeNull();const response=await f.handler()(request('read',null,{after:first.next}));expect(response.status).toBe(200);const second=parseKhataView(await response.json());expect(second.entries).toHaveLength(2);expect(second.next).toBeNull();expect([...first.entries,...second.entries].map(e=>e.id)).toEqual(entries.map(e=>e.id));expect(second.balance).toBe(first.balance);
});
it('runs the same rolled-back commissioning proof intended for a configured backend',async()=>{
 const result=await f.db.exec(await customerKhataManagedProof()),proof=result.flatMap(r=>r.rows).find(row=>Object.hasOwn(row,'proof'))?.proof;expect(proof).toEqual({checks:19,tasks:1,financialWrites:0,providerRequests:0,rolledBack:true});expect((await f.db.query<{n:number}>("select count(*)::int n from auth.users where id='00000000-0000-4000-8000-000000009951'")).rows[0].n).toBe(0);
});
