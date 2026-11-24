import {createStaffStockActionsHandler,createStaffStockActionsStore} from '../_shared/staff-stock-actions-handler.ts';
import {staffStockLimit} from '../_shared/staff-stock-handler.ts';
declare const Deno:{env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):void};
let handler:((request:Request)=>Promise<Response>)=async()=>Response.json({error:'Staff stock changes are unavailable. Tell the manager by hand.'},{status:503,headers:{'Cache-Control':'no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});
try{
 if(Deno.env.get('MISE_STAFF_STOCK_ENABLED')==='true'&&Deno.env.get('MISE_STAFF_STOCK_WRITES_ENABLED')==='true')handler=createStaffStockActionsHandler({store:createStaffStockActionsStore(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('MISE_SERVICE_API_KEY')??''),origins:new Set((Deno.env.get('MISE_ALLOWED_ORIGINS')??'').split(',').map(v=>v.trim()).filter(Boolean)),limit:staffStockLimit(Deno.env.get('MISE_STAFF_STOCK_REQUESTS_PER_MINUTE'))});
}catch{/* Installation-owned private configuration; originals/manual work stay available. */}
Deno.serve(handler);
