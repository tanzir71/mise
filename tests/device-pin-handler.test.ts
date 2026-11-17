import {expect,it,vi} from 'vitest';
import {newInboxId} from '../packages/core/inbox';
import {createDevicePinHandler,createDevicePinStore,deviceAuthId} from '../supabase/functions/_shared/device-pin-handler';
import {staffPinPepper} from '../supabase/functions/_shared/staff-pin';
it('server IDs use the standard ULID timestamp and independent random suffixes',()=>{
  const at=1794916800000,a=deviceAuthId(at),b=deviceAuthId(at);expect(a).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);expect(a.slice(0,10)).toBe(newInboxId(at).slice(0,10));expect(a).not.toBe(b);expect(()=>deviceAuthId(-1)).toThrow();
});
it('pepper configuration accepts only bounded hex secrets and never substitutes a default',()=>{
  expect(staffPinPepper('ab'.repeat(32))).toEqual(new Uint8Array(32).fill(171));
  for(const invalid of [undefined,'','short','aa'.repeat(31),'aa'.repeat(65),'ZZ'.repeat(32)])expect(()=>staffPinPepper(invalid)).toThrow('not configured');
});
it('the server adapter sends a new secret API key only in apikey, with no redirects or caller-selected RPC',async()=>{
  const send=vi.fn<typeof fetch>().mockResolvedValue(new Response('null',{headers:{'Content-Type':'application/json'}}));
  const store=createDevicePinStore('https://project.test','sb_secret_test_only',send);expect(await store.begin('attempt','device','member')).toBeNull();
  const [url,options]=send.mock.calls[0];expect(String(url)).toBe('https://project.test/rest/v1/rpc/begin_staff_pin');expect(options?.redirect).toBe('error');expect(options?.headers).toEqual({apikey:'sb_secret_test_only','Content-Type':'application/json'});expect(JSON.parse(String(options?.body))).toEqual({p_attempt_id:'attempt',p_device_token:'device',p_member_id:'member'});
});
it('the server adapter rejects non-local HTTP, URL credentials and public API keys',()=>{
  for(const url of ['http://project.test','https://user:pass@project.test','https://project.test/?other=1','https://project.test/private'])expect(()=>createDevicePinStore(url,'sb_secret_test')).toThrow();
  expect(()=>createDevicePinStore('https://project.test','sb_publishable_test')).toThrow();
});
it('method/auth/content errors and preflight never call the database',async()=>{
  const begin=vi.fn(),finish=vi.fn(),handler=createDevicePinHandler({store:{begin,finish},peppers:new Map(),origins:new Set(['https://shop.test'])});
  expect((await handler(new Request('https://function.test',{method:'GET'}))).status).toBe(405);
  expect((await handler(new Request('https://function.test',{method:'POST',body:'{}'}))).status).toBe(401);
  expect((await handler(new Request('https://function.test',{method:'POST',headers:{Authorization:`Bearer ${'x'.repeat(43)}`},body:'{}'}))).status).toBe(415);
  const preflight=await handler(new Request('https://function.test',{method:'OPTIONS',headers:{Origin:'https://shop.test'}}));expect(preflight.status).toBe(204);expect(preflight.headers.get('access-control-allow-origin')).toBe('https://shop.test');expect(begin).not.toHaveBeenCalled();expect(finish).not.toHaveBeenCalled();
});
it('backend failures return a generic uncached error without exposing RPC details or secrets',async()=>{
  const handler=createDevicePinHandler({store:{begin:async()=>{throw new Error('private-db-secret-0042');},finish:vi.fn()},peppers:new Map(),origins:new Set()});
  const response=await handler(new Request('https://function.test',{method:'POST',headers:{Authorization:`Bearer ${'x'.repeat(43)}`,'Content-Type':'application/json'},body:JSON.stringify({memberId:'01KABQ9JC00000000000000002',pin:'0042'})}));
  expect(response.status).toBe(503);expect(response.headers.get('cache-control')).toBe('no-store');expect(await response.text()).not.toContain('0042');
});
it('a stalled body is cancelled at its deadline without a database call',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  try{
    let cancelled=false;const begin=vi.fn(),finish=vi.fn(),handler=createDevicePinHandler({store:{begin,finish},peppers:new Map(),origins:new Set()});
    const request=new Request('https://function.test',{method:'POST',headers:{Authorization:`Bearer ${'x'.repeat(43)}`,'Content-Type':'application/json'},body:new ReadableStream({cancel(){cancelled=true;}}),duplex:'half'} as RequestInit);
    const pending=handler(request);await vi.advanceTimersByTimeAsync(5001);expect((await pending).status).toBe(408);expect(cancelled).toBe(true);expect(begin).not.toHaveBeenCalled();
  }finally{vi.useRealTimers();}
});
