import {readFileSync,readdirSync} from 'node:fs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {resolve,join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createCommandStore,createCommandsHandler} from '../supabase/functions/_shared/commands-handler';
import {createSyncReadHandler,createSyncReadStore} from '../supabase/functions/_shared/sync-read-handler';
import {createInboxImageHandler,ImageAccessDenied} from '../supabase/functions/_shared/inbox-image-handler';
import {prepareCloudMigration,encodeCommandRecord} from '../packages/core/cloud-records';
import {createBackup} from '../packages/core/backup';
import {newInboxId} from '../packages/core/inbox';
import {syncImagesFixture} from './sync-images-fixture';

/** Local test verifier and object storage are synthetic. HTTP, scoped SQL roles,
 * command tickets/receipts, cursors and database transactions are real.
 */
export async function startConvergenceServer(){
 const db=await PGlite.create();for(const f of ['supabase-auth.sql','supabase-storage.sql'])await db.exec(readFileSync(resolve('tests/fixtures',f),'utf8'));const dir=resolve('supabase/migrations');for(const f of readdirSync(dir).filter(n=>n.endsWith('.sql')).sort())await db.exec(readFileSync(join(dir,f),'utf8'));
 // This is the test-owned Storage SQL stub, never a managed Supabase bucket.
 await db.exec("insert into storage.buckets(id,name,public) values('mise-inbox','mise-inbox',false)");
 const f=await syncImagesFixture(),t=f.backup.tables,owner=t.members[0],outlet=t.outlets[0],managerId=newInboxId(),branchId=newInboxId(),uid=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');owner.outletIds=[];
 await db.transaction(async sql=>{for(const n of [1,2])await sql.query('insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,now())',[uid(n),'1415555010'+n]);for(const r of (await prepareCloudMigration(createBackup(t),uid(1))).records){const keys=Object.keys(r.values);await sql.query(`insert into public.${r.table}(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(r.values));}const branch=encodeCommandRecord('outlets',{...outlet,id:branchId,name:'Implicit owner branch'},owner.businessId),keys=Object.keys(branch.values);await sql.query(`insert into public.outlets(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(branch.values));await sql.query("insert into public.members(id,business_id,auth_user_id,name,phone,role,created_at,updated_at) values($1,$2,$3,'\"Manager\"','+14155550102','manager',1,1)",[managerId,owner.businessId,uid(2)]);await sql.query('insert into public.member_outlets values($1,$2,$3)',[owner.businessId,managerId,outlet.id]);});
 const allowed=new Set(['admit_sync_read','prepare_sync_read','read_sync_page','read_sync_coverage','operator_context','operator_contexts','prepare_money_write','finish_money_write','prepare_stock_write','finish_stock_write','admit_stock_batch','inbox_image_context']);
 const identity=(jwt:string)=>{const match=jwt.match(/^native\.([12])\.signature$/);if(!match)throw Error('Synthetic account unavailable');return Number(match[1]);};
 async function rpc(name:string,args:Record<string,unknown>,jwt:string|null,service=false){
  if(!allowed.has(name)||Object.keys(args).some(k=>!/^p_[a-z_]+$/.test(k)))throw Error('RPC is outside the fixture allowlist');
  return db.transaction(async sql=>{await sql.exec('set local role '+(service?'service_role':'authenticated'));await sql.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(service?{role:'service_role'}:{role:'authenticated',sub:uid(identity(jwt!)),user_metadata:{role:'owner'}})]);const entries=Object.entries(args);return (await sql.query<{data:unknown}>(`select public.${name}(${entries.map(([key],i)=>key+'=>$'+(i+1)).join(',')}) data`,entries.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v))).rows[0].data;});
 }
 const diagnostics:{name:string;code:string;message:string}[]=[];
 const bridge:typeof fetch=async(url,init)=>{const name=new URL(String(url)).pathname.split('/').at(-1)!,headers=new Headers(init?.headers),service=headers.get('apikey')==='sb_secret_test_only';try{const args=JSON.parse(init?.body as string),result=await rpc(name,args,headers.get('Authorization')?.slice(7)??null,service);return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json'}});}catch(error){const e=error as {code?:string;detail?:string;message?:string};diagnostics.push({name,code:e.code??'PT500',message:e.message??'Fixture RPC failed'});return new Response(JSON.stringify({code:e.code??'PT500',details:e.detail??null}),{status:e.code==='42501'?403:e.code==='PT409'||e.code==='23505'?409:e.code==='22023'?400:503});}};
 const origins=new Set(['http://127.0.0.1:4321']),read=createSyncReadHandler({origins,store:createSyncReadStore('https://database.test','sb_publishable_test_only',bridge),cursorKey:'cd'.repeat(32)}),commands=createCommandsHandler({origins,store:createCommandStore('https://database.test','sb_publishable_test_only',bridge,{serviceKey:'sb_secret_test_only'})}),images=createInboxImageHandler({origins,store:{context:async(jwt,id)=>{try{return await rpc('inbox_image_context',{p_image_id:id},jwt);}catch{throw new ImageAccessDenied();}},get:async()=>new Uint8Array(f.imageBytes),put:async()=>false,complete:async()=>{throw Error('No upload in this fixture');}}});
 let apiUrl='',loseCommand=false,losePage=false;const calls={commands:0,pages:0,images:0};
 const server=createServer(async(req,res)=>{try{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks),headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);const cors={'Access-Control-Allow-Origin':'http://127.0.0.1:4321','Access-Control-Allow-Methods':'POST,GET,OPTIONS','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-mise-sync-outlet'};
  if(req.method==='OPTIONS'){res.writeHead(204,cors).end();return;}
  const request=new Request(apiUrl+req.url,{method:req.method,headers,...(req.method==='GET'?{}:{body})}),path=new URL(request.url).pathname;let response:Response;
  const truncate=async(response:Response)=>{const bytes=Buffer.from(await response.arrayBuffer()),h=new Headers(cors);for(const [key,value]of response.headers)h.set(key,value);h.set('Content-Length',String(bytes.length));h.set('Connection','close');res.writeHead(response.status,Object.fromEntries(h));res.end(bytes.subarray(0,2));};
  if(path==='/functions/v1/commands'){calls.commands++;response=await commands(request);if(loseCommand&&response.ok){loseCommand=false;await truncate(response);return;}}
  else if(path==='/functions/v1/sync-read'){const isPage=JSON.parse(body.toString()).type==='page';if(isPage)calls.pages++;response=await read(request);if(isPage&&losePage&&response.ok){losePage=false;await truncate(response);return;}}
  else if(path==='/functions/v1/inbox-image'){calls.images++;response=await images(request);}
  else if(path.startsWith('/rest/v1/rpc/operator_')){response=await bridge(new URL(path,'https://database.test'),{method:'POST',headers,body});}
  else response=new Response('{}',{status:404});const responseHeaders=new Headers(cors);for(const [key,value]of response.headers)responseHeaders.set(key,value);res.writeHead(response.status,Object.fromEntries(responseHeaders));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(503).end();}});server.listen(0,'127.0.0.1');await once(server,'listening');apiUrl='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const config=(n:1|2,branch=false)=>({apiUrl,publishableKey:'sb_publishable_test_only',userId:uid(n),jwt:`native.${n}.signature`,businessId:owner.businessId,outletId:branch?branchId:outlet.id,actorId:n===1?owner.id:managerId,stockId:t.stockItems[0].id});
 return {config,calls,diagnostics,loseNextCommand(){loseCommand=true;},loseNextPage(){losePage=true;},async revokeManager(){await db.query('delete from public.member_outlets where member_id=$1',[managerId]);},async financialCount(ids:string[]){return (await db.query<{n:number}>('select count(*)::int n from public.sales where id=any($1::public.ulid[])',[ids])).rows[0].n;},async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await db.close();}};
}
