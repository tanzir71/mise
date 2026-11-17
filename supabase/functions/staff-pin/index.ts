import {createOwnerPinHandler,createOwnerPinStore} from '../_shared/owner-pin-handler.ts';
import {staffPinPepper} from '../_shared/staff-pin.ts';
declare const Deno:{env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):void};
let handler:(request:Request)=>Promise<Response>;
try{
  const origins=new Set((Deno.env.get('MISE_ALLOWED_ORIGINS')||'').split(',').filter(Boolean));
  if(!origins.size||[...origins].some(origin=>new URL(origin).origin!==origin))throw new Error('Origins required');
  let pepper:Uint8Array|undefined;try{pepper=staffPinPepper(Deno.env.get('MISE_STAFF_PIN_PEPPER_V1'));}catch{/* Removal remains available if the hashing secret is unavailable. */}
  handler=createOwnerPinHandler({store:createOwnerPinStore(Deno.env.get('SUPABASE_URL')||'',Deno.env.get('MISE_PUBLISHABLE_API_KEY')||''),pepper,origins});
}catch{handler=async()=>new Response(JSON.stringify({error:'PIN settings are unavailable. Try again later.'}),{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}
Deno.serve(handler);
