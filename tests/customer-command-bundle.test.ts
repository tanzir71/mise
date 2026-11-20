import {expect,it} from 'vitest';
// @ts-expect-error Deployment packaging is a standalone Node module.
import {edgeBundle} from '../scripts/edge-bundle.mjs';
const id=(n:number)=>String(n).padStart(26,'0');
it('the exact deployment module boots and executes the shared customer/khata mutation',async()=>{
  const bundle=await edgeBundle('commands');expect(bundle.sourceHashes).toHaveProperty('packages/core/customer-mutation.ts');expect(bundle.sourceHashes).toHaveProperty('packages/core/khata.ts');expect(bundle.sourceHashes).toHaveProperty('packages/core/customer-currency.ts');expect(bundle.bytes).toBeLessThan(20*1024*1024);
  let handler:((request:Request)=>Promise<Response>)|undefined;const runtime=globalThis as unknown as {Deno?:unknown},previousDeno=runtime.Deno,previousFetch=globalThis.fetch;
  try{
    runtime.Deno={env:{get:(name:string)=>({SUPABASE_URL:'https://api.test',MISE_PUBLISHABLE_API_KEY:'sb_publishable_test_only',MISE_SERVICE_API_KEY:'sb_secret_test_only',MISE_ALLOWED_ORIGINS:'https://shop.test'} as Record<string,string>)[name]},serve:(callback:typeof handler)=>{handler=callback;}};
    const calls:string[]=[];
    globalThis.fetch=async(url,options)=>{const name=new URL(String(url)).pathname.split('/').at(-1)!;calls.push(name);const args=JSON.parse(options?.body as string),headers=new Headers(options?.headers);
      if(name==='prepare_customer_intent'){
        expect(headers.get('Authorization')).toBe('Bearer user.valid.signature');
        return new Response(JSON.stringify({done:false,ticketId:args.p_ticket_id,token:'z'.repeat(43),businessId:id(1),outletId:id(2),actorId:id(3),at:123456,
          contextJson:JSON.stringify({business:{id:id(1),business_type:'corner_shop',market_code:'BD',name:'Shop',languages:['en'],created_at:1,updated_at:1},outlet:{id:id(2),business_id:id(1),name:'Outlet',address:'',currency:'BDT',timezone:'Asia/Dhaka',created_at:1,updated_at:1},customer:null,accounts:[],hasBalance:false})}));
      }
      expect(name).toBe('finish_customer_write');expect(headers.has('Authorization')).toBe(false);expect(headers.get('apikey')).toBe('sb_secret_test_only');
      const records=args.p_records as {table:string;values:Record<string,unknown>}[];expect(records).toHaveLength(4);expect(records.filter(r=>r.table==='events')).toHaveLength(2);
      const customer=records.find(r=>r.table==='customers')!.values,account=records.find(r=>r.table==='credit_accounts')!.values;
      expect(JSON.parse(customer.name as string)).toBe('করিম\0');expect(account.allowed).toBe(false);expect(account.credit_limit).toBe(0);
      return new Response(JSON.stringify({id:id(4),type:'customer.create',customerId:id(5),outletId:id(2),accountId:account.id,accountEventId:id(7),entryId:null,openingEventId:null,at:123456,customerUpdatedAt:123456,accountUpdatedAt:123456}));
    };
    await import('data:text/javascript;base64,'+Buffer.from(bundle.files[0].content).toString('base64'));
    expect(handler).toBeTypeOf('function');
    const response=await handler!(new Request('https://api.test/commands',{method:'POST',headers:{Origin:'https://shop.test',Authorization:'Bearer user.valid.signature','Content-Type':'application/json','X-Mise-Saved-Currency':'BDT'},body:JSON.stringify({id:id(4),type:'customer.create',customerId:id(5),outletId:id(2),input:{name:'করিম\0',nickname:'',phone:'01712345482',address:'',notes:'',tags:[]},credit:null,opening:null,ids:{accountId:id(6),accountEventId:id(7),openingEntryId:id(8),openingEventId:id(9)}})}));
    expect(response.status).toBe(200);expect((await response.json()).customerId).toBe(id(5));expect(calls).toEqual(['prepare_customer_intent','finish_customer_write']);
  }finally{runtime.Deno=previousDeno;globalThis.fetch=previousFetch;}
},30000);
