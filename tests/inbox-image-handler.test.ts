import {createHash} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {inboxPng} from './inbox-fixture';
import {createInboxImageHandler,readImageBody,ImageAccessDenied,type ImageContext} from '../supabase/functions/_shared/inbox-image-handler';
import {createInboxImageStore} from '../supabase/functions/_shared/inbox-image-store';
const id=(n:number)=>String(n).padStart(26,'0'),origin='https://shop.test',jwt='valid.user.signature';
const meta:ImageContext={id:id(4),businessId:id(1),outletId:id(2),inboxId:id(3),path:[1,2,3,4].map(id).join('/'),type:'image/png',size:inboxPng.length,sha256:createHash('sha256').update(inboxPng).digest('hex'),uploadedAt:null};
it('credential-free preflight and early method/origin/JWT/target rejection never read bytes or SQL',async()=>{
  const context=vi.fn(),put=vi.fn(),get=vi.fn(),complete=vi.fn(),handler=createInboxImageHandler({store:{context,put,get,complete},origins:new Set([origin])});
  for(const [method,header,url,status] of [['GET',{},'?image='+meta.id,401],['POST',{},'?image='+meta.id,405],['GET',{Authorization:'Bearer '+jwt},'?image='+meta.id+'&path=foreign',400],['GET',{Authorization:'Bearer '+jwt},'?image='+meta.id+'&image='+meta.id,400],['GET',{Authorization:'Bearer '+jwt,Origin:'https://foreign.test'},'?image='+meta.id,403]] as const){const r=await handler(new Request('https://api.test/'+url,{method,headers:header}));expect(r.status).toBe(status);expect(r.headers.get('cache-control')).toBe('no-store');}
  const preflight=await handler(new Request('https://api.test',{method:'OPTIONS',headers:{Origin:origin}}));expect(preflight.status).toBe(204);expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, PUT, OPTIONS');expect(context).not.toHaveBeenCalled();expect(get).not.toHaveBeenCalled();expect(put).not.toHaveBeenCalled();
});
it('a denied owner context never consumes the upload or exposes backend error details',async()=>{
  const put=vi.fn(),handler=createInboxImageHandler({origins:new Set([origin]),store:{context:async()=>{throw new ImageAccessDenied();},put,get:vi.fn(),complete:vi.fn()}}),read=vi.fn();
  const stream=new ReadableStream({pull:read}),r=await handler(new Request('https://api.test/?image='+meta.id,{method:'PUT',headers:{Authorization:'Bearer '+jwt,'Content-Type':'image/png'},body:stream,duplex:'half'} as RequestInit));expect(r.status).toBe(403);expect(put).not.toHaveBeenCalled();expect(await r.text()).not.toContain(meta.path);
});
it('the bounded reader refuses declared sizes and cancels a stalled stream at its deadline',async()=>{
  await expect(readImageBody(null,20,'21')).rejects.toMatchObject({status:413});await expect(readImageBody(null,20,'-1')).rejects.toMatchObject({status:400});
  vi.useFakeTimers();try{const cancel=vi.fn(),body=new ReadableStream<Uint8Array>({cancel});const pending=expect(readImageBody(body,20,null,90000)).rejects.toMatchObject({status:408});await vi.advanceTimersByTimeAsync(90000);await pending;expect(cancel).toHaveBeenCalledOnce();}finally{vi.useRealTimers();}
});
it('the adapter forwards the original owner JWT only to fixed publishable-key RPCs',async()=>{
  const send=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify(meta),{headers:{'Content-Type':'application/json'}})),store=createInboxImageStore('https://mise.test','sb_publishable_test_only','sb_secret_test_only',send);
  await store.context(jwt,meta.id);await store.complete(jwt,meta.id,id(5));
  for(const [index,name] of ['inbox_image_context','complete_inbox_image'].entries()){const [url,options]=send.mock.calls[index];expect(String(url)).toBe('https://mise.test/rest/v1/rpc/'+name);expect(options).toMatchObject({method:'POST',redirect:'error',headers:{apikey:'sb_publishable_test_only',Authorization:'Bearer '+jwt}});expect(options?.signal).toBeInstanceOf(AbortSignal);}
});
it('the adapter uploads immutable raw bytes with server hash metadata and keeps the service key out of Authorization',async()=>{
  const send=vi.fn<typeof fetch>(async()=>new Response('{}')),store=createInboxImageStore('https://mise.test','sb_publishable_test_only','sb_secret_test_only',send);expect(await store.put(meta,inboxPng)).toBe(true);
  const [url,options]=send.mock.calls[0];expect(String(url)).toBe('https://mise.test/storage/v1/object/mise-inbox/'+meta.path);const headers=new Headers(options?.headers);expect(headers.get('apikey')).toBe('sb_secret_test_only');expect(headers.has('authorization')).toBe(false);expect(headers.get('x-upsert')).toBe('false');expect(JSON.parse(atob(headers.get('x-metadata')!))).toEqual({sha256:meta.sha256});expect(new Uint8Array(options?.body as ArrayBuffer)).toEqual(inboxPng);
});
it('download uses the authenticated object API and bounds returned bytes before returning them',async()=>{
  const send=vi.fn<typeof fetch>(async()=>new Response(new Uint8Array(inboxPng).buffer,{headers:{'Content-Length':String(inboxPng.length)}})),store=createInboxImageStore('https://mise.test','sb_publishable_test_only','sb_secret_test_only',send);
  expect(await store.get(meta)).toEqual(inboxPng);expect(String(send.mock.calls[0][0])).toBe('https://mise.test/storage/v1/object/authenticated/mise-inbox/'+meta.path);
  await expect(store.get({...meta,size:1})).rejects.toMatchObject({status:413});await expect(store.get({...meta,path:'../../foreign'})).rejects.toThrow('Invalid image path');
});
it('invalid backend credentials/locations and owner authorization failures fail closed',async()=>{
  for(const url of ['http://mise.test','https://user:pass@mise.test','https://mise.test/path','https://mise.test/?redirect=x'])expect(()=>createInboxImageStore(url,'sb_publishable_test_only','sb_secret_test_only')).toThrow();
  expect(()=>createInboxImageStore('https://mise.test','legacy','sb_secret_test_only')).toThrow();expect(()=>createInboxImageStore('https://mise.test','sb_publishable_test_only','legacy')).toThrow();
  const store=createInboxImageStore('https://mise.test','sb_publishable_test_only','sb_secret_test_only',async()=>new Response('PRIVATE BACKEND DETAIL',{status:403}));await expect(store.context(jwt,meta.id)).rejects.toBeInstanceOf(ImageAccessDenied);
});
