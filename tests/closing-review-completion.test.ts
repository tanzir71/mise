import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createClosingReviewDatabase,uid,type ClosingReviewDatabase} from './closing-review-sql-fixture';
import {fixture,id,modes} from './closing-review-fixture';
import {closingReviewFields} from '../supabase/functions/_shared/closing-review';
import {closingWriteFields} from '../supabase/functions/_shared/closing-write';
import {closingFingerprint,replayClosingRecords} from '../packages/core/closing-replay';
import {closingWritePlan,type ClosingCommand} from '../packages/core/closing-commands';
import {parseClosingResolutionReceipt,reviewedClosingProposal} from '../packages/core/closing-review';
import {closingReviewSourceAudits} from '../packages/core/closing-review-source';
import {closingIntent} from '../apps/web/src/data/outbox-intents';
import {undoClosingCommand} from '../packages/core/closing';
import {closingReviewProjection} from '../packages/core/closing-review-view';
import {decodeCommandRecord,encodeCommandRecord,type CloudRecord} from '../packages/core/cloud-records';
import {closingReviewBoundary} from '../packages/core/closing-review-boundary';
import {closingReviewCreatedIds,parseClosingReviewSource} from '../packages/core/closing-review-source';
import {emptyBackupTables} from '../packages/core/backup-tables';
import {createBackup} from '../packages/core/backup';
import type {AuditEvent} from '../packages/core/models';
import {recordSaleCommand} from '../packages/core/sales';
let sql:ClosingReviewDatabase;
beforeAll(async()=>{sql=await createClosingReviewDatabase();},30000);
beforeEach(async()=>{await sql.reset();});
afterAll(async()=>{await sql?.db.close();});
const fresh=(mode:Parameters<typeof fixture>[0]='surplus')=>fixture(mode,{at:Date.now()-10000});
async function candidate(f:ReturnType<typeof fixture>,prepared:unknown,n=1,change?:(c:ClosingCommand)=>ClosingCommand){
 const selected=await closingReviewFields(prepared,f.packet);if(!selected.proposal)throw Error('No reviewed replacement available.');const c=change?change(selected.proposal):selected.proposal,ticket=id(81000),hash=await closingFingerprint(c);
 const normal=await sql.asRole(n,'authenticated','select public.prepare_closing_write($1,$2,$3,$4,$5,$6,$7) data',[c.id,ticket,c.type,c.outletId,JSON.stringify(closingWritePlan(c)),hash,c.occurredAt]);
 const fields=closingWriteFields(normal,c,ticket);if(!change)expect(closingReviewProjection(fields.p_records as CloudRecord[],c)).toEqual(selected.view.proposal);
 return {id:ticket,token:fields.p_token,hash,records:fields.p_records as CloudRecord[],command:c};
}
async function finish(p:unknown,outcome='withdrawn',replacement:Awaited<ReturnType<typeof candidate>>|null=null,role:'anon'|'authenticated'|'service_role'='service_role'){
 const review=p as {id:string;token:string};return sql.asRole(role==='authenticated'?1:null,role,'select public.finish_closing_review($1,$2,$3,$4,$5,$6,$7) data',[review.id,review.token,outcome,replacement?.id??null,replacement?.token??null,replacement?.hash??null,replacement?JSON.stringify(replacement.records):null]);
}
async function state(){return (await sql.db.query("select json_build_object('closings',(select coalesce(json_agg(row_to_json(c) order by id),'[]') from public.day_closings c),'sales',(select coalesce(json_agg(row_to_json(s) order by id),'[]') from public.sales s)) data")).rows;}
async function counts(){return (await sql.db.query<{events:number;receipts:number;resolutions:number}>("select (select count(*)::int from public.events) events,(select count(*)::int from private.shop_command_receipts) receipts,(select count(*)::int from private.closing_command_resolutions) resolutions")).rows[0];}
async function canonical(f:ReturnType<typeof fixture>){
 const tables=emptyBackupTables();tables.businesses.push(f.context.setup.business);tables.outlets.push(f.context.setup.outlet);tables.members.push(f.context.setup.owner);
 for(const [name,table] of [['sales','sales'],['dayClosings','day_closings'],['events','events']] as const){const rows=(await sql.db.query<{data:Record<string,unknown>}>(`select row_to_json(r) data from public.${table} r order by id`)).rows.map(row=>decodeCommandRecord(name,row.data));Object.assign(tables,{[name]:rows});}
 return createBackup(tables);
}
for(const outcome of ['withdrawn','replaced'] as const)it.each(modes)('validates the actual complete canonical '+outcome+' %s transaction and its creation fences',async mode=>{
 const f=fresh(mode);await sql.seed(f);const prepared=await sql.prepare(f),replacement=outcome==='replaced'?await candidate(f,prepared):null;await finish(prepared,outcome,replacement);
 const current=await canonical(f),event=current.tables.events.find(event=>event.id===f.command.id)!,boundary=await closingReviewBoundary(current.tables.events,f.command.outletId),source=parseClosingReviewSource(f.packet),ids=closingReviewCreatedIds(source);
 expect((event.after as {closingResolutionPosition:string}).closingResolutionPosition).toMatch(/^[1-9][0-9]*$/);
 for(const value of ids){const record={table:'sales',values:{id:value}};if(current.tables.sales.some(row=>row.id===value))expect(()=>boundary.assert([record],current)).not.toThrow();else expect(()=>boundary.assert([record],current)).toThrow();}
 if(f.command.type==='closing.undo'){expect(ids.has(f.command.closingId)).toBe(false);if(f.command.saleId)expect(ids.has(f.command.saleId)).toBe(false);expect(()=>boundary.assert([{table:'day_closings',values:{id:f.command.closingId}}],current)).not.toThrow();}
});
it.each(['position','duplicate','source','hash','actor','closing-link','scope','outcome','time','resolution','replacement-hash','missing-kind','missing-before','missing-after','missing-position','extra-before','before-context','after-context','after-cash','after-unrelated'] as const)('rejects damaged canonical %s evidence from an actual SQL completion',async kind=>{
 const f=fresh('undo-surplus');await sql.seed(f);const prepared=await sql.prepare(f),replacement=await candidate(f,prepared);await finish(prepared,'replaced',replacement);const current=await canonical(f),event=structuredClone(current.tables.events.find(event=>event.id===f.command.id)!) as AuditEvent,before=event.before as Record<string,unknown>,after=event.after as Record<string,unknown>;
 if(kind==='position')after.closingResolutionPosition='9223372036854775808';if(kind==='source')before.sourceJson='{}';if(kind==='hash')before.commandHash='f'.repeat(64);if(kind==='actor')event.actor.id=id(88888);if(kind==='closing-link')event.closingId=id(88888);if(kind==='scope')(after.receipt as {outletId:string}).outletId=id(88888);if(kind==='outcome')after.outcome='withdrawn';if(kind==='time')event.at++;if(kind==='resolution')before.resolutionId=id(88888);
 if(kind==='replacement-hash')(after.receipt as {replacement:{commandHash:string}}).replacement.commandHash='f'.repeat(64);if(kind==='missing-kind')delete before.commandType;if(kind==='missing-before')event.before=null;if(kind==='missing-after')event.after=null;if(kind==='missing-position')delete after.closingResolutionPosition;if(kind==='extra-before')before.unchecked='extra';
 if(kind==='before-context')before.closingBeforeJson='{}';if(kind==='after-context')after.closingAfterJson='{}';
 if(kind==='after-cash'||kind==='after-unrelated'){const context=JSON.parse(after.closingAfterJson as string);if(kind==='after-cash')context.sale.amount++;else context.actorName+=' changed';after.closingAfterJson=JSON.stringify(context);}
 await expect(closingReviewBoundary(kind==='duplicate'?[event,event]:[event],f.command.outletId)).rejects.toMatchObject({kind:'integrity'});
});
it('keeps a newly saved undo review available after an earlier resolution of different action IDs',async()=>{
 const f=fresh('undo-surplus');await sql.seed(f);await finish(await sql.prepare(f),'withdrawn');let n=85000;
 const change=undoClosingCommand(f.created.closing,f.context.setup,f.created.sale,f.command.occurredAt+100,()=>id(++n)),command=closingIntent(change,true),source=JSON.parse(f.packet.sourceJson);source.entryId=id(85010);source.sequence=2;source.at=command.occurredAt;source.events=closingReviewSourceAudits(command,change.events);
 const packet={...f.packet,id:id(85011),replacementId:id(85012),command,sourceHash:'b'.repeat(64),sourceJson:JSON.stringify(source)},prepared=await sql.prepare(f,1,packet),fields=await closingReviewFields(prepared,packet);
 expect(fields.view.current.available).toBe(true);expect(fields.view.proposal.enabled).toBe(true);
});

