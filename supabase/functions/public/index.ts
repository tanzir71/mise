import {createPublicOrderHandler,createPublicOrderStore,publicOrderLimits} from '../_shared/public-order-handler.ts';
declare const Deno:{env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):void};
let handler:(request:Request)=>Promise<Response>;
try{
 if(Deno.env.get('MISE_PUBLIC_ORDERS_ENABLED')!=='true')throw Error('Public ordering is disabled.');
 handler=createPublicOrderHandler({store:createPublicOrderStore(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('MISE_SERVICE_API_KEY')??''),
  origins:new Set((Deno.env.get('MISE_ALLOWED_ORIGINS')??'').split(',').filter(Boolean)),
  limits:publicOrderLimits(Deno.env.get('MISE_PUBLIC_ORDERS_PER_MINUTE'),Deno.env.get('MISE_PUBLIC_SHOP_ORDERS_PER_MINUTE'))});
}catch{handler=async()=>Response.json({error:'Online ordering is unavailable. Use the shop’s message option.'},{status:503,headers:{'Cache-Control':'no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});}
Deno.serve(handler);
