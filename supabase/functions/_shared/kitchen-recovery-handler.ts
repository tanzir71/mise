import {authHttp,AuthBodyError,readAuthBody} from './auth-http.ts';
import {isDeviceToken} from '../../../packages/core/device-access.ts';
import {parseKitchenCloseRequest,parseKitchenTapRecovery,parseRetainedKitchenTap,type KitchenCloseRequest,type RetainedKitchenTap} from '../../../packages/core/kitchen-recovery.ts';

export interface KitchenRecoveryStore {recover(device:string,session:string,original:RetainedKitchenTap,resolution:KitchenCloseRequest|null):Promise<unknown>}
class StoreError extends Error {constructor(readonly status:409|503){super('Saved-tap recovery is unconfirmed.');}}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
export function createKitchenRecoveryHandler(deps:{store:KitchenRecoveryStore;origins:ReadonlySet<string>}) {
  const origins=new Set(deps.origins);
  return async(request:Request):Promise<Response>=>{
    const {reply,blocked}=authHttp(request,origins);if(blocked)return blocked;
    const device=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if(!device)return reply(401,{error:'Sign in on this screen again.'});
    if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return reply(415,{error:'Use JSON.'});
    let raw:unknown;
    try{raw=await readAuthBody(request);}catch(error){return reply(error instanceof AuthBodyError?error.status:400,{error:'Keep the original saved tap.'});}
    let original:RetainedKitchenTap,resolution:KitchenCloseRequest|null,session:string;
    try{
      if(!object(raw)||!isDeviceToken(raw.sessionToken)||!['lookup','close'].includes(raw.action as string)||
          !exact(raw,raw.action==='lookup'?'action,sessionToken,original':'action,sessionToken,original,resolution'))throw Error();
      original=parseRetainedKitchenTap(raw.original);session=raw.sessionToken;
      resolution=raw.action==='close'?parseKitchenCloseRequest(raw.resolution,original.action):null;
    }catch{return reply(400,{error:'Keep the complete original saved tap and review request.'});}
    try{
      const value=await deps.store.recover(device,session,original,resolution);
      return value===null?reply(401,{error:'Sign in on this screen again.'}):reply(200,parseKitchenTapRecovery(value,original));
    }catch(error){return reply(error instanceof StoreError?error.status:503,{error:error instanceof StoreError&&error.status===409?
      'Keep the original saved tap and review it on this screen.':'The saved tap is unconfirmed. Keep it and try again.'});}
  };
}
export function createKitchenRecoveryStore(apiUrl:string,serviceKey:string,send:typeof fetch=fetch):KitchenRecoveryStore {
  const root=new URL(apiUrl);
  if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||root.protocol!=='https:'&&
      !(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname))||!/^sb_secret_[A-Za-z0-9_-]+$/.test(serviceKey))throw new StoreError(503);
  return {async recover(device,session,original,resolution){
    const body=JSON.stringify({p_device_token:device,p_session_token:session,p_original:original,p_resolution:resolution});
    const controller=new AbortController();let response:Response|undefined,timer:ReturnType<typeof setTimeout>|undefined;
    const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new StoreError(503));},5000);});
    try{
      response=await Promise.race([send(new URL('rest/v1/rpc/recover_kitchen_tap',root),{method:'POST',redirect:'error',signal:controller.signal,
        headers:{apikey:serviceKey,'Content-Type':'application/json'},body}),deadline]);
      if(!response.ok)throw new StoreError([400,409].includes(response.status)?409:503);
      const reader=response.body?.getReader();if(!reader)throw new StoreError(503);
      const chunks:Uint8Array[]=[];let size=0;
      try{for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;size+=part.value.byteLength;if(size>16384)throw new StoreError(503);chunks.push(part.value);}}
      catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
    }finally{clearTimeout(timer);controller.abort();void response?.body?.cancel().catch(()=>{});}
  }};
}
