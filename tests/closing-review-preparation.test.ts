import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {closingReviewFields} from '../supabase/functions/_shared/closing-review';
import {closingWriteFields} from '../supabase/functions/_shared/closing-write';
import {closingFingerprint} from '../packages/core/closing-replay';
import {closingWritePlan} from '../packages/core/closing-commands';
import {closingReviewFacts,closingReviewSourceAudits} from '../packages/core/closing-review-source';
import {undoClosingCommand} from '../packages/core/closing';
import {fixture,id,modes} from './closing-review-fixture';
import {createClosingReviewDatabase,uid,type ClosingReviewDatabase} from './closing-review-sql-fixture';
let sql:ClosingReviewDatabase;
beforeAll(async()=>{sql=await createClosingReviewDatabase();},30000);
beforeEach(async()=>{await sql.reset();});
afterAll(async()=>{await sql.db?.close();});
const fresh=(mode:Parameters<typeof fixture>[0]='surplus')=>fixture(mode,{at:Date.now()-10000});

it.each(modes)('prepares original %s source with actual scoped SQL state and no shop writes',async mode=>{
 const f=fresh(mode);await sql.seed(f);const before=(await sql.db.query<{n:number}>('select count(*)::int n from public.events')).rows[0].n,p=await sql.prepare(f),selected=await closingReviewFields(p,f.packet);
 expect(selected.view.commandId).toBe(f.command.id);expect(selected.view.actorId).toBe(f.context.setup.owner.id);expect(selected.view.current.stateHash).toMatch(/^[a-f0-9]{64}$/);expect(selected.view.proposal.enabled).toBe(true);expect(await sql.read(p)).toEqual(p);
 const stored=(await sql.db.query<{source:string;intent:string;secret:string;facts:unknown}>('select source_json source,original_intent intent,encode(token_hash,\'hex\') secret,facts from private.closing_review_tickets')).rows[0];
 expect(stored.source).toBe(f.packet.sourceJson);expect(stored.intent).toBe(JSON.stringify(f.command));expect(stored.facts).toEqual(closingReviewFacts(f.packet));expect(stored.secret).not.toBe((p as {token:string}).token);
 expect((await sql.db.query<{n:number}>('select count(*)::int n from public.events')).rows[0].n).toBe(before);
});
it('lets an assigned manager review only their own original physical action',async()=>{
 const f=fresh();await sql.seed(f);sql.memberSource(f,id(700002));const p=await sql.prepare(f,2);expect((await closingReviewFields(p,f.packet)).view.actorId).toBe(id(700002));await expect(sql.prepare(f,1)).rejects.toMatchObject({code:'42501'});
});
it.each([3,4,5])('denies role/member %s even with owner user_metadata',async n=>{const f=fresh();await sql.seed(f);await expect(sql.prepare(f,n)).rejects.toMatchObject({code:'42501'});});
it.each(['inactive','unconfirmed','anonymous','wrong-account'])('rechecks actual %s authorization on read',async mode=>{
 const f=fresh();await sql.seed(f);const p=await sql.prepare(f);
 if(mode==='inactive')await sql.db.query('update public.members set active=false where id=$1',[f.context.setup.owner.id]);
 if(mode==='unconfirmed')await sql.db.query('update auth.users set phone_confirmed_at=null where id=$1',[uid(1)]);
 if(mode==='anonymous')await sql.db.query('update auth.users set is_anonymous=true where id=$1',[uid(1)]);
 await expect(sql.read(p,mode==='wrong-account'?2:1)).rejects.toMatchObject({code:'42501'});
});
it('refuses a wrong token, expired preparation or changed full snapshot',async()=>{
 const f=fresh();await sql.seed(f);const p=await sql.prepare(f) as {id:string;token:string};await expect(sql.read({...p,token:'x'.repeat(43)})).rejects.toMatchObject({code:'PT409'});
 await sql.db.query('update private.closing_review_tickets set expires_at=0 where id=$1',[p.id]);await expect(sql.read(p)).rejects.toMatchObject({code:'PT409'});
 const current=await sql.prepare(f);await sql.db.query('update public.outlets set name=$1 where id=$2',[JSON.stringify('Changed name'),f.row.outletId]);await expect(sql.read(current)).rejects.toMatchObject({code:'PT409'});
});
it('returns an actual original receipt before stale state and expiry checks',async()=>{
 const f=fresh();await sql.seed(f);const review=await sql.prepare(f),c=f.command,ticket=id(80000),normal=await sql.asRole(1,'authenticated','select public.prepare_closing_write($1,$2,$3,$4,$5,$6,$7) data',[c.id,ticket,c.type,c.outletId,JSON.stringify(closingWritePlan(c)),await closingFingerprint(c),c.occurredAt]),fields=closingWriteFields(normal,c,ticket);
 const receipt=await sql.asRole(null,'service_role','select public.finish_closing_write($1,$2,$3) data',[fields.p_ticket_id,fields.p_token,JSON.stringify(fields.p_records)]);
 await sql.db.exec('update private.closing_review_tickets set expires_at=0');expect(await sql.read(review)).toEqual({done:true,receipt});expect(await sql.prepare(f)).toEqual({done:true,receipt});
});
it.each(['intent','facts','physical-time','parent','extra-facts','unit','source-size'])('denies altered %s preparation fields',async mode=>{
 const f=fresh();await sql.seed(f);const extra:Record<string,unknown>={},facts=closingReviewFacts(f.packet);
 if(mode==='intent')extra.p_intent_json=JSON.stringify({...f.command,extra:true});if(mode==='facts')facts.countedCash++;if(mode==='physical-time')extra.p_occurred_at=f.command.occurredAt+1;if(mode==='parent')extra.p_closing_id=id(3333);if(mode==='extra-facts')(facts as unknown as Record<string,unknown>).extra=true;if(mode==='unit')facts.currency='usd';if(mode==='source-size')extra.p_source_json=' '.repeat(16000001);
 extra.p_facts=facts;await expect(sql.prepare(f,1,{},extra)).rejects.toMatchObject({code:'22023'});
});
it('checks exact source/command hashes and every preparation scalar before constructing a view',async()=>{
 const f=fresh();await sql.seed(f);const original=await sql.prepare(f) as Record<string,unknown>;
 for(const field of ['id','replacementId','closingId','saleId','saleEventId','actorId','sourceHash','sourceJsonHash','commandHash','occurredAt','facts']){
  const changed={...original,[field]:field==='facts'?{}:field==='occurredAt'?0:id(1234)};await expect(closingReviewFields(changed,f.packet)).rejects.toThrow();
 }
});
it('retains complete maximum imported Bengali, NUL and surrogate text through real SQL preparation',async()=>{
 const f=fresh('undo-surplus'),note='ন'.repeat(999998)+'\0\ud800',name='N'.repeat(1_000_000);
 f.created.closing.note=note;f.created.closing.createdByName=name;
 const change=undoClosingCommand(f.created.closing,f.context.setup,f.created.sale,f.command.occurredAt,kind=>kind==='event'?f.command.id:f.command.saleEventId!);
 const source=JSON.parse(f.packet.sourceJson);source.events=closingReviewSourceAudits(f.command,change.events);f.packet.sourceJson=JSON.stringify(source);
 await sql.seed(f);const packet=await sql.prepare(f),selected=await closingReviewFields(packet,f.packet);
 expect(selected.view.proposal.enabled).toBe(true);if(!selected.view.proposal.enabled)throw Error();expect(selected.view.proposal.closing.note===note).toBe(true);expect(selected.view.proposal.closing.createdByName===name).toBe(true);
 const stored=(await sql.db.query<{source:string}>('select source_json source from private.closing_review_tickets')).rows[0].source;expect(stored===f.packet.sourceJson).toBe(true);expect(JSON.parse(stored).events[0].before.note===note).toBe(true);
},30000);
it('bounds one hundred live opaque preparations without storing plaintext tokens',async()=>{
 const f=fresh();await sql.seed(f);for(let i=0;i<100;i++)await sql.prepare(f,1,{id:id(91000+i),replacementId:id(92000+i)});
 await expect(sql.prepare(f,1,{id:id(93000),replacementId:id(93001)})).rejects.toMatchObject({code:'PT429'});expect((await sql.db.query<{n:number}>('select count(*)::int n from private.closing_review_tickets')).rows[0].n).toBe(100);
},15000);
it('forces RLS and denies all direct table/sequence grants, anonymous admission and public definers',async()=>{
 const f=fresh();await sql.seed(f);const tables=(await sql.db.query<{forced:boolean;rls:boolean}>("select relforcerowsecurity forced,relrowsecurity rls from pg_class where oid in('private.closing_review_tickets'::regclass,'private.closing_command_resolutions'::regclass)")).rows;expect(tables).toHaveLength(2);expect(tables.every(row=>row.forced&&row.rls)).toBe(true);
 for(const role of ['anon','authenticated','service_role'] as const){
  expect((await sql.db.query<{allowed:boolean}>("select has_table_privilege($1,'private.closing_review_tickets','select,insert,update,delete') or has_table_privilege($1,'private.closing_command_resolutions','select,insert,update,delete') or has_sequence_privilege($1,'private.closing_command_resolutions_position_seq','usage,select,update') allowed",[role])).rows[0].allowed).toBe(false);
  await expect(sql.asRole(role==='authenticated'?1:null,role,'select row_to_json(t) data from private.closing_review_tickets t')).rejects.toMatchObject({code:'42501'});
  if(role!=='authenticated')await expect(sql.asRole(null,role,'select public.admit_closing_review($1) data',[f.row.outletId])).rejects.toMatchObject({code:'42501'});
 }
 expect((await sql.db.query<{n:number}>("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef")).rows[0].n).toBe(0);
});
