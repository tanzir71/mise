import {inboxImageTypes,validateInboxImageBytes,type InboxImageType} from '../../../packages/core/inbox-image.ts';
import {deviceAuthId} from './device-pin-handler.ts';
export class ImageAccessDenied extends Error {constructor(readonly status:401|403=403){super('This image is unavailable.');}}
export class ImageBodyError extends Error {constructor(readonly status:400|408|413){super('Invalid image body.');}}
export interface ImageContext {id:string;businessId:string;outletId:string;inboxId:string;path:string;type:InboxImageType;size:number;sha256:string;uploadedAt:number|null}
export interface InboxImageStore {
  context(jwt:string,id:string):Promise<unknown>;
  complete(jwt:string,id:string,eventId:string):Promise<unknown>;
  put(meta:ImageContext,bytes:Uint8Array):Promise<boolean>;
  get(meta:ImageContext):Promise<Uint8Array>;
}
const ulid=/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
function context(v:unknown,id:string):ImageContext {
  if(!object(v)||v.id!==id||!['id','businessId','outletId','inboxId'].every(k=>typeof v[k]==='string'&&ulid.test(v[k]))||
    v.path!==`${v.businessId}/${v.outletId}/${v.inboxId}/${v.id}`||!inboxImageTypes.includes(v.type as InboxImageType)||typeof v.size!=='number'||!Number.isSafeInteger(v.size)||v.size<1||v.size>5242880||typeof v.sha256!=='string'||!/^[0-9a-f]{64}$/.test(v.sha256)||(v.uploadedAt!==null&&!time(v.uploadedAt)))throw new Error('Invalid image context');
  return {id,businessId:v.businessId as string,outletId:v.outletId as string,inboxId:v.inboxId as string,path:v.path as string,type:v.type as InboxImageType,size:v.size,sha256:v.sha256,uploadedAt:v.uploadedAt as number|null};
}
export async function readImageBody(body:ReadableStream<Uint8Array>|null,size:number,length:string|null,deadlineMs=90000):Promise<Uint8Array>{
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)!==size))throw new ImageBodyError(Number(length)>size?413:400);
  const reader=body?.getReader();if(!reader)throw new ImageBodyError(400);
  const chunks:Uint8Array[]=[];let total=0,timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new ImageBodyError(408)),deadlineMs);});
  try{while(true){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;total+=part.value.byteLength;if(total>size)throw new ImageBodyError(413);chunks.push(part.value);}}
  catch(error){void reader.cancel().catch(()=>{});throw error;}finally{clearTimeout(timer);reader.releaseLock();}
  if(total!==size)throw new ImageBodyError(400);const bytes=new Uint8Array(total);let at=0;for(const part of chunks){bytes.set(part,at);at+=part.length;}return bytes;
}
async function verify(meta:ImageContext,bytes:Uint8Array){
  if(bytes.length!==meta.size)throw new Error('Image size changed');validateInboxImageBytes(meta.type,bytes);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer)),n=>n.toString(16).padStart(2,'0')).join('');
  if(hash!==meta.sha256)throw new Error('Image bytes changed');
}
export function createInboxImageHandler(deps:{store:InboxImageStore;origins:ReadonlySet<string>;newId?:()=>string}){
  const origins=new Set(deps.origins),newId=deps.newId??deviceAuthId;
  return async(request:Request):Promise<Response>=>{
    const origin=request.headers.get('origin'),headers=new Headers({'Cache-Control':'no-store','Pragma':'no-cache','Vary':'Origin','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"});
    if(origin&&origins.has(origin))headers.set('Access-Control-Allow-Origin',origin);
    const reply=(status:number,value:unknown)=>{const h=new Headers(headers);h.set('Content-Type','application/json; charset=utf-8');return new Response(JSON.stringify(value),{status,headers:h});};
    if(origin&&!origins.has(origin))return reply(403,{error:'This origin is not allowed.'});
    if(request.method==='OPTIONS'){headers.set('Access-Control-Allow-Methods','GET, PUT, OPTIONS');headers.set('Access-Control-Allow-Headers','authorization, content-type, apikey');return new Response(null,{status:204,headers});}
    if(!['GET','PUT'].includes(request.method))return reply(405,{error:'Use GET or PUT.'});
    const auth=request.headers.get('authorization')||'',jwt=auth.length<=8192?auth.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1]:undefined;
    if(!jwt)return reply(401,{error:'Sign in again to use this image.'});
    const url=new URL(request.url),id=url.searchParams.get('image');
    if(!id||!ulid.test(id)||url.searchParams.size!==1)return reply(400,{error:'Choose one saved image.'});
    try{
      const meta=context(await deps.store.context(jwt,id),id);
      if(request.method==='GET'){
        const bytes=await deps.store.get(meta);await verify(meta,bytes);
        const fresh=context(await deps.store.context(jwt,id),id);if(fresh.path!==meta.path||fresh.sha256!==meta.sha256)throw new Error('Image changed');
        headers.set('Content-Type',meta.type);headers.set('Content-Length',String(bytes.length));headers.set('Content-Disposition','inline; filename="mise-image.'+(meta.type==='image/jpeg'?'jpg':meta.type==='image/png'?'png':'webp')+'"');
        return new Response(new Uint8Array(bytes).buffer,{status:200,headers});
      }
      if(request.headers.get('content-type')?.toLowerCase()!==meta.type)return reply(415,{error:'Use the original JPEG, PNG or WebP type.'});
      let bytes:Uint8Array;try{bytes=await readImageBody(request.body,meta.size,request.headers.get('content-length'));}catch(error){return reply(error instanceof ImageBodyError?error.status:400,{error:'Upload the complete original image.'});}
      try{await verify(meta,bytes);}catch{return reply(422,{error:'This file does not match the saved original.'});}
      let stored=false;try{stored=await deps.store.put(meta,bytes);}catch{/* A lost upload response is recovered by verifying the immutable object. */}
      if(!stored)await verify(meta,await deps.store.get(meta));
      const result=await deps.store.complete(jwt,id,newId());
      if(!object(result)||result.id!==id||!time(result.uploadedAt))throw new Error('Invalid upload result');
      return reply(200,{id,uploadedAt:result.uploadedAt});
    }catch(error){return error instanceof ImageAccessDenied?reply(error.status,{error:'This image is unavailable for this account.'}):reply(503,{error:'Images are unavailable. Try again later.'});}
  };
}
