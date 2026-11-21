import {expect,it,vi} from 'vitest';
import {createCloudStockReviewRemote} from '../apps/web/src/data/cloud-stock-review-remote';
import {createCommandRequest,createStockReviewRequest,assertCommandReceipt,type CommandAuthorization} from '../apps/web/src/data/command-request';
import {stockReviewResponseLimit,type StockReviewRequest} from '../packages/core/stock-review-source';
import {stockFingerprint} from '../packages/core/stock-replay';
import {stockBatchCommand} from '../packages/core/stock';
import {stockBatchIntent} from '../apps/web/src/data/outbox-intents';
import {stockFixture,STOCK_AT} from './stock-fixture';
import {adjusted,view,packet,id} from './stock-review-fixture';
import {testCommandAccount} from './command-account-fixture';
const config={apiUrl:'https://cloud.test',publishableKey:'sb_publishable_test_only'};
async function prepare(f=adjusted()) {const quote=view(f.f,f.p);quote.commandHash=await stockFingerprint(f.p.command);return {...f,quote,scope:{businessId:quote.businessId,outletId:quote.outletId,actorId:quote.actorId},account:testCommandAccount(config,async()=>'original.account.signature')};}
it('binds the stock review request and returned comparison to the original account and scope',async()=>{
 const f=await prepare(),saved=structuredClone(f.p),send=vi.fn<typeof fetch>(async(url,init)=>{expect(new URL(String(url)).searchParams.get('review')).toBe('stock-read');expect(init?.redirect).toBe('error');expect(init?.cache).toBe('no-store');expect(init?.credentials).toBe('omit');expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer original.account.signature');expect(JSON.parse(String(init?.body))).toEqual(f.p);return Response.json({done:false,review:f.quote});});
 const result=await createCloudStockReviewRemote(config,f.account,f.scope,send).prepare(f.p);expect(result).toEqual({done:false,review:f.quote});expect(f.p).toEqual(saved);expect(send).toHaveBeenCalledTimes(1);if(result.done)throw Error();expect(()=>assertCommandReceipt(result.review)).not.toThrow();
});
it('retains every field of the complete 1000-item maximum-escaped comparison above the ordinary reply limit',async()=>{
 const f=stockFixture(),base=f.items[0];f.items=Array.from({length:1000},(_,i)=>({...base,id:id(1000+i),eventId:id(2000+i),name:'Item '+i+'\0'.repeat(110),unit:'u'+'\0'.repeat(23),activeKey:'item '+i}));f.moves=[];
 const change=stockBatchCommand(f.items.map(item=>({id:item.id,revision:1,reason:'count',quantity:0.125,note:'\0'.repeat(1000)})),f,STOCK_AT+1000,true),p=packet(stockBatchIntent(change,true),change),built=await prepare({f,change,p}),body=JSON.stringify({done:false,review:built.quote}),size=new TextEncoder().encode(body).length;
 expect(size).toBeGreaterThan(2*1024*1024);expect(size).toBeLessThan(stockReviewResponseLimit);const send:typeof fetch=async()=>new Response(body,{headers:{'Content-Length':String(size),'Content-Type':'application/json'}}),result=await createCloudStockReviewRemote(config,built.account,built.scope,send).prepare(p);if(result.done||!result.review.proposal.enabled)throw Error();expect(result.review.current.items).toHaveLength(1000);expect(result.review.proposal.items).toHaveLength(1000);expect(result.review.proposal.items[999]).toEqual(built.quote.proposal.enabled?built.quote.proposal.items[999]:null);
 await expect(createCommandRequest(config,built.account,send)('{}',{},120000)).rejects.toMatchObject({kind:'retry'});
});
it('rejects declared or streamed stock replies above the bounded stock-specific limit',async()=>{
 const f=await prepare(),declared:typeof fetch=async()=>new Response('{}',{headers:{'Content-Length':String(stockReviewResponseLimit+1)}});await expect(createStockReviewRequest(config,f.account,'read',declared)('{}',{},120000)).rejects.toMatchObject({kind:'retry'});
 const cancelled=vi.fn(),streamed:typeof fetch=async()=>new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(stockReviewResponseLimit+1));},cancel:cancelled}));await expect(createStockReviewRequest(config,f.account,'read',streamed)('{}',{},120000)).rejects.toMatchObject({kind:'retry'});expect(cancelled).toHaveBeenCalledTimes(1);
});
it.each(['businessId','outletId','actorId','sourceHash','commandHash'] as const)('does not accept a comparison with changed %s',async field=>{
 const f=await prepare(),quote={...f.quote,[field]:field.endsWith('Hash')?'f'.repeat(64):id(80000)};await expect(createCloudStockReviewRemote(config,f.account,f.scope,async()=>Response.json({done:false,review:quote})).prepare(f.p)).rejects.toThrow();
});
it('rechecks the actual account after reading a response and retains only an ephemeral guard',async()=>{
 const f=await prepare();let current:CommandAuthorization={jwt:'original.account.signature',userId:'00000000-0000-4000-8000-000000000001',generation:1};const account={...f.account,getAuth:async()=>({...current}),assertCurrent:(value:CommandAuthorization)=>{if(value.generation!==current.generation)throw Error('Account changed');}},remote=createCloudStockReviewRemote(config,account,f.scope,async()=>Response.json({done:false,review:f.quote})),result=await remote.prepare(f.p);if(result.done)throw Error();current={...current,generation:2};expect(()=>assertCommandReceipt(result.review)).toThrow();expect(JSON.stringify(result.review)).not.toContain('original.account.signature');expect(JSON.stringify(result.review)).not.toContain(config.publishableKey);
});
it('never follows provider redirects or exposes a provider error document as a comparison',async()=>{
 const f=await prepare(),send:typeof fetch=async(_url,init)=>{expect(init?.redirect).toBe('error');return new Response('Private provider detail',{status:503});};await expect(createCloudStockReviewRemote(config,f.account,f.scope,send).prepare(f.p)).rejects.toMatchObject({kind:'retry'});
});
it('checks the original outlet before requesting another account-scoped comparison',async()=>{
 const f=await prepare(),send=vi.fn<typeof fetch>(async()=>Response.json({done:false,review:f.quote})),other:StockReviewRequest={...f.p,command:{...f.p.command,outletId:id(80000)}};await expect(createCloudStockReviewRemote(config,f.account,f.scope,send).prepare(other)).rejects.toThrow();expect(send).not.toHaveBeenCalled();
});
