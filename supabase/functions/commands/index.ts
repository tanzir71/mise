import {createCommandsHandler,createCommandStore} from '../_shared/commands-handler.ts';
import {createOrderReviewHandler,createOrderReviewStore} from '../_shared/order-review.ts';
import {createMoneyReviewHandler,createMoneyReviewStore} from '../_shared/money-review.ts';
import {createPurchaseReviewHandler,createPurchaseReviewStore} from '../_shared/purchase-review.ts';
import {createStockReviewHandler,createStockReviewStore} from '../_shared/stock-review.ts';
import {createCustomerReviewHandler,createCustomerReviewStore} from '../_shared/customer-review.ts';
import {createClosingReviewHandler,createClosingReviewStore} from '../_shared/closing-review.ts';
declare const Deno:{env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):void};
let handler:(request:Request)=>Promise<Response>;
try{
  const origins=new Set((Deno.env.get('MISE_ALLOWED_ORIGINS')||'').split(',').filter(Boolean));
  if(!origins.size||[...origins].some(origin=>new URL(origin).origin!==origin))throw new Error('Origins required');
  const apiUrl=Deno.env.get('SUPABASE_URL')||'',key=Deno.env.get('MISE_PUBLISHABLE_API_KEY')||'',serviceKey=Deno.env.get('MISE_SERVICE_API_KEY'),commands=createCommandsHandler({store:createCommandStore(apiUrl,key,fetch,{serviceKey}),origins});
  handler=async request=>{
    if(!new URL(request.url).searchParams.has('review'))return commands(request);
    try{
      if(new URL(request.url).searchParams.get('review')?.startsWith('money-'))return await createMoneyReviewHandler({store:createMoneyReviewStore(apiUrl,key,serviceKey||''),origins})(request);
      if(new URL(request.url).searchParams.get('review')?.startsWith('purchase-'))return await createPurchaseReviewHandler({store:createPurchaseReviewStore(apiUrl,key,serviceKey||''),origins})(request);
      if(new URL(request.url).searchParams.get('review')?.startsWith('stock-'))return await createStockReviewHandler({store:createStockReviewStore(apiUrl,key,serviceKey||''),origins})(request);
      if(new URL(request.url).searchParams.get('review')?.startsWith('customer-'))return await createCustomerReviewHandler({store:createCustomerReviewStore(apiUrl,key,serviceKey||''),origins})(request);
      if(new URL(request.url).searchParams.get('review')?.startsWith('closing-'))return await createClosingReviewHandler({store:createClosingReviewStore(apiUrl,key,serviceKey||''),origins})(request);
      return await createOrderReviewHandler({store:createOrderReviewStore(apiUrl,key,serviceKey||''),origins})(request);
    }
    catch{return new Response(JSON.stringify({error:'Saved action reviews are unavailable. Keep the original saved action.'}),{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}
  };
}catch{handler=async()=>new Response(JSON.stringify({error:'Changes are unavailable. Try again later.'}),{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}
Deno.serve(handler);
