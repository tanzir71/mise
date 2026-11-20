import {expect,it} from 'vitest';
import {savedCurrencyHeader} from '../packages/core/order-currency';
// @ts-expect-error Deployment packaging is a standalone Node module.
import {edgeBundle} from '../scripts/edge-bundle.mjs';
const id=(n:number)=>String(n).padStart(26,'0');
it('the exact deployment module executes shared counter validation with stable IDs and no server credential response',async()=>{
 const bundle=await edgeBundle('commands');for(const source of ['packages/core/money-commands.ts','packages/core/sales.ts','packages/core/credit-sales.ts'])expect(bundle.sourceHashes).toHaveProperty(source);
 let handler:((request:Request)=>Promise<Response>)|undefined;const runtime=globalThis as unknown as {Deno?:unknown},previousDeno=runtime.Deno,previousFetch=globalThis.fetch;
 try{
  runtime.Deno={env:{get:(name:string)=>({SUPABASE_URL:'https://api.test',MISE_PUBLISHABLE_API_KEY:'sb_publishable_test_only',MISE_SERVICE_API_KEY:'sb_secret_test_only',MISE_ALLOWED_ORIGINS:'https://shop.test'} as Record<string,string>)[name]},serve:(callback:typeof handler)=>{handler=callback;}};
  const calls:string[]=[];globalThis.fetch=async(url,options)=>{const name=new URL(String(url)).pathname.split('/').at(-1)!;calls.push(name);const args=JSON.parse(options?.body as string),headers=new Headers(options?.headers);
   if(name==='prepare_money_write'){
    expect(headers.get('Authorization')).toBe('Bearer user.valid.signature');expect(args.p_plan).toEqual({saleId:id(5),accountId:null,entryId:null,reversalId:null,creditEventId:null,itemIds:[]});
    return new Response(JSON.stringify({done:false,ticketId:args.p_ticket_id,token:'z'.repeat(43),businessId:id(1),outletId:id(2),actorId:id(3),at:123456,contextJson:JSON.stringify({business:{id:id(1),business_type:'corner_shop',market_code:'BD',name:'Shop',languages:['en'],created_at:1,updated_at:1},outlet:{id:id(2),business_id:id(1),name:'Outlet',address:'',currency:'BDT',timezone:'Asia/Dhaka',created_at:1,updated_at:1},customer:null,account:null,sale:null,entry:null,entries:[],items:[]})}));
   }
   expect(name).toBe('finish_money_write');expect(headers.has('Authorization')).toBe(false);expect(headers.get('apikey')).toBe('sb_secret_test_only');expect(args.p_occurred_at).toBe(1000);
   const records=args.p_records as {table:string;values:Record<string,unknown>}[];expect(records).toHaveLength(2);expect(records.find(r=>r.table==='sales')!.values).toMatchObject({id:id(5),amount:15000,given:20000,change:5000,created_at:1000,created_by:id(3),event_id:id(4)});expect(records.find(r=>r.table==='events')!.values.at).toBe(123456);
   return new Response(JSON.stringify({id:id(4),occurredAt:1000,type:'sale.record',outletId:id(2),saleId:id(5),accountId:null,entryId:null,amount:15000,at:123456,saleUpdatedAt:123456,entrySequence:null,undoOf:null,private:'discard me'}));
  };
  await import('data:text/javascript;base64,'+Buffer.from(bundle.files[0].content).toString('base64')+'#money');
  expect(handler).toBeTypeOf('function');const response=await handler!(new Request('https://api.test/commands',{method:'POST',headers:{Origin:'https://shop.test',Authorization:'Bearer user.valid.signature','Content-Type':'application/json',[savedCurrencyHeader]:'BDT'},body:JSON.stringify({id:id(4),occurredAt:1000,type:'sale.record',saleId:id(5),outletId:id(2),input:{expression:'75*2',method:'cash',wallet:null,given:20000,who:'',items:[]}})}));
  expect(response.status).toBe(200);expect(await response.json()).not.toHaveProperty('private');expect(calls).toEqual(['prepare_money_write','finish_money_write']);
 }finally{runtime.Deno=previousDeno;globalThis.fetch=previousFetch;}
},30000);
