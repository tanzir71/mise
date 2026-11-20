import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {setupCommand} from '../packages/core/setup';
import {emptyBackupTables} from '../packages/core/backup-tables';
import {createBackup} from '../packages/core/backup';
import {cloudRecordMaps,decodeCommandRecord,encodeCommandRecord,prepareCloudMigration,type CloudRecord} from '../packages/core/cloud-records';
import {saveCustomerCommand} from '../packages/core/customers';
import {saveCreditTermsCommand,defaultCreditTerms,openingBalanceCommand,creditBalance} from '../packages/core/khata';
import {moneyWritePlan,parseMoneyCommand,parseMoneyCommandReceipt,type MoneyCommand} from '../packages/core/money-commands';
import {parseShopCommand,parseShopCommandReceipt} from '../packages/core/shop-commands';
import {parseMoneyResolutionReceipt,reviewedMoneyProposal,type FinancialMoneyCommand} from '../packages/core/money-review';
import {createMoneyReviewHandler,createMoneyReviewStore} from '../supabase/functions/_shared/money-review';
import {commandReviewHeader} from '../packages/core/command-resolution';
import type {MoneyReviewRequest} from '../packages/core/money-review';
import {moneyFingerprint,moneyWriteFields} from '../supabase/functions/_shared/money-write';
import {createCommandStore,createCommandsHandler} from '../supabase/functions/_shared/commands-handler';
import {newInboxId} from '../packages/core/inbox';
import {moneyHostedProofSql} from './money-hosted-fixture';
import {savedCurrencyHeader} from '../packages/core/order-currency';
import type {CreditAccount,CreditEntry,Customer,Sale,SetupCommand} from '../packages/core/models';
const uid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,origin='https://shop.test',literal='হিসাব\0'+String.fromCharCode(0xd800);
let db:PGlite,source:SetupCommand,branch:SetupCommand,foreign:SetupCommand,customer:Customer,account:CreditAccount,otherAccount:CreditAccount;
const actors:{n:number;id:string;role:string;business:string;outlet:string}[]=[],initial:CloudRecord[]=[];let lastError='';
async function insert(records:CloudRecord[]){await db.transaction(async sql=>{for(const r of records){const columns=Object.keys(r.values);await sql.query(`insert into public.${r.table}(${columns.join(',')}) values(${columns.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(r.values));}});}
async function asRole<T>(n:number|null,role:'authenticated'|'service_role'|'anon',query:string,args:unknown[]=[]){return db.transaction(async sql=>{await sql.exec('set local role '+role);await sql.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role,...(n?{sub:uid(n)}:{}),user_metadata:{role:'owner'}})]);return (await sql.query<T>(query,args)).rows;});}
function store(beforeFinish?:(args:Record<string,unknown>)=>Promise<void>){return createCommandStore('https://database.test','sb_publishable_test_only',async(url,options)=>{
 const name=new URL(String(url)).pathname.split('/').at(-1)!,args=JSON.parse(options?.body as string),headers=new Headers(options?.headers),service=headers.get('apikey')==='sb_secret_test_only';
 const parameters:Record<string,string[]>={prepare_money_write:['p_id','p_ticket_id','p_type','p_outlet_id','p_plan','p_hash','p_occurred_at'],finish_money_write:['p_ticket_id','p_token','p_occurred_at','p_records']};
 expect(parameters[name]).toBeDefined();if(service){expect(headers.has('Authorization')).toBe(false);await beforeFinish?.(args);}else expect(headers.get('apikey')).toBe('sb_publishable_test_only');
 try{const result=await asRole<{data:unknown}>(service?null:Number(headers.get('Authorization')!.split('.')[1]),service?'service_role':'authenticated',`select public.${name}(${parameters[name].map((_,i)=>'$'+(i+1)).join(',')}) as data`,parameters[name].map(k=>['p_records','p_plan'].includes(k)?JSON.stringify(args[k]):args[k]));return new Response(JSON.stringify(result[0].data));}
 catch(error){const {code,message,detail:details}=error as {code:string;message:string;detail?:string};lastError=code+': '+message;return new Response(JSON.stringify({code,details}),{status:code==='42501'?403:['PT409','23505'].includes(code)?409:code==='22023'?400:500});}
 },{serviceKey:'sb_secret_test_only'});}
async function http(n:number,c:unknown,beforeFinish?:(args:Record<string,unknown>)=>Promise<void>,currency:string|null='BDT'){return createCommandsHandler({origins:new Set([origin]),store:store(beforeFinish)})(new Request('https://api.test/commands',{method:'POST',headers:{Origin:origin,Authorization:`Bearer user.${n}.signature`,'Content-Type':'application/json',...(currency!==null&&(c as MoneyCommand).type!=='khata.communication'?{[savedCurrencyHeader]:currency}:{})},body:JSON.stringify(c)}));}
function base(){return {id:newInboxId(),outletId:source.snapshot.outlet.id,occurredAt:Date.now()-1000};}
function cash():Extract<MoneyCommand,{type:'sale.record'}>{return {...base(),type:'sale.record',saleId:newInboxId(),input:{expression:'75 × 2',method:'cash',wallet:null,given:20000,who:literal,items:[{itemId:source.items[0].id,unitPrice:7500,qty:2}]}};}
function credit():Extract<MoneyCommand,{type:'sale.credit'}>{return {...base(),type:'sale.credit',saleId:newInboxId(),accountId:account.id,entryId:newInboxId(),creditEventId:newInboxId(),input:{expression:'150',items:[],confirmation:null}};}
function payment():Extract<MoneyCommand,{type:'khata.payment'}>{return {...base(),type:'khata.payment',accountId:account.id,entryId:newInboxId(),input:{amount:5000,method:'cash',wallet:null,note:literal}};}
function undoSale(c:Extract<MoneyCommand,{type:'sale.record'|'sale.credit'}>):Extract<MoneyCommand,{type:'sale.undo'}>{return {...base(),type:'sale.undo',saleId:c.saleId,entryId:c.type==='sale.credit'?newInboxId():null,creditEventId:c.type==='sale.credit'?newInboxId():null};}
async function accepted(c:MoneyCommand,n=1){const r=await http(n,c);expect(r.status,lastError+' '+await r.clone().text()).toBe(200);return parseMoneyCommandReceipt(await r.json(),c);}
async function counts(){return (await db.query<{sales:number;entries:number;events:number;receipts:number}>("select (select count(*)::int from public.sales) sales,(select count(*)::int from public.credit_entries) entries,(select count(*)::int from public.events) events,(select count(*)::int from private.shop_command_receipts) receipts")).rows[0];}
async function prepare(c:MoneyCommand,n=1){return (await asRole<{data:Record<string,unknown>}>(n,'authenticated','select public.prepare_money_write($1,$2,$3,$4,$5,$6,$7) data',[c.id,newInboxId(),c.type,c.outletId,JSON.stringify(moneyWritePlan(c)),await moneyFingerprint(c),c.occurredAt]))[0].data;}
async function finish(p:Record<string,unknown>,c:MoneyCommand,modify?:(records:CloudRecord[])=>void){const f=moneyWriteFields(p,c,p.ticketId as string);modify?.(f.p_records as CloudRecord[]);return asRole<{data:unknown}>(null,'service_role','select public.finish_money_write($1,$2,$3,$4) data',[f.p_ticket_id,f.p_token,f.p_occurred_at,JSON.stringify(f.p_records)]);}
async function loadSale(id:string){return decodeCommandRecord('sales',JSON.parse((await db.query<{data:string}>('select row_to_json(s)::text data from public.sales s where id=$1',[id])).rows[0].data)) as unknown as Sale;}
async function ledger(){return (await db.query<{data:string}>('select row_to_json(e)::text data from public.credit_entries e where account_id=$1 order by sequence',[account.id])).rows.map(r=>decodeCommandRecord('creditEntries',JSON.parse(r.data)) as unknown as CreditEntry);}
async function opening(amount=20000){const e=openingBalanceCommand(amount,1,{setup:source.snapshot,customer,account,entries:[]},Date.now()-1000);await insert([encodeCommandRecord('creditEntries',e.entry,customer.businessId),encodeCommandRecord('events',e.event,customer.businessId)]);return e.entry;}
beforeAll(async()=>{
 db=await PGlite.create();for(const f of ['supabase-auth.sql','supabase-storage.sql'])await db.exec(readFileSync(new URL('./fixtures/'+f,import.meta.url),'utf8'));
 const dir=new URL('../supabase/migrations/',import.meta.url);for(const f of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())await db.exec(readFileSync(new URL(f,dir),'utf8'));
 for(const n of [1,2,3,4,5,6])await db.query('insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,now())',[uid(n),'1415555010'+n]);
 const input={businessType:'corner_shop' as const,marketCode:'BD' as const,name:'Money',phone:'01712345482'};source=setupCommand(input);branch=setupCommand({...input,name:'Branch'});foreign=setupCommand({...input,name:'Foreign'});
 branch.snapshot.business=source.snapshot.business;branch.snapshot.outlet.businessId=source.snapshot.business.id;branch.snapshot.owner={...source.snapshot.owner,outletIds:[branch.snapshot.outlet.id]};
 for(const [s,n,skip] of [[source,1,false],[branch,1,true],[foreign,4,false]] as const){const tables=emptyBackupTables();tables.businesses.push(s.snapshot.business);tables.outlets.push(s.snapshot.outlet);tables.members.push(s.snapshot.owner);tables.categories.push(...s.categories);tables.items.push(...s.items);const plan=await prepareCloudMigration(createBackup(tables),uid(n));await insert(plan.records.filter(r=>!(skip&&['businesses','members','member_outlets'].includes(r.table))));}
 actors.push({n:1,id:source.snapshot.owner.id,role:'owner',business:source.snapshot.business.id,outlet:source.snapshot.outlet.id},{n:4,id:foreign.snapshot.owner.id,role:'owner',business:foreign.snapshot.business.id,outlet:foreign.snapshot.outlet.id});
 for(const [n,role,outlet] of [[2,'manager',source.snapshot.outlet.id],[3,'manager',branch.snapshot.outlet.id],[5,'staff',source.snapshot.outlet.id],[6,'agent',source.snapshot.outlet.id]] as const){const id=newInboxId();await db.query('insert into public.members(id,business_id,auth_user_id,name,role,created_at,updated_at) values($1,$2,$3,$4,$5,1,1)',[id,source.snapshot.business.id,uid(n),'"Person"',role]);actors.push({n,id,role,business:source.snapshot.business.id,outlet});}
 customer=saveCustomerCommand({name:literal,nickname:'',phone:'01712345482',address:'',notes:literal,tags:[]},source.snapshot,[],null,1).customer;
 account=saveCreditTermsCommand({...defaultCreditTerms,allowed:true,limit:50000},customer,source.snapshot,null,1).account;
 otherAccount=saveCreditTermsCommand({...defaultCreditTerms,allowed:true,limit:50000},customer,branch.snapshot,null,1).account;
 initial.push(encodeCommandRecord('customers',customer,customer.businessId),encodeCommandRecord('creditAccounts',account,customer.businessId),encodeCommandRecord('creditAccounts',otherAccount,customer.businessId));
 for(const outlet of [source.snapshot.outlet,branch.snapshot.outlet])initial.push({table:'customer_outlets',values:{business_id:customer.businessId,outlet_id:outlet.id,customer_id:customer.id}});
},30_000);
beforeEach(async()=>{
 lastError='';await db.exec("truncate public.customers,public.events cascade;delete from private.money_write_tickets;delete from private.money_review_tickets;delete from private.money_command_resolutions;update auth.users set phone='1415555010'||right(id::text,1),phone_confirmed_at=now(),banned_until=null,deleted_at=null;update public.members set active=true;update public.items set available=true");
 await db.query('update public.outlets set currency=$1 where id=$2',['BDT',source.snapshot.outlet.id]);
 for(const a of actors){await db.query('update public.members set role=$1,auth_user_id=$2 where id=$3',[a.role,uid(a.n),a.id]);await db.query('delete from public.member_outlets where member_id=$1',[a.id]);await db.query('insert into public.member_outlets values($1,$2,$3)',[a.business,a.id,a.outlet]);}
 await insert(initial);await db.query('update public.items set price=7500 where id=$1',[source.items[0].id]);
});
afterAll(async()=>{await db?.close();});

it('a new counter sale cannot borrow the current outlet currency without its original saved unit',async()=>{
 const c=cash();c.input.items=[];
 await db.query('update public.outlets set currency=$1 where id=$2',['USD',c.outletId]);
 expect((await http(1,c,undefined,null)).status).toBe(409);
 expect(await counts()).toEqual({sales:0,entries:0,events:0,receipts:0});
});

it('a saved BDT counter sale is not reinterpreted as USD on new admission',async()=>{
 const c=cash();c.input.items=[];const original=structuredClone(c);
 await db.query('update public.outlets set currency=$1 where id=$2',['USD',c.outletId]);
 expect((await http(1,c)).status).toBe(409);expect(c).toEqual(original);
 expect(await counts()).toEqual({sales:0,entries:0,events:0,receipts:0});
});
it('a genuinely saved USD counter sale can be admitted in USD',async()=>{
 const c=cash();c.input.items=[];
 await db.query('update public.outlets set currency=$1 where id=$2',['USD',c.outletId]);
 expect((await http(1,c,undefined,'USD')).status).toBe(200);
 expect(await loadSale(c.saleId)).toMatchObject({currency:'USD',amount:15000});
});
it.each(['bdt','BDT,USD','BDTUSD'])('an invalid saved money unit %s is rejected without money or receipts',async currency=>{
 expect((await http(1,cash(),undefined,currency)).status).toBe(400);
 expect(await counts()).toEqual({sales:0,entries:0,events:0,receipts:0});
});
it('a profile change between money preparation and commit cannot refresh the saved unit on retry',async()=>{
 const c=cash();c.input.items=[];let finishes=0;
 const r=await http(1,c,async()=>{finishes++;await db.query('update public.outlets set currency=$1 where id=$2',['USD',c.outletId]);});
 expect(r.status).toBe(409);expect(finishes).toBe(1);
 expect(await counts()).toEqual({sales:0,entries:0,events:0,receipts:0});
});
it('an actual completed counter receipt replays before missing or changed currency assertions',async()=>{
 const c=cash(),receipt=await accepted(c);
 await db.query('update public.outlets set currency=$1 where id=$2',['USD',c.outletId]);
 for(const currency of [null,'USD','BDT']){const r=await http(1,c,undefined,currency);expect(r.status).toBe(200);expect(parseMoneyCommandReceipt(await r.json(),c)).toEqual(receipt);}
 expect(await loadSale(c.saleId)).toMatchObject({currency:'BDT',amount:15000});
 expect(await counts()).toEqual({sales:1,entries:0,events:1,receipts:1});
});
it('historical BDT counter undo keeps its original unit after the profile changes to USD',async()=>{
 const c=cash();await accepted(c);
 await db.query('update public.outlets set currency=$1 where id=$2',['USD',c.outletId]);
 expect(await accepted(undoSale(c))).toMatchObject({amount:-15000,undoOf:c.saleId});
 expect(await loadSale(c.saleId)).toMatchObject({currency:'BDT',voidReason:'undo'});
});
it('historical BDT khata payments and reversals retain their account unit after a USD profile change',async()=>{
 await opening();await db.query('update public.outlets set currency=$1 where id=$2',['USD',source.snapshot.outlet.id]);
 const c=payment();expect(await accepted(c)).toMatchObject({amount:5000});
 const undo:MoneyCommand={...base(),type:'khata.undo',entryId:c.entryId,reversalId:newInboxId()};await accepted(undo);
 expect((await ledger()).every(e=>e.currency==='BDT')).toBe(true);
 expect(creditBalance(account,await ledger())).toBe(20000);
});
it('a contradictory payment unit is rejected while its original BDT ledger remains untouched',async()=>{
 await opening();const before=await ledger(),c=payment();
 expect((await http(1,c,undefined,'USD')).status).toBe(409);expect(await ledger()).toEqual(before);
});
it('the exact rolled-back hosted role fixture covers every financial family without retaining Auth or shop data',async()=>{const sql=await moneyHostedProofSql(),result=await db.exec(sql),proof=result.at(-1)!.rows[0] as {proof:Record<string,unknown>;auth_rows:number;business_rows:number;ticket_rows:number};expect(proof).toEqual({proof:{commands:7,receipts:7,allClocksRetained:true,replayExact:true,ordinaryCompletionDenied:true,privateReadsDenied:true,otherIdentityDenied:true,salesVoided:2,finalBalance:12345,literalPaymentRetained:true,pendingTickets:0},auth_rows:0,business_rows:0,ticket_rows:0});});
it.each([1,2])('operator %s saves exact cash, change, catalogue snapshots, actor and offline occurrence time',async n=>{const c=cash();c.occurredAt-=86400000;const r=await accepted(c,n),sale=await loadSale(c.saleId);expect(sale).toMatchObject({id:c.saleId,amount:15000,given:20000,change:5000,createdAt:c.occurredAt,eventId:c.id,createdBy:actors.find(a=>a.n===n)!.id,who:literal});expect(sale.items[0]).toMatchObject({name:'Rice',qty:2,lineTotal:15000});expect(r.at).toBeGreaterThan(c.occurredAt);expect(r.saleUpdatedAt).toBeGreaterThanOrEqual(r.at);expect(await counts()).toEqual({sales:1,entries:0,events:1,receipts:1});});
it.each(['wallet','card'] as const)('records a %s receipt without cash given/change',async method=>{const c=cash();c.input={...c.input,method,wallet:method==='wallet'?'bKash':null,given:null};await accepted(c);expect(await loadSale(c.saleId)).toMatchObject({method,methodName:method==='wallet'?'bKash':'Card'});expect((await loadSale(c.saleId)).given).toBeUndefined();});
it('binds replay to actor and exact canonical intent after later catalogue changes',async()=>{const c=cash(),receipt=await accepted(c);await db.query('update public.items set price=1 where id=$1',[source.items[0].id]);expect(await accepted(c)).toEqual(receipt);expect((await http(2,c)).status).toBe(403);expect((await http(1,{...c,input:{...c.input,who:'changed'}})).status).toBe(409);expect((await counts()).sales).toBe(1);expect(await moneyFingerprint(c)).toBe(await moneyFingerprint(Object.fromEntries(Object.entries(c).reverse()) as MoneyCommand));});
it('records a credit sale, linked charge, two audits and one receipt atomically',async()=>{const c=credit(),r=await accepted(c);expect(r).toMatchObject({saleId:c.saleId,entryId:c.entryId,accountId:account.id,entrySequence:1,amount:15000});expect((await loadSale(c.saleId)).method).toBe('credit');expect(await ledger()).toMatchObject([{id:c.entryId,saleId:c.saleId,amount:15000,eventId:c.creditEventId}]);expect(await counts()).toEqual({sales:1,entries:1,events:2,receipts:1});});
it('requires exact balance and limit confirmation, and rejects stale confirmation after concurrent debt',async()=>{await opening(45000);const c=credit();expect((await http(1,c)).status).toBe(409);c.input.confirmation={balance:45000,limit:50000};expect((await http(1,c)).status).toBe(409);c.id=newInboxId();const r=await accepted(c);expect((await ledger()).find(e=>e.id===r.entryId)?.overLimit).toEqual(c.input.confirmation);const next=credit();next.input.confirmation=c.input.confirmation;expect((await http(1,next)).status).toBe(409);expect((await counts()).sales).toBe(1);});
it('serializes stale balance/sequence preparations and keeps record IDs across rebase',async()=>{const c=credit();let calls=0;const r=await http(1,c,async()=>{if(++calls===1)await opening(1000);});expect(r.status,lastError).toBe(200);expect(calls).toBe(2);expect((await r.json()).entrySequence).toBe(2);expect((await ledger()).at(-1)?.id).toBe(c.entryId);});
it('caps automatic stale rebases at three preparations',async()=>{const c=cash();let calls=0;const r=await http(1,c,async()=>{calls++;await db.query('update public.outlets set updated_at=updated_at+1 where id=$1',[c.outletId]);});expect(r.status).toBe(409);expect(calls).toBe(3);expect((await counts()).sales).toBe(0);});
it('cash undo preserves original receipt and reverses once',async()=>{const c=cash();await accepted(c);const before=await loadSale(c.saleId),u=undoSale(c),r=await accepted(u);expect(r).toMatchObject({amount:-15000,undoOf:c.saleId,entryId:null});expect(await loadSale(c.saleId)).toEqual({...before,voidedAt:u.occurredAt,voidReason:'undo',updatedAt:r.saleUpdatedAt!});expect(await accepted(u)).toEqual(r);expect((await http(1,undoSale(c))).status).toBe(400);});
it('committed audit snapshots match the actual financial row and its server admission clock',async()=>{const c=cash(),r=await accepted(c);let event=(await db.query<{data:string;at:number}>('select after_data::text data,at from public.events where id=$1',[c.id])).rows[0];expect(JSON.parse(event.data)).toEqual(await loadSale(c.saleId));expect(event.at).toBe(r.at);const u=undoSale(c),undo=await accepted(u);event=(await db.query<{data:string;at:number}>('select after_data::text data,at from public.events where id=$1',[u.id])).rows[0];expect(JSON.parse(event.data)).toEqual(await loadSale(c.saleId));expect(event.at).toBe(undo.at);});
it('credit sale undo reverses the matching charge and retains literal before/after audits',async()=>{const c=credit();await accepted(c);const u=undoSale(c);await accepted(u);const entries=await ledger();expect(creditBalance(account,entries)).toBe(0);expect(entries[1]).toMatchObject({id:u.entryId,amount:-15000,reversalOf:c.entryId});expect((await counts()).events).toBe(4);});
it('payment cannot exceed due, records exact Unicode and can be undone with one adjustment',async()=>{await opening();const c=payment();c.input.amount=20001;expect((await http(1,c)).status).toBe(400);c.input.amount=5000;c.id=newInboxId();await accepted(c);expect((await ledger())[1]).toMatchObject({note:literal,amount:5000});const u:MoneyCommand={...base(),type:'khata.undo',entryId:c.entryId,reversalId:newInboxId()};const r=await accepted(u);expect(r.amount).toBe(5000);expect(creditBalance(account,await ledger())).toBe(20000);expect((await http(1,{...u,id:newInboxId(),reversalId:newInboxId()})).status).toBe(400);});
it('partly paid credit cannot be undone until its payment has been reversed',async()=>{const c=credit();await accepted(c);const p=payment();await accepted(p);expect((await http(1,undoSale(c))).status).toBe(400);await accepted({...base(),type:'khata.undo',entryId:p.entryId,reversalId:newInboxId()});await accepted(undoSale(c));expect(creditBalance(account,await ledger())).toBe(0);});
it('manual communication records no money and sends no message',async()=>{const c:MoneyCommand={...base(),type:'khata.communication',accountId:account.id,entryId:newInboxId(),input:{text:literal,purpose:'reminder',channel:'manual'}};expect(await accepted(c)).toMatchObject({amount:0,entrySequence:1});expect(await ledger()).toMatchObject([{type:'reminder',amount:0,note:literal,methodName:'manual'}]);});
it.each([3,4,5,6])('identity %s cannot write this outlet or elevate through metadata',async n=>{expect((await http(n,cash())).status).toBe(403);expect((await counts()).sales).toBe(0);});
it('cross-outlet khata IDs never expose their ledger, even to the business owner',async()=>{const c=credit();c.accountId=otherAccount.id;await expect(prepare(c)).rejects.toMatchObject({code:'42501'});expect((await http(2,c)).status).toBe(403);});
it.each(['inactive','role','unconfirmed','phone','banned','deleted','assignment','identity'])('live %s revocation is checked again before commit',async kind=>{const a=actors.find(a=>a.n===2)!,r=await http(2,cash(),async()=>{if(kind==='assignment')await db.query('delete from public.member_outlets where member_id=$1',[a.id]);else if(kind==='identity')await db.query('update public.members set auth_user_id=null where id=$1',[a.id]);else if(kind==='inactive')await db.query('update public.members set active=false where id=$1',[a.id]);else if(kind==='role')await db.query("update public.members set role='staff' where id=$1",[a.id]);else await db.query(`update auth.users set ${kind==='unconfirmed'?'phone_confirmed_at=null':kind==='phone'?"phone=''":kind==='banned'?"banned_until=now()+interval '1 day'":'deleted_at=now()'} where id=$1`,[uid(2)]);});expect(r.status,lastError).toBe(403);expect((await counts()).sales).toBe(0);});
it('archived customers, disabled credit and changed item prices reject before writes',async()=>{await db.query('update public.customers set archived_at=1 where id=$1',[customer.id]);expect((await http(1,credit())).status).toBe(400);await db.query('update public.customers set archived_at=null where id=$1',[customer.id]);await db.query('update public.credit_accounts set allowed=false where id=$1',[account.id]);expect((await http(1,credit())).status).toBe(400);await db.query('update public.items set price=1 where id=$1',[source.items[0].id]);expect((await http(1,cash())).status).toBe(400);expect((await counts()).events).toBe(0);});
it('an unrelated outlet ledger cannot stale or enter the selected context',async()=>{const c=credit(),p=await prepare(c),context=JSON.parse(p.contextJson as string);expect(context.entries).toEqual([]);expect(context.account.id).toBe(account.id);expect(context.items).toEqual([]);await db.query('update public.credit_accounts set credit_limit=1 where id=$1',[otherAccount.id]);await finish(p,c);expect((await counts()).sales).toBe(1);});
it('historical notes are redacted while the exact undo target remains available',async()=>{await opening();await accepted(payment());const all=await ledger(),c:MoneyCommand={...base(),type:'khata.undo',entryId:all[1].id,reversalId:newInboxId()},context=JSON.parse((await prepare(c)).contextJson as string);expect(context.entries[0].note).toBe('');expect(context.entries[1].note).toBe(literal);expect(context.entry.note).toBe(literal);expect(context.customer.notes).toBe(literal);});
it('server time enforces undo expiry despite backdating, including after preparation',async()=>{const c=cash();c.occurredAt-=601000;await accepted(c);expect((await http(1,{...undoSale(c),occurredAt:c.occurredAt+1})).status).toBe(400);const fresh=cash();await accepted(fresh);const u=undoSale(fresh),p=await prepare(u);await db.query('update private.money_write_tickets set created_at=created_at-601000 where id=$1',[p.ticketId]);await db.query('update public.sales set created_at=created_at-601000 where id=$1',[fresh.saleId]);await expect(finish(p,u)).rejects.toMatchObject({code:'PT409'});});
it('expired opaque proofs and altered source-time binding cannot commit',async()=>{const c=cash(),p=await prepare(c);await expect(finish({...p,token:'x'.repeat(43)},c)).rejects.toMatchObject({code:'PT409'});await db.query('update private.money_write_tickets set expires_at=1 where id=$1',[p.ticketId]);await expect(finish(p,c)).rejects.toMatchObject({code:'PT409'});expect((await counts()).sales).toBe(0);});
it.each(['extra','actor','scope','saleId','amount','audit'])('commit %s tampering rolls back every row',async kind=>{const c=credit(),p=await prepare(c);await expect(finish(p,c,rows=>{const s=rows.find(r=>r.table==='sales')!,e=rows.find(r=>r.table==='credit_entries')!,a=rows.find(r=>r.table==='events'&&r.values.id===c.id)!;if(kind==='extra')s.values.unexpected=1;else if(kind==='actor')e.values.created_by=actors.find(a=>a.n===2)!.id;else if(kind==='scope')s.values.outlet_id=branch.snapshot.outlet.id;else if(kind==='saleId')s.values.id=newInboxId();else if(kind==='amount')e.values.amount=1;else a.values.command='not.allowed';})).rejects.toBeDefined();expect(await counts()).toEqual({sales:0,entries:0,events:0,receipts:0});});
it('a collision in the companion audit rolls back the earlier sale, charge and primary audit',async()=>{const c=credit();await db.query('insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[c.creditEventId,customer.businessId,c.outletId,'member',source.snapshot.owner.id,'fixture','null','null',1]);const p=await prepare(c);await expect(finish(p,c)).rejects.toMatchObject({code:'23505'});expect(await counts()).toEqual({sales:0,entries:0,events:1,receipts:0});});
it('raw anonymous reads, client writes/private access and non-service completion remain denied',async()=>{const c=cash(),p=await prepare(c),fields=moneyWriteFields(p,c,p.ticketId as string);for(const query of ['select * from public.sales','select * from private.money_write_tickets'])await expect(asRole(null,'anon',query)).rejects.toMatchObject({code:'42501'});await expect(asRole(1,'authenticated','select * from private.money_write_tickets')).rejects.toMatchObject({code:'42501'});await expect(asRole(1,'authenticated','delete from public.sales')).rejects.toMatchObject({code:'42501'});await expect(asRole(1,'authenticated','select public.finish_money_write($1,$2,$3,$4)',[fields.p_ticket_id,fields.p_token,fields.p_occurred_at,JSON.stringify(fields.p_records)])).rejects.toMatchObject({code:'42501'});await expect(asRole(null,'service_role','select public.prepare_money_write($1,$2,$3,$4,$5,$6,$7)',[c.id,newInboxId(),c.type,c.outletId,JSON.stringify(moneyWritePlan(c)),await moneyFingerprint(c),c.occurredAt])).rejects.toMatchObject({code:'42501'});});
it('the strict money schema rejects tenant/actor fields, floats, duplicate IDs and forged receipts',async()=>{const c=cash();for(const input of [{...c,businessId:customer.businessId},{...c,actorId:source.snapshot.owner.id},{...c,input:{...c.input,given:1.1}},{...c,saleId:c.id},{...c,occurredAt:-1},{...c,input:{...c.input,items:[{...c.input.items[0],qty:1.5}]}}])expect(()=>parseShopCommand(input)).toThrow();const r=await accepted(c);expect(()=>parseMoneyCommandReceipt({...r,occurredAt:c.occurredAt+1},c)).toThrow();expect(()=>parseMoneyCommandReceipt({...r,entryId:newInboxId(),entrySequence:1},c)).toThrow();expect(parseMoneyCommandReceipt({...r,backend:'private'},c)).toEqual(r);expect(parseMoneyCommand(c)).toEqual(c);});
it('server commit column allowlists remain aligned with the shared codec',async()=>{const src=(await db.query<{prosrc:string}>("select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and proname='finish_money_write'")).rows[0].prosrc;const specs=JSON.parse(src.match(/specs jsonb:='([^']+)'/)![1]);for(const table of ['sales','creditEntries','events'] as const)expect(specs[cloudRecordMaps[table].table].sort()).toEqual([...Object.keys(cloudRecordMaps[table].fields),'business_id'].sort());});

function reviewSource(c:FinancialMoneyCommand,unit='BDT'){
 const cashRow={id:'saleId'in c?c.saleId:newInboxId(),outletId:c.outletId,currency:unit,amount:15000,methodName:c.type==='sale.credit'?'Credit':'Cash',who:literal,...(c.type==='sale.credit'?{creditAccountId:c.accountId,customerId:customer.id}:{})};
 const entry={id:c.type==='khata.undo'?c.reversalId:'entryId'in c?c.entryId:newInboxId(),outletId:c.outletId,accountId:'accountId'in c?c.accountId:account.id,customerId:customer.id,currency:unit,amount:c.type==='khata.payment'?c.input.amount:c.type==='sale.credit'?15000:5000,methodName:'Cash',...(c.type==='sale.credit'?{saleId:c.saleId}:{}),...(c.type==='khata.undo'?{reversalOf:c.entryId}:{})};
 const money=[...('saleId'in c?[{table:'sales',key:c.saleId,before:c.type==='sale.undo'?cashRow:null,after:cashRow}]:[]),...(c.type==='sale.credit'||c.type==='khata.payment'||c.type==='khata.undo'?[{table:'creditEntries',key:entry.id,before:null,after:entry}]:[])];
 return JSON.stringify({v:1,entryId:newInboxId(),sequence:1,commandIndex:0,at:c.occurredAt,money,priorCommands:[]});
}
async function openMoneyReview(c:FinancialMoneyCommand,n=1,sourceJson=reviewSource(c),selected={id:newInboxId(),replacementId:newInboxId()},sourceHash='a'.repeat(64)){
 const data=(await asRole<{data:Record<string,unknown>}>(n,'authenticated','select public.prepare_money_review($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) data',[selected.id,selected.replacementId,c.id,c.type,c.outletId,JSON.stringify(moneyWritePlan(c)),await moneyFingerprint(c),c.occurredAt,JSON.stringify(parseMoneyCommand(c)),sourceHash,sourceJson,JSON.parse(sourceJson).money[0].after.currency]))[0].data;
 return {...data,sourceJson,sourceHash,command:c} as Record<string,unknown>&{command:FinancialMoneyCommand;sourceJson:string;sourceHash:string};
}
async function finishMoneyReview(r:Record<string,unknown>,outcome:'withdrawn'|'replaced'='withdrawn',p:Record<string,unknown>|null=null,c:FinancialMoneyCommand|null=null,consent:{balance:number;limit:number}|null=null,confirmCredit=false){
 const fields=p&&c?moneyWriteFields(p,c,p.ticketId as string):null;
 return (await asRole<{data:unknown}>(null,'service_role','select public.finish_money_review($1,$2,$3,$4,$5,$6,$7,$8,$9) data',[r.id,r.token,outcome,confirmCredit,JSON.stringify(consent),fields?.p_ticket_id??null,fields?.p_token??null,c?await moneyFingerprint(c):null,fields?JSON.stringify(fields.p_records):null]))[0].data;
}
it('a reviewed withdrawal records no cash, preserves literal source and replays its actual outcome under a later currency',async()=>{
 const c=cash(),saved=reviewSource(c);await db.query('update public.outlets set currency=$1 where id=$2',['USD',c.outletId]);const before=await counts(),r=await openMoneyReview(c,1,saved),receipt=parseMoneyResolutionReceipt(await finishMoneyReview(r),c),after=await counts();
 expect(receipt).toMatchObject({type:'command.resolved',commandId:c.id,outcome:'withdrawn',replacement:null});expect(after).toEqual({...before,events:before.events+1,receipts:before.receipts+1});
 const retained=(await db.query<{original_intent:string;source_json:string}>('select original_intent,source_json from private.money_command_resolutions where command_id=$1',[c.id])).rows[0];expect(retained).toEqual({original_intent:JSON.stringify(parseMoneyCommand(c)),source_json:saved});
 await db.query('update private.money_review_tickets set expires_at=0 where id=$1',[r.id]);expect(await finishMoneyReview(r)).toEqual(receipt);
 const retry=await http(1,c);expect(retry.status).toBe(200);expect(parseShopCommandReceipt(await retry.json(),c)).toEqual(receipt);expect(await counts()).toEqual(after);
});
it('a prepared ordinary writer cannot revive withdrawn counter money under a different audit identity',async()=>{
 const c=cash(),alias={...c,id:newInboxId()},prepared=await prepare(alias),r=await openMoneyReview(c);await finishMoneyReview(r);const before=await counts();await expect(finish(prepared,alias)).rejects.toMatchObject({code:'PT409'});expect(await counts()).toEqual(before);expect(before.sales).toBe(0);
});
it('reserved financial identities also block other record writers and bulk admission after withdrawal',async()=>{
 const c=cash(),p=await prepare(c),records=moneyWriteFields(p,c,p.ticketId as string).p_records as CloudRecord[],r=await openMoneyReview(c);await finishMoneyReview(r);const before=await counts();
 await expect(insert(records.filter(row=>row.table==='sales'))).rejects.toMatchObject({code:'PT409'});expect(await counts()).toEqual(before);
 await opening(20000);const pay=payment(),prepared=await prepare(pay),entries=moneyWriteFields(prepared,pay,prepared.ticketId as string).p_records as CloudRecord[],review=await openMoneyReview(pay);await finishMoneyReview(review);const beforeEntry=await counts();
 await expect(insert(entries.filter(row=>row.table==='credit_entries'))).rejects.toMatchObject({code:'PT409'});expect(await counts()).toEqual(beforeEntry);
});
it('an explicitly replaced counter action keeps original financial IDs, occurrence time and a genuine receipt without an order revision',async()=>{
 const c=cash(),before=await counts(),r=await openMoneyReview(c),replacement=reviewedMoneyProposal(c,r.replacementId as string),p=await prepare(replacement),receipt=parseMoneyResolutionReceipt(await finishMoneyReview(r,'replaced',p,replacement),c),after=await counts();
 expect(receipt.replacement).toMatchObject({id:replacement.id,confirmation:null,receipt:{id:replacement.id,saleId:c.saleId,occurredAt:c.occurredAt,amount:15000}});expect(receipt.replacement).not.toHaveProperty('revision');
 expect(after).toEqual({sales:before.sales+1,entries:before.entries,events:before.events+2,receipts:before.receipts+2});expect(await loadSale(c.saleId)).toMatchObject({currency:'BDT',amount:15000,createdAt:c.occurredAt});expect(await finishMoneyReview(r,'replaced',p,replacement)).toEqual(receipt);expect(await counts()).toEqual(after);
});
it('the SQL completion boundary refuses a USD replacement for original saved BDT cash even when both tickets share the current snapshot',async()=>{
 const c=cash(),saved=reviewSource(c);await db.query('update public.outlets set currency=$1 where id=$2',['USD',c.outletId]);const r=await openMoneyReview(c,1,saved),replacement=reviewedMoneyProposal(c,r.replacementId as string),p=await prepare(replacement),before=await counts();
 await expect(finishMoneyReview(r,'replaced',p,replacement)).rejects.toMatchObject({code:'PT409',message:'Keep the original saved monetary unit.'});expect(await counts()).toEqual(before);expect((await db.query('select * from private.money_review_tickets where id=$1',[r.id])).rows).toHaveLength(1);
});
it('a commit-time profile race retains the financial review without recording replacement cash',async()=>{
 const c=cash(),r=await openMoneyReview(c),replacement=reviewedMoneyProposal(c,r.replacementId as string),p=await prepare(replacement),before=await counts();await db.query('update public.outlets set currency=$1 where id=$2',['USD',c.outletId]);await expect(finishMoneyReview(r,'replaced',p,replacement)).rejects.toMatchObject({code:'PT409'});expect(await counts()).toEqual(before);
});
it('reviewed credit above the actual limit requires separate exact consent and leaves the original command untouched',async()=>{
 const c=credit(),original=JSON.stringify(c);await opening(40000);const r=await openMoneyReview(c),consent={balance:40000,limit:50000},replacement=reviewedMoneyProposal(c,r.replacementId as string,consent),p=await prepare(replacement),before=await counts();
 await expect(finishMoneyReview(r,'replaced',p,replacement,consent,false)).rejects.toMatchObject({code:'22023'});expect(await counts()).toEqual(before);
 const receipt=parseMoneyResolutionReceipt(await finishMoneyReview(r,'replaced',p,replacement,consent,true),c);expect(receipt.replacement?.confirmation).toEqual(consent);expect(creditBalance(account,await ledger())).toBe(55000);expect(JSON.stringify(c)).toBe(original);expect((await loadSale(c.saleId)).currency).toBe('BDT');
});
it('a balance change after credit review invalidates the old consent and cannot add a charge',async()=>{
 const c=credit();await opening(40000);const r=await openMoneyReview(c),consent={balance:40000,limit:50000},replacement=reviewedMoneyProposal(c,r.replacementId as string,consent),p=await prepare(replacement);await accepted(payment());const before=await counts();await expect(finishMoneyReview(r,'replaced',p,replacement,consent,true)).rejects.toMatchObject({code:'PT409'});expect(await counts()).toEqual(before);
});
it('financial review is outlet scoped and its source cannot be read with another phone account',async()=>{
 const c=cash(),r=await openMoneyReview(c);for(const n of [3,4,5,6])await expect(openMoneyReview(c,n)).rejects.toMatchObject({code:'42501'});
 await expect(asRole(2,'authenticated','select public.read_money_review($1,$2)',[r.id,r.token])).rejects.toMatchObject({code:'42501'});
 expect((await asRole<{data:boolean}>(2,'authenticated','select public.admit_money_review($1) data',[c.outletId]))[0].data).toBe(true);
});
it('revoking the original actor after financial review blocks both read and service completion',async()=>{
 const c=cash(),r=await openMoneyReview(c),before=await counts();await db.query('update public.members set active=false where id=$1',[source.snapshot.owner.id]);await expect(asRole(1,'authenticated','select public.read_money_review($1,$2)',[r.id,r.token])).rejects.toMatchObject({code:'42501'});await expect(finishMoneyReview(r)).rejects.toMatchObject({code:'42501'});expect(await counts()).toEqual(before);
});
it('expired financial comparisons and altered source selections cannot finalize the original cash',async()=>{
 const c=cash(),r=await openMoneyReview(c),before=await counts();await expect(openMoneyReview(c,1,r.sourceJson,{id:r.id as string,replacementId:r.replacementId as string},'b'.repeat(64))).rejects.toMatchObject({code:'PT409'});
 await db.query('update private.money_review_tickets set expires_at=0 where id=$1',[r.id]);await expect(finishMoneyReview(r)).rejects.toMatchObject({code:'PT409'});expect(await counts()).toEqual(before);
});
it('new financial review tables are private under forced RLS and only the service can finalize a selected outcome',async()=>{
 const c=cash(),r=await openMoneyReview(c);for(const role of ['anon','authenticated','service_role'] as const)for(const table of ['money_review_tickets','money_command_resolutions'])await expect(asRole(role==='authenticated'?1:null,role,'select * from private.'+table)).rejects.toMatchObject({code:'42501'});
 await expect(asRole(1,'authenticated','select public.finish_money_review($1,$2,$3,$4,$5,$6,$7,$8,$9)',[r.id,r.token,'withdrawn',false,'null',null,null,null,null])).rejects.toMatchObject({code:'42501'});
 const policies=await db.query<{relrowsecurity:boolean;relforcerowsecurity:boolean}>("select relrowsecurity,relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and relname in ('money_review_tickets','money_command_resolutions')");expect(policies.rows).toEqual([{relrowsecurity:true,relforcerowsecurity:true},{relrowsecurity:true,relforcerowsecurity:true}]);
});

function moneyReviewHttp(packet:MoneyReviewRequest|Record<string,unknown>,resolve=false,options:{n?:number;beforeFinish?:()=>Promise<void>;returned?:(name:string,value:unknown)=>unknown}={}){
 const remote=createMoneyReviewStore('https://database.test','sb_publishable_test_only','sb_secret_test_only',async(url,request)=>{
  const name=new URL(String(url)).pathname.split('/').at(-1)!,args=JSON.parse(request?.body as string),headers=new Headers(request?.headers),service=headers.get('apikey')==='sb_secret_test_only',
   parameters:Record<string,string[]>={admit_money_review:['p_outlet_id'],inspect_money_outcome:['p_command_id','p_type','p_outlet_id','p_hash'],prepare_money_review:['p_id','p_replacement_id','p_command_id','p_type','p_outlet_id','p_plan','p_hash','p_occurred_at','p_intent_json','p_source_hash','p_source_json','p_saved_currency'],read_money_review:['p_id','p_token'],prepare_money_write:['p_id','p_ticket_id','p_type','p_outlet_id','p_plan','p_hash','p_occurred_at'],finish_money_review:['p_id','p_token','p_outcome','p_confirm_credit','p_confirmation','p_replacement_ticket','p_replacement_token','p_replacement_hash','p_replacement_records']};
  expect(parameters[name]).toBeDefined();expect(service).toBe(name==='finish_money_review');if(service){expect(headers.has('Authorization')).toBe(false);await options.beforeFinish?.();}
  try{
   const rows=await asRole<{data:unknown}>(service?null:Number(headers.get('Authorization')!.split('.')[1]),service?'service_role':'authenticated',`select public.${name}(${parameters[name].map((_,i)=>'$'+(i+1)).join(',')}) as data`,parameters[name].map(key=>['p_plan','p_confirmation','p_replacement_records'].includes(key)?JSON.stringify(args[key]):args[key]));
   return new Response(JSON.stringify(options.returned?options.returned(name,rows[0].data):rows[0].data));
  }catch(error){const {code,message}=error as {code:string;message:string};lastError=code+': '+message;return new Response(JSON.stringify({code}),{status:code==='42501'?403:code==='PT429'?429:['PT409','23505'].includes(code)?409:code==='22023'?400:500});}
 });
 const command=packet.command as FinancialMoneyCommand;
 return createMoneyReviewHandler({store:remote,origins:new Set([origin])})(new Request('https://api.test/commands?review='+(resolve?'money-resolve':'money-read'),{method:'POST',headers:{Origin:origin,Authorization:`Bearer user.${options.n??1}.signature`,'Content-Type':'application/json',[commandReviewHeader]:command.outletId},body:JSON.stringify(packet)}));
}
function moneyPacket(c:FinancialMoneyCommand):MoneyReviewRequest{return {id:newInboxId(),replacementId:newInboxId(),command:c,sourceHash:'a'.repeat(64),sourceJson:reviewSource(c)};}
it('the actual HTTP review retains a saved BDT counter action under USD, returns only its comparison and finalizes withdrawal without cash',async()=>{
 const c=cash(),packet=moneyPacket(c),before=await counts();await db.query('update public.outlets set currency=$1 where id=$2',['USD',c.outletId]);
 const read=await moneyReviewHttp(packet);expect(read.status,lastError+' '+await read.clone().text()).toBe(200);const body=await read.json();expect(body).toMatchObject({done:false,review:{current:{profileCurrency:'USD'},proposal:{enabled:false,reason:'currency'}}});
 for(const field of ['contextJson','plan','sourceJson','auth_user_id','savedCurrency'])expect(body.review).not.toHaveProperty(field);expect(JSON.stringify(body)).not.toContain('sb_secret_');
 const result=await moneyReviewHttp({...packet,token:body.review.token,outcome:'withdrawn',confirmCredit:false},true);expect(result.status,lastError+' '+await result.clone().text()).toBe(200);expect(parseMoneyResolutionReceipt(await result.json(),c).outcome).toBe('withdrawn');expect((await counts()).sales).toBe(before.sales);
 const retry=await moneyReviewHttp(packet);expect(retry.status).toBe(200);expect(await retry.json()).toMatchObject({done:true,receipt:{type:'command.resolved',outcome:'withdrawn'}});
});
it('the actual HTTP credit comparison requires fresh explicit limit consent and returns the genuine replacement receipt',async()=>{
 const c=credit(),packet=moneyPacket(c);await opening(40000);const read=await moneyReviewHttp(packet);expect(read.status,lastError+' '+await read.clone().text()).toBe(200);const body=await read.json();
 expect(body.review).toMatchObject({current:{balance:40000,limit:50000},proposal:{enabled:true,balance:55000,requiresCreditConfirmation:true,confirmation:{balance:40000,limit:50000}}});
 const before=await counts(),decision={...packet,token:body.review.token,outcome:'replaced',confirmCredit:false};expect((await moneyReviewHttp(decision,true)).status).toBe(409);expect(await counts()).toEqual(before);
 const completed=await moneyReviewHttp({...decision,confirmCredit:true},true);expect(completed.status,lastError+' '+await completed.clone().text()).toBe(200);expect(parseMoneyResolutionReceipt(await completed.json(),c).replacement?.confirmation).toEqual({balance:40000,limit:50000});expect(creditBalance(account,await ledger())).toBe(55000);
});
it('the HTTP formatter rejects mismatched occurrence and saved-unit bindings before any financial decision',async()=>{
 for(const patch of [{occurredAt:0},{savedCurrency:'USD'}]){
  const packet=moneyPacket(cash()),before=await counts(),read=await moneyReviewHttp(packet,false,{returned:(name,value)=>name==='prepare_money_review'?{...(value as object),...patch}:value});expect(read.status).toBe(503);expect(await counts()).toEqual(before);
 }
});
it('the HTTP completion keeps original cash when the profile changes after the selected comparison',async()=>{
 const c=cash(),packet=moneyPacket(c),read=await moneyReviewHttp(packet);expect(read.status,lastError+' '+await read.clone().text()).toBe(200);const body=await read.json();expect(body.review.proposal.enabled).toBe(true);const before=await counts(),result=await moneyReviewHttp({...packet,token:body.review.token,outcome:'replaced',confirmCredit:false},true,{beforeFinish:async()=>{await db.query('update public.outlets set currency=$1 where id=$2',['USD',c.outletId]);}});
 expect(result.status).toBe(409);expect(await counts()).toEqual(before);
});
it('the HTTP review recovers an already recorded original before imposing the current shop currency',async()=>{
 const c=cash(),packet=moneyPacket(c),recorded=await accepted(c),before=await counts();await db.query('update public.outlets set currency=$1 where id=$2',['USD',c.outletId]);const result=await moneyReviewHttp(packet);expect(result.status).toBe(200);expect(await result.json()).toEqual({done:true,receipt:recorded});expect(await counts()).toEqual(before);
});
it('a lost HTTP withdrawal reply recovers its genuine source-bound outcome without recording cash twice',async()=>{
 const c=cash(),packet=moneyPacket(c),read=await moneyReviewHttp(packet),body=await read.json(),decision={...packet,token:body.review.token,outcome:'withdrawn',confirmCredit:false};
 const lost=await moneyReviewHttp(decision,true,{returned:(name,value)=>{if(name==='finish_money_review')throw Error('Connection closed after SQL commit');return value;}});expect(lost.status).toBe(503);const committed=await counts();expect(committed.sales).toBe(0);
 const recovered=await moneyReviewHttp(packet);expect(recovered.status).toBe(200);expect(await recovered.json()).toMatchObject({done:true,receipt:{type:'command.resolved',sourceHash:packet.sourceHash,outcome:'withdrawn'}});expect(await counts()).toEqual(committed);
 expect((await moneyReviewHttp({...packet,sourceHash:'b'.repeat(64)})).status).toBe(409);expect(await counts()).toEqual(committed);
});
