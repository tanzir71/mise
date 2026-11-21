import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createClosingReviewDatabase,type ClosingReviewDatabase} from './closing-review-sql-fixture';
import {fixture,id,modes} from './closing-review-fixture';
import {createClosingReviewHandler,createClosingReviewStore} from '../supabase/functions/_shared/closing-review';
import {createCommandsHandler,createCommandStore} from '../supabase/functions/_shared/commands-handler';
import {prepareClosingReviewSource} from '../apps/web/src/data/closing-review-source';
import {parseClosingResolutionReceipt} from '../packages/core/closing-review';
import {parsePreparedClosingReview} from '../packages/core/closing-review-view';
import {commandReviewHeader} from '../packages/core/command-resolution';
import {encodeCommandRecord} from '../packages/core/cloud-records';
import {recordSaleCommand} from '../packages/core/sales';
import {undoClosingCommand} from '../packages/core/closing';
import {closingIntent} from '../apps/web/src/data/outbox-intents';
// @ts-expect-error Deployment packaging is a standalone Node module.
import {edgeBundle} from '../scripts/edge-bundle.mjs';

let sql:ClosingReviewDatabase;
beforeAll(async()=>{sql=await createClosingReviewDatabase();},30000);
beforeEach(async()=>{await sql.reset();});
afterAll(async()=>{await sql?.db.close();});
const origin='https://shop.test';
const parameters:Record<string,string[]>={
 admit_closing_review:['p_outlet_id'],inspect_closing_outcome:['p_command_id','p_type','p_closing_id','p_outlet_id','p_hash'],
 prepare_closing_review:['p_id','p_replacement_id','p_command_id','p_type','p_outlet_id','p_closing_id','p_sale_id','p_sale_event_id','p_occurred_at','p_hash','p_intent_json','p_source_hash','p_source_json','p_facts'],
 read_closing_review:['p_id','p_token'],prepare_closing_write:['p_id','p_ticket_id','p_type','p_outlet_id','p_plan','p_hash','p_occurred_at'],
 prepare_saved_closing:['p_id','p_ticket_id','p_type','p_outlet_id','p_plan','p_hash','p_occurred_at','p_parent_event_id'],
 finish_closing_write:['p_ticket_id','p_token','p_records'],finish_closing_review:['p_id','p_token','p_outcome','p_replacement_ticket','p_replacement_token','p_replacement_hash','p_replacement_records'],
};
function gateway(hook?:(name:string,args:Record<string,unknown>,value:unknown)=>Promise<void>){
 const calls:string[]=[];const send:typeof fetch=async(url,options)=>{
  const name=new URL(String(url)).pathname.split('/').at(-1)!,names=parameters[name],args=JSON.parse(options?.body as string),headers=new Headers(options?.headers),service=name.startsWith('finish_');calls.push(name);expect(names).toBeDefined();
  expect(headers.get('apikey')).toBe(service?'sb_secret_test_only':'sb_publishable_test_only');if(service)expect(headers.has('Authorization')).toBe(false);else expect(headers.get('Authorization')).toMatch(/^Bearer account\.[12]\.test$/);
  const values=names.map(k=>['p_plan','p_facts','p_records','p_replacement_records'].includes(k)&&args[k]!==null?JSON.stringify(args[k]):args[k]);let value;
  try{value=await sql.asRole(service?null:Number(headers.get('Authorization')!.split('.')[1]),service?'service_role':'authenticated',`select public.${name}(${names.map((_,i)=>'$'+(i+1)).join(',')}) data`,values);}
  catch(error){const code=(error as {code:string}).code;return new Response(JSON.stringify({code}),{status:code==='42501'?403:code==='PT429'?429:['PT409','23505'].includes(code)?409:400});}
  await hook?.(name,args,value);return new Response(JSON.stringify(value));
 };return {send,calls};
}
async function ready(mode:Parameters<typeof fixture>[0]='surplus',at=Date.now()-10000){const f=fixture(mode,{at});f.packet=await prepareClosingReviewSource(f.row,0,f.packet.id,f.packet.replacementId);await sql.seed(f);return f;}
function runtime(g=gateway()){
 let next=900000;const store=createClosingReviewStore('https://database.test','sb_publishable_test_only','sb_secret_test_only',g.send,()=>id(++next));
 return {store,handler:createClosingReviewHandler({store,origins:new Set([origin])}),normal:createCommandsHandler({store:createCommandStore('https://database.test','sb_publishable_test_only',g.send,{serviceKey:'sb_secret_test_only',newId:()=>id(++next)}),origins:new Set([origin])}),...g};
}
function request(f:Awaited<ReturnType<typeof ready>>,mode='read',body:unknown=f.packet,account=1){return new Request('https://api.test/commands?review=closing-'+mode,{method:'POST',headers:{Origin:origin,Authorization:`Bearer account.${account}.test`,'Content-Type':'application/json',[commandReviewHeader]:f.row.outletId},body:JSON.stringify(body)});}
async function counts(){return (await sql.db.query<{receipts:number;resolutions:number}>("select (select count(*)::int from private.shop_command_receipts) receipts,(select count(*)::int from private.closing_command_resolutions) resolutions")).rows[0];}

