import {createKitchenRecoveryHandler,createKitchenRecoveryStore} from '../_shared/kitchen-recovery-handler.ts';
declare const Deno:{env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):void};
let handler:(request:Request)=>Promise<Response>;
try{
  const origins=new Set((Deno.env.get('MISE_ALLOWED_ORIGINS')??'').split(',').filter(Boolean));
  if(!origins.size||[...origins].some(origin=>new URL(origin).origin!==origin))throw Error();
  handler=createKitchenRecoveryHandler({origins,store:createKitchenRecoveryStore(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('MISE_SERVICE_API_KEY')??'')});
}catch{handler=async()=>new Response(JSON.stringify({error:'Saved-tap recovery is unavailable.'}),{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}
Deno.serve(handler);
