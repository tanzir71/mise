import {createDeskNotificationsHandler,createDeskNotificationsStore} from '../_shared/desk-notifications-handler.ts';
declare const Deno:{env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):void};
let handler:(request:Request)=>Promise<Response>;
try {
 const origins=new Set((Deno.env.get('MISE_ALLOWED_ORIGINS')??'').split(',').filter(Boolean));
 if(!origins.size||[...origins].some(origin=>new URL(origin).origin!==origin))throw Error('Configure exact origins.');
 handler=createDeskNotificationsHandler({origins,applicationKey:Deno.env.get('MISE_WEB_PUSH_VAPID_PUBLIC_KEY'),
  store:createDeskNotificationsStore(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('MISE_PUBLISHABLE_API_KEY')??'')});
}catch{handler=async()=>Response.json({error:'Desk notifications are unavailable.'},{status:503,headers:{'Cache-Control':'no-store'}});}
Deno.serve(handler);
