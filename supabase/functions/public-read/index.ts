import {createPublicCapabilityHandler,createPublicCapabilityStore,publicReadLimits} from '../_shared/public-capability-handler.ts';

declare const Deno:{env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):void};
let handler:(request:Request)=>Promise<Response>;
try{
 handler=createPublicCapabilityHandler({store:createPublicCapabilityStore(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('MISE_SERVICE_API_KEY')??''),
  origins:new Set((Deno.env.get('MISE_ALLOWED_ORIGINS')??'').split(',').filter(Boolean)),
  limits:publicReadLimits(Deno.env.get('MISE_PUBLIC_READS_PER_MINUTE'),Deno.env.get('MISE_PUBLIC_LINK_READS_PER_MINUTE'))});
}catch{handler=async()=>Response.json({error:'Customer links are unavailable. Contact the shop.'},{status:503,headers:{'Cache-Control':'no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});}
Deno.serve(handler);
