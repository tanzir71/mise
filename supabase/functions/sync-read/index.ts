import {createSyncReadHandler,createSyncReadStore} from '../_shared/sync-read-handler.ts';
declare const Deno:{env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):void};
let handler:(request:Request)=>Promise<Response>;
try{
 const origins=new Set((Deno.env.get('MISE_ALLOWED_ORIGINS')??'').split(',').filter(Boolean));if(!origins.size||[...origins].some(origin=>new URL(origin).origin!==origin))throw new Error('Origins required');
 handler=createSyncReadHandler({origins,store:createSyncReadStore(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('MISE_PUBLISHABLE_API_KEY')??''),cursorKey:Deno.env.get('MISE_SYNC_CURSOR_KEY_V1')??''});
}catch{handler=async()=>new Response(JSON.stringify({error:'Sync is unavailable. Keep local work and try again later.'}),{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}
Deno.serve(handler);
