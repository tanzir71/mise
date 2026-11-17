import {createInboxImageHandler} from '../_shared/inbox-image-handler.ts';
import {createInboxImageStore} from '../_shared/inbox-image-store.ts';
declare const Deno:{env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):void};
let handler:(request:Request)=>Promise<Response>;
try{
  const origins=new Set((Deno.env.get('MISE_ALLOWED_ORIGINS')||'').split(',').filter(Boolean));
  if(!origins.size||[...origins].some(origin=>new URL(origin).origin!==origin))throw new Error('Origins required');
  handler=createInboxImageHandler({store:createInboxImageStore(Deno.env.get('SUPABASE_URL')||'',Deno.env.get('MISE_PUBLISHABLE_API_KEY')||'',Deno.env.get('MISE_SERVICE_API_KEY')||''),origins});
}catch{handler=async()=>new Response(JSON.stringify({error:'Images are unavailable. Try again later.'}),{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}
Deno.serve(handler);
