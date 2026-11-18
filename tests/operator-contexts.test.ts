import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {once} from 'node:events';
import {setupCommand} from '../packages/core/setup';
import {emptyBackupTables} from '../packages/core/backup-tables';
import {createBackup} from '../packages/core/backup';
import {prepareCloudMigration,encodeCommandRecord,type CloudRecord} from '../packages/core/cloud-records';
import {operatorAccountHash,parseOperatorContext,parseOperatorPage,OperatorContextError,type OperatorContext,type OperatorPage} from '../packages/core/operators';
import {createOperatorRemote} from '../apps/web/src/data/operator-remote';
import {newInboxId} from '../packages/core/inbox';
import {operatorHostedProofSql} from './operator-hosted-fixture';

const uid=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),ids=Object.fromEntries([2,3,5,6].map(n=>[n,newInboxId()]));
let db:PGlite,server:Server,origin:string,seed:CloudRecord[],shop:ReturnType<typeof setupCommand>,branch:string;
async function run<T>(n:number|null,query:string,args:unknown[]=[],role='authenticated'){
 return db.transaction(async sql=>{await sql.exec('set local role '+role);await sql.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role,...(n===null?{}:{sub:uid(n)}),user_metadata:{role:'owner'}})]);return (await sql.query<T>(query,args)).rows;});
}
async function list(n=1,after:unknown=null,limit=50){return (await run<{data:OperatorPage}>(n,'select public.operator_contexts($1,$2) data',[after===null?null:JSON.stringify(after),limit]))[0].data;}
async function select(n=1,outlet=shop.snapshot.outlet.id,actor=n===1?shop.snapshot.owner.id:ids[n],business=shop.snapshot.business.id){return (await run<{data:OperatorContext}>(n,'select public.operator_context($1,$2,$3) data',[business,outlet,actor]))[0].data;}
async function insert(records:CloudRecord[]){for(const r of records)await db.query(`insert into public.${r.table}(${Object.keys(r.values).join(',')}) values(${Object.keys(r.values).map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(r.values));}
const remote=(n=1,send:typeof fetch=fetch)=>createOperatorRemote({apiUrl:origin,publishableKey:'sb_publishable_test_only'},async()=>({jwt:'user.'+n+'.signature',userId:uid(n)}),send);
beforeAll(async()=>{
 db=await PGlite.create();for(const file of ['supabase-auth.sql','supabase-storage.sql'])await db.exec(readFileSync(new URL('./fixtures/'+file,import.meta.url),'utf8'));
 const dir=new URL('../supabase/migrations/',import.meta.url);for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())await db.exec(readFileSync(new URL(file,dir),'utf8'));
 shop=setupCommand({businessType:'corner_shop',marketCode:'BD',name:'Operator discovery',phone:'01712345482'});branch=newInboxId();const t=emptyBackupTables();t.businesses.push(shop.snapshot.business);t.outlets.push(shop.snapshot.outlet);t.members.push({...shop.snapshot.owner,outletIds:[]});t.categories.push(...shop.categories);t.items.push(...shop.items);t.events.push(shop.event);seed=(await prepareCloudMigration(createBackup(t),uid(1))).records;
 server=createServer(async(req,res)=>{
  try{const n=Number(req.headers.authorization?.match(/^Bearer user\.(\d+)\.signature$/)?.[1]);if(!n){res.writeHead(401);res.end();return;}let body='';for await(const part of req)body+=part;const b=JSON.parse(body);
   const query=req.url==='/rest/v1/rpc/operator_contexts'?'select public.operator_contexts($1,$2) data':req.url==='/rest/v1/rpc/operator_context'?'select public.operator_context($1,$2,$3) data':null;
   if(!query){res.writeHead(404);res.end();return;}const args=req.url!.endsWith('operator_contexts')?[b.p_after===null?null:JSON.stringify(b.p_after),b.p_limit]:[b.p_business_id,b.p_outlet_id,b.p_actor_id],rows=await run<{data:unknown}>(n,query,args);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(rows[0].data));
  }catch{res.writeHead(403,{'Content-Type':'application/json'});res.end(JSON.stringify({message:'Private provider diagnostic must not reach the UI'}));}
 });server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
},60000);
beforeEach(async()=>{
 await db.transaction(sql=>sql.exec("set local session_replication_role='replica';truncate public.businesses cascade;truncate auth.users cascade;delete from private.sync_read_pages;delete from private.sync_read_windows;delete from private.sync_changes;delete from private.sync_scope_versions;"));
 for(const n of [1,2,3,4,5,6])await db.query('insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,now())',[uid(n),'1415555010'+n]);
 await insert(seed);await insert([encodeCommandRecord('outlets',{...shop.snapshot.outlet,id:branch,name:'Branch'},shop.snapshot.business.id)]);
 for(const [n,role,outlet]of [[2,'manager',shop.snapshot.outlet.id],[3,'manager',branch],[5,'staff',shop.snapshot.outlet.id],[6,'agent',shop.snapshot.outlet.id]]as const){await db.query('insert into public.members(id,business_id,auth_user_id,name,role,created_at,updated_at) values($1,$2,$3,$4,$5,1,1)',[ids[n],shop.snapshot.business.id,uid(n),JSON.stringify('Operator '+n),role]);await db.query('insert into public.member_outlets values($1,$2,$3)',[shop.snapshot.business.id,ids[n],outlet]);}
});
afterAll(async()=>{if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}await db?.close();});

it('discovers every owner outlet without adding implicit assignments and binds the PostgreSQL UUID-byte fingerprint',async()=>{
 const result=await list(),hash=createHash('sha256').update(Buffer.from(uid(1).replaceAll('-',''),'hex')).digest('hex');expect(result.contexts).toHaveLength(2);expect(new Set(result.contexts.map(c=>c.outletId))).toEqual(new Set([branch,shop.snapshot.outlet.id]));expect(result.accountHash).toBe(hash);expect(await operatorAccountHash(uid(1))).toBe(hash);expect(parseOperatorPage(result,hash,null,50)).toEqual(result);expect((await db.query('select * from public.member_outlets where member_id=$1',[shop.snapshot.owner.id])).rows).toEqual([]);
 const encoded=JSON.stringify(result);expect(encoded).not.toContain(uid(1));expect(encoded).not.toContain('14155550101');expect(encoded).not.toContain('auth_user_id');expect(encoded).not.toContain('apiKey');
});
it('lists only assigned manager outlets and rechecks the actual member when selecting',async()=>{
 for(const [n,outlet,foreign]of [[2,shop.snapshot.outlet.id,branch],[3,branch,shop.snapshot.outlet.id]]as const){const result=await list(n);expect(result.contexts).toHaveLength(1);expect(result.contexts[0]).toMatchObject({actorId:ids[n],outletId:outlet,role:'manager'});expect(parseOperatorContext(await select(n,outlet))).toEqual(result.contexts[0]);await expect(select(n,foreign)).rejects.toThrow();await expect(select(n,outlet,shop.snapshot.owner.id)).rejects.toThrow();}
});
it('does not convert staff, agents, foreign accounts or forged metadata into owner choices',async()=>{
 for(const n of [4,5,6]){expect((await list(n)).contexts).toEqual([]);await expect(select(n,shop.snapshot.outlet.id,shop.snapshot.owner.id)).rejects.toThrow();}
 for(const role of ['anon','service_role']){await expect(run(null,'select public.operator_contexts(null,50)',[],role)).rejects.toThrow();await expect(run(null,'select public.operator_context($1,$2,$3)',[shop.snapshot.business.id,shop.snapshot.outlet.id,shop.snapshot.owner.id],role)).rejects.toThrow();}
});
it.each(['phone_confirmed_at=null','is_anonymous=true',"banned_until=now()+interval '1 hour'",'deleted_at=now()',"phone='' "])('requires a current verified phone account (%s)',async(change)=>{
 await db.query('update auth.users set '+change+' where id=$1',[uid(1)]);await expect(list()).rejects.toThrow(/verified phone/);await expect(select()).rejects.toThrow(/verified phone/);
});
it('rejects cached manager selection after assignment removal, deactivation or demotion',async()=>{
 const original=(await remote(2).list()).contexts[0];await db.query('delete from public.member_outlets where member_id=$1',[ids[2]]);expect((await list(2)).contexts).toEqual([]);await expect(remote(2).select(original)).rejects.toThrow(/allowed/);
 await db.query('insert into public.member_outlets values($1,$2,$3)',[shop.snapshot.business.id,ids[2],shop.snapshot.outlet.id]);await db.query('update public.members set active=false where id=$1',[ids[2]]);await expect(remote(2).select(original)).rejects.toThrow();await db.query("update public.members set active=true,role='staff' where id=$1",[ids[2]]);await expect(select(2)).rejects.toThrow();
});
it('paginates stable business/outlet positions with bounded display metadata and no missing owner branch',async()=>{
 for(let n=1000;n<1055;n++)await insert([encodeCommandRecord('outlets',{...shop.snapshot.outlet,id:String(n).padStart(26,'0'),name:'Branch '+n},shop.snapshot.business.id)]);
 const first=await remote().list(),last=await remote().list(first.next);expect(first.contexts).toHaveLength(50);expect(last.contexts).toHaveLength(7);expect(last.next).toBeNull();expect(new Set([...first.contexts,...last.contexts].map(c=>c.outletId)).size).toBe(57);
 for(const bad of [{businessId:'bad',outletId:branch},{businessId:shop.snapshot.business.id,outletId:branch,extra:true},[]])await expect(list(1,bad)).rejects.toThrow();for(const limit of [0,51])await expect(list(1,null,limit)).rejects.toThrow();
});
it('retains literal JSON labels and bounds oversized labels without changing the canonical source',async()=>{
 const literal='Outlet\0\ud800 বাংলা';await db.query('update public.outlets set name=$1 where id=$2',[JSON.stringify(literal),shop.snapshot.outlet.id]);expect((await select()).outletName).toBe(literal);
 const large='বাংলা'.repeat(1400);await db.query('update public.businesses set name=$1 where id=$2',[JSON.stringify(large),shop.snapshot.business.id]);expect((await select()).businessName).toBeNull();expect((await db.query<{name:string}>('select name from public.businesses where id=$1',[shop.snapshot.business.id])).rows[0].name).toBe(large);
});
it('keeps public RPCs invoker-only and private definer access fixed to an empty search path',async()=>{
 const rows=(await db.query<{name:string;definer:boolean;config:string[]}>('select p.proname name,p.prosecdef definer,p.proconfig config from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=\'public\' and p.proname in (\'operator_contexts\',\'operator_context\')')).rows;expect(rows).toHaveLength(2);expect(rows.every(r=>!r.definer&&r.config.includes('search_path=""'))).toBe(true);await expect(run(1,'select private.operator_account_hash()')).rejects.toThrow();
});
it('uses actual HTTP-to-PostgreSQL RPCs with the original JWT and pinned runtime connection',async()=>{
 const seen:string[]=[],send:typeof fetch=async(url,init)=>{seen.push(String(url));expect(init).toMatchObject({method:'POST',redirect:'error',credentials:'omit',cache:'no-store'});expect(init?.headers).toMatchObject({Authorization:'Bearer user.2.signature',apikey:'sb_publishable_test_only'});return fetch(url,init);};
 const api=remote(2,send),page=await api.list();expect((await api.select(page.contexts[0])).actorId).toBe(ids[2]);expect(seen).toEqual([origin+'/rest/v1/rpc/operator_contexts',origin+'/rest/v1/rpc/operator_context']);
});
it('freezes selection before awaiting Auth and rejects a different signed-in account fingerprint',async()=>{
 const choice=(await list(2)).contexts[0],original=structuredClone(choice),api=createOperatorRemote({apiUrl:origin,publishableKey:'sb_publishable_test_only'},async()=>{choice.actorId=shop.snapshot.owner.id;choice.outletId=branch;return {jwt:'user.2.signature',userId:uid(2)};});expect(await api.select(choice)).toMatchObject(original);
 const wrong=createOperatorRemote({apiUrl:origin,publishableKey:'sb_publishable_test_only'},async()=>({jwt:'user.2.signature',userId:uid(1)}));await expect(wrong.list()).rejects.toBeInstanceOf(OperatorContextError);
});
it('redacts Auth, network, stream and provider diagnostics and bounds response bytes',async()=>{
 const diagnostic='synthetic private provider diagnostic',config={apiUrl:origin,publishableKey:'sb_publishable_test_only'},signed=async()=>({jwt:'user.1.signature',userId:uid(1)});
 const failures=[createOperatorRemote(config,async()=>{throw new Error(diagnostic);}),remote(1,async()=>{throw new Error(diagnostic);}),remote(1,async()=>new Response(JSON.stringify({message:diagnostic}),{status:403})),remote(1,async()=>new Response(new ReadableStream({start(c){c.error(new Error(diagnostic));}}),{headers:{'Content-Type':'application/json'}})),createOperatorRemote(config,signed,async()=>new Response('x'.repeat(1048577),{headers:{'Content-Type':'application/json'}}))];
 for(const api of failures){let message='';try{await api.list();}catch(e){expect(e).toBeInstanceOf(OperatorContextError);message=(e as Error).message;}expect(message).not.toBe('');expect(message).not.toContain(diagnostic);}
});
it('rejects altered response order, extra auth fields and mismatched page accounts',async()=>{
 const page=await list(),hash=page.accountHash;expect(()=>parseOperatorPage({...page,contexts:[...page.contexts].reverse()},hash,null,50)).toThrow();expect(()=>parseOperatorPage({...page,accountHash:'a'.repeat(64)},hash,null,50)).toThrow();expect(()=>parseOperatorContext({...page.contexts[0],authUserId:uid(1)})).toThrow();
});
it('runs the exact hosted SQL-role proof and rolls back every fictional account and shop',async()=>{
 const result=(await db.exec(await operatorHostedProofSql())).at(-1)!.rows[0] as {proof:Record<string,boolean>;auth_rows:number;business_rows:number};expect(result.auth_rows).toBe(0);expect(result.business_rows).toBe(0);expect(Object.keys(result.proof)).toHaveLength(15);expect(Object.values(result.proof).every(Boolean)).toBe(true);
});
