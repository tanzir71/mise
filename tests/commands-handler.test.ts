import {expect,it,vi} from 'vitest';
import {parseCloudCommand,parseCloudCommandReceipt,type CloudCommandReceipt} from '../packages/core/cloud-commands';
import {createCommandsHandler,createCommandStore,CommandDenied,CommandConflict} from '../supabase/functions/_shared/commands-handler';
const id=(n:number)=>String(n).padStart(26,'0'),origin='https://shop.test',jwt='user.valid.signature';
const command={id:id(1),type:'catalogue.availability' as const,itemId:id(2),outletId:id(3),occurredAt:123,available:false};
const receipt:CloudCommandReceipt={id:command.id,type:command.type,itemId:command.itemId,outletId:id(3),occurredAt:123,categoryId:id(10),available:false,at:123,itemUpdatedAt:123,sequence:1,undoOf:null};
function request(body:unknown=command,headers:Record<string,string>={},method='POST'){return new Request('https://api.test/commands',{method,headers:{Origin:origin,Authorization:'Bearer '+jwt,'Content-Type':'application/json',...headers},...(method==='POST'?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});}
it('reuses strict shared intent validation and never accepts actor, tenant, SQL or financial fields',async()=>{
  const apply=vi.fn(),handler=createCommandsHandler({store:{apply},origins:new Set([origin])});
  for(const extra of [{actorId:'owner'},{businessId:'foreign'},{outletId:'foreign'},{sql:'drop table items'},{amount:5},{before:{available:true}}]){const value={...command,...extra};expect(()=>parseCloudCommand(value)).toThrow();expect((await handler(request(value))).status).toBe(400);}expect(apply).not.toHaveBeenCalled();expect(parseCloudCommand(command)).toEqual(command);
});
it('rejects bad credentials, MIME, body bounds, origins and methods before applying a command',async()=>{
  const apply=vi.fn(),handler=createCommandsHandler({store:{apply},origins:new Set([origin])});
  expect((await handler(request(command,{Authorization:''}))).status).toBe(401);expect((await handler(request(command,{'Content-Type':'text/plain'}))).status).toBe(415);expect((await handler(request('x'.repeat(32001)))).status).toBe(413);expect((await handler(request('{bad'))).status).toBe(400);expect((await handler(request(command,{Origin:'https://foreign.test'}))).status).toBe(403);expect((await handler(request(command,{},'GET'))).status).toBe(405);expect((await handler(request(command,{},'OPTIONS'))).status).toBe(204);expect(apply).not.toHaveBeenCalled();
});
it('returns only a validated uncached receipt with the same ID and immutable request identity',async()=>{
  const apply=vi.fn(async()=>({...receipt,auth_user_id:'PRIVATE ID',private:'SECRET'})),handler=createCommandsHandler({store:{apply},origins:new Set([origin])});
  const r=await handler(request());expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('no-store');expect(await r.json()).toEqual(receipt);expect(apply).toHaveBeenCalledExactlyOnceWith(jwt,command);
  expect(()=>parseCloudCommandReceipt({...receipt,available:true},command)).toThrow();expect(()=>parseCloudCommandReceipt({...receipt,sequence:0},command)).toThrow();expect(()=>parseCloudCommandReceipt({...receipt,id:id(8)},command)).toThrow();
});
it('authorization/conflict/unavailable failures expose no backend details and preserve retry identity',async()=>{
  for(const [error,status] of [[new CommandDenied(),403],[new CommandConflict('PRIVATE DATABASE DETAIL'),409],[new Error('PRIVATE DATABASE DETAIL'),503]] as const){const handler=createCommandsHandler({origins:new Set([origin]),store:{apply:async()=>{throw error;}}});const r=await handler(request());expect(r.status).toBe(status);expect(r.headers.get('cache-control')).toBe('no-store');expect(await r.text()).not.toContain('PRIVATE');}
});
it('undo accepts only the original command reference, not a client-chosen inverse state',async()=>{
  const undo={id:id(4),type:'catalogue.undo' as const,undoOf:command.id,outletId:command.outletId,occurredAt:123};expect(parseCloudCommand(undo)).toEqual(undo);expect(()=>parseCloudCommand({...undo,available:true})).toThrow();expect(parseCloudCommandReceipt({...receipt,id:undo.id,type:undo.type,undoOf:command.id,available:true},undo).available).toBe(true);
});
it('the adapter forwards the original JWT with a publishable key to a fixed transactional RPC',async()=>{
  const send=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify(receipt))),store=createCommandStore('https://mise.test','sb_publishable_test_only',send);await store.apply(jwt,command);
  const [url,options]=send.mock.calls[0];expect(String(url)).toBe('https://mise.test/rest/v1/rpc/apply_catalogue_intent');expect(options).toMatchObject({method:'POST',redirect:'error',headers:{apikey:'sb_publishable_test_only',Authorization:'Bearer '+jwt}});expect(options?.signal).toBeInstanceOf(AbortSignal);expect(JSON.parse(options?.body as string)).toEqual({p_id:command.id,p_type:command.type,p_item_id:command.itemId,p_available:false,p_undo_of:null,p_outlet_id:command.outletId,p_occurred_at:command.occurredAt});
});
it('only configured API authorities and publishable keys are accepted and RPC failures map safely',async()=>{
  for(const root of ['http://mise.test','https://user:pass@mise.test','https://mise.test/path','https://mise.test/?x=y'])expect(()=>createCommandStore(root,'sb_publishable_test_only')).toThrow();expect(()=>createCommandStore('https://mise.test','sb_secret_test_only')).toThrow();
  for(const status of [401,403,409,500]){const store=createCommandStore('https://mise.test','sb_publishable_test_only',async()=>new Response('PRIVATE DETAIL',{status}));await expect(store.apply(jwt,command)).rejects.toBeInstanceOf(status===401||status===403?CommandDenied:status===409?CommandConflict:Error);}
});
const create={id:id(11),type:'catalogue.create' as const,itemId:id(12),outletId:id(13),occurredAt:123,categoryId:id(16),input:{name:' Tea\0 ',nameLocal:' চা ',unit:' cup ',category:' Drinks ',price:123,available:true,oftenBought:false}};
const created:CloudCommandReceipt={...receipt,id:create.id,type:create.type,itemId:create.itemId,outletId:create.outletId,categoryId:create.categoryId,available:true};
const prepared={done:false,ticketId:id(15),token:'A'.repeat(43),actorId:id(14),outletId:create.outletId,at:123,itemJson:'null',categoriesJson:'[]'};
function writeStore(send:typeof fetch,serviceKey:string|undefined='sb_secret_test_only'){let next=15;return createCommandStore('https://mise.test','sb_publishable_test_only',send,{serviceKey,newId:()=>id(next++)});}
it('catalogue writes prepare with the original JWT and commit validated fields with a service-only ticket',async()=>{
  const send=vi.fn<typeof fetch>(async url=>new Response(JSON.stringify(String(url).endsWith('/prepare_catalogue_intent')?prepared:created)));
  const handler=createCommandsHandler({origins:new Set([origin]),store:writeStore(send)}),response=await handler(request(create));expect(response.status).toBe(200);expect(await response.json()).toEqual(created);
  const [firstUrl,first]=send.mock.calls[0],[lastUrl,last]=send.mock.calls[1];expect(String(firstUrl)).toBe('https://mise.test/rest/v1/rpc/prepare_catalogue_intent');expect(first?.headers).toEqual({apikey:'sb_publishable_test_only','Content-Type':'application/json',Authorization:'Bearer '+jwt});
  const authorization=JSON.parse(first?.body as string);expect(authorization).toMatchObject({p_id:create.id,p_ticket_id:id(15),p_item_id:create.itemId,p_outlet_id:create.outletId,p_type:create.type});expect(authorization.p_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(String(lastUrl)).toBe('https://mise.test/rest/v1/rpc/finish_catalogue_intent');expect(last?.headers).toEqual({apikey:'sb_secret_test_only','Content-Type':'application/json'});expect(JSON.parse(last?.body as string)).toEqual({p_ticket_id:id(15),p_token:prepared.token,p_name_json:JSON.stringify('Tea\0'),p_local_json:JSON.stringify('চা'),p_unit_json:JSON.stringify('cup'),p_price:123,p_category_id:id(16),p_new_category_json:JSON.stringify('Drinks'),p_available:true,p_often_bought:false});
});
it('receipt replay bypasses privileged mutation and strips any private backend fields',async()=>{
  const send=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({done:true,receipt:{...created,token:'private proof'}}))),handler=createCommandsHandler({origins:new Set([origin]),store:writeStore(send)});
  const response=await handler(request(create));expect(response.status).toBe(200);expect(await response.json()).toEqual(created);expect(send).toHaveBeenCalledTimes(1);
});
it.each([{ticketId:id(99)},{actorId:'invalid'},{outletId:id(99)},{token:'invalid'},{itemJson:'{}'},{categoriesJson:'not json'}])('invalid prepared catalogue context never reaches the service RPC %j',async extra=>{
  const send=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({...prepared,...extra}))),handler=createCommandsHandler({origins:new Set([origin]),store:writeStore(send)});expect((await handler(request(create))).status).toBe(503);expect(send).toHaveBeenCalledTimes(1);
});
it('changed snapshots reprepare at most three times and never expose backend details',async()=>{
  const send=vi.fn<typeof fetch>(async(url,options)=>new Response(JSON.stringify(String(url).endsWith('/prepare_catalogue_intent')?{...prepared,ticketId:JSON.parse(options?.body as string).p_ticket_id}:{code:'PT409',details:'catalogue_snapshot_changed',message:'PRIVATE DETAIL'}),{status:String(url).endsWith('/prepare_catalogue_intent')?200:409})),handler=createCommandsHandler({origins:new Set([origin]),store:writeStore(send)});
  const response=await handler(request(create));expect(response.status).toBe(409);expect(await response.text()).not.toContain('PRIVATE');expect(send).toHaveBeenCalledTimes(6);
});
it.each([401,409,500])('privileged RPC failure %s is bounded and does not retry a different command',async status=>{
  const send=vi.fn<typeof fetch>(async url=>{const preparing=String(url).endsWith('/prepare_catalogue_intent');return new Response(JSON.stringify(preparing?prepared:{code:'23505',message:'PRIVATE DETAIL'}),{status:preparing?200:status});}),handler=createCommandsHandler({origins:new Set([origin]),store:writeStore(send)});
  const response=await handler(request(create));expect(response.status).toBe(status===409?409:503);expect(await response.text()).not.toContain('PRIVATE');expect(send).toHaveBeenCalledTimes(2);
});
it('missing server credentials reject writes without contacting any RPC',async()=>{
  const send=vi.fn<typeof fetch>(),store=createCommandStore('https://mise.test','sb_publishable_test_only',send),handler=createCommandsHandler({origins:new Set([origin]),store});expect((await handler(request(create))).status).toBe(503);expect(send).not.toHaveBeenCalled();
});
it('unmarked HTTP conflicts cannot request an automatic privileged retry',async()=>{
  const send=vi.fn<typeof fetch>(async url=>new Response(JSON.stringify(String(url).endsWith('/prepare_catalogue_intent')?prepared:{code:'PT409',details:'different-conflict'}),{status:String(url).endsWith('/prepare_catalogue_intent')?200:409})),handler=createCommandsHandler({origins:new Set([origin]),store:writeStore(send)});
  expect((await handler(request(create))).status).toBe(409);expect(send).toHaveBeenCalledTimes(2);
});
it.each([{name:42},{price:'123'},{price:-1},{price:0.5},{available:1},{oftenBought:'true'},{category:null},{extra:'spoof'},{name:' '}])('catalogue validation rejects malformed fields before either RPC %j',async fields=>{
  const send=vi.fn<typeof fetch>(),handler=createCommandsHandler({origins:new Set([origin]),store:writeStore(send)});expect((await handler(request({...create,input:{...create.input,...fields}}))).status).toBe(400);expect(send).not.toHaveBeenCalled();
});
