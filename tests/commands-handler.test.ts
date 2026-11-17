import {expect,it,vi} from 'vitest';
import {parseCloudCommand,parseCloudCommandReceipt,type CloudCommandReceipt} from '../packages/core/cloud-commands';
import {createCommandsHandler,createCommandStore,CommandDenied,CommandConflict} from '../supabase/functions/_shared/commands-handler';
const id=(n:number)=>String(n).padStart(26,'0'),origin='https://shop.test',jwt='user.valid.signature';
const command={id:id(1),type:'catalogue.availability' as const,itemId:id(2),available:false};
const receipt:CloudCommandReceipt={id:command.id,type:command.type,itemId:command.itemId,outletId:id(3),available:false,at:123,itemUpdatedAt:123,sequence:1,undoOf:null};
function request(body:unknown=command,headers:Record<string,string>={},method='POST'){return new Request('https://api.test/commands',{method,headers:{Origin:origin,Authorization:'Bearer '+jwt,'Content-Type':'application/json',...headers},...(method==='POST'?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});}
it('reuses strict shared intent validation and never accepts actor, tenant, SQL or financial fields',async()=>{
  const apply=vi.fn(),handler=createCommandsHandler({store:{apply},origins:new Set([origin])});
  for(const extra of [{actorId:'owner'},{businessId:'foreign'},{outletId:id(4)},{sql:'drop table items'},{amount:5},{before:{available:true}}]){const value={...command,...extra};expect(()=>parseCloudCommand(value)).toThrow();expect((await handler(request(value))).status).toBe(400);}expect(apply).not.toHaveBeenCalled();expect(parseCloudCommand(command)).toEqual(command);
});
it('rejects bad credentials, MIME, body bounds, origins and methods before applying a command',async()=>{
  const apply=vi.fn(),handler=createCommandsHandler({store:{apply},origins:new Set([origin])});
  expect((await handler(request(command,{Authorization:''}))).status).toBe(401);expect((await handler(request(command,{'Content-Type':'text/plain'}))).status).toBe(415);expect((await handler(request('x'.repeat(2049)))).status).toBe(413);expect((await handler(request('{bad'))).status).toBe(400);expect((await handler(request(command,{Origin:'https://foreign.test'}))).status).toBe(403);expect((await handler(request(command,{},'GET'))).status).toBe(405);expect((await handler(request(command,{},'OPTIONS'))).status).toBe(204);expect(apply).not.toHaveBeenCalled();
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
  const undo={id:id(4),type:'catalogue.undo' as const,undoOf:command.id};expect(parseCloudCommand(undo)).toEqual(undo);expect(()=>parseCloudCommand({...undo,available:true})).toThrow();expect(parseCloudCommandReceipt({...receipt,id:undo.id,type:undo.type,undoOf:command.id,available:true},undo).available).toBe(true);
});
it('the adapter forwards the original JWT with a publishable key to a fixed transactional RPC',async()=>{
  const send=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify(receipt))),store=createCommandStore('https://mise.test','sb_publishable_test_only',send);await store.apply(jwt,command);
  const [url,options]=send.mock.calls[0];expect(String(url)).toBe('https://mise.test/rest/v1/rpc/apply_catalogue_command');expect(options).toMatchObject({method:'POST',redirect:'error',headers:{apikey:'sb_publishable_test_only',Authorization:'Bearer '+jwt}});expect(options?.signal).toBeInstanceOf(AbortSignal);expect(JSON.parse(options?.body as string)).toEqual({p_id:command.id,p_type:command.type,p_item_id:command.itemId,p_available:false,p_undo_of:null});
});
it('only configured API authorities and publishable keys are accepted and RPC failures map safely',async()=>{
  for(const root of ['http://mise.test','https://user:pass@mise.test','https://mise.test/path','https://mise.test/?x=y'])expect(()=>createCommandStore(root,'sb_publishable_test_only')).toThrow();expect(()=>createCommandStore('https://mise.test','sb_secret_test_only')).toThrow();
  for(const status of [401,403,409,500]){const store=createCommandStore('https://mise.test','sb_publishable_test_only',async()=>new Response('PRIVATE DETAIL',{status}));await expect(store.apply(jwt,command)).rejects.toBeInstanceOf(status===401||status===403?CommandDenied:status===409?CommandConflict:Error);}
});
