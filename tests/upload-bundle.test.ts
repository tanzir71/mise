import {expect,it} from 'vitest';
// @ts-expect-error Deployment packaging is a standalone Node module.
import {edgeBundle} from '../scripts/edge-bundle.mjs';
it('the exact single-file deployment boots shared validation without unresolved imports or credentials',async()=>{
  const bundle=await edgeBundle('migration-upload');expect(bundle.files).toHaveLength(1);expect(bundle.bytes).toBeLessThan(20*1024*1024);expect(bundle.sha256).toMatch(/^[a-f0-9]{64}$/);expect(bundle.sourceHashes).toHaveProperty('packages/core/cloud-upload.ts');expect(bundle.sourceHashes).toHaveProperty('packages/core/cloud-records.ts');
  let handler:((request:Request)=>Promise<Response>)|undefined;const global=globalThis as unknown as {Deno?:unknown},previous=global.Deno;
  try{global.Deno={env:{get:(name:string)=>({SUPABASE_URL:'https://api.test',MISE_PUBLISHABLE_API_KEY:'sb_publishable_test_only',MISE_SERVICE_API_KEY:'sb_secret_test_only',MISE_ALLOWED_ORIGINS:'https://shop.test'} as Record<string,string>)[name]},serve:(callback:typeof handler)=>{handler=callback;}};
    await import('data:text/javascript;base64,'+Buffer.from(bundle.files[0].content).toString('base64'));expect(handler).toBeTypeOf('function');
    const response=await handler!(new Request('https://api.test/',{method:'POST',headers:{Origin:'https://shop.test','Content-Type':'application/json'},body:'{}'}));expect(response.status).toBe(401);expect(await response.text()).not.toContain('sb_secret');
    const preflight=await handler!(new Request('https://api.test/',{method:'OPTIONS',headers:{Origin:'https://shop.test'}}));expect(preflight.status).toBe(204);expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('https://shop.test');
  }finally{global.Deno=previous;}
},30000);
