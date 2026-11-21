import {expect,it} from 'vitest';
// @ts-expect-error Deployment packaging is a standalone Node module.
import {edgeBundle} from '../scripts/edge-bundle.mjs';
import {stockBatchHeader} from '../packages/core/stock-commands';
import {commandReviewHeader} from '../packages/core/command-resolution';
import {adjusted} from './stock-review-fixture';
const id=(n:number)=>String(n).padStart(26,'0');
it('the exact deployment module admits the owner before reading a stock batch and runs shared physical-count rules',async()=>{
 const bundle=await edgeBundle('commands');for(const source of ['packages/core/stock.ts','packages/core/stock-commands.ts','supabase/functions/_shared/stock-write.ts'])expect(bundle.sourceHashes).toHaveProperty(source);
 const runtime=globalThis as unknown as {Deno?:unknown},previousDeno=runtime.Deno,previousFetch=globalThis.fetch;let handler:((request:Request)=>Promise<Response>)|undefined;
 try{
  runtime.Deno={env:{get:(name:string)=>({SUPABASE_URL:'https://api.test',MISE_PUBLISHABLE_API_KEY:'sb_publishable_test_only',MISE_SERVICE_API_KEY:'sb_secret_test_only',MISE_ALLOWED_ORIGINS:'https://shop.test'} as Record<string,string>)[name]},serve:(callback:typeof handler)=>{handler=callback;}};
  const calls:string[]=[];globalThis.fetch=async(url,options)=>{const name=new URL(String(url)).pathname.split('/').at(-1)!;calls.push(name);const args=JSON.parse(options?.body as string),headers=new Headers(options?.headers);
   if(name!=='finish_stock_write'){expect(headers.get('apikey')).toBe('sb_publishable_test_only');expect(headers.get('Authorization')).toBe('Bearer user.valid.signature');}
   if(name==='admit_stock_batch'){expect(args).toEqual({p_outlet_id:id(2)});return new Response('true');}
   if(name==='prepare_stock_write')return new Response(JSON.stringify({done:false,ticketId:args.p_ticket_id,token:'z'.repeat(43),businessId:id(1),outletId:id(2),actorId:id(3),at:10000,contextJson:JSON.stringify({business:{id:id(1),business_type:'corner_shop',market_code:'BD',name:'Shop',languages:['en'],created_at:1,updated_at:1},outlet:{id:id(2),business_id:id(1),name:'Outlet',address:'',currency:'BDT',timezone:'Asia/Dhaka',created_at:1,updated_at:1},items:[{id:id(5),outlet_id:id(2),created_at:1,updated_at:1,revision:1,name:'Rice',name_local:'',active_key:'"rice"',unit:'kg',category:'',aliases:[],on_hand:20,target:30,pack_size:1,low_at:null,supplier_id:null,archived_at:null,last_counted_at:1,event_id:id(6)}],moves:[],suppliers:[]})}));
   expect(name).toBe('finish_stock_write');expect(headers.has('Authorization')).toBe(false);expect(headers.get('apikey')).toBe('sb_secret_test_only');
   const records=args.p_records as {table:string;values:Record<string,unknown>}[];expect(records).toHaveLength(3);expect(records.find(r=>r.table==='stock_items')!.values).toMatchObject({id:id(5),on_hand:0,revision:2,updated_at:10000,event_id:id(4)});expect(records.find(r=>r.table==='stock_moves')!.values).toMatchObject({id:id(7),before_quantity:20,after_quantity:0,delta:-20,created_at:1000,created_by:id(3),count_batch_id:id(8),note:JSON.stringify('চাল\0')});
   return new Response(JSON.stringify({id:id(4),outletId:id(2),type:'stock.batch',occurredAt:1000,at:10000,batchId:id(8),undoOf:null,results:[{stockItemId:id(5),eventId:id(4),moveId:id(7),revision:2,onHand:0,updatedAt:10000}],private:'discard'}));
  };
  await import('data:text/javascript;base64,'+Buffer.from(bundle.files[0].content).toString('base64')+'#stock');expect(handler).toBeTypeOf('function');
  const response=await handler!(new Request('https://api.test/commands',{method:'POST',headers:{Origin:'https://shop.test',Authorization:'Bearer user.valid.signature','Content-Type':'application/json',[stockBatchHeader]:id(2)},body:JSON.stringify({id:id(4),outletId:id(2),occurredAt:1000,type:'stock.batch',count:true,batchId:id(8),changes:[{id:id(5),revision:1,eventId:id(4),moveId:id(7),reason:'count',source:'count',quantity:0,note:'চাল\0'}]})}));
  expect(response.status).toBe(200);expect(await response.json()).not.toHaveProperty('private');expect(calls).toEqual(['admit_stock_batch','prepare_stock_write','finish_stock_write']);
 }finally{runtime.Deno=previousDeno;globalThis.fetch=previousFetch;}
},30000);

