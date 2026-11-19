import {expect,it,vi} from 'vitest';
import {createCloudInboxImageUploader} from '../apps/web/src/data/cloud-inbox-upload';
import {cloudConnectionTarget} from '../packages/core/cloud-connection';
import {operatorAccountHash} from '../packages/core/operators';
import {syncHash} from '../packages/core/sync-read';
import {assertCommandReceipt,type CommandAccount} from '../apps/web/src/data/command-request';
import {inboxPng} from './inbox-fixture';
const config={apiUrl:'https://images.test',publishableKey:'sb_publishable_test_only'},uid='00000000-0000-4000-8000-000000000001',scope='/mise/app/shop',id=(n:number)=>String(n).padStart(26,'0');
const original={jwt:'user.1.signature',userId:uid,generation:1};
async function fixture(){
 const image={id:id(1),businessId:id(2),outletId:id(3),inboxId:id(4),type:'image/png' as const,size:inboxPng.length,sha256:await syncHash(inboxPng)},blob=new Blob([new Uint8Array(inboxPng)],{type:'image/png'}),account:CommandAccount={scope,accountHash:await operatorAccountHash(uid),targetHash:await cloudConnectionTarget(config,scope,uid),getAuth:vi.fn(async()=>original),assertCurrent:vi.fn(()=>{})};
 return {image,blob,account};
}
const response=(value:unknown)=>new Response(JSON.stringify(value));
it('uploads complete original bytes with a pinned origin, live identity and an ephemeral receipt guard',async()=>{
 const f=await fixture();let current=true;f.account.assertCurrent=()=>{if(!current)throw Error('Changed');};const send=vi.fn(async(url:URL|RequestInfo,init?:RequestInit)=>{
  expect(String(url)).toBe(config.apiUrl+'/functions/v1/inbox-image?image='+f.image.id);expect(init).toMatchObject({method:'PUT',redirect:'error',credentials:'omit',cache:'no-store',headers:{'Content-Type':'image/png',apikey:config.publishableKey,Authorization:'Bearer '+original.jwt}});expect(new Uint8Array(await (init?.body as Blob).arrayBuffer())).toEqual(inboxPng);return response({id:f.image.id,uploadedAt:123});
 });
 const receipt=await createCloudInboxImageUploader(config,f.account,send)(f.image,f.blob);expect(receipt).toEqual({id:f.image.id,uploadedAt:123});expect(f.account.getAuth).toHaveBeenCalledTimes(2);expect(send).toHaveBeenCalledTimes(1);assertCommandReceipt(receipt);current=false;expect(()=>assertCommandReceipt(receipt)).toThrow();
});
it.each(['hash','size','type']as const)('refuses a changed original %s before Auth or HTTP',async field=>{
 const f=await fixture(),send=vi.fn();if(field==='hash')f.image.sha256='d'.repeat(64);if(field==='size')f.image.size++;if(field==='type')f.blob=new Blob([new Uint8Array(inboxPng)],{type:'image/jpeg'});
 await expect(createCloudInboxImageUploader(config,f.account,send)(f.image,f.blob)).rejects.toMatchObject({kind:'review'});expect(send).not.toHaveBeenCalled();expect(f.account.getAuth).not.toHaveBeenCalled();
});
it.each(['account','connection']as const)('rejects a changed %s before sending image bytes',async field=>{
 const f=await fixture(),send=vi.fn();f.account[field==='account'?'accountHash':'targetHash']='d'.repeat(64);await expect(createCloudInboxImageUploader(config,f.account,send)(f.image,f.blob)).rejects.toMatchObject({kind:'auth'});expect(send).not.toHaveBeenCalled();
});
it('retains a remotely stored image as unconfirmed when the account changes after HTTP',async()=>{
 const f=await fixture();let current=true;f.account.assertCurrent=()=>{if(!current)throw Error('Changed');};const send=vi.fn(async()=>{current=false;return response({id:f.image.id,uploadedAt:123});});await expect(createCloudInboxImageUploader(config,f.account,send)(f.image,f.blob)).rejects.toMatchObject({kind:'auth'});expect(send).toHaveBeenCalledTimes(1);
});
it.each([{id:id(9),uploadedAt:123},{id:id(1),uploadedAt:-1},{id:id(1),uploadedAt:123,token:'unexpected'}])('rejects an unrelated or malformed image confirmation',async receipt=>{
 const f=await fixture();await expect(createCloudInboxImageUploader(config,f.account,async()=>response(receipt))(f.image,f.blob)).rejects.toMatchObject({kind:'retry'});
});
it('recovers a lost reply by retrying the exact same image and never manufacturing a local receipt',async()=>{
 const f=await fixture(),calls:Uint8Array[]=[];let lost=true;const upload=createCloudInboxImageUploader(config,f.account,async(_url,init)=>{calls.push(new Uint8Array(await (init?.body as Blob).arrayBuffer()));if(lost){lost=false;throw Error('Lost');}return response({id:f.image.id,uploadedAt:123});});await expect(upload(f.image,f.blob)).rejects.toMatchObject({kind:'retry'});expect(await upload(f.image,f.blob)).toEqual({id:f.image.id,uploadedAt:123});expect(calls).toEqual([inboxPng,inboxPng]);
});
