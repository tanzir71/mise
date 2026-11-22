import {createKitchenAlarmsHandler,createKitchenAlarmsStore} from '../_shared/kitchen-alarms-handler.ts';
declare const Deno:{env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):void};
let handler:(request:Request)=>Promise<Response>;
try {
 handler=createKitchenAlarmsHandler({key:Deno.env.get('MISE_KITCHEN_ALARM_KEY')??'',
  store:createKitchenAlarmsStore(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('MISE_SERVICE_API_KEY')??'')});
}catch{handler=async()=>Response.json({error:'Kitchen alarms are unavailable.'},{status:503,headers:{'Cache-Control':'no-store'}});}
Deno.serve(handler);
