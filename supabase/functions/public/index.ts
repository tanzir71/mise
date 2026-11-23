import {createPublicOrderHandler,createPublicOrderStore,publicOrderLimits} from '../_shared/public-order-handler.ts';
import {createOrderCheckoutHandler,createOrderCheckoutStore,checkoutLimits} from '../_shared/order-checkout-handler.ts';
import {createStaffLinkHandler,createStaffLinkStore,staffLinkLimits} from '../_shared/staff-link-handler.ts';
import {createCustomerKhataHandler,createCustomerKhataStore,khataLimits} from '../_shared/customer-khata-handler.ts';
declare const Deno:{env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):void};
const unavailable=async()=>Response.json({error:'Online ordering is unavailable. Use the shop’s message option.'},{status:503,headers:{'Cache-Control':'no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});
let orders:(request:Request)=>Promise<Response>=unavailable,checkout:(request:Request)=>Promise<Response>=unavailable,staff:(request:Request)=>Promise<Response>=async()=>Response.json({error:'Staff links are unavailable. Tell the manager by hand.'},{status:503,headers:{'Cache-Control':'no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});
try{
 if(Deno.env.get('MISE_PUBLIC_ORDERS_ENABLED')!=='true')throw Error('Public ordering is disabled.');
 orders=createPublicOrderHandler({store:createPublicOrderStore(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('MISE_SERVICE_API_KEY')??''),
  origins:new Set((Deno.env.get('MISE_ALLOWED_ORIGINS')??'').split(',').filter(Boolean)),
  limits:publicOrderLimits(Deno.env.get('MISE_PUBLIC_ORDERS_PER_MINUTE'),Deno.env.get('MISE_PUBLIC_SHOP_ORDERS_PER_MINUTE'))});
 checkout=createOrderCheckoutHandler({store:createOrderCheckoutStore(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('MISE_SERVICE_API_KEY')??''),
  origins:new Set((Deno.env.get('MISE_ALLOWED_ORIGINS')??'').split(',').filter(Boolean)),limits:checkoutLimits(Deno.env.get('MISE_PUBLIC_CONFIRMATIONS_PER_MINUTE'),Deno.env.get('MISE_PUBLIC_LINK_CONFIRMATIONS_PER_MINUTE'))});
}catch{orders=unavailable;checkout=unavailable;}
try{
 if(Deno.env.get('MISE_STAFF_LINKS_ENABLED')==='true')staff=createStaffLinkHandler({store:createStaffLinkStore(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('MISE_SERVICE_API_KEY')??''),
  origins:new Set((Deno.env.get('MISE_ALLOWED_ORIGINS')??'').split(',').map(value=>value.trim()).filter(Boolean)),
  limits:staffLinkLimits(Deno.env.get('MISE_PUBLIC_STAFF_REQUESTS_PER_MINUTE'),Deno.env.get('MISE_PUBLIC_STAFF_LINK_REQUESTS_PER_MINUTE'))});
}catch{/* The installation must configure this service before enabling it. */}
let khata:(request:Request)=>Promise<Response>=unavailable;
try{if(Deno.env.get('MISE_CUSTOMER_KHATA_ENABLED')==='true')khata=createCustomerKhataHandler({store:createCustomerKhataStore(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('MISE_SERVICE_API_KEY')??''),origins:new Set((Deno.env.get('MISE_ALLOWED_ORIGINS')??'').split(',').map(v=>v.trim()).filter(Boolean)),limits:khataLimits(Deno.env.get('MISE_PUBLIC_KHATA_REQUESTS_PER_MINUTE'),Deno.env.get('MISE_PUBLIC_KHATA_LINK_REQUESTS_PER_MINUTE'))});}catch{/* Installation-owned configuration is required. */}
const handler=(request:Request)=>{const path=new URL(request.url).pathname;return path.endsWith('/public/khata')?khata(request):path.endsWith('/public/staff')?staff(request):path.endsWith('/public/orders')?orders(request):checkout(request);};
Deno.serve(handler);
