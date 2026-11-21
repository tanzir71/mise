import Socket from 'npm:ws@8.23.0';
import {createDeviceAccessStore} from '../_shared/device-access-handler.ts';
import {kitchenBroadcastSubscriber,type KitchenBroadcastSocketFactory} from '../_shared/kitchen-broadcast.ts';
import {createKitchenLiveHandler} from '../_shared/kitchen-live-handler.ts';

declare const Deno: {env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):void};
let handler:(request:Request)=>Promise<Response>;
try {
  const root = Deno.env.get('SUPABASE_URL') ?? '', key = Deno.env.get('MISE_SERVICE_API_KEY') ?? '';
  const origins = new Set((Deno.env.get('MISE_ALLOWED_ORIGINS') ?? '').split(',').filter(Boolean));
  if (!origins.size || [...origins].some(origin => new URL(origin).origin !== origin)) throw Error();
  const open: KitchenBroadcastSocketFactory = (url,headers,callbacks) => {
    const socket = new Socket(url,{headers,handshakeTimeout:5000,followRedirects:false,perMessageDeflate:false,maxPayload:16384});
    socket.on('open',callbacks.open);
    socket.on('message',(bytes,binary) => {if (binary) {callbacks.close(); socket.terminate();} else callbacks.text(bytes.toString());});
    socket.on('close',callbacks.close); socket.on('error',callbacks.close);
    socket.on('unexpected-response',(_request,response) => {response.resume(); callbacks.close(); socket.terminate();});
    return {send:text => socket.send(text),close:() => socket.terminate()};
  };
  const store = createDeviceAccessStore(root,key);
  handler = createKitchenLiveHandler({origins,access:store.session,subscribe:kitchenBroadcastSubscriber(root,key,open)});
} catch {handler = async () => new Response(JSON.stringify({error:'Live updates are unavailable.'}),{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}
Deno.serve(handler);
