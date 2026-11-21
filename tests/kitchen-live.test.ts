import {afterEach,expect,it,vi} from 'vitest';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
// @ts-expect-error Deployment packaging is a standalone Node module.
import {edgeBundle} from '../scripts/edge-bundle.mjs';
import {IDBFactory} from 'fake-indexeddb';
import {createKitchenLiveHandler,type KitchenLiveDependencies} from '../supabase/functions/_shared/kitchen-live-handler';
import {kitchenBroadcastSubscriber,type KitchenBroadcastSocketFactory} from '../supabase/functions/_shared/kitchen-broadcast';
import {parseKitchenLiveFrame} from '../packages/core/kitchen-live';
import {watchKitchenLive} from '../apps/web/src/data/kitchen-live';
import {openScreenJournal} from '../apps/web/src/data/device-screen-journal';
import {kitchenScreenFixture} from './fixtures/kitchen-screen';
const cleanup:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const stop of cleanup.splice(0).reverse())await stop();vi.useRealTimers();vi.restoreAllMocks();});
const origin='https://shop.test';
function request(body:unknown={sessionToken:'S'.repeat(43)},signal?:AbortSignal){return new Request('https://api.test/functions/v1/kitchen-live',{method:'POST',headers:{origin,Authorization:'Bearer '+'D'.repeat(43),'Content-Type':'application/json'},body:JSON.stringify(body),signal});}
async function fixture(){
 const f=await kitchenScreenFixture();let hint=()=>{},broken=()=>{};
 const stopped=vi.fn(),access=vi.fn(async():Promise<unknown>=>f.access),subscribe=vi.fn(async(outlet:string,changed:()=>void,disconnected:()=>void)=>{expect(outlet).toBe(f.access.outletId);hint=changed;broken=disconnected;return stopped;});
 const deps:KitchenLiveDependencies={origins:new Set([origin]),access,subscribe,now:()=>f.now};
 return {...f,deps,read:access,subscribe,stopped,hint:()=>hint(),broken:()=>broken(),handler:createKitchenLiveHandler(deps)};
}
async function readFrame(reader:ReadableStreamDefaultReader<Uint8Array>){const part=await reader.read();expect(part.done).toBe(false);const text=new TextDecoder().decode(part.value);expect(text.endsWith('\n\n')).toBe(true);return parseKitchenLiveFrame(JSON.parse(text.slice(6).trim()));}
it('authorizes the same live device/session before and after a private join, then sends only metadata',async()=>{
 const f=await fixture(),response=await f.handler(request()),reader=response.body!.getReader();cleanup.push(()=>reader.cancel());
 expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store');expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
 expect(await readFrame(reader)).toEqual({v:1,type:'ready'});expect(f.read.mock.calls).toEqual([['D'.repeat(43),'S'.repeat(43)],['D'.repeat(43),'S'.repeat(43)]]);
 f.hint();expect(await readFrame(reader)).toEqual({v:1,type:'wake'});expect(f.read).toHaveBeenCalledTimes(3);await reader.cancel();expect(f.stopped).toHaveBeenCalledOnce();
});
it('a revoked session during topic setup never receives a successful stream',async()=>{
 const f=await fixture();f.subscribe.mockImplementation(async()=>{f.read.mockResolvedValue(null);return f.stopped;});const response=await f.handler(request());expect(response.status).toBe(401);expect(f.stopped).toHaveBeenCalledOnce();expect(await response.text()).not.toContain(f.access.outletId);
});
it.each(['revoked','outlet','member','read'] as const)('stops %s access before sending another wake signal',async kind=>{
 const f=await fixture(),response=await f.handler(request()),reader=response.body!.getReader();cleanup.push(()=>reader.cancel());await readFrame(reader);
 f.read.mockResolvedValue(kind==='revoked'?null:kind==='outlet'?{...f.access,outletId:'00000000000000000000000001'}:kind==='member'?{...f.access,memberId:'00000000000000000000000001'}:{...f.access,permissions:[]});
 f.hint();expect(await readFrame(reader)).toEqual({v:1,type:'auth'});expect((await reader.read()).done).toBe(true);expect(f.stopped).toHaveBeenCalledOnce();
});
it('heartbeats re-check current access and a bounded worker ends without leaking broker data',async()=>{
 vi.useFakeTimers();const f=await fixture(),response=await f.handler(request()),reader=response.body!.getReader();cleanup.push(()=>reader.cancel());await readFrame(reader);
 const heartbeat=readFrame(reader);await vi.advanceTimersByTimeAsync(15000);expect(await heartbeat).toEqual({v:1,type:'heartbeat'});expect(f.read).toHaveBeenCalledTimes(3);
 f.broken();expect((await reader.read()).done).toBe(true);expect(f.stopped).toHaveBeenCalledOnce();
});
it('rotates the stream before the Edge worker limit and bounds a stalled reader without losing the cursor source',async()=>{
 vi.useFakeTimers();const f=await fixture(),response=await f.handler(request()),reader=response.body!.getReader();cleanup.push(()=>reader.cancel());await readFrame(reader);
 for(let tick=0;tick<7;tick++){const next=readFrame(reader);await vi.advanceTimersByTimeAsync(15000);expect((await next).type).toBe('heartbeat');}
 await vi.advanceTimersByTimeAsync(5000);expect((await reader.read()).done).toBe(true);expect(f.stopped).toHaveBeenCalledOnce();
 const slow=await fixture(),held=await slow.handler(request());await vi.advanceTimersByTimeAsync(120000);expect(slow.stopped).toHaveBeenCalledOnce();const bytes=await held.text();expect(bytes.match(/data:/g)).toHaveLength(8);expect(bytes).not.toContain(slow.access.outletId);
});
it('request abort cancels its private upstream subscription and original credential checks',async()=>{
 const f=await fixture(),controller=new AbortController(),response=await f.handler(request(undefined,controller.signal)),reader=response.body!.getReader();await readFrame(reader);controller.abort();expect((await reader.read()).done).toBe(true);expect(f.stopped).toHaveBeenCalledOnce();f.hint();expect(f.read).toHaveBeenCalledTimes(2);
});
it.each(['origin','method','device','extra','token','mime'] as const)('refuses an invalid %s before any private subscription',async kind=>{
 const f=await fixture(),source=request(),headers=new Headers(source.headers);if(kind==='origin')headers.set('origin','https://other.test');if(kind==='device')headers.set('authorization','Bearer owner-jwt');if(kind==='mime')headers.set('content-type','text/plain');
 const req=new Request(source.url,{method:kind==='method'?'GET':'POST',headers,...(kind==='method'?{}:{body:JSON.stringify(kind==='extra'?{sessionToken:'S'.repeat(43),outletId:f.access.outletId}:kind==='token'?{sessionToken:'0042'}:{sessionToken:'S'.repeat(43)})})});
 expect((await f.handler(req)).status).toBe(kind==='origin'?403:kind==='method'?405:kind==='device'?401:kind==='mime'?415:400);expect(f.subscribe).not.toHaveBeenCalled();expect(f.read).not.toHaveBeenCalled();
});
function broker(){
 let callbacks:Parameters<KitchenBroadcastSocketFactory>[2]|undefined;
 const sent:Record<string,unknown>[]=[],close=vi.fn();
 const open:KitchenBroadcastSocketFactory=vi.fn((url,headers,events)=>{expect(new URL(url).searchParams.has('apikey')).toBe(false);expect(url).not.toContain('sb_secret');expect(headers).toEqual({apikey:'sb_secret_test_only'});callbacks=events;queueMicrotask(events.open);return {send:(text:string)=>sent.push(JSON.parse(text)),close};});
 return {open,sent,close,receive:(value:unknown)=>callbacks!.text(JSON.stringify(value))};
}
it('private broadcasts are isolated by derived topic/event and never forward the order payload',async()=>{
 const f=await kitchenScreenFixture(),b=broker(),changed=vi.fn(),failed=vi.fn(),pending=kitchenBroadcastSubscriber('https://api.test','sb_secret_test_only',b.open)(f.access.outletId,changed,failed);await Promise.resolve();
 const topic='realtime:kitchen:'+f.access.outletId;expect(b.sent[0]).toMatchObject({event:'phx_join',topic,payload:{config:{private:true,postgres_changes:[]}}});expect(JSON.stringify(b.sent)).not.toContain('sb_secret');
 b.receive({topic,event:'phx_reply',ref:'1',payload:{status:'ok'}});const stop=await pending;cleanup.push(stop);
 b.receive({topic:'realtime:kitchen:other',event:'broadcast',payload:{type:'broadcast',event:'kitchen_changed',payload:{orderId:f.order.id}}});
 b.receive({topic,event:'broadcast',payload:{type:'broadcast',event:'other',payload:{orderId:f.order.id}}});expect(changed).not.toHaveBeenCalled();
 b.receive({topic,event:'broadcast',payload:{type:'broadcast',event:'kitchen_changed',payload:{orderId:f.order.id,customer:'PRIVATE'}}});expect(changed.mock.calls).toEqual([[]]);stop();expect(b.close).toHaveBeenCalledOnce();expect(failed).not.toHaveBeenCalled();
});
it('a failed private join and an unanswered heartbeat close the socket without exposing diagnostics',async()=>{
 vi.useFakeTimers();const f=await kitchenScreenFixture(),b=broker(),pending=kitchenBroadcastSubscriber('https://api.test','sb_secret_test_only',b.open)(f.access.outletId,()=>{},()=>{}),rejected=expect(pending).rejects.toThrow('Kitchen updates are unavailable.');await Promise.resolve();
 b.receive({topic:'realtime:kitchen:'+f.access.outletId,event:'phx_reply',ref:'1',payload:{status:'error',response:{secret:'PRIVATE'}}});await rejected;expect(b.close).toHaveBeenCalledOnce();
 const two=broker(),failed=vi.fn(),joining=kitchenBroadcastSubscriber('https://api.test','sb_secret_test_only',two.open)(f.access.outletId,()=>{},failed);await Promise.resolve();two.receive({topic:'realtime:kitchen:'+f.access.outletId,event:'phx_reply',ref:'1',payload:{status:'ok'}});cleanup.push(await joining);
 await vi.advanceTimersByTimeAsync(20000);expect(two.sent[1]).toMatchObject({topic:'phoenix',event:'heartbeat'});await vi.advanceTimersByTimeAsync(20000);expect(failed).toHaveBeenCalledOnce();expect(two.close).toHaveBeenCalledOnce();
});
it('the browser accepts only closed wake metadata and stops after a remote authorization failure',async()=>{
 const f=await kitchenScreenFixture(),journal=await openScreenJournal('/mise/app/',new IDBFactory());cleanup.push(()=>journal.close());const source=await journal.replace(await journal.read(),f.screen),wake=vi.fn(),state=vi.fn(),denied=vi.fn();let writer!:ReadableStreamDefaultController<Uint8Array>;
 const send:typeof fetch=vi.fn(async(url,init)=>{expect(String(url)).toBe('https://screen.test/functions/v1/kitchen-live');expect(init).toMatchObject({method:'POST',credentials:'omit',redirect:'error',headers:{Authorization:'Bearer '+'D'.repeat(43)}});expect(JSON.parse(init!.body as string)).toEqual({sessionToken:'S'.repeat(43)});return new Response(new ReadableStream<Uint8Array>({start(w){writer=w;}}),{headers:{'content-type':'text/event-stream'}});});
 const stop=watchKitchenLive(journal,source,{blank:async()=>{},send,wake,state,denied});cleanup.push(stop);await vi.waitFor(()=>expect(send).toHaveBeenCalledOnce());
 writer.enqueue(new TextEncoder().encode('data: {"v":1,"type":"rea'));writer.enqueue(new TextEncoder().encode('dy"}\n\ndata: {"v":1,"type":"wake"}\n\n'));await vi.waitFor(()=>expect(wake).toHaveBeenCalledTimes(2));expect(state).toHaveBeenCalledWith(true);
 writer.enqueue(new TextEncoder().encode('data: {"v":1,"type":"auth"}\n\n'));await vi.waitFor(()=>expect(denied).toHaveBeenCalledOnce());expect(state).toHaveBeenLastCalledWith(false);
});
it('a changed native staff record stops browser hints before they can wake a different session',async()=>{
 const f=await kitchenScreenFixture(),journal=await openScreenJournal('/mise/app/',new IDBFactory());cleanup.push(()=>journal.close());const source=await journal.replace(await journal.read(),f.screen),wake=vi.fn(),denied=vi.fn(),cancelled=vi.fn();let writer!:ReadableStreamDefaultController<Uint8Array>;
 const send:typeof fetch=async()=>new Response(new ReadableStream<Uint8Array>({start(w){writer=w;},cancel(){cancelled();}}),{headers:{'content-type':'text/event-stream'}});
 const stop=watchKitchenLive(journal,source,{blank:async()=>{},send,wake,state:()=>{},denied});cleanup.push(stop);await vi.waitFor(()=>expect(writer).toBeDefined());
 await journal.replace(source,{phase:'empty'});writer.enqueue(new TextEncoder().encode('data: {"v":1,"type":"ready"}\n\n'));await vi.waitFor(()=>expect(cancelled).toHaveBeenCalledOnce());expect(wake).not.toHaveBeenCalled();expect(denied).not.toHaveBeenCalled();
});
it('a broker payload disguised as browser wake metadata cannot update or wake the screen',async()=>{
 const f=await kitchenScreenFixture(),journal=await openScreenJournal('/mise/app/',new IDBFactory());cleanup.push(()=>journal.close());const source=await journal.replace(await journal.read(),f.screen),wake=vi.fn(),cancelled=vi.fn();
 const send:typeof fetch=async()=>new Response(new ReadableStream<Uint8Array>({start(writer){writer.enqueue(new TextEncoder().encode('data: {"v":1,"type":"ready"}\n\ndata: {"v":1,"type":"wake","order":{"status":"ready","payment":"PRIVATE"}}\n\n'));},cancel(){cancelled();}}),{headers:{'content-type':'text/event-stream'}});
 const stop=watchKitchenLive(journal,source,{blank:async()=>{},send,wake,state:()=>{},denied:()=>{throw Error('Malformed data is not a grant or an authentication outcome.');}});cleanup.push(stop);
 await vi.waitFor(()=>expect(cancelled).toHaveBeenCalledOnce());expect(wake).toHaveBeenCalledOnce();expect((await journal.read()).revision).toBe(source.revision);
});
it('the reviewed deployment modules boot with only the pinned server WebSocket import and reject unauthenticated calls',async()=>{
 const runtime=globalThis as unknown as {Deno?:unknown},previous=runtime.Deno;
 try{
  for(const name of ['kitchen-tickets','kitchen-live']){
   const bundle=await edgeBundle(name);expect(bundle.files).toHaveLength(1);expect(bundle.runtimeImports).toEqual(name==='kitchen-live'?['npm:ws@8.23.0']:[]);expect(bundle.bytes).toBeLessThan(20*1024*1024);expect(bundle.sourceHashes).toHaveProperty('packages/core/device-access.ts');expect(bundle.files[0].content).not.toContain('sb_secret_test_only');
   let handler:((request:Request)=>Promise<Response>)|undefined;
   runtime.Deno={env:{get:(key:string)=>({SUPABASE_URL:'https://api.test',MISE_SERVICE_API_KEY:'sb_secret_test_only',MISE_ALLOWED_ORIGINS:origin} as Record<string,string>)[key]},serve:(value:typeof handler)=>{handler=value;}};
   // Node and Deno use the same pinned ws release. Resolve only that reviewed
   // import locally to execute the exact entry and its authorization checks.
   const code=bundle.files[0].content.replaceAll('npm:ws@8.23.0',pathToFileURL(createRequire(import.meta.url).resolve('ws')).href);
   await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64')+'#'+name);expect(handler).toBeTypeOf('function');
   const denied=await handler!(new Request('https://api.test/'+name,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'}));expect(denied.status).toBe(401);expect(await denied.text()).not.toContain('sb_secret');
   expect((await handler!(new Request('https://api.test/'+name,{method:'OPTIONS',headers:{Origin:origin}}))).status).toBe(204);
  }
 }finally{runtime.Deno=previous;}
},30000);
