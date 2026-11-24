import {createStaffStockHandler,createStaffStockStore,staffStockLimit} from '../_shared/staff-stock-handler.ts';
declare const Deno:{env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):void};
let handler:((request:Request)=>Promise<Response>)=async()=>Response.json({error:'Shared-screen stock is unavailable. Tell the manager by hand.'},{status:503,headers:{'Cache-Control':'no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});
try{
 if(Deno.env.get('MISE_STAFF_STOCK_ENABLED')==='true')handler=createStaffStockHandler({
  store:createStaffStockStore(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('MISE_SERVICE_API_KEY')??''),
  origins:new Set((Deno.env.get('MISE_ALLOWED_ORIGINS')??'').split(',').map(value=>value.trim()).filter(Boolean)),
  limit:staffStockLimit(Deno.env.get('MISE_STAFF_STOCK_REQUESTS_PER_MINUTE'))});
}catch{/* Each installation configures its own private backend before opt-in. */}
Deno.serve(handler);
