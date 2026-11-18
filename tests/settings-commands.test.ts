import 'fake-indexeddb/auto';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync,readdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {setupCommand} from '../packages/core/setup';
import {createBackup} from '../packages/core/backup';
import {emptyBackupTables} from '../packages/core/backup-tables';
import {prepareCloudMigration,decodeCommandRecord,type CloudRecord} from '../packages/core/cloud-records';
import {defaultCreditMessaging} from '../packages/core/khata-messages';
import {exportDatasets} from '../packages/core/exports';
import {newInboxId} from '../packages/core/inbox';
import {parseSettingsCommand,parseSettingsCommandReceipt,settingsWritePlan,type SettingsCommand,type SettingsCommandReceipt} from '../packages/core/settings-commands';
import {settingsFingerprint,settingsWriteFields} from '../supabase/functions/_shared/settings-write';
import {createCommandsHandler,createCommandStore} from '../supabase/functions/_shared/commands-handler';
import {MiseDatabase} from '../apps/web/src/data/db';
import {CloudUploadJournal,uploadWithLocalOutbox} from '../apps/web/src/data/cloud-upload';
import {assertLocalUploadCoverage,deliverLocalOutbox} from '../apps/web/src/data/local-outbox';
import {MemoryCloudUpload,uploadId} from './cloud-upload-fixture';
import {settingsHostedProofSql} from './settings-hosted-fixture';

