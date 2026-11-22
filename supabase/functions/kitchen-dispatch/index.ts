import {generateRequestDetails} from 'npm:web-push@4.0.0';
import {createKitchenDispatchHandler} from '../_shared/kitchen-dispatch-handler.ts';
import {createKitchenAlarmsStore} from '../_shared/kitchen-alarms-handler.ts';
import {createKitchenPushStore} from '../_shared/kitchen-push-handler.ts';
import {createDeskPushSender} from '../_shared/desk-push-sender.ts';
declare const Deno:{env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):void};
let handler:(request:Request)=>Promise<Response>;
try{
 const url=Deno.env.get('SUPABASE_URL')??'',service=Deno.env.get('MISE_SERVICE_API_KEY')??'',publicKey=Deno.env.get('MISE_WEB_PUSH_VAPID_PUBLIC_KEY')??'';
 handler=createKitchenDispatchHandler({key:Deno.env.get('MISE_KITCHEN_ALARM_KEY')??'',applicationKey:publicKey,alarms:createKitchenAlarmsStore(url,service),push:createKitchenPushStore(url,service),send:createDeskPushSender(generateRequestDetails,{publicKey,privateKey:Deno.env.get('MISE_WEB_PUSH_VAPID_PRIVATE_KEY')??'',subject:Deno.env.get('MISE_WEB_PUSH_VAPID_SUBJECT')??''})});
}catch{handler=async()=>Response.json({error:'Kitchen dispatch is unavailable.'},{status:503,headers:{'Cache-Control':'no-store'}});}
Deno.serve(handler);
