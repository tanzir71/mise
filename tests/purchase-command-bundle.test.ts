import {expect,it} from 'vitest';
// @ts-expect-error Deployment packaging is a standalone Node module.
import {edgeBundle} from '../scripts/edge-bundle.mjs';
import {purchaseBodyHeader} from '../packages/core/purchase-commands';
import {savedCurrencyHeader} from '../packages/core/order-currency';
const id=(n:number)=>String(n).padStart(26,'0');
it('the deployment module admits the original invoice owner and runs shared exact-price validation without exposing service credentials',async()=>{
 const bundle=await edgeBundle('commands');for(const source of ['packages/core/purchases.ts','packages/core/purchase-commands.ts','packages/core/purchase-currency.ts','supabase/functions/_shared/purchase-write.ts'])expect(bundle.sourceHashes).toHaveProperty(source);
 const runtime=globalThis as unknown as {Deno?:unknown},previousDeno=runtime.Deno,previousFetch=globalThis.fetch;let handler:((request:Request)=>Promise<Response>)|undefined;
 try{
  runtime.Deno={env:{get:(name:string)=>({SUPABASE_URL:'https://api.test',MISE_PUBLISHABLE_API_KEY:'sb_publishable_test_only',MISE_SERVICE_API_KEY:'sb_secret_test_only',MISE_ALLOWED_ORIGINS:'https://shop.test'} as Record<string,string>)[name]},serve:(callback:typeof handler)=>{handler=callback;}};
  const calls:string[]=[];globalThis.fetch=async(url,options)=>{const name=new URL(String(url)).pathname.split('/').at(-1)!;calls.push(name);const args=JSON.parse(options?.body as string),headers=new Headers(options?.headers);
   if(name!=='finish_purchase_write'){expect(headers.get('apikey')).toBe('sb_publishable_test_only');expect(headers.get('Authorization')).toBe('Bearer user.valid.signature');}
   if(name==='admit_purchase_record'){expect(args).toEqual({p_outlet_id:id(2)});return new Response('true');}
   if(name==='prepare_purchase_write'){expect(args.p_plan.lineFacts).toEqual([{stockItemId:null,unitKey:'"kg"',qty:2.5,unitPrice:12001}]);expect(JSON.parse(args.p_plan.linesJson)[0]).toMatchObject({name:'চাল\0',lineTotal:30003});return new Response(JSON.stringify({done:false,ticketId:args.p_ticket_id,token:'z'.repeat(43),businessId:id(1),outletId:id(2),actorId:id(3),at:10000,contextJson:JSON.stringify({business:{id:id(1),business_type:'corner_shop',market_code:'BD',name:'Shop',languages:['en'],created_at:1,updated_at:1},outlet:{id:id(2),business_id:id(1),name:'Outlet',address:'',currency:'BDT',timezone:'Asia/Dhaka',created_at:1,updated_at:1},supplier:null,purchase:null,stock:[]})}));}
   expect(name).toBe('finish_purchase_write');expect(headers.has('Authorization')).toBe(false);expect(headers.get('apikey')).toBe('sb_secret_test_only');
   const records=args.p_records as {table:string;values:Record<string,unknown>}[];expect(records).toHaveLength(2);expect(records.find(r=>r.table==='purchases')!.values).toMatchObject({id:id(5),total:30003,created_at:1000,updated_at:10000,event_id:id(4),paid:'due',created_by:id(3)});expect(records.find(r=>r.table==='events')!.values.at).toBe(10000);
   return new Response(JSON.stringify({id:id(4),outletId:id(2),type:'purchase.record',occurredAt:1000,at:10000,supplierId:null,purchaseId:id(5),revision:null,total:30003,updatedAt:10000,voidedAt:null,undoOf:null,private:'discard'}));
  };
  await import('data:text/javascript;base64,'+Buffer.from(bundle.files[0].content).toString('base64')+'#purchase');expect(handler).toBeTypeOf('function');
  const response=await handler!(new Request('https://api.test/commands',{method:'POST',headers:{Origin:'https://shop.test',Authorization:'Bearer user.valid.signature','Content-Type':'application/json',[purchaseBodyHeader]:id(2),[savedCurrencyHeader]:'BDT'},body:JSON.stringify({id:id(4),outletId:id(2),occurredAt:1000,type:'purchase.record',purchaseId:id(5),input:{supplierId:null,supplierName:'Supplier',reference:'',paid:'due',wallet:null,note:'Manual only',lines:[{stockItemId:null,name:'চাল\0',unit:'kg',qty:2.5,unitPrice:12001}]}})}));
  expect(response.status).toBe(200);expect(await response.json()).not.toHaveProperty('private');expect(calls).toEqual(['admit_purchase_record','prepare_purchase_write','finish_purchase_write']);
 }finally{runtime.Deno=previousDeno;globalThis.fetch=previousFetch;}
},30000);