it.each(modes)('uses original-JWT preparation and service-only replacement completion for %s over HTTP',async mode=>{
 const f=await ready(mode),r=runtime(),response=await r.handler(request(f));expect(response.status).toBe(200);const body=await response.json(),review=parsePreparedClosingReview(body.review,f.packet);expect(review.proposal.enabled).toBe(true);
 const resolved=await r.handler(request(f,'resolve',{...f.packet,token:review.token,outcome:'replaced'}));expect(resolved.status).toBe(200);const result=parseClosingResolutionReceipt(await resolved.json(),f.packet);expect(result.outcome).toBe('replaced');expect(await counts()).toEqual({receipts:2,resolutions:1});
 const retry=await r.normal(new Request('https://api.test/commands',{method:'POST',headers:{Origin:origin,Authorization:'Bearer account.1.test','Content-Type':'application/json',...(f.command.type==='closing.undo'?{'X-Mise-Closing-Parent':f.created.closing.eventId}:{})},body:JSON.stringify(f.command)}));expect(retry.status).toBe(200);expect(await retry.json()).toEqual(result);expect(r.calls.filter(name=>name==='finish_closing_review')).toHaveLength(1);
 const text=JSON.stringify(result);expect(text).not.toMatch(/sb_secret_|contextJson|sourceJson|ticketId|token/);
});
it.each(modes)('withdraws original %s through HTTP without issuing an ordinary replacement',async mode=>{
 const f=await ready(mode),r=runtime(),first=await(await r.handler(request(f))).json(),response=await r.handler(request(f,'resolve',{...f.packet,token:first.review.token,outcome:'withdrawn'}));expect(response.status).toBe(200);expect(parseClosingResolutionReceipt(await response.json(),f.packet).outcome).toBe('withdrawn');expect(r.calls).not.toContain('prepare_closing_write');expect(await counts()).toEqual({receipts:1,resolutions:1});
});
it('recovers a committed decision after a lost reply and expired original token without duplicate money',async()=>{
 const f=await ready(),g=gateway(async name=>{if(name==='finish_closing_review')throw Error('Synthetic lost response');}),r=runtime(g),first=await(await r.handler(request(f))).json(),input={...f.packet,token:first.review.token,outcome:'replaced'};
 expect((await r.handler(request(f,'resolve',input))).status).toBe(503);expect(await counts()).toEqual({receipts:2,resolutions:1});await sql.db.exec('update private.closing_review_tickets set expires_at=0');
 const again=await r.handler(request(f,'resolve',input));expect(again.status).toBe(200);expect(parseClosingResolutionReceipt(await again.json(),f.packet).outcome).toBe('replaced');expect(await counts()).toEqual({receipts:2,resolutions:1});expect(g.calls.filter(name=>name==='finish_closing_review')).toHaveLength(1);
});
it('requires a fresh current comparison after another canonical cash receipt',async()=>{
 const f=await ready(),r=runtime(),before=await(await r.handler(request(f))).json(),cash=recordSaleCommand({expression:'10',method:'cash'},{setup:f.context.setup,items:[],wallets:[]},f.command.occurredAt-1,kind=>kind==='sale'?id(88000):id(88001));await sql.insert([encodeCommandRecord('sales',cash.sale,f.row.businessId),encodeCommandRecord('events',cash.event,f.row.businessId)]);
 expect((await r.handler(request(f,'resolve',{...f.packet,token:before.review.token,outcome:'replaced'}))).status).toBe(409);expect(r.calls).not.toContain('finish_closing_review');
 const current=await(await r.handler(request(f))).json(),response=await r.handler(request(f,'resolve',{...f.packet,token:current.review.token,outcome:'replaced'}));expect(response.status).toBe(200);expect(parseClosingResolutionReceipt(await response.json(),f.packet).replacement?.receipt.addedWalkIn).toBe(1501);
});
it('retains a raced comparison rather than submitting a new count without review',async()=>{
 const f=await ready();let race=false;const r=runtime(gateway(async name=>{if(name==='read_closing_review'&&!race){race=true;const cash=recordSaleCommand({expression:'10',method:'cash'},{setup:f.context.setup,items:[],wallets:[]},f.command.occurredAt-1,kind=>kind==='sale'?id(88000):id(88001));await sql.insert([encodeCommandRecord('sales',cash.sale,f.row.businessId),encodeCommandRecord('events',cash.event,f.row.businessId)]);}}));
 const first=await(await r.handler(request(f))).json(),response=await r.handler(request(f,'resolve',{...f.packet,token:first.review.token,outcome:'replaced'}));expect(response.status).toBe(409);expect(r.calls).not.toContain('finish_closing_review');expect(await counts()).toEqual({receipts:0,resolutions:0});
});
it('keeps another account from inspecting the original decision and recovers under the original account',async()=>{
 const f=await ready(),r=runtime(),first=await(await r.handler(request(f))).json(),input={...f.packet,token:first.review.token,outcome:'withdrawn'};
 expect((await r.handler(request(f,'resolve',input,2))).status).toBe(403);expect(await counts()).toEqual({receipts:0,resolutions:0});expect((await r.handler(request(f,'resolve',input))).status).toBe(200);expect((await r.handler(request(f,'read',f.packet,2))).status).toBe(403);
});
it('allows withdrawal of a past-day undo but cannot replace it or extend its deadline',async()=>{
 const f=await ready('undo-surplus',Date.now()-86410000),r=runtime(),first=await(await r.handler(request(f))).json();expect(first.review.proposal).toEqual({enabled:false,reason:'deadline'});
 const input={...f.packet,token:first.review.token,outcome:'replaced'};expect((await r.handler(request(f,'resolve',input))).status).toBe(409);expect(r.calls).not.toContain('prepare_closing_write');
 const withdrawn=await r.handler(request(f,'resolve',{...input,outcome:'withdrawn'}));expect(withdrawn.status).toBe(200);expect(parseClosingResolutionReceipt(await withdrawn.json(),f.packet).outcome).toBe('withdrawn');
});
it('retains a queued undo when its original closing was explicitly replaced with a different cash surplus',async()=>{
 const f=await ready(),r=runtime(),undo=undoClosingCommand(f.created.closing,f.context.setup,f.created.sale,f.command.occurredAt+1000,kind=>kind==='event'?id(89000):id(89001)),queued=closingIntent(undo,true),original=JSON.stringify(undo);
 const cash=recordSaleCommand({expression:'10',method:'cash'},{setup:f.context.setup,items:[],wallets:[]},f.command.occurredAt-1,kind=>kind==='sale'?id(88000):id(88001));await sql.insert([encodeCommandRecord('sales',cash.sale,f.row.businessId),encodeCommandRecord('events',cash.event,f.row.businessId)]);
 const checked=await(await r.handler(request(f))).json(),replacement=await r.handler(request(f,'resolve',{...f.packet,token:checked.review.token,outcome:'replaced'}));expect(replacement.status).toBe(200);expect(parseClosingResolutionReceipt(await replacement.json(),f.packet).replacement?.receipt.addedWalkIn).toBe(1501);
 const result=await r.normal(new Request('https://api.test/commands',{method:'POST',headers:{Origin:origin,Authorization:'Bearer account.1.test','Content-Type':'application/json','X-Mise-Closing-Parent':f.created.closing.eventId},body:JSON.stringify(queued)}));
 expect(result.status).toBe(409);expect((await sql.db.query<{amount:number;voided_at:number|null}>('select amount,voided_at from public.sales where id=$1',[f.command.saleId])).rows[0]).toMatchObject({amount:1501,voided_at:null});expect(JSON.stringify(undo)).toBe(original);
});
it('admits the actual phone/outlet before reading a body and keeps oversized review bodies bounded',async()=>{
 const f=await ready(),r=runtime(),denied=request(f);let reads=0;Object.defineProperty(denied,'body',{get(){reads++;throw Error('Body should remain unread');}});
 const invalid=new Request(denied,{headers:{Origin:origin,Authorization:'Bearer account.2.test','Content-Type':'application/json',[commandReviewHeader]:id(9999)}});Object.defineProperty(invalid,'body',{get(){reads++;throw Error('Body should remain unread');}});
 expect((await r.handler(invalid)).status).toBe(403);expect(reads).toBe(0);
 const oversized=request(f);oversized.headers.set('Content-Length','48000001');expect((await r.handler(oversized)).status).toBe(413);expect(r.calls).not.toContain('prepare_closing_review');
});
it('preserves full imported native source through actual HTTP preparation and atomic completion',async()=>{
 const f=fixture('undo-surplus',{at:Date.now()-10000}),note='ন'.repeat(999998)+'\0\ud800',name='N'.repeat(1_000_000);f.created.closing.note=note;f.created.closing.createdByName=name;
 const change=undoClosingCommand(f.created.closing,f.context.setup,f.created.sale,f.command.occurredAt,kind=>kind==='event'?f.command.id:f.command.saleEventId!);f.row.changes=[{table:'dayClosings',key:change.closing.id,before:f.created.closing,after:change.closing},{table:'sales',key:change.sale!.id,before:f.created.sale!,after:change.sale!},...change.events.map(after=>({table:'events' as const,key:after.id,before:null,after}))];
 f.packet=await prepareClosingReviewSource(f.row,0,f.packet.id,f.packet.replacementId);const before=f.packet.sourceJson;expect(new TextEncoder().encode(JSON.stringify(f.packet)).length).toBeGreaterThan(32000);await sql.seed(f);
 const r=runtime(),response=await r.handler(request(f));expect(response.status).toBe(200);const body=await response.json();expect(body.review.proposal.enabled).toBe(true);expect(body.review.proposal.closing.note===note).toBe(true);
 const done=await r.handler(request(f,'resolve',{...f.packet,token:body.review.token,outcome:'replaced'}));expect(done.status).toBe(200);expect(parseClosingResolutionReceipt(await done.json(),f.packet).outcome).toBe('replaced');
 expect((await sql.db.query<{source:string}>('select source_json source from private.closing_command_resolutions')).rows[0].source===before).toBe(true);expect(f.packet.sourceJson===before).toBe(true);expect(await counts()).toEqual({receipts:2,resolutions:1});
},30000);
it('boots the exact commands deployment module and routes both closing review endpoints',async()=>{
 const f=await ready(),g=gateway(),bundle=await edgeBundle('commands');for(const path of ['supabase/functions/_shared/closing-review.ts','packages/core/closing-review-source.ts','packages/core/closing-review-view.ts'])expect(bundle.sourceHashes).toHaveProperty(path);
 const runtime=globalThis as unknown as {Deno?:unknown},previousDeno=runtime.Deno,previousFetch=globalThis.fetch;let handler:((r:Request)=>Promise<Response>)|undefined;
 try{
  runtime.Deno={env:{get:(name:string)=>({SUPABASE_URL:'https://database.test',MISE_PUBLISHABLE_API_KEY:'sb_publishable_test_only',MISE_SERVICE_API_KEY:'sb_secret_test_only',MISE_ALLOWED_ORIGINS:origin} as Record<string,string>)[name]},serve:(callback:typeof handler)=>{handler=callback;}};globalThis.fetch=g.send;
  await import('data:text/javascript;base64,'+Buffer.from(bundle.files[0].content).toString('base64')+'#closing-review');expect(handler).toBeTypeOf('function');const first=await handler!(request(f));expect(first.status).toBe(200);const read=await first.json(),resolved=await handler!(request(f,'resolve',{...f.packet,token:read.review.token,outcome:'replaced'}));expect(resolved.status).toBe(200);expect(parseClosingResolutionReceipt(await resolved.json(),f.packet).outcome).toBe('replaced');
 }finally{runtime.Deno=previousDeno;globalThis.fetch=previousFetch;}
},30000);
