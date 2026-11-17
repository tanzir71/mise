import {createDevicePinHandler,createDevicePinStore} from '../_shared/device-pin-handler.ts';
import {staffPinPepper} from '../_shared/staff-pin.ts';
declare const Deno:{env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):void};

let handler:(request:Request)=>Promise<Response>;
try{
  const origins=new Set((Deno.env.get('MISE_ALLOWED_ORIGINS')||'').split(',').filter(Boolean));
  if(!origins.size||[...origins].some(origin=>new URL(origin).origin!==origin))throw new Error('Origins required');
  handler=createDevicePinHandler({store:createDevicePinStore(Deno.env.get('SUPABASE_URL')||'',Deno.env.get('MISE_SERVICE_API_KEY')||''),
    peppers:new Map([['v1',staffPinPepper(Deno.env.get('MISE_STAFF_PIN_PEPPER_V1'))]]),origins});
}catch{
  handler=async()=>new Response(JSON.stringify({error:'Sign-in is unavailable. Ask the owner to check this device.'}),{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
}
Deno.serve(handler);