const uid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,literal='ওয়ার্ড\0'+String.fromCharCode(0xd800),origin='https://shop.test';
let sql:PGlite,source:ReturnType<typeof setupCommand>,branch:ReturnType<typeof setupCommand>,foreign:ReturnType<typeof setupCommand>;
const actors:{n:number;id:string;role:string;outlet:string;business:string}[]=[];let lastError='';
async function asRole<T>(n:number|null,role:'anon'|'authenticated'|'service_role',query:string,args:unknown[]=[]){return sql.transaction(async tx=>{await tx.exec(`set local role ${role}`);await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role,...(n?{sub:uid(n)}:{}),user_metadata:{role:'owner',businessId:'spoof'}})]);return (await tx.query<T>(query,args)).rows;});}
async function insert(records:readonly CloudRecord[]){for(const r of records){const keys=Object.keys(r.values);await sql.query(`insert into public.${r.table}(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(r.values));}}
function command(type:SettingsCommand['type']='khata.wording',outletId=source.snapshot.outlet.id):SettingsCommand{
 const occurredAt=Date.now()-5000;
 return parseSettingsCommand({id:newInboxId(),type,outletId,occurredAt,input:type==='khata.wording'?{paymentNote:' '+literal+' ',templates:{gentle:{en:' {name} {shop} {amount} '+literal+' ',bn:' {name} {shop} {amount} '+literal+' '},direct:{en:' {name} {shop} {amount} '+literal+' ',bn:' {name} {shop} {amount} '+literal+' '}}}:{format:'csv',datasets:['sales','credit'],rows:17,filename:'prepared-'+String.fromCharCode(0xd800)+'.csv',capturedAt:occurredAt-1000,from:'2026-11-01',to:'2026-11-18',includePhones:false}});
}
async function prepare(c:SettingsCommand,n=1,plan= settingsWritePlan(c),ticket=newInboxId()){return (await asRole<{data:Record<string,unknown>}>(n,'authenticated','select public.prepare_settings_write($1,$2,$3,$4,$5,$6,$7) data',[c.id,ticket,c.type,c.outletId,JSON.stringify(plan),await settingsFingerprint(c),c.occurredAt]))[0].data;}
async function finish(p:Record<string,unknown>,c:SettingsCommand,change?:(fields:Record<string,unknown>)=>void){const fields=settingsWriteFields(p,c,p.ticketId as string);change?.(fields);return (await asRole<{data:SettingsCommandReceipt}>(null,'service_role','select public.finish_settings_write($1,$2,$3) data',[fields.p_ticket_id,fields.p_token,fields.p_input_json]))[0].data;}
async function accepted(c:SettingsCommand,n=1){const p=await prepare(c,n);return parseSettingsCommandReceipt(p.done?p.receipt:await finish(p,c),c);}
async function outlet(id=source.snapshot.outlet.id){return (await sql.query<{data:Record<string,unknown>}>('select row_to_json(o) data from public.outlets o where id=$1',[id])).rows[0].data;}
async function events(){return (await sql.query<{data:Record<string,unknown>}>('select row_to_json(e) data from public.events e order by at,id')).rows.map(r=>decodeCommandRecord('events',r.data));}
async function counts(){return (await sql.query<{events:number;receipts:number;sales:number;entries:number}>('select (select count(*)::int from public.events) events,(select count(*)::int from private.shop_command_receipts) receipts,(select count(*)::int from public.sales) sales,(select count(*)::int from public.credit_entries) entries')).rows[0];}
function nativeStore(beforeFinish?:(args:Record<string,unknown>)=>Promise<void>){return createCommandStore('https://database.test','sb_publishable_test_only',async(url,options)=>{
 const name=new URL(String(url)).pathname.split('/').at(-1)!,headers=new Headers(options?.headers),args=JSON.parse(options?.body as string),service=headers.get('apikey')==='sb_secret_test_only',n=service?null:Number(headers.get('Authorization')!.split('.')[1]);
 const names:Record<string,string[]>={prepare_settings_write:['p_id','p_ticket_id','p_type','p_outlet_id','p_plan','p_hash','p_occurred_at'],finish_settings_write:['p_ticket_id','p_token','p_input_json']};if(!names[name])throw Error('Unexpected RPC');expect(Object.keys(args).sort()).toEqual([...names[name]].sort());expect(service).toBe(name==='finish_settings_write');if(service){expect(headers.has('Authorization')).toBe(false);await beforeFinish?.(args);}
 try{const values=names[name].map(k=>typeof args[k]==='object'?JSON.stringify(args[k]):args[k]),r=await asRole<{data:unknown}>(n,service?'service_role':'authenticated',`select public.${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) data`,values);return Response.json(r[0].data);}
 catch(error){const e=error as {code?:string;message?:string;detail?:string};lastError=(e.code??'')+': '+(e.message??'');return Response.json({code:e.code,details:e.detail,message:'PRIVATE BACKEND DETAILS'},{status:e.code==='42501'?403:e.code==='PT409'||e.code==='23505'?409:e.code==='22023'?400:503});}
 },{serviceKey:'sb_secret_test_only'});}
beforeAll(async()=>{
 sql=await PGlite.create();for(const f of ['supabase-auth.sql','supabase-storage.sql'])await sql.exec(readFileSync(new URL('./fixtures/'+f,import.meta.url),'utf8'));const dir=new URL('../supabase/migrations/',import.meta.url);for(const f of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())await sql.exec(readFileSync(new URL(f,dir),'utf8'));
 for(const n of [1,2,3,4,5,6])await sql.query('insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,now())',[uid(n),'1415555010'+n]);
 const input={businessType:'corner_shop' as const,marketCode:'BD' as const,name:literal,phone:'01712345482'};source=setupCommand(input);branch=setupCommand({...input,name:'Branch'});foreign=setupCommand({...input,name:'Foreign'});branch.snapshot.business=source.snapshot.business;branch.snapshot.outlet.businessId=source.snapshot.business.id;branch.snapshot.owner={...source.snapshot.owner,outletIds:[branch.snapshot.outlet.id]};
 for(const [s,n,skip] of [[source,1,false],[branch,1,true],[foreign,4,false]] as const){const t=emptyBackupTables();t.businesses.push(s.snapshot.business);t.outlets.push(s.snapshot.outlet);t.members.push(s.snapshot.owner);t.categories.push(...s.categories);t.items.push(...s.items);const p=await prepareCloudMigration(createBackup(t),uid(n));await insert(p.records.filter(r=>!(skip&&['businesses','members'].includes(r.table))));}
 actors.push({n:1,id:source.snapshot.owner.id,role:'owner',outlet:source.snapshot.outlet.id,business:source.snapshot.business.id},{n:4,id:foreign.snapshot.owner.id,role:'owner',outlet:foreign.snapshot.outlet.id,business:foreign.snapshot.business.id});
 for(const [n,role,id] of [[2,'manager',source.snapshot.outlet.id],[3,'manager',branch.snapshot.outlet.id],[5,'staff',source.snapshot.outlet.id],[6,'agent',source.snapshot.outlet.id]] as const){const member=newInboxId();await sql.query('insert into public.members(id,business_id,auth_user_id,name,role,created_at,updated_at) values($1,$2,$3,$4,$5,1,1)',[member,source.snapshot.business.id,uid(n),'"Person"',role]);actors.push({n,id:member,role,outlet:id,business:source.snapshot.business.id});}
},30_000);
beforeEach(async()=>{lastError='';await sql.exec("truncate public.events cascade;delete from private.settings_write_tickets;update public.outlets set credit_messaging=null,shop_link='https://shop.test/old',order_warning_minutes=7,updated_at=created_at;update auth.users set phone='1415555010'||right(id::text,1),phone_confirmed_at=now(),banned_until=null,deleted_at=null;update public.members set active=true");for(const a of actors){await sql.query('update public.members set role=$1,auth_user_id=$2 where id=$3',[a.role,uid(a.n),a.id]);await sql.query('delete from public.member_outlets where member_id=$1',[a.id]);await sql.query('insert into public.member_outlets values($1,$2,$3)',[a.business,a.id,a.outlet]);}});
afterAll(async()=>{await sql?.close();});

it('the exact hosted SQL-role proof retains both command families and rolls back all synthetic identities and records',async()=>{
 const result=await sql.exec(await settingsHostedProofSql()),row=result.at(-1)!.rows[0] as {proof:Record<string,unknown>;auth_rows:number;business_rows:number;ticket_rows:number};expect(row).toMatchObject({auth_rows:0,business_rows:0,ticket_rows:0,proof:{commands:4,receipts:4,audits:4,pendingTickets:0}});for(const value of Object.values(row.proof))if(typeof value==='boolean')expect(value).toBe(true);
});

it.each(['actor','credential','language','placeholder','length'] as const)('rejects unplanned %s fields or invalid reminder wording before admission',kind=>{
 const c=command();if(c.type!=='khata.wording')throw Error();if(kind==='actor')Object.assign(c,{actorId:source.snapshot.owner.id});if(kind==='credential')Object.assign(c.input,{access_token:'untrusted-client-field'});if(kind==='language')Object.assign(c.input.templates.gentle,{fr:'unplanned'});if(kind==='placeholder')c.input.templates.gentle.en='{name} {shop} {amount} {accountKey}';if(kind==='length')c.input.paymentNote='x'.repeat(251);expect(()=>parseSettingsCommand(c)).toThrow();
});
it.each(['date','range','filename','datasets','rows'] as const)('rejects invalid prepared-export %s without accepting a file or record graph',kind=>{
 const c=command('export.prepare');if(c.type!=='export.prepare')throw Error();if(kind==='date')c.input.from='2026-02-30';if(kind==='range')c.input.from='2027-01-01';if(kind==='filename')c.input.filename='../private.json';if(kind==='datasets')c.input.datasets=['sales','sales'];if(kind==='rows')c.input.rows=1.5;expect(()=>parseSettingsCommand(c)).toThrow();
});
it('the full escaped reminder payload fits the ordinary authenticated command limit and retains every code unit',async()=>{
 const c=command();if(c.type!=='khata.wording')throw Error();const template='{name}{shop}{amount}'+'\0'.repeat(980);c.input={paymentNote:'\0'.repeat(250),templates:{gentle:{en:template,bn:template},direct:{en:template,bn:template}}};expect(template.length).toBe(1000);expect(new TextEncoder().encode(JSON.stringify(c)).length).toBeLessThan(32000);const handler=createCommandsHandler({store:nativeStore(),origins:new Set([origin])}),response=await handler(new Request('https://edge.test/commands',{method:'POST',headers:{Origin:origin,Authorization:'Bearer caller.1.sig','Content-Type':'application/json'},body:JSON.stringify(c)}));expect(response.status,lastError).toBe(200);expect((await outlet()).credit_messaging).toEqual(c.input);
});

it.each([1,2])('operator %s saves literal wording with the original audit identity and only the allowed outlet fields',async n=>{
 const c=command(),before=await outlet(),r=await accepted(c,n),after=await outlet(),[event]=await events();expect(c.type).toBe('khata.wording');expect(after.credit_messaging).toEqual(c.input);expect(after.updated_at).toBe(r.outletUpdatedAt);expect({...after,credit_messaging:null,updated_at:before.updated_at}).toEqual(before);expect(event).toMatchObject({id:c.id,command:c.type,at:r.at,actor:{id:actors.find(a=>a.n===n)!.id},before:decodeCommandRecord('outlets',before),after:decodeCommandRecord('outlets',after)});expect(await counts()).toEqual({events:1,receipts:1,sales:0,entries:0});
});
it.each(['csv','xlsx','pdf','json','zip'] as const)('records %s preparation metadata without changing shop data or claiming a download',async format=>{
 const c=command('export.prepare');if(c.type!=='export.prepare')throw Error();c.input.format=format;c.input.datasets=format==='json'?[]:[...exportDatasets];const before=await outlet(),r=await accepted(c),[event]=await events();expect(await outlet()).toEqual(before);expect(r.outletUpdatedAt).toBeNull();expect(event).toMatchObject({id:c.id,command:'export.prepare',before:null,after:c.input,at:r.at});expect(event).not.toHaveProperty('downloaded');expect(await counts()).toEqual({events:1,receipts:1,sales:0,entries:0});
});
it.each([3,4,5,6])('identity %s cannot use editable metadata to obtain scoped shop writes',async n=>{await expect(prepare(command(),n)).rejects.toMatchObject({code:'42501'});expect(await counts()).toEqual({events:0,receipts:0,sales:0,entries:0});});
it('replays the original historical receipt without restoring older wording and denies changed intent under the same ID',async()=>{
 const c=command(),first=await accepted(c),next=command();if(next.type!=='khata.wording')throw Error();next.input.paymentNote='New payment instructions';await accepted(next);expect(await accepted(c)).toEqual(first);expect((await outlet()).credit_messaging).toEqual(next.input);const forged=structuredClone(c);forged.occurredAt++;await expect(prepare(forged)).rejects.toMatchObject({code:'23505'});expect((await counts()).events).toBe(2);
});
it('a service cannot substitute normalized fields after the original proof was bound',async()=>{
 const c=command(),p=await prepare(c),before=await outlet();await expect(finish(p,c,fields=>{fields.p_input_json=JSON.stringify(defaultCreditMessaging);})).rejects.toMatchObject({code:'22023'});expect(await outlet()).toEqual(before);expect((await counts()).events).toBe(0);await finish(p,c);expect((await counts()).events).toBe(1);
});
it.each(['intent','time','outlet','field'] as const)('binds the claimed fingerprint to the exact original %s',async kind=>{
 const c=command(),plan=settingsWritePlan(c),original=structuredClone(c);if(kind==='intent')plan.intentJson=JSON.stringify({...c,id:newInboxId()});if(kind==='time')c.occurredAt++;if(kind==='outlet')c.outletId=branch.snapshot.outlet.id;if(kind==='field'&&'paymentNoteJson'in plan.input)plan.input.paymentNoteJson='"Changed"';
 await expect(prepare(c,1,plan)).rejects.toMatchObject({code:'22023'});expect((await counts()).events).toBe(0);expect(original.id).toBe(c.id);
});
it('requires live assignment and confirmed Auth again at completion',async()=>{
 const c=command(),p=await prepare(c,2);await sql.query('delete from public.member_outlets where member_id=$1',[actors.find(a=>a.n===2)!.id]);await expect(finish(p,c)).rejects.toMatchObject({code:'42501'});expect((await counts()).events).toBe(0);
});
it('replay cannot bypass later Auth revocation',async()=>{const c=command();await accepted(c);await sql.query('update auth.users set banned_until=now()+interval \'1 day\' where id=$1',[uid(1)]);await expect(prepare(c)).rejects.toMatchObject({code:'42501'});});
it('expired or incorrect proofs do not write',async()=>{const c=command(),p=await prepare(c),fields=settingsWriteFields(p,c,p.ticketId as string);await expect(asRole(null,'service_role','select public.finish_settings_write($1,$2,$3)',[fields.p_ticket_id,'wrong',fields.p_input_json])).rejects.toMatchObject({code:'42501'});await sql.query('update private.settings_write_tickets set expires_at=0 where id=$1',[fields.p_ticket_id]);await expect(finish(p,c)).rejects.toMatchObject({code:'42501'});expect((await counts()).events).toBe(0);});
it('ordinary and service identities cannot use private tables or preparation/completion outside their roles',async()=>{
 const c=command(),p=await prepare(c),fields=settingsWriteFields(p,c,p.ticketId as string);for(const role of ['anon','authenticated','service_role'] as const)await expect(asRole(role==='authenticated'?1:null,role,'select * from private.settings_write_tickets')).rejects.toMatchObject({code:'42501'});
 for(const role of ['anon','authenticated'] as const)await expect(asRole(role==='authenticated'?1:null,role,'select public.finish_settings_write($1,$2,$3)',[fields.p_ticket_id,fields.p_token,fields.p_input_json])).rejects.toMatchObject({code:'42501'});
 for(const role of ['anon','service_role'] as const)await expect(asRole(null,role,'select public.prepare_settings_write($1,$2,$3,$4,$5,$6,$7)',[c.id,newInboxId(),c.type,c.outletId,JSON.stringify(settingsWritePlan(c)),await settingsFingerprint(c),c.occurredAt])).rejects.toMatchObject({code:'42501'});
});
it('an audit collision rolls back the wording, receipt and ticket consumption',async()=>{
 const c=command(),p=await prepare(c),before=await outlet();await sql.query('insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at) values($1,$2,$3,\'member\',$4,\'test.collision\',\'null\',\'null\',1)',[c.id,source.snapshot.business.id,c.outletId,source.snapshot.owner.id]);await expect(finish(p,c)).rejects.toMatchObject({code:'23505'});expect(await outlet()).toEqual(before);expect((await counts()).receipts).toBe(0);expect((await sql.query<{n:number}>('select count(*)::int n from private.settings_write_tickets')).rows[0].n).toBe(1);
});
it('a future device clock requires review while existing future outlet metadata never moves backwards',async()=>{
 const c=command();c.occurredAt=Date.now()+600000;await expect(prepare(c)).rejects.toMatchObject({code:'PT409'});const updated=Date.now()+86400000;await sql.query('update public.outlets set updated_at=$1 where id=$2',[updated,c.outletId]);const r=await accepted(command());expect(r.outletUpdatedAt).toBe(updated);
});
it('HTTP admission retries only the tagged stale snapshot and preserves unrelated newer fields',async()=>{
 const c=command(),change=vi.fn(async()=>{if(change.mock.calls.length===1)await sql.query('update public.outlets set order_warning_minutes=13 where id=$1',[c.outletId]);}),store=nativeStore(change),r=await store.apply('caller.1.sig',c);expect(change).toHaveBeenCalledTimes(2);expect(parseSettingsCommandReceipt(r,c).id).toBe(c.id);expect((await outlet()).order_warning_minutes).toBe(13);expect((await counts()).events).toBe(1);
});
it('repeated snapshot conflicts stop after three bounded attempts without recording the action',async()=>{
 const c=command(),change=vi.fn(async()=>{await sql.query('update public.outlets set order_warning_minutes=order_warning_minutes+1 where id=$1',[c.outletId]);}),handler=createCommandsHandler({store:nativeStore(change),origins:new Set([origin])});const response=await handler(new Request('https://edge.test/commands',{method:'POST',headers:{Origin:origin,Authorization:'Bearer caller.1.sig','Content-Type':'application/json'},body:JSON.stringify(c)}));expect(response.status).toBe(409);expect(change).toHaveBeenCalledTimes(3);expect((await counts()).events).toBe(0);expect(await response.text()).not.toContain('PRIVATE BACKEND');
});
it('the actual serialized local wording and export queue passes through HTTP into SQL and retains accepted receipts',async()=>{
 const local=new MiseDatabase('mise-settings-local-'+randomUUID()),journal=new CloudUploadJournal('mise-settings-journal-'+randomUUID());
 try{const t=emptyBackupTables();t.businesses.push(source.snapshot.business);t.outlets.push(decodeCommandRecord('outlets',await outlet()) as unknown as typeof source.snapshot.outlet);t.members.push(source.snapshot.owner);t.categories.push(...source.categories);t.items.push(...source.items);const backup=createBackup(t);await local.restoreBackup(backup,await local.previewRestore(backup));const snapshot=await journal.prepare(local,uploadId());await uploadWithLocalOutbox(local,journal,snapshot.id,'c'.repeat(64),new MemoryCloudUpload());await local.saveCreditMessaging({...defaultCreditMessaging,paymentNote:literal});await local.recordPreparedExport({outletId:source.snapshot.outlet.id,actorId:source.snapshot.owner.id,format:'json',datasets:[],rows:99,filename:'backup.json',capturedAt:Date.now(),from:null,to:null,includePhones:true});const queued=await local.outbox.orderBy('[uploadId+sequence]').toArray();expect(queued.map(r=>r.commands[0].type)).toEqual(['khata.wording','export.prepare']);const handler=createCommandsHandler({store:nativeStore(),origins:new Set([origin])});const send=async(c:SettingsCommand)=>{const response=await handler(new Request('https://edge.test/commands',{method:'POST',headers:{Origin:origin,Authorization:'Bearer caller.1.sig','Content-Type':'application/json'},body:JSON.stringify(c)}));expect(response.status,lastError).toBe(200);return parseSettingsCommandReceipt(await response.json(),c);};await deliverLocalOutbox(local,'c'.repeat(64),c=>send(parseSettingsCommand(c)));expect((await local.outbox.toArray()).every(r=>r.status==='accepted'&&r.receipts.length===1)).toBe(true);expect((await events()).map(e=>e.id).sort()).toEqual(queued.map(r=>r.commands[0].id).sort());expect((await counts()).sales).toBe(0);await assertLocalUploadCoverage(local,snapshot,'c'.repeat(64));}
 finally{await local.delete();await journal.delete();}
});
