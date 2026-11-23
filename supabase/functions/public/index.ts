import {createPublicOrderHandler,createPublicOrderStore,publicOrderLimits} from '../_shared/public-order-handler.ts';
import {createOrderCheckoutHandler,createOrderCheckoutStore,checkoutLimits} from '../_shared/order-checkout-handler.ts';
declare const Deno:{env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):void};
let handler:(request:Request)=>Promise<Response>;
try{
 if(Deno.env.get('MISE_PUBLIC_ORDERS_ENABLED')!=='true')throw Error('Public ordering is disabled.');
 const orders=createPublicOrderHandler({store:createPublicOrderStore(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('MISE_SERVICE_API_KEY')??''),
  origins:new Set((Deno.env.get('MISE_ALLOWED_ORIGINS')??'').split(',').filter(Boolean)),
  limits:publicOrderLimits(Deno.env.get('MISE_PUBLIC_ORDERS_PER_MINUTE'),Deno.env.get('MISE_PUBLIC_SHOP_ORDERS_PER_MINUTE'))});
 const checkout=createOrderCheckoutHandler({store:createOrderCheckoutStore(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('MISE_SERVICE_API_KEY')??''),
  origins:new Set((Deno.env.get('MISE_ALLOWED_ORIGINS')??'').split(',').filter(Boolean)),limits:checkoutLimits(Deno.env.get('MISE_PUBLIC_CONFIRMATIONS_PER_MINUTE'),Deno.env.get('MISE_PUBLIC_LINK_CONFIRMATIONS_PER_MINUTE'))});
 handler=request=>new URL(request.url).pathname.endsWith('/public/orders')?orders(request):checkout(request);
}catch{handler=async()=>Response.json({error:'Online ordering is unavailable. Use the shop’s message option.'},{status:503,headers:{'Cache-Control':'no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});}
Deno.serve(handler);
