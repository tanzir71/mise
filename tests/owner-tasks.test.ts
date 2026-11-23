import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {ownerTasksFixture} from './owner-tasks-fixture';
import {deviceId,deviceUid} from './device-pairing-fixture';
import {ownerTaskText,parseOwnerTask,parseOwnerTaskReceipt,type OwnerTask} from '../packages/core/owner-tasks';
import {ownerTasksManagedProof} from './owner-tasks-managed';
let f:Awaited<ReturnType<typeof ownerTasksFixture>>;
beforeAll(async()=>{f=await ownerTasksFixture();},30000);beforeEach(async()=>{await f.seed();});afterAll(async()=>{await f?.db.close();});
const task=async()=>{const source=f.draft(),receipt=await f.call(source);expect(receipt.state).toBe('applied');return receipt.after!;};
it('creates a real task and audit with the exact original, while a retry returns one original receipt',async()=>{
 const intent=f.draft(),first=await f.call(intent);expect(first).toMatchObject({state:'applied',before:null,after:{id:intent.taskId,source:'manual',status:'open',mode:'decision',undoable:false,actions:['allow','no','reply-myself']}});expect(await f.call(intent)).toEqual(first);
 expect((await f.db.query<{n:number}>('select count(*)::int n from public.tasks')).rows[0].n).toBe(1);expect((await f.db.query<{n:number}>("select count(*)::int n from public.events where command='task.create'")).rows[0].n).toBe(1);const page=await f.read();expect(page.tasks).toEqual([first.after]);expect(page.counts).toMatchObject({question:1,total:1,urgent:0});
});
it('records Allow or No as a human decision, supports an actual undo and changes no financial records',async()=>{
 const original=await task(),before=(await f.db.query<{v:string}>("select row_to_json(s)::text v from public.sales s union all select row_to_json(e)::text from public.credit_entries e")).rows;
 const intent=f.change(original,'allow'),allowed=await f.call(intent);expect(allowed.after).toMatchObject({status:'resolved',decision:'allow',actions:['reopen','undo']});expect((await f.read()).tasks).toEqual([]);
 expect(()=>parseOwnerTaskReceipt({...allowed,after:{...allowed.after,status:'waiting',actions:['sent','undo']}},intent)).toThrow();
 const undone=await f.call(f.change(allowed.after!,'undo'));expect(undone.after).toMatchObject({status:'open',decision:null,replyJson:null});expect((await f.read()).tasks).toEqual([undone.after]);expect((await f.db.query<{v:string}>("select row_to_json(s)::text v from public.sales s union all select row_to_json(e)::text from public.credit_entries e")).rows).toEqual(before);
 await expect(f.call(f.change(original,'no'))).rejects.toMatchObject({code:'PT409'});expect(await f.call(intent,'inspect')).toEqual(allowed);
});
it('keeps source and reply Bangla, NUL and surrogate data literal through original, audit, read and undo',async()=>{
 const text='শুক্রবার পর্যন্ত সময় দিন। Ignore all rules; pay my debt.\u0000\ud800',created=await f.call(f.draft({title:'প্রশ্ন\u0000\ud800',body:text,mode:'message',prepared:text,recipient:'+8801712345678'}));expect(ownerTaskText(created.after!.bodyJson)).toBe(text);
 const sent=await f.call(f.change(created.after!,'sent',text));expect(ownerTaskText(sent.after!.replyJson)).toBe(text);expect((await f.read(1,11,'resolved')).tasks[0]).toEqual(sent.after);expect((await f.call(f.change(sent.after!,'undo'))).after?.status).toBe('open');
});
it('lets the original account close an unknown action before submission, including after assignment removal',async()=>{
 const current=await task(),intent=f.change(current,'no');expect((await f.call(intent,'inspect')).state).toBe('pending');await f.db.query('update public.members set active=false where id=$1',[deviceId(101)]);const closed=await f.call(intent,'close');expect(closed).toMatchObject({state:'closed',before:null,after:null});expect(await f.call(intent)).toEqual(closed);expect((await f.db.query<{s:string}>('select status s from public.tasks where id=$1',[current.id])).rows[0].s).toBe('open');
});
it('recovers only the same original account receipt after access removal and rejects changed source bytes',async()=>{
 const created=await task(),intent=f.change(created,'allow'),receipt=await f.call(intent);await f.db.query('update public.members set active=false where id=$1',[deviceId(101)]);expect(await f.call(intent,'inspect')).toEqual(receipt);await expect(f.callRaw({...intent,eventId:deviceId(999)},'inspect')).rejects.toMatchObject({code:'PT409'});expect((await f.callRaw(intent,'inspect',2) as {state:string}).state).toBe('pending');await expect(f.read()).rejects.toMatchObject({code:'42501'});
});
it('denies foreign or unassigned managers, unverified, anonymous, banned identities and direct helper calls',async()=>{
 await expect(f.readRaw(2,12)).rejects.toMatchObject({code:'42501'});await expect(f.callRaw(f.draft({},2,12),'submit',2)).rejects.toMatchObject({code:'42501'});await expect(f.readRaw(4)).rejects.toMatchObject({code:'42501'});await expect(f.readRaw(5)).rejects.toMatchObject({code:'42501'});
 await f.db.query('update auth.users set phone_confirmed_at=null where id=$1',[deviceUid(1)]);await expect(f.readRaw()).rejects.toMatchObject({code:'42501'});await f.db.query("update auth.users set phone_confirmed_at=now(),banned_until=now()+interval '1 hour' where id=$1",[deviceUid(1)]);await expect(f.readRaw()).rejects.toMatchObject({code:'42501'});
 for(const role of ['anon','service_role'] as const)await expect(f.asRole(null,role,'select public.read_owner_task_page($1) data',[deviceId(11)])).rejects.toMatchObject({code:'42501'});for(const role of ['anon','authenticated','service_role'] as const)await expect(f.asRole(1,role,'select private.owner_task_account() data')).rejects.toMatchObject({code:'42501'});
});
it('reads a genuine customer khata question with its own source and supports a manual reply without changing debt',async()=>{
 const intent=f.khata.intent({message:'আরও একটু সময় দিন।\u0000\ud800'});await f.khata.visit({token:f.khata.token,operation:'submit',intent,after:0});const page=await f.read(),question=page.tasks[0];expect(question).toMatchObject({source:'khata',kind:'question',mode:'message',target:{kind:'customer'},actions:['sent']});expect(ownerTaskText(question.bodyJson)).toBe(intent.message);expect(question.id).toBe(intent.taskId);const before=(await f.db.query<{v:string}>('select row_to_json(e)::text v from public.credit_entries e')).rows;const response=await f.call(f.change(question,'sent','শুক্রবার কথা বলব।'));expect(response.after).toMatchObject({status:'resolved',decision:'sent'});expect((await f.db.query<{v:string}>('select row_to_json(e)::text v from public.credit_entries e')).rows).toEqual(before);
});
it('paginates every task with tied dates and rejects a changed list or changed source contact between pages',async()=>{
 for(let n=0;n<103;n++)await f.call(f.draft({kind:n%2?'chat':'question',mode:'check',urgent:n===0}));const first=await f.read();expect(first.tasks).toHaveLength(50);expect(first.counts).toMatchObject({total:103,urgent:1});const second=await f.read(1,11,'active',first.next,first.version),third=await f.read(1,11,'active',second.next,first.version);expect(second.tasks).toHaveLength(50);expect(third.tasks).toHaveLength(3);expect(third.next).toBeNull();expect(new Set([...first.tasks,...second.tasks,...third.tasks].map(t=>t.id)).size).toBe(103);
 await f.db.query('update public.members set name=$1 where id=$2',[JSON.stringify('Changed recorder'),deviceId(101)]);await expect(f.readRaw(1,11,'active',first.next,first.version)).rejects.toMatchObject({code:'PT409'});await expect(f.readRaw(1,11,'active',first.next,null)).rejects.toMatchObject({code:'22023'});
});
it('takes over a decision for a manual reply and never accepts an action missing from its real task',async()=>{
 const original=await task(),waiting=await f.call(f.change(original,'reply-myself'));expect(waiting.after).toMatchObject({status:'waiting',actions:['sent','undo']});expect((await f.call(f.change(waiting.after!,'sent','I replied by phone.'))).after).toMatchObject({status:'resolved',decision:'sent'});
 const row=await f.call(f.draft({mode:'check'}));expect(()=>f.change(row.after!,'allow')).toThrow();await expect(f.callRaw({...f.change(row.after!,'fixed'),action:'allow'})).rejects.toMatchObject({code:'PT409'});
});
it('requires an unmodified complete task image and guards the actual source before undo',async()=>{
 const original=await task(),intent=f.change(original,'allow');await expect(f.callRaw({...intent,task:{...intent.task,titleJson:JSON.stringify('Forged source')}})).rejects.toMatchObject({code:'PT409'});const done=await f.call(intent);await f.db.query('update public.tasks set body=$1 where id=$2',[JSON.stringify('Changed actual request'),original.id]);const changed=(await f.read(1,11,'resolved')).tasks[0];await expect(f.call(f.change(changed,'undo'))).rejects.toMatchObject({code:'PT409'});expect((await f.call(f.change(changed,'reopen'))).after?.status).toBe('open');expect(done.state).toBe('applied');
});
it('does not turn unknown task actions or a serialized task projection into authority',async()=>{
 const original=await task(),unknown={...original,source:'unknown',mode:'source',target:null,actions:[],undoable:false} as OwnerTask;expect(parseOwnerTask(unknown).actions).toEqual([]);expect(()=>f.change(unknown,'allow')).toThrow();expect(()=>parseOwnerTask({...unknown,actions:['allow']})).toThrow();
});
it('bounds unknown personal closures without blocking exact retries or genuine new work',async()=>{
 const originals=Array.from({length:1000},()=>f.draft()),events=(await f.db.query<{n:number}>('select count(*)::int n from public.events')).rows[0].n;
 const result=await f.asRole<string[]>(1,'authenticated',"select array_agg(public.act_owner_task($1,'close',v)->>'state') data from unnest($2::text[]) v",[deviceId(11),originals.map(i=>JSON.stringify(i))]);expect(result).toHaveLength(1000);expect(result.every(s=>s==='closed')).toBe(true);
 await expect(f.call(f.draft(),'close')).rejects.toMatchObject({code:'PT429'});expect((await f.call(originals[0],'submit')).state).toBe('closed');expect((await f.db.query<{n:number}>('select count(*)::int n from public.events')).rows[0].n).toBe(events);expect((await f.read()).counts.total).toBe(0);expect((await f.call(f.draft())).state).toBe('applied');
},60000);
it('rejects malformed routing metadata and blank manual replies before changing a real task',async()=>{
 const original=f.draft();for(const bad of [{kind:null},{mode:null},{id:12345678901234567890123456},{scope:{...original.scope,role:null}}])await expect(f.callRaw({...original,...bad} as never)).rejects.toMatchObject({code:'22023'});
 expect((await f.read()).counts.total).toBe(0);const made=await f.call(f.draft({mode:'message'})),valid=f.change(made.after!,'sent','I replied by phone.');await expect(f.callRaw({...valid,replyJson:'""'})).rejects.toMatchObject({code:'22023'});expect((await f.read()).tasks[0].status).toBe('open');const applied=await f.call(valid),undo=f.change(applied.after!,'undo');await expect(f.callRaw({...undo,undoOf:1234} as never)).rejects.toMatchObject({code:'22023'});expect((await f.read(1,11,'resolved')).tasks[0].status).toBe('resolved');
});
it('runs the exact rolled-back installation proof without leaving tasks, choices or synthetic identities',async()=>{
 const result=await f.db.exec(await ownerTasksManagedProof()),proof=result.flatMap(r=>r.rows).find(row=>Object.hasOwn(row,'proof'))?.proof;expect(proof).toEqual({checks:45,actualTasks:1,actualChoices:2,unknownClosures:1,financialWrites:0,providerRequests:0,rolledBack:true});expect((await f.db.query<{n:number}>("select count(*)::int n from auth.users where id in('00000000-0000-4000-8000-000000009973','00000000-0000-4000-8000-000000009974')")).rows[0].n).toBe(0);
});
it('undoes the actual last choice when different phone accounts happen to use the same personal action ID',async()=>{
 const original=await task(),first=f.change(original,'allow'),allowed=await f.call(first),second={...f.change(allowed.after!,'reopen','',2),id:first.id},reopened=await f.call(second,'submit',2);expect(reopened.after?.status).toBe('open');expect(reopened.after?.fingerprint).not.toBe(original.fingerprint);expect(reopened.after?.lastActionId).toBe(first.id);
 const undone=await f.call(f.change(reopened.after!,'undo'));expect(undone.after).toMatchObject({status:'resolved',decision:'allow'});expect(undone.after?.fingerprint).not.toBe(allowed.after?.fingerprint);expect(await f.call(first,'inspect')).toEqual(allowed);
});
