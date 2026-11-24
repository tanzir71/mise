import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createHmac,randomUUID} from 'node:crypto';
import {generateVAPIDKeys} from 'web-push';
import {beforeAll,expect,it} from 'vitest';
// @ts-expect-error Deployment packaging is a standalone Node module.
import {edgeBundle} from '../scripts/edge-bundle.mjs';
interface Bundle{files:{content:string}[];runtimeImports:string[];sourceHashes:Record<string,string>}
let worker:Bundle,owner:Bundle,sequence=0;
const key='C'.repeat(43),vapid=generateVAPIDKeys(),runtime=pathToFileURL(createRequire(import.meta.url).resolve('web-push')).href;
const env={MISE_URGENT_INBOX_ENABLED:'true',MISE_URGENT_INBOX_KEY:key,SUPABASE_URL:'https://rpc.test',MISE_SERVICE_API_KEY:'sb_secret_test_only',MISE_WEB_PUSH_VAPID_PUBLIC_KEY:vapid.publicKey,MISE_WEB_PUSH_VAPID_PRIVATE_KEY:vapid.privateKey,MISE_WEB_PUSH_VAPID_SUBJECT:'https://desk.test/contact'};
beforeAll(async()=>{worker=await edgeBundle('urgent-inbox-push');owner=await edgeBundle('urgent-inbox-notifications');},30000);
const never:typeof fetch=async()=>{throw Error('Unexpected packaged HTTP');};
async function execute(bundle:Bundle,values:Record<string,string>,send:typeof fetch,work:(handler:(r:Request)=>Promise<Response>)=>Promise<void>){const root=globalThis as unknown as {Deno?:unknown},oldDeno=root.Deno,oldFetch=globalThis.fetch;let handler:((r:Request)=>Promise<Response>)|undefined;try{root.Deno={env:{get:(name:string)=>values[name]},serve:(h:typeof handler)=>{handler=h;}};globalThis.fetch=send;const source=bundle.files[0].content.replaceAll('npm:web-push@4.0.0',runtime);await import('data:text/javascript;base64,'+Buffer.from(source+'\n// urgent-bundle '+sequence++).toString('base64'));if(!handler)throw Error('No packaged handler');await work(handler);}finally{root.Deno=oldDeno;globalThis.fetch=oldFetch;}}
const request=()=>{const at=Date.now(),nonce=randomUUID(),mac=createHmac('sha256',key).update(`mise:urgent-inbox:v1\n${at}\n${nonce}\n25`).digest('hex');return new Request('https://rpc.test/functions/v1/urgent-inbox-push',{method:'POST',headers:{authorization:`Bearer v1.${at}.${nonce}.${mac}`,'Content-Type':'application/json'},body:'{}'});};
it('packages both exact functions with only the reviewed pinned encryption runtime and no configuration values',()=>{
 expect(worker.runtimeImports).toEqual(['npm:web-push@4.0.0']);expect(owner.runtimeImports).toEqual([]);
 for(const path of ['supabase/functions/_shared/urgent-inbox-authorization.ts','supabase/functions/_shared/urgent-inbox-push-handler.ts','supabase/functions/_shared/urgent-inbox-push-sender.ts','packages/core/urgent-inbox.ts'])expect(worker.sourceHashes).toHaveProperty(path);
 for(const bundle of [worker,owner]){expect(bundle.files[0].content).not.toContain(vapid.privateKey);expect(bundle.files[0].content).not.toContain(env.MISE_SERVICE_API_KEY);}
});
it('starts disabled and denies bare reusable keys before SQL when configured',async()=>{
 await execute(worker,{},never,async handler=>{expect((await handler(request())).status).toBe(503);});
 await execute(worker,env,never,async handler=>{expect((await handler(new Request('https://rpc.test/functions/v1/urgent-inbox-push',{method:'POST',headers:{authorization:'Bearer '+key,'Content-Type':'application/json'},body:'{}'}))).status).toBe(401);});
});
it('consumes the actual one-use SQL grant before a counts-only empty tick',async()=>{
 const calls:string[]=[];await execute(worker,env,async(url,init)=>{const path=new URL(String(url)).pathname;calls.push(path);const headers=new Headers(init?.headers);expect(headers.get('apikey')).toBe('sb_secret_test_only');expect(headers.has('authorization')).toBe(false);if(path.endsWith('/claim_urgent_inbox_dispatch'))return Response.json(true);expect(path).toBe('/rest/v1/rpc/prepare_urgent_inbox_push');return Response.json({v:1,at:Date.now(),jobs:[]});},async handler=>{const response=await handler(request());expect(response.status).toBe(200);expect(await response.json()).toMatchObject({processed:0,sent:0,failed:0});});expect(calls).toEqual(['/rest/v1/rpc/claim_urgent_inbox_dispatch','/rest/v1/rpc/prepare_urgent_inbox_push']);
});
it('rejects an absent grant without preparing work',async()=>{
 let calls=0;await execute(worker,env,async()=>{calls++;return Response.json(false);},async handler=>{expect((await handler(request())).status).toBe(409);});expect(calls).toBe(1);
});
it('keeps original withdrawal available with delivery disabled and no private VAPID credential',async()=>{
 const id='00000000000000000000000001',eventId='00000000000000000000000002';await execute(owner,{SUPABASE_URL:'https://rpc.test',MISE_PUBLISHABLE_API_KEY:'sb_publishable_test_only',MISE_ALLOWED_ORIGINS:'https://desk.test'},async(url,init)=>{expect(String(url)).toBe('https://rpc.test/rest/v1/rpc/withdraw_urgent_inbox');expect(new Headers(init?.headers).get('authorization')).toBe('Bearer original.phone.signature');expect(new Headers(init?.headers).get('apikey')).toBe('sb_publishable_test_only');return Response.json({v:1,id,eventId,closedAt:Date.now(),consent:null});},async handler=>{const response=await handler(new Request('https://rpc.test/functions/v1/urgent-inbox-notifications',{method:'POST',headers:{origin:'https://desk.test',authorization:'Bearer original.phone.signature','Content-Type':'application/json'},body:JSON.stringify({action:'withdraw',id,eventId})}));expect(response.status).toBe(200);expect(await response.json()).toMatchObject({id,eventId,consent:null});});
});
it('does not advertise readiness with only a public VAPID key while still allowing original cleanup',async()=>{
 const values={SUPABASE_URL:'https://rpc.test',MISE_PUBLISHABLE_API_KEY:'sb_publishable_test_only',MISE_ALLOWED_ORIGINS:'https://desk.test',MISE_URGENT_INBOX_ENABLED:'true',MISE_WEB_PUSH_VAPID_PUBLIC_KEY:vapid.publicKey};
 await execute(owner,values,never,async handler=>{const response=await handler(new Request('https://rpc.test/functions/v1/urgent-inbox-notifications',{method:'POST',headers:{origin:'https://desk.test',authorization:'Bearer original.phone.signature','Content-Type':'application/json'},body:JSON.stringify({action:'configuration',outletId:'00000000000000000000000011'})}));expect(response.status).toBe(503);expect(await response.text()).not.toContain(vapid.publicKey);});
});
it('advertises only scoped public configuration after private delivery settings are complete',async()=>{
 const context={v:1,businessId:'00000000000000000000000001',outletId:'00000000000000000000000011',memberId:'00000000000000000000000101',role:'owner'};
 await execute(owner,{...env,MISE_PUBLISHABLE_API_KEY:'sb_publishable_test_only',MISE_ALLOWED_ORIGINS:'https://desk.test'},async()=>Response.json(context),async handler=>{const response=await handler(new Request('https://rpc.test/functions/v1/urgent-inbox-notifications',{method:'POST',headers:{origin:'https://desk.test',authorization:'Bearer original.phone.signature','Content-Type':'application/json'},body:JSON.stringify({action:'configuration',outletId:context.outletId})}));expect(response.status).toBe(200);const text=await response.text();expect(JSON.parse(text)).toEqual({v:1,context,applicationKey:vapid.publicKey});for(const value of [key,vapid.privateKey,env.MISE_SERVICE_API_KEY])expect(text).not.toContain(value);});
});