it.each(modes)('withdraws the original %s atomically without changing its financial parents',async mode=>{
 const f=fresh(mode);await sql.seed(f);const before=await state(),p=await sql.prepare(f),start=await counts(),result=parseClosingResolutionReceipt(await finish(p),f.packet);
 expect(result.outcome).toBe('withdrawn');expect(result.replacement).toBeNull();expect(await state()).toEqual(before);expect(await counts()).toEqual({events:start.events+1,receipts:1,resolutions:1});
 expect(await finish(p)).toEqual(result);expect(await sql.read(p)).toEqual({done:true,receipt:result});
 const archive=(await sql.db.query<{source:string;intent:string}>('select source_json source,original_intent intent from private.closing_command_resolutions')).rows[0];expect(archive.source).toBe(f.packet.sourceJson);expect(archive.intent).toBe(JSON.stringify(f.command));
});
it.each(modes)('replaces the original %s with one ordinary transaction and exact historical identities',async mode=>{
 const f=fresh(mode);await sql.seed(f);const p=await sql.prepare(f),replacement=await candidate(f,p),start=await counts(),result=parseClosingResolutionReceipt(await finish(p,'replaced',replacement),f.packet);
 expect(result.outcome).toBe('replaced');expect(result.replacement?.id).toBe(f.packet.replacementId);expect(result.replacement?.commandHash).toBe(replacement.hash);expect(result.replacement?.receipt.occurredAt).toBe(f.command.occurredAt);
 expect(await counts()).toEqual({events:start.events+(f.command.saleId?3:2),receipts:2,resolutions:1});expect(await finish(p,'replaced',replacement)).toEqual(result);expect(await finish(p)).toEqual(result);
 const closing=(await sql.db.query<{id:string;created_at:number;counted_cash:number;voided_at:number|null}>('select id,created_at,counted_cash,voided_at from public.day_closings where id=$1',[f.command.closingId])).rows[0];
 expect(closing.id).toBe(f.command.closingId);expect(Number(closing.created_at)).toBe(f.created.closing.createdAt);expect(closing.counted_cash).toBe(f.created.closing.countedCash);expect(Number(closing.voided_at)||null).toBe(f.command.type==='closing.undo'?f.command.occurredAt:null);
});
it('reviews different canonical cash and records only the explicitly selected new surplus',async()=>{
 const f=fresh();await sql.seed(f);const cash=recordSaleCommand({expression:'10',method:'cash'},{setup:f.context.setup,items:[],wallets:[]},f.command.occurredAt-1,kind=>kind==='event'?id(82000):id(82001));await sql.insert([encodeCommandRecord('sales',cash.sale,f.row.businessId),encodeCommandRecord('events',cash.event,f.row.businessId)]);
 const p=await sql.prepare(f),replacement=await candidate(f,p),result=parseClosingResolutionReceipt(await finish(p,'replaced',replacement),f.packet);
 expect(result.replacement?.receipt).toMatchObject({difference:1501,addedWalkIn:1501,occurredAt:f.command.occurredAt});expect((await sql.db.query<{amount:number}>('select amount from public.sales where id=$1',[f.command.saleId])).rows[0].amount).toBe(1501);
});
it.each(['anon','authenticated'] as const)('denies %s completion even with a genuine preparation and ordinary candidate',async role=>{
 const f=fresh();await sql.seed(f);const p=await sql.prepare(f),replacement=await candidate(f,p),before=await counts();await expect(finish(p,'replaced',replacement,role)).rejects.toMatchObject({code:'42501'});expect(await counts()).toEqual(before);
});
it.each(['count','choice','note','physical-time','closing-parent','cash-parent'])('denies a differently prepared %s intent without any writes',async kind=>{
 const f=fresh();await sql.seed(f);const p=await sql.prepare(f),replacement=await candidate(f,p,1,c=>{
  if(c.type!=='closing.record')throw Error();if(kind==='count')return {...c,input:{...c.input,countedCash:c.input.countedCash+1}};if(kind==='choice')return {...c,saleId:null,saleEventId:null,input:{...c.input,addDifference:false}};if(kind==='note')return {...c,input:{...c.input,note:'Different'}};
  if(kind==='physical-time')return {...c,occurredAt:c.occurredAt-1};if(kind==='closing-parent')return {...c,closingId:id(83000)};return {...c,saleId:id(83001),saleEventId:id(83002)};
 });const before=await state(),start=await counts();await expect(finish(p,'replaced',replacement)).rejects.toMatchObject({code:'22023'});expect(await state()).toEqual(before);expect(await counts()).toEqual(start);
});
it.each(['cash-amount','count','currency','audit','audit-before','audit-after','audit-extra','missing-cash','missing-audit'])('rejects forged service %s records atomically',async mode=>{
 const f=fresh();await sql.seed(f);const p=await sql.prepare(f),replacement=await candidate(f,p),closing=replacement.records.find(r=>r.table==='day_closings')!,cash=replacement.records.find(r=>r.table==='sales')!,event=replacement.records.find(r=>r.table==='events')!;
 if(mode==='cash-amount')cash.values.amount=Number(cash.values.amount)+1;if(mode==='count')closing.values.counted_cash=Number(closing.values.counted_cash)+1;if(mode==='currency')closing.values.currency='USD';if(mode==='audit')event.values.actor_id=id(888);
 if(mode==='audit-before')event.values.before_data='{}';if(mode==='audit-after')event.values.after_data='{}';if(mode==='audit-extra'){const after=JSON.parse(event.values.after_data as string);after.invented=true;event.values.after_data=JSON.stringify(after);}
 if(mode==='missing-cash')replacement.records=replacement.records.filter(r=>r!==cash);if(mode==='missing-audit')replacement.records=replacement.records.filter(r=>r!==event);
 const before=await state(),start=await counts();await expect(finish(p,'replaced',replacement)).rejects.toBeDefined();expect(await state()).toEqual(before);expect(await counts()).toEqual(start);
});
it('rolls back ordinary closing, cash, audits and receipts if resolution audit insertion fails',async()=>{
 const f=fresh();await sql.seed(f);const p=await sql.prepare(f),replacement=await candidate(f,p),before=await state(),start=await counts();
 await sql.db.exec("create function private.fail_closing_resolution_audit() returns trigger language plpgsql as $$begin if new.command='sync.resolve' then raise exception 'Synthetic audit failure';end if;return new;end$$;create trigger fail_closing_resolution_audit before insert on public.events for each row execute function private.fail_closing_resolution_audit()");
 try{await expect(finish(p,'replaced',replacement)).rejects.toMatchObject({message:'Synthetic audit failure'});expect(await state()).toEqual(before);expect(await counts()).toEqual(start);}finally{await sql.db.exec('drop trigger fail_closing_resolution_audit on public.events;drop function private.fail_closing_resolution_audit()');}
 expect(parseClosingResolutionReceipt(await finish(p,'replaced',replacement),f.packet).outcome).toBe('replaced');
});
it.each(['inactive','unconfirmed','anonymous','banned','identity'])('rechecks live %s access before service completion',async mode=>{
 const f=fresh();await sql.seed(f);const p=await sql.prepare(f),replacement=await candidate(f,p);
 if(mode==='inactive')await sql.db.query('update public.members set active=false where id=$1',[f.context.setup.owner.id]);if(mode==='unconfirmed')await sql.db.query('update auth.users set phone_confirmed_at=null where id=$1',[uid(1)]);if(mode==='anonymous')await sql.db.query('update auth.users set is_anonymous=true where id=$1',[uid(1)]);if(mode==='banned')await sql.db.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1",[uid(1)]);if(mode==='identity')await sql.db.query('update public.members set auth_user_id=null where id=$1',[f.context.setup.owner.id]);
 const before=await state();await expect(finish(p,'replaced',replacement)).rejects.toMatchObject({code:'42501'});expect(await state()).toEqual(before);
});
it.each(['review-expired','normal-expired','snapshot','normal-snapshot','token','normal-token'])('retains source and data after %s',async mode=>{
 const f=fresh();await sql.seed(f);let p=await sql.prepare(f) as {id:string;token:string};const replacement=await candidate(f,p);
 if(mode==='review-expired')await sql.db.query('update private.closing_review_tickets set expires_at=0 where id=$1',[p.id]);if(mode==='normal-expired')await sql.db.query('update private.closing_write_tickets set expires_at=0 where id=$1',[replacement.id]);if(mode==='snapshot')await sql.db.query('update public.outlets set name=$1 where id=$2',[JSON.stringify('Changed'),f.row.outletId]);if(mode==='normal-snapshot')await sql.db.query("update private.closing_write_tickets set snapshot_hash=sha256('changed'::bytea) where id=$1",[replacement.id]);if(mode==='token')p={...p,token:'z'.repeat(43)};if(mode==='normal-token')replacement.token='z'.repeat(43);
 const before=await state(),start=await counts();await expect(finish(p,'replaced',replacement)).rejects.toBeDefined();expect(await state()).toEqual(before);expect(await counts()).toEqual(start);expect((await sql.db.query<{n:number}>('select count(*)::int n from private.closing_review_tickets')).rows[0].n).toBe(1);
});
it('does not reserve existing closing/cash parents when an undo is withdrawn',async()=>{
 const f=fresh('undo-surplus');await sql.seed(f);const p=await sql.prepare(f);await finish(p);const reserved=(await sql.db.query<{ids:string[]}>('select reserved_ids ids from private.closing_command_resolutions')).rows[0].ids;
 expect(reserved).toContain(f.command.id);expect(reserved).toContain(f.command.saleEventId);expect(reserved).not.toContain(f.command.closingId);expect(reserved).not.toContain(f.command.saleId);
});
it('returns genuine original success before expired review state and never adds a second resolution',async()=>{
 const f=fresh();await sql.seed(f);const p=await sql.prepare(f),c=f.command,ticket=id(84000),normal=await sql.asRole(1,'authenticated','select public.prepare_closing_write($1,$2,$3,$4,$5,$6,$7) data',[c.id,ticket,c.type,c.outletId,JSON.stringify(closingWritePlan(c)),await closingFingerprint(c),c.occurredAt]),fields=closingWriteFields(normal,c,ticket);
 const receipt=await sql.asRole(null,'service_role','select public.finish_closing_write($1,$2,$3) data',[ticket,fields.p_token,JSON.stringify(fields.p_records)]);await sql.db.exec('update private.closing_review_tickets set expires_at=0');
 expect(await finish(p)).toEqual(receipt);expect((await counts()).resolutions).toBe(0);expect((await counts()).receipts).toBe(1);
});
async function normalSave(c:ClosingCommand,ticket=id(85000)){
 const prepared=await sql.asRole(1,'authenticated','select public.prepare_closing_write($1,$2,$3,$4,$5,$6,$7) data',[c.id,ticket,c.type,c.outletId,JSON.stringify(closingWritePlan(c)),await closingFingerprint(c),c.occurredAt]),fields=closingWriteFields(prepared,c,ticket);
 return sql.asRole(null,'service_role','select public.finish_closing_write($1,$2,$3) data',[ticket,fields.p_token,JSON.stringify(fields.p_records)]);
}
it('blocks resurrection of withdrawn created IDs while allowing a separately chosen fresh closing',async()=>{
 const f=fresh();await sql.seed(f);await finish(await sql.prepare(f));const before=await state();
 await expect(normalSave({...f.command,id:id(85001)})).rejects.toMatchObject({code:'PT409'});expect(await state()).toEqual(before);
 const c={...f.command,id:id(85002),closingId:id(85003),saleId:id(85004),saleEventId:id(85005)};expect(await normalSave(c,id(85006))).toMatchObject({id:c.id,closingId:c.closingId});expect((await counts()).resolutions).toBe(1);
});
it('permits a fresh explicit undo of existing parents after withdrawing the earlier undo',async()=>{
 const f=fresh('undo-surplus');await sql.seed(f);await finish(await sql.prepare(f));const c={...f.command,id:id(86000),saleEventId:id(86001)};
 expect(await normalSave(c)).toMatchObject({id:c.id,closingId:c.closingId,undoOf:c.closingId});expect((await counts()).resolutions).toBe(1);
});
it('retains original undo currency/timezone when current outlet settings change',async()=>{
 const f=fresh('undo-surplus');await sql.seed(f);await sql.db.query("update public.outlets set currency='USD',timezone='America/Los_Angeles' where id=$1",[f.row.outletId]);
 const p=await sql.prepare(f),replacement=await candidate(f,p),result=parseClosingResolutionReceipt(await finish(p,'replaced',replacement),f.packet);
 expect(result.replacement?.receipt.day).toBe(f.created.closing.day);expect((await sql.db.query<{currency:string;timezone:string}>('select currency,timezone from public.day_closings where id=$1',[f.command.closingId])).rows[0]).toEqual({currency:'BDT',timezone:'Asia/Dhaka'});
});
it('rejects an expired original-day undo despite a forged earlier normal admission clock',async()=>{
 const f=fixture('undo-surplus',{at:Date.now()-86410000});await sql.seed(f);const p=await sql.prepare(f),c=reviewedClosingProposal(f.command,f.packet.replacementId,null),ticket=id(87000),token='r'.repeat(43),hash=await closingFingerprint(c),plan=closingWritePlan(c),at=c.occurredAt+1000;
 const raw=(await sql.db.query<{data:string}>('select private.closing_write_context($1,$2,$3,$4,$5)::text data',[f.row.businessId,c.outletId,f.context.setup.owner.id,c.type,JSON.stringify(plan)])).rows[0].data;
 const {intentJson,...storedPlan}=plan;expect(intentJson).toBe(JSON.stringify(c));
 await sql.db.query("insert into private.closing_write_tickets(id,command_id,business_id,outlet_id,actor_id,auth_user_id,type,plan,occurred_at,request_hash,snapshot_hash,token_hash,created_at,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,sha256(convert_to($11,'UTF8')),sha256(convert_to($12,'UTF8')),$13,$14)",[ticket,c.id,f.row.businessId,c.outletId,f.context.setup.owner.id,uid(1),c.type,JSON.stringify(storedPlan),c.occurredAt,hash,raw,token,at,Date.now()+60000]);
 const replacement={id:ticket,token,hash,records:replayClosingRecords({businessId:f.row.businessId,outletId:c.outletId,actorId:f.context.setup.owner.id,at,contextJson:raw},c),command:c},before=await state();
 await expect(finish(p,'replaced',replacement)).rejects.toMatchObject({code:'PT409'});expect(await state()).toEqual(before);expect((await counts()).resolutions).toBe(0);
});
it('completes maximum imported text without truncating normalized rows or literal source',async()=>{
 const f=fresh('undo-surplus'),note='ন'.repeat(999998)+'\0\ud800',name='N'.repeat(1_000_000);f.created.closing.note=note;f.created.closing.createdByName=name;
 const change=undoClosingCommand(f.created.closing,f.context.setup,f.created.sale,f.command.occurredAt,kind=>kind==='event'?f.command.id:f.command.saleEventId!),source=JSON.parse(f.packet.sourceJson);source.events=closingReviewSourceAudits(f.command,change.events);f.packet.sourceJson=JSON.stringify(source);
 await sql.seed(f);const p=await sql.prepare(f),replacement=await candidate(f,p);expect(new TextEncoder().encode(JSON.stringify(replacement.records)).length).toBeGreaterThan(256000);
 const result=parseClosingResolutionReceipt(await finish(p,'replaced',replacement),f.packet);expect(result.outcome).toBe('replaced');
 const saved=(await sql.db.query<{note:string;name:string}>('select note::text note,created_by_name::text name from public.day_closings where id=$1',[f.command.closingId])).rows[0];expect(JSON.parse(saved.note)===note).toBe(true);expect(JSON.parse(saved.name)===name).toBe(true);
 const archived=(await sql.db.query<{source:string;bytes:number}>('select source_json source,octet_length(source_json)::int bytes from private.closing_command_resolutions')).rows[0];expect(archived.source===f.packet.sourceJson).toBe(true);expect(archived.bytes).toBeGreaterThan(8000000);
 const downloaded=await canonical(f);await expect(closingReviewBoundary(downloaded.tables.events,f.command.outletId)).resolves.toHaveProperty('assert');
},30000);
it('denies direct client completion helpers and exposes no public definer',async()=>{
 const signature='private.finish_closing_review(public.ulid,text,text,public.ulid,text,text,jsonb)';for(const role of ['anon','authenticated','service_role'])expect((await sql.db.query<{allowed:boolean}>('select has_function_privilege($1,$2,\'execute\') allowed',[role,signature])).rows[0].allowed).toBe(role==='service_role');
 expect((await sql.db.query<{n:number}>("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef")).rows[0].n).toBe(0);
});
it('preserves the established opaque-token semantics for escaped strings, literals, nesting and key order',async()=>{
 const texts=['','বাংলা\0\ud800','back\\slash','quote"colon: value',': ","x":1','\n\t\r','\\u0000','🧾',String.fromCharCode(0xdfff)],values:unknown[]=[null,true,42,-123.5,...texts];
 for(let i=0;i<60;i++)values.push({a:texts[i%texts.length]+texts[(i*7+2)%texts.length],nested:{z:[texts[(i+3)%texts.length],i,null,false]},order:i});
 for(const value of values){const json=JSON.stringify(value);expect((await sql.db.query<{equal:boolean}>('select private.closing_audit_tokens($1::json)=private.inbox_json_tokens($1::json) equal',[json])).rows[0].equal).toBe(true);}
 expect((await sql.db.query<{equal:boolean}>('select private.closing_audit_tokens($1::json)=private.closing_audit_tokens($2::json) equal',[JSON.stringify({b:'\0',a:'\ud800'}),JSON.stringify({a:'\ud800',b:'\0'},null,2)])).rows[0].equal).toBe(true);
});
