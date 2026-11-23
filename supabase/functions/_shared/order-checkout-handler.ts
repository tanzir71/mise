import {parseCheckoutRequest,parseCheckoutPayment,parseQuotedOrder,parseConfirmationOutcome,confirmationIntentJson,type CheckoutRequest} from '../../../packages/core/order-confirmation-protocol.ts';
import {orderConfirmationRecords} from '../../../packages/core/order-confirmation-projection.ts';
import type {OrderConfirmation} from '../../../packages/core/order-confirmation.ts';
import type {CloudRecord} from '../../../packages/core/cloud-records.ts';
import {authHttp,AuthBodyError,readAuthBody} from './auth-http.ts';
export interface CheckoutLimits {global:number;link:number}
export interface OrderCheckoutStore {
 prepare(input:CheckoutRequest,limits:CheckoutLimits):Promise<unknown>;
 finish(original:OrderConfirmation,preparation:Record<string,unknown>,records:CloudRecord[]):Promise<unknown>;
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const unavailable=()=>Error('Customer confirmation is unavailable.');
export function checkoutLimits(global?:string,link?:string):CheckoutLimits {
 const parse=(v:string|undefined,fallback:number)=>{if(v===undefined||v==='')return fallback;if(!/^[1-9]\d{0,4}$/.test(v)||Number(v)>60000)throw unavailable();return Number(v);};
 return {global:parse(global,300),link:parse(link,30)};
}
async function publicOutcome(raw:Record<string,unknown>,intent:OrderConfirmation){
 if(!exact(raw,'v,id,intentJson,state,closedAt,receipt,quoteJson'))throw unavailable();
 const quote=raw.quoteJson===null?undefined:(await parseQuotedOrder({v:1,state:'quote',quoteJson:raw.quoteJson,quoteHash:intent.quoteHash})).quote;
 // Never spread a database preparation or internal context into a response.
 return parseConfirmationOutcome({v:raw.v,id:raw.id,intentJson:raw.intentJson,state:raw.state,closedAt:raw.closedAt,receipt:raw.receipt},intent,quote);
}
export function createOrderCheckoutHandler(deps:{store:OrderCheckoutStore;origins:ReadonlySet<string>;limits?:CheckoutLimits}) {
 const origins=new Set(deps.origins),limits={...deps.limits??checkoutLimits()};
 if(!origins.size||[...origins].some(origin=>new URL(origin).origin!==origin)||![limits.global,limits.link].every(v=>Number.isInteger(v)&&v>=1&&v<=60000))throw unavailable();
 const secure=(response:Response)=>{response.headers.set('Referrer-Policy','no-referrer');response.headers.set('X-Content-Type-Options','nosniff');response.headers.set('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");response.headers.set('Access-Control-Expose-Headers','Retry-After');return response;};
 return async(request:Request):Promise<Response>=>{
  const http=authHttp(request,origins),reply=(status:number,value:unknown,headers?:Record<string,string>)=>secure(http.reply(status,value,headers));
  if(http.blocked)return secure(http.blocked);
  const url=new URL(request.url),quote=url.pathname.endsWith('/public/order-quote'),payment=url.pathname.endsWith('/public/order-payment');
  if(url.search||!quote&&!payment&&!url.pathname.endsWith('/public/order-confirmations'))return reply(400,{error:'Use the scoped customer confirmation endpoint.'});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return reply(415,{error:'Use JSON.'});
  let input:CheckoutRequest;
  try{input=parseCheckoutRequest(await readAuthBody(request,quote?1024:65536),quote);if(payment!==(input.action==='payment'))throw unavailable();}
  catch(error){return reply(error instanceof AuthBodyError?error.status:400,{error:'Keep the complete original link and choices.'});}
  try{
   for(let retry=0;retry<3;retry++){
    let raw=await deps.store.prepare(input,limits),completed=false;
    if(!object(raw)||raw.v!==1)throw unavailable();
    if(raw.state==='payment'){
     if(!payment||!input.intent)throw unavailable();return reply(200,parseCheckoutPayment(raw,input.intent));
    }
    if(raw.state==='quote'){
     if(!quote)throw unavailable();const q=await parseQuotedOrder(raw);
     return reply(200,{v:1,state:'quote',quoteJson:q.quoteJson,quoteHash:q.quoteHash});
    }
    if(raw.state==='prepared'){
     if(input.action!=='submit'||!input.intent)throw unavailable();
     let records:CloudRecord[];
     try{records=await orderConfirmationRecords(raw,input.intent);}catch{return reply(409,{error:'The shop must review the current prices or khata permission. Keep this original and contact the shop.'});}
     raw=await deps.store.finish(input.intent,raw,records);completed=true;
     if(!object(raw)||raw.v!==1)throw unavailable();if(raw.state==='conflict')continue;
    }
    if(['pending','closed','applied'].includes(raw.state as string)){
     if(quote||!input.intent)throw unavailable();return reply(raw.state==='pending'?202:completed&&raw.state==='applied'?201:200,await publicOutcome(raw,input.intent));
    }
    if(raw.state==='limited'){
     if(!Number.isInteger(raw.retryAfter)||Number(raw.retryAfter)<1||Number(raw.retryAfter)>60)throw unavailable();
     return reply(429,{error:'This link is busy. Keep your choices and try again shortly.'},{'Retry-After':String(raw.retryAfter)});
    }
    if(raw.state==='missing')return reply(404,{error:'This order link is unavailable. Contact the shop.'});
    if(raw.state==='changed')return reply(409,{error:'The quote or original choices changed. Check or close this original before reviewing new prices.'});
    if(raw.state==='unavailable')return reply(409,{error:'Online confirmation is unavailable for this order. Contact the shop to confirm it by hand.'});
    throw unavailable();
   }
   return reply(409,{error:'The order changed during confirmation. Keep this original and check it before trying again.'});
  }catch{return reply(503,{error:'The confirmation is unconfirmed. Keep it and check before sending another.'});}
 };
}
/** Fixed RPCs, service-only key, whole-response deadline and byte bound. The
 * customer never chooses SQL, a tenant, a member, a ledger or service limits. */
export function createOrderCheckoutStore(url:string,key:string,send:typeof fetch=fetch):OrderCheckoutStore {
 const root=new URL(url);
 if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname))||!/^sb_secret_[A-Za-z0-9_-]+$/.test(key))throw unavailable();
 async function call(name:'prepare_order_confirmation'|'finish_order_confirmation',body:Record<string,unknown>):Promise<unknown>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,response:Response|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},15000);});
  try{
   response=await Promise.race([send(new URL('rest/v1/rpc/'+name,root),{method:'POST',credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{apikey:key,'Content-Type':'application/json'},body:JSON.stringify(body)}),deadline]);
   if(!response.ok)throw unavailable();const reader=response.body?.getReader();if(!reader)throw unavailable();const chunks:Uint8Array[]=[];let length=0;
   try{for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;length+=part.value.byteLength;if(length>8388608)throw unavailable();chunks.push(part.value);}}
   catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   const data=new Uint8Array(length);let offset=0;for(const part of chunks){data.set(part,offset);offset+=part.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
  }finally{clearTimeout(timer);controller.abort();void response?.body?.cancel().catch(()=>{});}
 }
 return {prepare:async(input,limits)=>call('prepare_order_confirmation',{p_token:input.token,p_intent_json:input.intent===null?null:confirmationIntentJson(input.intent),p_operation:input.action,p_global_limit:limits.global,p_link_limit:limits.link}),
  finish:async(original,p,records)=>call('finish_order_confirmation',{p_id:original.id,p_ticket:p.ticketToken,p_records:records})};
}
