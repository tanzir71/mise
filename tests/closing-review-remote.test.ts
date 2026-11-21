import {expect,it,vi} from 'vitest';
import {createCloudClosingReviewRemote} from '../apps/web/src/data/cloud-closing-review-remote';
import {createClosingReviewRequest,createCommandRequest,assertCommandReceipt,type CommandAuthorization} from '../apps/web/src/data/command-request';
import {closingReviewResponseLimit} from '../packages/core/closing-review-view';
import {closingReviewSourceAudits} from '../packages/core/closing-review-source';
import {undoClosingCommand} from '../packages/core/closing';
import {closingIntent} from '../apps/web/src/data/outbox-intents';
import {testCommandAccount} from './command-account-fixture';
import {fixture,modes,id,view} from './closing-review-fixture';
import {ordinaryClosingReceipt,closingResolution} from './closing-review-client-fixture';
const config={apiUrl:'https://cloud.test',publishableKey:'sb_publishable_test_only'};
async function prepared(mode:typeof modes[number]='surplus'){
 const f=fixture(mode),quote=await view(f);return {f,quote,scope:{businessId:quote.businessId,outletId:quote.outletId,actorId:quote.actorId},account:testCommandAccount(config,async()=>'original.account.signature')};
}
it.each(modes)('binds the complete %s comparison to the original account and scoped endpoint',async mode=>{
 const p=await prepared(mode),original=structuredClone(p.f.packet),send=vi.fn<typeof fetch>(async(url,init)=>{
  expect(new URL(String(url)).searchParams.get('review')).toBe('closing-read');expect(init?.redirect).toBe('error');expect(init?.cache).toBe('no-store');expect(init?.credentials).toBe('omit');
  expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer original.account.signature');expect(JSON.parse(String(init?.body))).toEqual(original);return Response.json({done:false,review:p.quote});
 });
 const result=await createCloudClosingReviewRemote(config,p.account,p.scope,send).prepare(p.f.packet);expect(result).toEqual({done:false,review:p.quote});expect(p.f.packet).toEqual(original);if(result.done)throw Error();expect(()=>assertCommandReceipt(result.review)).not.toThrow();
});
it('checks the actual new command hash and complete reviewed fingerprint before confirming a replacement',async()=>{
 const p=await prepared(),resolved=await closingResolution(p.f.packet,'replaced'),send=vi.fn<typeof fetch>(async url=>{expect(new URL(String(url)).searchParams.get('review')).toBe('closing-resolve');return Response.json(resolved);}),remote=createCloudClosingReviewRemote(config,p.account,p.scope,send);
 expect(await remote.resolve({...p.f.packet,token:p.quote.token,outcome:'withdrawn'})).toEqual(resolved);
 resolved.replacement!.commandHash='f'.repeat(64);await expect(remote.resolve({...p.f.packet,token:p.quote.token,outcome:'replaced'})).rejects.toMatchObject({kind:'review'});
});
it.each(['actor','business','hash','closing','source'] as const)('rejects an unrelated or altered %s comparison',async kind=>{
 const p=await prepared(),quote=structuredClone(p.quote);
 if(kind==='actor')quote.actorId=id(88888);if(kind==='business')quote.businessId=id(88888);if(kind==='hash')quote.commandHash='f'.repeat(64);if(kind==='closing')quote.commandId=id(88888);if(kind==='source')quote.sourceHash='f'.repeat(64);
 await expect(createCloudClosingReviewRemote(config,p.account,p.scope,async()=>Response.json({done:false,review:quote})).prepare(p.f.packet)).rejects.toThrow();
});
it('refuses a different outlet before asking for Auth',async()=>{
 const p=await prepared(),auth=vi.fn(async()=>'original.account.signature'),send=vi.fn<typeof fetch>();
 await expect(createCloudClosingReviewRemote(config,testCommandAccount(config,auth),{...p.scope,outletId:id(88888)},send).prepare(p.f.packet)).rejects.toThrow();expect(auth).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
});
it('invalidates a received comparison after the original sign-in generation changes',async()=>{
 const p=await prepared();let generation=1;const account={...p.account,getAuth:async()=>({jwt:'original.account.signature',userId:'00000000-0000-4000-8000-000000000001',generation}),assertCurrent:(auth:CommandAuthorization)=>{if(auth.generation!==generation)throw Error('Account changed');}};
 const result=await createCloudClosingReviewRemote(config,account,p.scope,async()=>Response.json({done:false,review:p.quote})).prepare(p.f.packet);if(result.done)throw Error();generation++;expect(()=>assertCommandReceipt(result.review)).toThrow();
});
it.each(['difference','day','clock'] as const)('does not recover an ordinary undo over altered %s facts',async kind=>{
 const p=await prepared('undo-surplus'),receipt=ordinaryClosingReceipt(p.f.packet);
 if(kind==='difference')receipt.difference++;if(kind==='day')receipt.day='2000-01-01';if(kind==='clock'){receipt.at+=86400000;receipt.closingUpdatedAt=receipt.at;receipt.saleUpdatedAt=receipt.at;}
 await expect(createCloudClosingReviewRemote(config,p.account,p.scope,async()=>Response.json({done:true,receipt})).prepare(p.f.packet)).rejects.toMatchObject({kind:'retry'});
});
it('retains full imported undo text above the ordinary reply limit',async()=>{
 const f=fixture('undo-surplus'),note='ন'.repeat(999998)+'\0\ud800',name='N'.repeat(1_000_000);f.created.closing.note=note;f.created.closing.createdByName=name;
 let n=88000;f.change=undoClosingCommand(f.created.closing,f.context.setup,f.created.sale,f.command.occurredAt,()=>id(++n));f.command=closingIntent(f.change,true);f.packet.command=f.command;
 const source=JSON.parse(f.packet.sourceJson);source.events=closingReviewSourceAudits(f.command,f.change.events);f.packet.sourceJson=JSON.stringify(source);
 const quote=await view(f),scope={businessId:quote.businessId,outletId:quote.outletId,actorId:quote.actorId},account=testCommandAccount(config,async()=>'original.account.signature'),body=JSON.stringify({done:false,review:quote});expect(new TextEncoder().encode(body).length).toBeGreaterThan(4_000_000);
 const send:typeof fetch=async()=>new Response(body),result=await createCloudClosingReviewRemote(config,account,scope,send).prepare(f.packet);if(result.done)throw Error();
 expect(result.review.proposal.enabled).toBe(true);if(!result.review.proposal.enabled)throw Error();expect(result.review.proposal.closing.note).toBe(note);expect(result.review.proposal.closing.createdByName).toBe(name);
 await expect(createCommandRequest(config,account,send)('{}',{},120000)).rejects.toMatchObject({kind:'retry'});
});
it.each(['declared','streamed'] as const)('refuses an oversized %s response without truncating it',async kind=>{
 const p=await prepared(),send:typeof fetch=async()=>kind==='declared'?new Response('{}',{headers:{'Content-Length':String(closingReviewResponseLimit+1)}}):new Response(new Uint8Array(closingReviewResponseLimit+1));
 await expect(createClosingReviewRequest(config,p.account,'read',send)('{}',{},120000)).rejects.toMatchObject({kind:'retry'});
});
