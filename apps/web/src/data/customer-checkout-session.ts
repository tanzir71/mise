import {customerApiOrigin} from '@mise/core/customer-link-url';
import {newInboxId} from '@mise/core/inbox';
import {publicOrderHash} from '@mise/core/public-order-submission';
import {decidedQuote,parseOrderConfirmation,parseOrderQuote,type OrderConfirmation,type SwapDecision} from '@mise/core/order-confirmation';
import {parseQuotedOrder,parseCheckoutPayment,parseConfirmationOutcome,confirmationIntentJson,type ConfirmationOutcome,type QuotedOrder} from '@mise/core/order-confirmation-protocol';
export interface SavedCustomerConfirmation {quoteJson:string;quoteHash:string;intent:OrderConfirmation;closeRequested:boolean;outcome:ConfirmationOutcome|null}
interface Journal {v:1;scope:string;actions:SavedCustomerConfirmation[]}
interface Storage {getItem(key:string):string|null;setItem(key:string,value:string):void}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const failed=()=>Error('Keep this browser’s original choices. Contact the shop before sending another confirmation.');
const parse=(raw:string):unknown=>{try{return JSON.parse(raw);}catch{throw failed();}};
export async function createCustomerCheckoutSession(input:{apiUrl:string;token:string;orderId:string},deps:{storage:Storage;locks?:Pick<LockManager,'request'>;send?:typeof fetch}){
 const apiUrl=customerApiOrigin(input.apiUrl),token=input.token,orderId=input.orderId;
 if(!/^[A-Za-z0-9_-]{43}$/.test(token)||!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(orderId)||!globalThis.crypto?.subtle)throw failed();
 const scope=await publicOrderHash(apiUrl+'\n'+token+'\n'+orderId),key='mise.customer-confirmations.v1:'+scope,send=deps.send??fetch,controllers=new Set<AbortController>();let active=true;
 const assert=()=>{if(!active)throw failed();};
 function read():Journal {
  assert();const raw=deps.storage.getItem(key);if(raw===null)return {v:1,scope,actions:[]};if(new TextEncoder().encode(raw).byteLength>8388608)throw failed();
  const value=parse(raw);
  if(!object(value)||!exact(value,'v,scope,actions')||value.v!==1||value.scope!==scope||!Array.isArray(value.actions)||value.actions.length>200)throw failed();
  const ids=new Set<string>(),actions=value.actions.map((v:unknown)=>{
   if(!object(v)||!exact(v,'quoteJson,quoteHash,intent,closeRequested,outcome')||typeof v.quoteJson!=='string'||typeof v.quoteHash!=='string'||!/^[0-9a-f]{64}$/.test(v.quoteHash)||typeof v.closeRequested!=='boolean')throw failed();
   const intent=parseOrderConfirmation(v.intent),quote=parseOrderQuote(parse(v.quoteJson));
   if(quote.orderId!==orderId||v.quoteHash!==intent.quoteHash||ids.has(intent.id)||JSON.stringify(intent)!==JSON.stringify(v.intent))throw failed();ids.add(intent.id);
   return {quoteJson:v.quoteJson,quoteHash:v.quoteHash,intent,closeRequested:v.closeRequested,outcome:v.outcome===null?null:parseConfirmationOutcome(v.outcome,intent,quote)};
  });
  if(actions.slice(0,-1).some(a=>a.outcome===null||a.outcome.state==='pending'))throw failed();
  return {v:1,scope,actions};
 }
 function write(value:Journal){assert();const raw=JSON.stringify(value);if(new TextEncoder().encode(raw).byteLength>8388608||value.actions.length>200)throw failed();deps.storage.setItem(key,raw);if(deps.storage.getItem(key)!==raw)throw failed();read();}
 async function lock<T>(run:()=>Promise<T>):Promise<T>{assert();if(!deps.locks)throw Error('This browser cannot safely keep a shared confirmation. Copy your choices and confirm with the shop.');return deps.locks.request(key,async()=>{assert();return run();});}
 async function verify(saved:SavedCustomerConfirmation){await parseQuotedOrder({v:1,state:'quote',quoteJson:saved.quoteJson,quoteHash:saved.quoteHash});assert();return saved;}
 async function saved(){const value=read();for(const row of value.actions)await verify(row);return value;}
 async function http(path:'order-quote'|'order-confirmations'|'order-payment',body:Record<string,unknown>):Promise<unknown>{
  assert();const controller=new AbortController();controllers.add(controller);let timer:ReturnType<typeof setTimeout>|undefined,response:Response|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(failed());},35000);});
  try{
   response=await Promise.race([send(new URL('/functions/v1/public/'+path,apiUrl),{method:'POST',credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),deadline]);
   if(!response.ok)throw Error(response.status===404?'This order link is unavailable. Keep the original and contact the shop.':response.status===409?'The shop must review the quote or saved choices. Check or close the original before reviewing new prices.':'The confirmation is unconfirmed. Keep it and check before sending another.');
   const reader=response.body?.getReader();if(!reader)throw failed();const chunks:Uint8Array[]=[];let length=0;
   try{for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;length+=part.value.byteLength;if(length>8388608)throw failed();chunks.push(part.value);}}
   catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   const data=new Uint8Array(length);let offset=0;for(const part of chunks){data.set(part,offset);offset+=part.length;}assert();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
  }finally{clearTimeout(timer);controller.abort();controllers.delete(controller);void response?.body?.cancel().catch(()=>{});}
 }
 async function quote():Promise<QuotedOrder>{const q=await parseQuotedOrder(await http('order-quote',{v:1,token}));assert();if(q.quote.orderId!==orderId)throw failed();return q;}
 async function prepare(q:QuotedOrder,swaps:SwapDecision[],payment:OrderConfirmation['payment']){
  const approved=await parseQuotedOrder({v:1,state:'quote',quoteJson:q.quoteJson,quoteHash:q.quoteHash});assert();if(approved.quote.orderId!==orderId)throw failed();const priced=decidedQuote(approved.quote,swaps,0);
  if(payment.method==='wallet'&&!approved.quote.wallets.some(w=>w.id===payment.walletId)||payment.method==='credit'&&(!approved.quote.credit||priced.total===null||priced.total>approved.quote.credit.maximum||BigInt(approved.quote.credit.balance)+BigInt(priced.total)>BigInt(approved.quote.credit.limit)))throw Error('The shop must review this payment choice or current khata limit.');
  return lock(async()=>{
   const state=read(),last=state.actions.at(-1);if(last&&(last.outcome===null||last.outcome.state==='pending'||last.outcome.state==='applied'&&(approved.quote.revision<=last.outcome.receipt!.revision||approved.quoteHash===last.quoteHash)))throw Error('Check or close the saved original before confirming different choices.');
   const intent=parseOrderConfirmation({v:1,id:newInboxId(),quoteHash:q.quoteHash,swaps,payment,ids:{updateEventId:newInboxId(),pricedEventId:newInboxId(),acceptedEventId:newInboxId(),paymentEventId:newInboxId(),saleId:newInboxId(),saleEventId:newInboxId(),entryId:newInboxId(),creditEventId:newInboxId()}});
   const original={quoteJson:approved.quoteJson,quoteHash:approved.quoteHash,intent,closeRequested:false,outcome:null};state.actions.push(original);write(state);return structuredClone(original);
  });
 }
 async function call(id:string,operation:'submit'|'inspect'|'close'){
  const original=await lock(async()=>{
   const state=read(),row=state.actions.find(a=>a.intent.id===id);if(!row)throw failed();await verify(row);
   if(operation==='close'&&!row.closeRequested){row.closeRequested=true;write(state);}return structuredClone(row);
  });
  const action=original.closeRequested&&operation==='submit'?'close':operation;
  const raw=await http('order-confirmations',{v:1,token,action,intent:original.intent}),outcome=parseConfirmationOutcome(raw,original.intent,parseOrderQuote(JSON.parse(original.quoteJson)));assert();
  await lock(async()=>{
   const state=read(),row=state.actions.find(a=>a.intent.id===id);if(!row||row.quoteJson!==original.quoteJson||row.quoteHash!==original.quoteHash||confirmationIntentJson(row.intent)!==confirmationIntentJson(original.intent))throw failed();
   if(row.outcome&&row.outcome.state!=='pending'&&JSON.stringify(row.outcome)!==JSON.stringify(outcome))throw failed();row.outcome=outcome;write(state);
  });
  return outcome;
 }
 read();
 async function payment(id:string){const original=(await saved()).actions.find(a=>a.intent.id===id);if(!original||original.outcome?.state!=='applied')throw failed();const raw=await http('order-payment',{v:1,token,action:'payment',intent:original.intent}),value=parseCheckoutPayment(raw,original.intent,parseOrderQuote(JSON.parse(original.quoteJson)));assert();return value;}
 return {key,saved,quote,prepare,call,payment,stop(){active=false;for(const controller of controllers)controller.abort();controllers.clear();}};
}
export type CustomerCheckoutSession=Awaited<ReturnType<typeof createCustomerCheckoutSession>>;
