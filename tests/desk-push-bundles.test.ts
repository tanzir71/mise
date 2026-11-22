import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {beforeAll,expect,it} from 'vitest';
import {generateVAPIDKeys} from 'web-push';
// @ts-expect-error Deployment packaging is a standalone Node module.
import {edgeBundle} from '../scripts/edge-bundle.mjs';
interface Bundle {files:{content:string}[];runtimeImports:string[];sourceHashes:Record<string,string>}
let worker:Bundle,desk:Bundle,loadNumber=0;
const vapid=generateVAPIDKeys(),key='A'.repeat(43),webPushUrl=pathToFileURL(createRequire(import.meta.url).resolve('web-push')).href;
beforeAll(async()=>{worker=await edgeBundle('kitchen-push');desk=await edgeBundle('desk-notifications');},30000);
async function execute(bundle:Bundle,env:Record<string,string>,send:typeof fetch,work:(handler:(request:Request)=>Promise<Response>)=>Promise<void>){
 const runtime=globalThis as unknown as {Deno?:unknown},oldDeno=runtime.Deno,oldFetch=globalThis.fetch;let handler:((request:Request)=>Promise<Response>)|undefined;
 try{
  runtime.Deno={env:{get:(name:string)=>env[name]},serve:(value:typeof handler)=>{handler=value;}};globalThis.fetch=send;
  // The pinned npm runtime remains external in deployment. Node executes the
  // identical reviewed installed package for this local packaging check.
  const source=bundle.files[0].content.replaceAll('npm:web-push@4.0.0',webPushUrl);
  await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64')+'#desk-'+(++loadNumber));
  expect(handler).toBeTypeOf('function');await work(handler!);
 }finally{runtime.Deno=oldDeno;globalThis.fetch=oldFetch;}
}
const workerEnv={SUPABASE_URL:'https://rpc.test',MISE_SERVICE_API_KEY:'sb_secret_test_only',MISE_KITCHEN_ALARM_KEY:key,
 MISE_WEB_PUSH_VAPID_PUBLIC_KEY:vapid.publicKey,MISE_WEB_PUSH_VAPID_PRIVATE_KEY:vapid.privateKey,MISE_WEB_PUSH_VAPID_SUBJECT:'https://desk.test/contact'};
const never:typeof fetch=async()=>{throw Error('Unexpected network request');};
it('keeps exactly the reviewed pinned runtime import in the worker and no runtime dependency in the owner endpoint',()=>{
 expect(worker.runtimeImports).toEqual(['npm:web-push@4.0.0']);expect(desk.runtimeImports).toEqual([]);
 for(const path of ['supabase/functions/_shared/kitchen-push-handler.ts','supabase/functions/_shared/desk-push-sender.ts','packages/core/desk-push.ts'])expect(worker.sourceHashes).toHaveProperty(path);
 expect(desk.sourceHashes).toHaveProperty('supabase/functions/_shared/desk-notifications-handler.ts');
 expect(worker.files[0].content).not.toContain(vapid.privateKey);expect(desk.files[0].content).not.toContain(vapid.privateKey);
});
it('the packaged worker initializes the real library and denies an unauthenticated request before SQL',async()=>{
 await execute(worker,workerEnv,never,async handler=>{const response=await handler(new Request('https://rpc.test/functions/v1/kitchen-push',{method:'POST'}));expect(response.status).toBe(401);});
});
it('the packaged worker reads its actual private runtime configuration and completes a counts-only empty tick',async()=>{
 let calls=0;const send:typeof fetch=async(url,init)=>{calls++;expect(String(url)).toBe('https://rpc.test/rest/v1/rpc/prepare_kitchen_push');
  const headers=new Headers(init?.headers);expect(headers.get('apikey')).toBe('sb_secret_test_only');expect(headers.has('authorization')).toBe(false);
  expect(JSON.parse(String(init?.body))).toEqual({p_application_key:vapid.publicKey,p_limit:25});return Response.json({v:1,at:Date.now(),jobs:[]});};
 await execute(worker,workerEnv,send,async handler=>{const response=await handler(new Request('https://rpc.test/functions/v1/kitchen-push',{method:'POST',headers:{authorization:'Bearer '+key,'Content-Type':'application/json'},body:'{}'}));expect(response.status).toBe(200);expect(await response.json()).toMatchObject({processed:0,sent:0,failed:0});});expect(calls).toBe(1);
});
it('the packaged worker fails closed without configured secrets',async()=>{
 await execute(worker,{},never,async handler=>{const response=await handler(new Request('https://rpc.test/functions/v1/kitchen-push',{method:'POST'}));expect(response.status).toBe(503);expect(await response.text()).not.toContain('sb_secret');});
});
it('the packaged owner endpoint forwards the original JWT and supports cleanup without a private VAPID key',async()=>{
 const env={SUPABASE_URL:'https://rpc.test',MISE_PUBLISHABLE_API_KEY:'sb_publishable_test_only',MISE_ALLOWED_ORIGINS:'https://desk.test'},id='00000000000000000000000001';let calls=0;
 const send:typeof fetch=async(url,init)=>{calls++;expect(String(url)).toBe('https://rpc.test/rest/v1/rpc/read_desk_push');expect(new Headers(init?.headers).get('authorization')).toBe('Bearer original.phone.signature');expect(new Headers(init?.headers).get('apikey')).toBe('sb_publishable_test_only');expect(JSON.parse(String(init?.body))).toEqual({p_id:id});return Response.json(null);};
 await execute(desk,env,send,async handler=>{const response=await handler(new Request('https://rpc.test/functions/v1/desk-notifications',{method:'POST',headers:{origin:'https://desk.test',authorization:'Bearer original.phone.signature','Content-Type':'application/json'},body:JSON.stringify({action:'read',id})}));expect(response.status).toBe(200);expect(await response.json()).toBeNull();});expect(calls).toBe(1);
});
