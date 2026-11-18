import {expect,it} from 'vitest';
// @ts-expect-error Deployment packaging is a standalone Node module.
import {edgeBundle} from '../scripts/edge-bundle.mjs';
import {setupCommand} from '../packages/core/setup';
import {cloudRecordMaps,encodeCommandRecord} from '../packages/core/cloud-records';
import {closingPreview} from '../packages/core/today';
import type {ClosingCommand} from '../packages/core/closing-commands';
const id=(n:number)=>String(n).padStart(26,'0');
it('the exact deployment module validates the original operator review and submits all closing records with service-only credentials',async()=>{
 const bundle=await edgeBundle('commands');for(const path of ['packages/core/closing.ts','packages/core/today.ts','packages/core/closing-commands.ts','supabase/functions/_shared/closing-write.ts'])expect(bundle.sourceHashes).toHaveProperty(path);
 const s=setupCommand({businessType:'corner_shop',marketCode:'BD',name:'সমাপনী\0',phone:'01712345482'},null,1000).snapshot,ctx={setup:s,sales:[],orders:[],refunds:[],accounts:[],entries:[],customers:[],stock:[],closings:[]},preview=closingPreview(ctx,1000);
 const raw=(table:'businesses'|'outlets',value:unknown)=>Object.fromEntries(Object.entries(encodeCommandRecord(table,value,s.business.id).values).map(([k,v])=>[k,v!==null&&(cloudRecordMaps[table].fields as Record<string,string>)[k]?.startsWith('j:')?JSON.parse(v as string):v]));
 const c:ClosingCommand={id:id(4),outletId:s.outlet.id,closingId:id(5),occurredAt:1000,type:'closing.record',saleId:id(6),saleEventId:id(7),input:{day:preview.summary.day,fingerprint:preview.fingerprint,countedCash:123,addDifference:true,note:'Literal\0'}};
 const receipt={id:c.id,type:c.type,outletId:c.outletId,closingId:c.closingId,occurredAt:1000,at:10000,day:preview.summary.day,difference:123,addedWalkIn:123,closingUpdatedAt:10000,saleId:c.saleId,saleUpdatedAt:10000,undoOf:null};
 const runtime=globalThis as unknown as {Deno?:unknown},previousDeno=runtime.Deno,previousFetch=globalThis.fetch;let handler:((r:Request)=>Promise<Response>)|undefined;const calls:string[]=[];
 try{
  runtime.Deno={env:{get:(name:string)=>({SUPABASE_URL:'https://api.test',MISE_PUBLISHABLE_API_KEY:'sb_publishable_test_only',MISE_SERVICE_API_KEY:'sb_secret_test_only',MISE_ALLOWED_ORIGINS:'https://shop.test'} as Record<string,string>)[name]},serve:(callback:typeof handler)=>{handler=callback;}};
  globalThis.fetch=async(url,options)=>{const name=new URL(String(url)).pathname.split('/').at(-1)!;calls.push(name);const a=JSON.parse(options?.body as string),h=new Headers(options?.headers);
   if(name==='prepare_closing_write'){expect(h.get('Authorization')).toBe('Bearer user.valid.signature');expect(h.get('apikey')).toBe('sb_publishable_test_only');expect(a.p_plan).toMatchObject({closingId:c.closingId,saleId:c.saleId,saleEventId:c.saleEventId,reviewJson:c.input.fingerprint,countedCash:123,expectedCash:0});return new Response(JSON.stringify({done:false,ticketId:a.p_ticket_id,token:'z'.repeat(43),businessId:s.business.id,outletId:s.outlet.id,actorId:s.owner.id,at:10000,contextJson:JSON.stringify({business:raw('businesses',s.business),outlet:raw('outlets',s.outlet),actorName:s.owner.name,closing:null,sale:null,sales:[],orders:[],refunds:[],accounts:[],entries:[],customers:[],stock:[],closings:[]})}));}
   expect(name).toBe('finish_closing_write');expect(h.get('apikey')).toBe('sb_secret_test_only');expect(h.has('Authorization')).toBe(false);const rows=a.p_records as {table:string;values:Record<string,unknown>}[];expect(rows).toHaveLength(4);expect(rows[0].values).toMatchObject({id:c.closingId,event_id:c.id,added_sale_id:c.saleId,counted_cash:123,expected_cash:0,difference:123,added_walk_in:123,created_at:1000,updated_at:10000});expect(rows.find(r=>r.table==='sales')!.values).toMatchObject({id:c.saleId,event_id:c.saleEventId,amount:123,closing_id:c.closingId});expect(rows.filter(r=>r.table==='events').map(r=>r.values.at)).toEqual([10000,10000]);return new Response(JSON.stringify(receipt));
  };
  await import('data:text/javascript;base64,'+Buffer.from(bundle.files[0].content).toString('base64')+'#closing');expect(handler).toBeTypeOf('function');const response=await handler!(new Request('https://api.test/commands',{method:'POST',headers:{Origin:'https://shop.test',Authorization:'Bearer user.valid.signature','Content-Type':'application/json'},body:JSON.stringify(c)}));expect(response.status).toBe(200);const body=await response.text();expect(body).not.toMatch(/sb_secret_|contextJson|ticketId|token/);expect(JSON.parse(body)).toEqual(receipt);expect(calls).toEqual(['prepare_closing_write','finish_closing_write']);
 }finally{runtime.Deno=previousDeno;globalThis.fetch=previousFetch;}
},30000);
