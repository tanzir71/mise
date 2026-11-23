import {createStaffDeviceHandler,createStaffDeviceStore,staffDeviceLimit} from '../_shared/staff-device-handler.ts';
declare const Deno:{env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):void};
let handler:((request:Request)=>Promise<Response>)=async()=>Response.json({error:'Shared-screen attendance is unavailable. Tell the manager by hand.'},{status:503,headers:{'Cache-Control':'no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});
try{
 if(Deno.env.get('MISE_STAFF_DEVICE_ENABLED')==='true')handler=createStaffDeviceHandler({
  store:createStaffDeviceStore(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('MISE_SERVICE_API_KEY')??''),
  origins:new Set((Deno.env.get('MISE_ALLOWED_ORIGINS')??'').split(',').map(value=>value.trim()).filter(Boolean)),
  limit:staffDeviceLimit(Deno.env.get('MISE_STAFF_DEVICE_REQUESTS_PER_MINUTE'))});
}catch{/* The installation configures its own private service before enabling it. */}
Deno.serve(handler);
