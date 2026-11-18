import {expect,it,vi} from 'vitest';
import {cloudConnectionTarget} from '../packages/core/cloud-connection';
import {operatorAccountHash} from '../packages/core/operators';
import {syncHash} from '../packages/core/sync-read';
import {SyncImageError,parseSyncImageSource,type SyncImageSource} from '../packages/core/sync-images';
import {createCloudImageRemote} from '../apps/web/src/data/cloud-image-remote';
import {inboxPng} from './inbox-fixture';
const uid='00000000-0000-4000-8000-000000000001',config={apiUrl:'https://images.test',publishableKey:'sb_publishable_test_only'},scope='/mise/app/shop';
const id=(n:number)=>String(n).padStart(26,'0'),auth=async()=>({jwt:'user.1.signature',userId:uid});
async function source():Promise<SyncImageSource>{return {version:1,readId:id(1),sourceHash:'a'.repeat(64),readSeal:'b'.repeat(64),changeId:'9007199254740993',recordHash:'c'.repeat(64),target:{targetHash:await cloudConnectionTarget(config,scope,uid),businessId:id(2),outletId:id(3),actorId:id(4),accountHash:await operatorAccountHash(uid),role:'manager'},image:{id:id(5),businessId:id(2),outletId:id(3),inboxId:id(6),type:'image/png',size:inboxPng.length,sha256:await syncHash(inboxPng)}};}
const response=(bytes:Uint8Array=inboxPng,type='image/png',headers:Record<string,string>={})=>new Response(new Uint8Array(bytes).buffer,{headers:{'Content-Type':type,...headers}});
it('downloads exact original bytes with pinned runtime origin, original JWT and two account checks',async()=>{
 const input=await source(),getAuth=vi.fn(auth),send=vi.fn(async(url:URL|RequestInfo,init?:RequestInit)=>{expect(String(url)).toBe(config.apiUrl+'/functions/v1/inbox-image?image='+input.image.id);expect(init).toMatchObject({method:'GET',redirect:'error',credentials:'omit',cache:'no-store',headers:{apikey:config.publishableKey,Authorization:'Bearer user.1.signature'}});expect(init?.signal).toBeInstanceOf(AbortSignal);return response();});
 const result=await createCloudImageRemote(config,scope,getAuth,send).get(input);expect(result.type).toBe('image/png');expect(new Uint8Array(await result.arrayBuffer())).toEqual(inboxPng);expect(getAuth).toHaveBeenCalledTimes(2);expect(send).toHaveBeenCalledTimes(1);
});
it('freezes source and connection before awaiting Auth',async()=>{
 const input=await source(),original=input.image.id,connection={...config},getAuth=async()=>{input.image.id=id(99);input.image.sha256='d'.repeat(64);connection.apiUrl='https://foreign.test';return auth();},send=vi.fn(async(url:URL|RequestInfo)=>{expect(String(url)).toBe(config.apiUrl+'/functions/v1/inbox-image?image='+original);return response();});expect((await createCloudImageRemote(connection,scope,getAuth,send).get(input)).size).toBe(inboxPng.length);
});
it.each(['account','connection']as const)('refuses another %s before making an image request',async field=>{
 const input=await source();if(field==='account')input.target.accountHash='d'.repeat(64);else input.target.targetHash='d'.repeat(64);const send=vi.fn(async()=>response());await expect(createCloudImageRemote(config,scope,auth,send).get(input)).rejects.toMatchObject({kind:'auth'});expect(send).not.toHaveBeenCalled();
});
it('rejects an account switch after receiving and hashing bytes',async()=>{
 const input=await source();let calls=0;await expect(createCloudImageRemote(config,scope,async()=>{calls++;return {jwt:'user.1.signature',userId:calls===1?uid:'00000000-0000-4000-8000-000000000002'};},async()=>response()).get(input)).rejects.toMatchObject({kind:'auth'});
});
it.each([401,403])('denies status %s without reading or exposing its diagnostic body',async status=>{
 const input=await source();let read=false;const result=new Response('PRIVATE PROVIDER DATA',{status});Object.defineProperty(result,'body',{get(){return {cancel:async()=>{read=true;}};}});await expect(createCloudImageRemote(config,scope,auth,async()=>result).get(input)).rejects.toMatchObject({kind:'auth'});expect(read).toBe(true);
});
it.each([404,409,429,500,503])('keeps status %s retryable and redacts provider content',async status=>{
 const input=await source();await expect(createCloudImageRemote(config,scope,auth,async()=>new Response('PRIVATE PROVIDER DATA',{status})).get(input)).rejects.toMatchObject({kind:'retry',message:expect.not.stringContaining('PRIVATE PROVIDER DATA')});
});
it.each(['short','long','hash','signature','type']as const)('rejects %s image corruption',async mode=>{
 const input=await source();let bytes=new Uint8Array(inboxPng),type='image/png';if(mode==='short')bytes=bytes.slice(0,-1);if(mode==='long')bytes=new Uint8Array([...bytes,0]);if(mode==='hash')bytes[bytes.length-1]^=1;if(mode==='signature')bytes[0]=0;if(mode==='type')type='image/jpeg';await expect(createCloudImageRemote(config,scope,auth,async()=>response(bytes,type)).get(input)).rejects.toMatchObject({kind:'integrity'});
});
it('uses actual decoded bytes rather than trusting wire Content-Length',async()=>{
 const input=await source();expect((await createCloudImageRemote(config,scope,auth,async()=>response(inboxPng,'image/png',{'Content-Length':'1','Content-Encoding':'gzip'})).get(input)).size).toBe(inboxPng.length);
});
it('bounds stalled streams and cancels their reader without leaking diagnostics',async()=>{
 const input=await source();let cancelled=false;const stream=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}});await expect(createCloudImageRemote(config,scope,auth,async()=>new Response(stream,{headers:{'Content-Type':'image/png'}}),20).get(input)).rejects.toMatchObject({kind:'retry'});expect(cancelled).toBe(true);
});
it('bounds stalled Auth and fetch, and never requests Auth after prior cancellation',async()=>{
 const input=await source(),never=new Promise<never>(()=>{});await expect(createCloudImageRemote(config,scope,async()=>never,async()=>response(),20).get(input)).rejects.toMatchObject({kind:'retry'});await expect(createCloudImageRemote(config,scope,auth,async()=>never,20).get(input)).rejects.toMatchObject({kind:'retry'});
 const controller=new AbortController();controller.abort();const getAuth=vi.fn(auth);await expect(createCloudImageRemote(config,scope,getAuth,async()=>response()).get(input,controller.signal)).rejects.toMatchObject({kind:'retry'});expect(getAuth).not.toHaveBeenCalled();
});
it('cancels oversized streams as soon as the original size is exceeded',async()=>{
 const input=await source();let cancelled=false;const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(inboxPng.length+1));},cancel(){cancelled=true;}});await expect(createCloudImageRemote(config,scope,auth,async()=>new Response(stream,{headers:{'Content-Type':'image/png'}})).get(input)).rejects.toMatchObject({kind:'integrity'});expect(cancelled).toBe(true);
});
it('redacts Auth, fetch and stream failures',async()=>{
 const input=await source(),diagnostic='PRIVATE PROVIDER DATA';for(const remote of [createCloudImageRemote(config,scope,async()=>{throw Error(diagnostic);}),createCloudImageRemote(config,scope,auth,async()=>{throw Error(diagnostic);}),createCloudImageRemote(config,scope,auth,async()=>new Response(new ReadableStream({start(c){c.error(Error(diagnostic));}}),{headers:{'Content-Type':'image/png'}}))])await expect(remote.get(input)).rejects.toMatchObject({message:expect.not.stringContaining(diagnostic)});
});
it('rejects unscoped metadata, extra credentials and invalid review positions with fixed errors',async()=>{
 const input=await source();for(const value of [{...input,apiKey:'PRIVATE'},{...input,changeId:'0'},{...input,image:{...input.image,businessId:id(99)}},{...input,image:{...input.image,size:5242881}}])expect(()=>parseSyncImageSource(value)).toThrow(SyncImageError);
});
