import {customerApiOrigin} from '@mise/core/customer-link-url';
import {parsePublicOrderSubmission,parsePublicOrderOutcome,type PublicOrderSubmission,type PublicOrderOutcome} from '@mise/core/public-order-submission';
export class PublicOrderError extends Error{
 constructor(readonly kind:'review'|'limited'|'missing'|'unconfirmed',readonly retryAfter=0){super(kind==='review'?'Keep the original request and review it with the shop.':kind==='limited'?'Keep your request and try again shortly.':kind==='missing'?'The original request could not be checked. Contact the shop before sending another.':'The request is unconfirmed. Check it again before sending another order.');}
}
/** Customer capabilities only. Never load owner Auth, keys, cookies or database code. */
export function createPublicOrderRemote(api:string,send:typeof fetch=fetch){
 const endpoint=new URL('/functions/v1/public/orders',customerApiOrigin(api));
 return async(value:PublicOrderSubmission,signal?:AbortSignal):Promise<PublicOrderOutcome>=>{
  const input=parsePublicOrderSubmission(value),body=JSON.stringify(input);
  if(new TextEncoder().encode(body).length>65536)throw new PublicOrderError('review');
  const controller=new AbortController(),lifetime=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  let timer:ReturnType<typeof setTimeout>|undefined,response:Response|undefined;
  const deadline=new Promise<never>((_,reject)=>{const stop=()=>reject(new PublicOrderError('unconfirmed'));if(lifetime.aborted)stop();else lifetime.addEventListener('abort',stop,{once:true});timer=setTimeout(()=>controller.abort(),20000);});
  try{
   if(lifetime.aborted)throw new PublicOrderError('unconfirmed');
   response=await Promise.race([send(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body,cache:'no-store',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',signal:lifetime}),deadline]);
   if(![200,201,202].includes(response.status)){
    if(response.status===429){const delay=response.headers.get('Retry-After');if(!delay||!/^([1-9]|[1-5][0-9]|60)$/.test(delay))throw new PublicOrderError('unconfirmed');throw new PublicOrderError('limited',Number(delay));}
    throw new PublicOrderError(response.status===404?'missing':[400,409,413,415].includes(response.status)?'review':'unconfirmed');
   }
   const reader=response.body?.getReader();if(!reader)throw new PublicOrderError('unconfirmed');
   const parts:Uint8Array[]=[];let length=0;
   try{for(;;){const p=await Promise.race([reader.read(),deadline]);if(p.done)break;length+=p.value.length;if(length>65536)throw new PublicOrderError('unconfirmed');parts.push(p.value);}}
   catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   const bytes=new Uint8Array(length);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}
   const outcome=parsePublicOrderOutcome(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),input.intent);
   if(response.status===202&&outcome.state!=='pending'||response.status===201&&outcome.state!=='created'||input.action==='inspect'&&response.status===201||input.action==='close'&&outcome.state==='pending')throw new PublicOrderError('unconfirmed');
   return outcome;
  }catch(error){throw error instanceof PublicOrderError?error:new PublicOrderError('unconfirmed');}
  finally{clearTimeout(timer);controller.abort();void response?.body?.cancel().catch(()=>{});}
 };
}
