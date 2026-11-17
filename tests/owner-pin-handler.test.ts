import {expect,it,vi} from 'vitest';
import {createOwnerPinHandler,createOwnerPinStore,OwnerPinDenied,type OwnerPinStore} from '../supabase/functions/_shared/owner-pin-handler';
const member='01KABQ9JC00000000000000002',outlet='01KABQ9JC00000000000000003',business='01KABQ9JC00000000000000001',event='01KABQ9JC00000000000000004';
const request=(value:unknown,token='header.owner.signature')=>new Request('https://functions.test/staff-pin',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(value)});
const setBody={action:'set',outletId:outlet,memberId:member,pin:'9876'};
function store():OwnerPinStore{return {context:vi.fn().mockResolvedValue({businessId:business,outletId:outlet,memberId:member,configured:true}),set:vi.fn().mockResolvedValue({memberId:member,revision:event,changedAt:1}),clear:vi.fn().mockResolvedValue({memberId:member,cleared:true})};}
const handler=(database=store())=>createOwnerPinHandler({store:database,pepper:new Uint8Array(32).fill(37),origins:new Set(),newId:()=>event});
it.each([{...setBody,businessId:business},{...setBody,verifier:'0'.repeat(64)},{...setBody,role:'owner'},{...setBody,pin:'123'},{...setBody,action:'promote'}])('rejects caller-controlled proof/scope fields and malformed actions',async body=>{
  const database=store();expect((await handler(database)(request(body))).status).toBe(400);expect(database.context).not.toHaveBeenCalled();expect(database.set).not.toHaveBeenCalled();
});
it('device tokens and API keys cannot stand in for an owner JWT',async()=>{
  const database=store();for(const token of ['x'.repeat(43),'sb_secret_test','sb_publishable_test'])expect((await handler(database)(request(setBody,token))).status).toBe(401);expect(database.context).not.toHaveBeenCalled();
});
it('a denied owner context never reaches credential derivation or mutation',async()=>{
  const database=store();database.context=vi.fn().mockRejectedValue(new OwnerPinDenied());const response=await handler(database)(request(setBody));expect(response.status).toBe(403);expect(database.set).not.toHaveBeenCalled();
});
it('a mismatched backend scope fails closed',async()=>{
  const database=store();database.context=vi.fn().mockResolvedValue({businessId:business,outletId:outlet,memberId:event,configured:true});expect((await handler(database)(request(setBody))).status).toBe(503);expect(database.set).not.toHaveBeenCalled();
});
it('responses never echo credential fields even if the backend adds them',async()=>{
  const database=store();database.set=vi.fn().mockResolvedValue({memberId:member,revision:event,changedAt:1,salt:'private',verifier:'private'});
  const response=await handler(database)(request(setBody));expect(await response.json()).toEqual({memberId:member,revision:event,changedAt:1});expect(response.headers.get('cache-control')).toBe('no-store');
});
it('new PINs fail closed without a pepper while removal remains available',async()=>{
  const database=store(),handle=createOwnerPinHandler({store:database,origins:new Set(),newId:()=>event});expect((await handle(request(setBody))).status).toBe(503);expect(database.set).not.toHaveBeenCalled();
  expect((await handle(request({action:'clear',outletId:outlet,memberId:member}))).status).toBe(200);
});
it('the owner adapter uses a publishable key and keeps simultaneous JWTs request-scoped',async()=>{
  const send=vi.fn<typeof fetch>().mockImplementation(async()=>new Response('null')),database=createOwnerPinStore('https://project.test','sb_publishable_test',send);
  await Promise.all([database.context('first.jwt.token',outlet,member,'set'),database.context('second.jwt.token',outlet,member,'clear')]);
  expect(send.mock.calls.map(([,options])=>new Headers(options?.headers).get('authorization'))).toEqual(['Bearer first.jwt.token','Bearer second.jwt.token']);
  for(const [url,options] of send.mock.calls){expect(String(url)).toBe('https://project.test/rest/v1/rpc/staff_pin_context');expect(new Headers(options?.headers).get('apikey')).toBe('sb_publishable_test');expect(options?.redirect).toBe('error');}
});
it('the owner adapter refuses service keys and preserves HTTP authentication failures',async()=>{
  expect(()=>createOwnerPinStore('https://project.test','sb_secret_test')).toThrow();
  const send=vi.fn<typeof fetch>().mockResolvedValue(new Response('{}',{status:401}));await expect(createOwnerPinStore('https://project.test','sb_publishable_test',send).context('a.b.c',outlet,member,'set')).rejects.toMatchObject({status:401});
});