it.each(['stock-read','stock-resolve'])('the exact deployment routes %s through stock admission and recovers its genuine ordinary receipt',async mode=>{
 const bundle=await edgeBundle('commands');expect(bundle.sourceHashes).toHaveProperty('supabase/functions/_shared/stock-review.ts');
 const {p,change}=adjusted(),command=p.command;if(command.type!=='stock.adjust')throw Error('Expected stock adjustment');
 const item=change.items[0],at=command.occurredAt+10000,receipt={id:command.id,type:command.type,outletId:command.outletId,occurredAt:command.occurredAt,at,batchId:null,undoOf:null,results:[{stockItemId:item.id,eventId:command.id,moveId:command.moveId,revision:item.revision,onHand:item.onHand,updatedAt:at}]};
 const runtime=globalThis as unknown as {Deno?:unknown},previousDeno=runtime.Deno,previousFetch=globalThis.fetch;let handler:((request:Request)=>Promise<Response>)|undefined;
 try{
  runtime.Deno={env:{get:(name:string)=>({SUPABASE_URL:'https://api.test',MISE_PUBLISHABLE_API_KEY:'sb_publishable_test_only',MISE_SERVICE_API_KEY:'sb_secret_test_only',MISE_ALLOWED_ORIGINS:'https://shop.test'} as Record<string,string>)[name]},serve:(callback:typeof handler)=>{handler=callback;}};
  const calls:string[]=[];globalThis.fetch=async(url,options)=>{
   const name=new URL(String(url)).pathname.split('/').at(-1)!,args=JSON.parse(options?.body as string),headers=new Headers(options?.headers);calls.push(name);
   expect(headers.get('apikey')).toBe('sb_publishable_test_only');expect(headers.get('Authorization')).toBe('Bearer user.valid.signature');
   if(name==='admit_stock_review'){expect(args).toEqual({p_outlet_id:command.outletId});return Response.json(true);}
   expect(name).toBe('inspect_stock_outcome');expect(args).toMatchObject({p_command_id:command.id,p_type:command.type,p_outlet_id:command.outletId});return Response.json({...receipt,private:'discard'});
  };
  await import('data:text/javascript;base64,'+Buffer.from(bundle.files[0].content).toString('base64')+'#'+mode);expect(handler).toBeTypeOf('function');
  const body=mode==='stock-resolve'?{...p,token:'z'.repeat(43),outcome:'withdrawn'}:p;
  const response=await handler!(new Request('https://api.test/commands?review='+mode,{method:'POST',headers:{Origin:'https://shop.test',Authorization:'Bearer user.valid.signature','Content-Type':'application/json',[commandReviewHeader]:command.outletId},body:JSON.stringify(body)}));
  expect(response.status).toBe(200);expect(await response.json()).toEqual(mode==='stock-read'?{done:true,receipt}:receipt);expect(calls).toEqual(['admit_stock_review','inspect_stock_outcome']);
 }finally{runtime.Deno=previousDeno;globalThis.fetch=previousFetch;}
},30000);
