import {createInitialUploadHandler} from '../_shared/upload-handler.ts';
import {createInitialUploadStore} from '../_shared/upload-store.ts';
declare const Deno:{env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):void};
let handler:(request:Request)=>Promise<Response>;
try{const origins=new Set((Deno.env.get('MISE_ALLOWED_ORIGINS')||'').split(',').filter(Boolean));if(!origins.size||[...origins].some(origin=>new URL(origin).origin!==origin))throw new Error('Origins required');handler=createInitialUploadHandler({origins,store:createInitialUploadStore(Deno.env.get('SUPABASE_URL')||'',Deno.env.get('MISE_PUBLISHABLE_API_KEY')||'',Deno.env.get('MISE_SERVICE_API_KEY')||'')});}
catch{handler=async()=>new Response(JSON.stringify({error:'Upload is unavailable. Keep your local copy.'}),{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}
Deno.serve(handler);
