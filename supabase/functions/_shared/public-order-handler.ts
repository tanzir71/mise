import { parsePublicOrderSubmission, publicOrderHash, publicOrderAttemptIdFromHash, publicOrderIntentJson, parsePublicOrderOutcome, type PublicOrderSubmission } from '../../../packages/core/public-order-submission.ts';
import { publicOrderRecords } from '../../../packages/core/public-order-projection.ts';
import type { CloudRecord } from '../../../packages/core/cloud-records.ts';
import { authHttp, AuthBodyError, readAuthBody } from './auth-http.ts';

export interface PublicOrderLimits {global:number;shop:number}
export interface PublicOrderStore {
  prepare(input:PublicOrderSubmission,limits:PublicOrderLimits):Promise<unknown>;
  finish(input:PublicOrderSubmission,preparation:Record<string,unknown>,records:CloudRecord[]):Promise<unknown>;
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const unavailable=()=>Error('Public ordering is unavailable.');
export function publicOrderLimits(global?:string,shop?:string):PublicOrderLimits {
  const parse=(v:string|undefined,fallback:number)=>{if(v===undefined||v==='')return fallback;if(!/^[1-9]\d{0,4}$/.test(v)||Number(v)>60000)throw unavailable();return Number(v);};
  return {global:parse(global,300),shop:parse(shop,30)};
}
export function createPublicOrderHandler(deps:{store:PublicOrderStore;origins:ReadonlySet<string>;limits?:PublicOrderLimits}) {
  const origins=new Set(deps.origins),limits={...deps.limits??publicOrderLimits()};
  if(!origins.size||[...origins].some(origin=>new URL(origin).origin!==origin)||![limits.global,limits.shop].every(v=>Number.isInteger(v)&&v>=1&&v<=60000))throw unavailable();
  const secure=(response:Response)=>{response.headers.set('Referrer-Policy','no-referrer');response.headers.set('X-Content-Type-Options','nosniff');response.headers.set('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");response.headers.set('Access-Control-Expose-Headers','Retry-After');return response;};
  return async(request:Request):Promise<Response>=>{
    const http=authHttp(request,origins),reply=(status:number,value:unknown,headers?:Record<string,string>)=>secure(http.reply(status,value,headers));
    if(http.blocked)return secure(http.blocked);
    const url=new URL(request.url);
    if(!url.pathname.endsWith('/public/orders')||url.search)return reply(400,{error:'Use the public order endpoint with a request body.'});
    if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return reply(415,{error:'Use JSON.'});
    let input:PublicOrderSubmission;
    try{
      input=parsePublicOrderSubmission(await readAuthBody(request,65536));
      if(input.website!==''||publicOrderAttemptIdFromHash(await publicOrderHash(input.trackingToken))!==input.intent.id)throw unavailable();
    }catch(error){return reply(error instanceof AuthBodyError?error.status:400,{error:'Review the complete request, or contact the shop.'});}
    try{
      for(let retry=0;retry<3;retry++){
        let raw=await deps.store.prepare(input,limits),created=false;
        if(!object(raw)||raw.v!==1)throw unavailable();
        if(raw.state==='prepared'){
          if(input.action!=='submit')throw unavailable();
          let records:CloudRecord[];
          try{if(input.expectedTable!==undefined&&JSON.parse(String(raw.contextJson)).table!==input.expectedTable)throw unavailable();records=publicOrderRecords(raw,input.intent);}catch{return reply(409,{error:'This request needs the shop’s review. Keep it and use the message option.'});}
          raw=await deps.store.finish(input,raw,records);created=true;
          if(!object(raw)||raw.v!==1)throw unavailable();
          if(raw.state==='conflict')continue;
        }
        if(raw.state==='created'||raw.state==='closed'||raw.state==='pending')
          return reply(raw.state==='pending'?202:created&&raw.state==='created'?201:200,parsePublicOrderOutcome(raw,input.intent));
        if(raw.state==='limited'){
          if(typeof raw.retryAfter!=='number'||!Number.isInteger(raw.retryAfter)||raw.retryAfter<1||raw.retryAfter>60)throw unavailable();
          return reply(429,{error:'The shop is receiving many requests. Keep yours and try again shortly.'},{'Retry-After':String(raw.retryAfter)});
        }
        if(raw.state==='missing')return reply(404,{error:'This request is unavailable. Contact the shop.'});
        if(raw.state==='changed')return reply(409,{error:'The original request or shop snapshot changed. Keep the original and review it.'});
        if(raw.state==='unavailable')return reply(503,{error:'Online ordering is unavailable. Keep your request and contact the shop.'});
        throw unavailable();
      }
      return reply(409,{error:'The shop changed while receiving your request. Check the original request or contact the shop.'});
    }catch{return reply(503,{error:'The request is unconfirmed. Check it again before sending another order.'});}
  };
}

/** The endpoint and SQL argument names are fixed here. Customer input never
 * chooses a URL, tenant, role, clock, limit, SQL operation or financial table. */
export function createPublicOrderStore(url:string,serviceKey:string,send:typeof fetch=fetch):PublicOrderStore {
  const root=new URL(url);
  if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname))||!/^sb_secret_[A-Za-z0-9_-]+$/.test(serviceKey))throw unavailable();
  async function call(rpc:'prepare_public_order'|'finish_public_order',body:Record<string,unknown>):Promise<unknown>{
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,response:Response|undefined;
    const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},5000);});
    try{
      response=await Promise.race([send(new URL('rest/v1/rpc/'+rpc,root),{method:'POST',redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,
        headers:{apikey:serviceKey,'Content-Type':'application/json'},body:JSON.stringify(body)}),deadline]);
      if(!response.ok)throw unavailable();const reader=response.body?.getReader();if(!reader)throw unavailable();
      const chunks:Uint8Array[]=[];let length=0;
      try{for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;length+=part.value.byteLength;if(length>262144)throw unavailable();chunks.push(part.value);}}
      catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
      const bytes=new Uint8Array(length);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
    }catch{throw unavailable();}
    finally{clearTimeout(timer);controller.abort();void response?.body?.cancel().catch(()=>{});}
  }
  return {
    async prepare(input,limits){return call('prepare_public_order',{p_shop_secret:input.shopToken,p_tracking_hash:await publicOrderHash(input.trackingToken),
      p_intent_json:publicOrderIntentJson(input.intent),p_operation:input.action,p_global_limit:limits.global,p_shop_limit:limits.shop});},
    async finish(input,preparation,records){return call('finish_public_order',{p_attempt_id:input.intent.id,p_ticket:preparation.ticketToken,p_records:records});},
  };
}
