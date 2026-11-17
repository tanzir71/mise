import {expect,it,vi} from 'vitest';
import {createDeviceOrdersHandler,createDeviceOrdersStore} from '../supabase/functions/_shared/device-orders-handler';
const device='D'.repeat(43),session='S'.repeat(43),origin='https://shop.test';
function request(body:unknown={sessionToken:session},headers:Record<string,string>={},method='POST'){
  return new Request('https://api.test/device-orders',{method,headers:{origin,authorization:`Bearer ${device}`,'content-type':'application/json',...headers},...(method==='POST'?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
}
it('blocks invalid authentication, foreign origins and non-POST methods before a privileged read',async()=>{
  const read=vi.fn(),handler=createDeviceOrdersHandler({store:{read},origins:new Set([origin])});
  for(const headers of [{authorization:''},{authorization:'Bearer '+device+'.evil'}])expect((await handler(request(undefined,headers))).status).toBe(401);
  expect((await handler(request(undefined,{origin:'https://foreign.test'}))).status).toBe(403);
  expect((await handler(request(undefined,{},'GET'))).status).toBe(405);
  const options=await handler(request(undefined,{},'OPTIONS'));expect(options.status).toBe(204);expect(options.headers.get('access-control-allow-origin')).toBe(origin);expect(read).not.toHaveBeenCalled();
});
it('rejects caller scope/proof fields, incomplete cursors, invalid limits and oversized JSON without calling SQL',async()=>{
  const read=vi.fn(),handler=createDeviceOrdersHandler({store:{read},origins:new Set([origin])});
  for(const body of [{sessionToken:session,mode:'counter'},{sessionToken:session,businessId:'owner'},{sessionToken:session,permission:'orders.read'},{sessionToken:session,after:{id:'0'.repeat(26)}},...[0,101,null,1.5].map(limit=>({sessionToken:session,limit})),{sessionToken:'bad'},'{bad'])expect((await handler(request(body))).status).toBe(400);
  expect((await handler(request(' '.repeat(2049)))).status).toBe(413);expect((await handler(request(undefined,{'content-type':'text/plain'}))).status).toBe(415);expect(read).not.toHaveBeenCalled();
});
it('passes only the two credentials and validated page cursor to the store, with uncached generic denial',async()=>{
  const read=vi.fn(async()=>null),handler=createDeviceOrdersHandler({store:{read},origins:new Set([origin])}),after={createdAt:123,id:'0'.repeat(26)};
  const response=await handler(request({sessionToken:session,after,limit:100}));expect(read).toHaveBeenCalledExactlyOnceWith(device,session,after,100);
  expect(response.status).toBe(401);expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.get('vary')).toBe('Origin');const body=await response.text();expect(body).not.toContain(device);expect(body).not.toContain(session);
});
it('does not expose store exceptions or malformed partial results',async()=>{
  for(const read of [async()=>{throw new Error('SECRET DATABASE DETAIL');},async()=>({mode:'counter',orders:[{sourceText:'PRIVATE SOURCE'}]})]){
    const response=await createDeviceOrdersHandler({store:{read},origins:new Set([origin])})(request());expect(response.status).toBe(503);expect(response.headers.get('cache-control')).toBe('no-store');expect(await response.text()).toBe(JSON.stringify({error:'Orders are unavailable. Try again later.'}));
  }
});
it('the privileged adapter puts credentials only in a fixed POST body and the server key only in apikey',async()=>{
  const send=vi.fn<typeof fetch>(async()=>new Response('null',{headers:{'content-type':'application/json'}}));
  const store=createDeviceOrdersStore('https://mise.test','sb_secret_test_only',send);expect(await store.read(device,session,null,50)).toBeNull();
  const [url,options]=send.mock.calls[0];expect(String(url)).toBe('https://mise.test/rest/v1/rpc/read_device_orders');expect(options).toMatchObject({method:'POST',redirect:'error',headers:{apikey:'sb_secret_test_only','Content-Type':'application/json'}});expect(options?.headers).not.toHaveProperty('Authorization');expect(options?.signal).toBeInstanceOf(AbortSignal);
  expect(JSON.parse(options?.body as string)).toEqual({p_device_token:device,p_session_token:session,p_after_time:null,p_after_id:null,p_limit:50});expect(String(url)).not.toContain(device);expect(String(url)).not.toContain(session);
});
it('the adapter rejects alternate API authorities, non-secret keys and unsuccessful responses',async()=>{
  for(const url of ['http://mise.test','https://user:pass@mise.test','https://mise.test/path','https://mise.test/?redirect=foreign','https://mise.test/#fragment'])expect(()=>createDeviceOrdersStore(url,'sb_secret_test_only')).toThrow();
  for(const key of ['','legacy-jwt','sb_publishable_public'])expect(()=>createDeviceOrdersStore('https://mise.test',key)).toThrow();
  const store=createDeviceOrdersStore('https://mise.test','sb_secret_test_only',async()=>new Response('sensitive backend detail',{status:500}));await expect(store.read(device,session,null,50)).rejects.toThrow('Orders unavailable');
});
