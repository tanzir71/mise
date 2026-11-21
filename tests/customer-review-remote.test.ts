import {expect,it,vi} from 'vitest';
import {createCloudCustomerReviewRemote} from '../apps/web/src/data/cloud-customer-review-remote';
import {createCustomerReviewRequest,createCommandRequest,assertCommandReceipt,type CommandAuthorization} from '../apps/web/src/data/command-request';
import {customerReviewResponseLimit} from '../packages/core/customer-review-view';
import {customerFingerprint} from '../packages/core/customer-commands';
import {reviewedCustomerProposal,type CustomerResolutionReceipt} from '../packages/core/customer-review';
import {testCommandAccount} from './command-account-fixture';
import {fixture,modes,id,reviewView,ordinaryCustomerReceipt} from './customer-review-fixture';
const config={apiUrl:'https://cloud.test',publishableKey:'sb_publishable_test_only'};
async function prepared(mode:typeof modes[number]='create-opening'){
 const f=fixture(mode),quote=await reviewView(f);return {f,quote,scope:{businessId:quote.businessId,outletId:quote.outletId,actorId:quote.actorId},account:testCommandAccount(config,async()=>'original.account.signature')};
}
it.each(modes)('binds the complete %s comparison to the original phone account and current scope',async mode=>{
 const f=await prepared(mode),saved=structuredClone(f.f.packet),send=vi.fn<typeof fetch>(async(url,init)=>{
  expect(new URL(String(url)).searchParams.get('review')).toBe('customer-read');expect(init?.redirect).toBe('error');expect(init?.cache).toBe('no-store');expect(init?.credentials).toBe('omit');expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer original.account.signature');expect(JSON.parse(String(init?.body))).toEqual(saved);return Response.json({done:false,review:f.quote});
 });
 const result=await createCloudCustomerReviewRemote(config,f.account,f.scope,send).prepare(f.f.packet);expect(result).toEqual({done:false,review:f.quote});expect(f.f.packet).toEqual(saved);if(result.done)throw Error();expect(()=>assertCommandReceipt(result.review)).not.toThrow();
});
it('verifies the actual replacement command hash before acknowledging a resolved reply',async()=>{
 const f=await prepared(),c=f.f.command,next=reviewedCustomerProposal(c,f.f.packet.replacementId),receipt=ordinaryCustomerReceipt(f.f,next),resolved:CustomerResolutionReceipt={id:id(840001),type:'command.resolved',commandId:c.id,commandType:c.type,customerId:c.customerId,outletId:c.outletId,commandHash:await customerFingerprint(c),sourceHash:f.f.packet.sourceHash,at:receipt.at+1,outcome:'replaced',replacement:{id:next.id,commandHash:await customerFingerprint(next),receipt}};
 const send=vi.fn<typeof fetch>(async(url)=>{expect(new URL(String(url)).searchParams.get('review')).toBe('customer-resolve');return Response.json(resolved);}),remote=createCloudCustomerReviewRemote(config,f.account,f.scope,send);
 expect(await remote.resolve({...f.f.packet,token:f.quote.token,outcome:'withdrawn'})).toEqual(resolved);
 resolved.replacement!.commandHash='f'.repeat(64);await expect(remote.resolve({...f.f.packet,token:f.quote.token,outcome:'replaced'})).rejects.toMatchObject({kind:'review'});
});
it.each(['actor','business','hash','customer','source'] as const)('rejects an unrelated or altered %s response',async kind=>{
 const f=await prepared(),value=structuredClone(f.quote);
 if(kind==='actor')value.actorId=id(840001);if(kind==='business')value.businessId=id(840001);if(kind==='hash')value.commandHash='f'.repeat(64);if(kind==='customer')value.commandId=id(840001);if(kind==='source')value.sourceHash='f'.repeat(64);
 const remote=createCloudCustomerReviewRemote(config,f.account,f.scope,async()=>Response.json({done:false,review:value}));await expect(remote.prepare(f.f.packet)).rejects.toThrow();
});
it('does not send a saved action to another outlet',async()=>{
 const f=await prepared(),send=vi.fn<typeof fetch>(),remote=createCloudCustomerReviewRemote(config,f.account,f.scope,send);await expect(remote.prepare({...f.f.packet,command:{...f.f.command,outletId:id(840001)}})).rejects.toThrow();expect(send).not.toHaveBeenCalled();
});
it('invalidates a received comparison when the original sign-in generation changes',async()=>{
 const f=await prepared();let generation=1;const account={...f.account,getAuth:async()=>({jwt:'original.account.signature',userId:'00000000-0000-4000-8000-000000000001',generation}),assertCurrent:(auth:CommandAuthorization)=>{if(auth.generation!==generation)throw Error();}};
 const result=await createCloudCustomerReviewRemote(config,account,f.scope,async()=>Response.json({done:false,review:f.quote})).prepare(f.f.packet);if(result.done)throw Error();generation++;expect(()=>assertCommandReceipt(result.review)).toThrow();
});
it('retains a maximum imported before-note above the ordinary reply limit',async()=>{
 const f=fixture('update-contact'),source=JSON.parse(f.packet.sourceJson),profile=source.events.find((e:{kind:string})=>e.kind==='customer');profile.before.notes='\\'.repeat(1_000_000);f.packet.sourceJson=JSON.stringify(source);
 const quote=await reviewView(f,{customer:profile.before}),scope={businessId:quote.businessId,outletId:quote.outletId,actorId:quote.actorId},account=testCommandAccount(config,async()=>'original.account.signature'),body=JSON.stringify({done:false,review:quote});expect(new TextEncoder().encode(body).length).toBeGreaterThan(4_000_000);
 const send:typeof fetch=async()=>new Response(body),result=await createCloudCustomerReviewRemote(config,account,scope,send).prepare(f.packet);if(result.done)throw Error();expect(JSON.parse(result.review.current.contextJson).customer.notes===profile.before.notes).toBe(true);await expect(createCommandRequest(config,account,send)('{}',{},120000)).rejects.toMatchObject({kind:'retry'});
});
it.each(['declared','streamed'] as const)('rejects an oversized %s response without truncation',async kind=>{
 const f=await prepared(),send:typeof fetch=async()=>kind==='declared'?new Response('{}',{headers:{'Content-Length':String(customerReviewResponseLimit+1)}}):new Response(new Uint8Array(customerReviewResponseLimit+1));await expect(createCustomerReviewRequest(config,f.account,'read',send)('{}',{},120000)).rejects.toMatchObject({kind:'retry'});
});
