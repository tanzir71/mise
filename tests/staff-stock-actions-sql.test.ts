import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createStaffDeviceFixture} from './staff-device-fixture';
import {deviceId as id} from './device-pairing-fixture';
import {deriveStaffPin} from '../supabase/functions/_shared/staff-pin';
import {newInboxId} from '../packages/core/inbox';
import {parseStaffStockPage} from '../packages/core/staff-stock';
import {parseStaffStockIntent,staffStockIntentHash,staffStockRpcFields,parseStaffStockPrepared,parseOwnStaffStockOutcome,type StaffStockIntent,type StaffStockCommand,type StaffStockPrepared} from '../packages/core/staff-stock-actions';
import {createStaffStockActionsHandler,StaffStockActionStoreError,type StaffStockActionsStore} from '../supabase/functions/_shared/staff-stock-actions-handler';
import type {StaffDeviceSession} from '../packages/core/device-access';
import {decodeCommandRecord} from '../packages/core/cloud-records';
import {adjustStockCommand,type StockWriteContext} from '../packages/core/stock';
import type {StockItem,Business,Outlet} from '../packages/core/models';
import {stockFingerprint} from '../packages/core/stock-replay';
import {stockWritePlan} from '../packages/core/stock-commands';
import {parseStockReviewRequest,stockReviewSourceAudits,stockReviewUnitFacts} from '../packages/core/stock-review-source';
import {staffStockHash} from '../packages/core/staff-stock-actions';
let f:Awaited<ReturnType<typeof createStaffDeviceFixture>>;
const permissions={confirmOrders:false,updateStock:true,viewOwnPerformance:false},origin='https://shop.test';
beforeAll(async()=>{f=await createStaffDeviceFixture();},30000);beforeEach(async()=>{await f.seed();});afterAll(async()=>{await f?.db.close();});
async function login(secret:string,member=id(105)){
 const challenge=await f.asRole<{allowed:boolean;attemptId:string;businessId:string;salt:string}>(null,'service_role','select public.begin_staff_pin($1,$2,$3) data',[newInboxId(),secret,member]);expect(challenge.allowed).toBe(true);
 const proof=await deriveStaffPin('0042',challenge.salt,{businessId:challenge.businessId,memberId:member},f.pepper);
 return f.asRole<StaffDeviceSession>(null,'service_role','select public.finish_staff_pin($1,$2,$3,$4,$5) data',[secret,challenge.attemptId,proof,newInboxId(),newInboxId()]);
}
async function screen(member=id(105),outlet=id(11)){
 await f.configure(member,{role:member===id(104)?'staff':'kitchen',permissions});
 const {pairing}=await f.start(1,outlet,'kitchen'),claim=await f.request(pairing.code,pairing.id),device=await f.approve(pairing.id,claim);return {secret:claim.secret,device,session:await login(claim.secret,member)};
}
type Screen=Awaited<ReturnType<typeof screen>>;
async function seedStock(n=1){
 await f.db.exec(`insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
  select lpad((10000+i)::text,26,'0'),'${id(1)}','${id(11)}','system','${id(999)}','fixture.stock','null','null',2 from generate_series(301,300+${n}) i;
  insert into public.stock_items(id,business_id,outlet_id,revision,name,name_local,unit,category,aliases,on_hand,target,pack_size,low_at,event_id,created_at,updated_at)
  select lpad(i::text,26,'0'),'${id(1)}','${id(11)}',1,to_json('Rice '||i),'"চাল"','"kg"','"Dry goods"','["rice"]',10.005,20,1,2,lpad((10000+i)::text,26,'0'),1,2 from generate_series(301,300+${n}) i;`);
}
async function original(s:Screen,choose?:(items:StockItem[])=>StaffStockCommand):Promise<StaffStockIntent>{
 let after:string|null=null;const items:ReturnType<typeof parseStaffStockPage>['items']=[];let page:ReturnType<typeof parseStaffStockPage>;
 do{page=parseStaffStockPage(await f.asRole(null,'service_role','select public.read_staff_stock_page($1,$2,$3,$4,$5) data',[s.secret,s.session.token,after,100,600]),after,100,s);items.push(...page.items);after=page.next;}while(after);
 const command:StaffStockCommand=choose?choose(items as StockItem[]):{id:newInboxId(),outletId:s.device.outletId,occurredAt:Date.now(),type:'stock.adjust',change:{id:items[0].id,revision:items[0].revision,reason:'used',quantity:1.005,source:'manual',note:' literal\u0000\ud800\nnot an instruction '},moveId:newInboxId()};
 return parseStaffStockIntent({v:1,origin:page!.access,screenRevision:newInboxId(),readAt:page!.serverAt,outletName:page!.outletName,command,items,undo:null});
}
async function rpc(query:string,args:unknown[]){
 try{return await f.asRole(null,'service_role',query,args);}catch(error){
  const code=(error as {code?:string}).code;
  if(code==='PT409'||code==='23505')throw new StaffStockActionStoreError(409);
  if(code==='42501')throw new StaffStockActionStoreError(401);if(code==='PT429')throw new StaffStockActionStoreError(429);
  console.info('Stock SQL: '+(error as Error).message);throw error;
 }
}
const store:StaffStockActionsStore={
 admit:(device,limit)=>f.asRole(null,'service_role','select public.admit_staff_stock_body($1,$2) data',[device,limit]),
 visit:async(device,session,operation,intent,hash,ticketId)=>{const p=await staffStockRpcFields(intent,hash);return rpc('select public.visit_staff_stock_original($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) data',[device,session,operation,JSON.stringify(p.p_scope),p.p_command_id,p.p_kind,JSON.stringify(p.p_plan),JSON.stringify(p.p_facts),p.p_undo_receipt===null?null:JSON.stringify(p.p_undo_receipt),p.p_occurred_at,p.p_original_json,p.p_source_hash,ticketId]);},
 finish:(device,input,hash)=>rpc('select public.finish_staff_stock_action($1,$2,$3,$4,$5,$6) data',[device,input.sessionToken,input.ticketId,input.token,input.reviewHash,hash]),
};
const handler=createStaffStockActionsHandler({store,origins:new Set([origin])});
async function request(s:Screen,intent:StaffStockIntent,operation:'prepare'|'inspect'|'close'|'commit',prepared?:StaffStockPrepared){
 const response=await handler(new Request('https://screen.test/functions/v1/staff-stock-actions',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+s.secret,'Content-Type':'application/json'},body:JSON.stringify({operation,sessionToken:s.session.token,intent,...(operation==='commit'?{ticketId:prepared!.review.id,token:prepared!.token,reviewHash:prepared!.reviewHash}:{})})}));
 return {status:response.status,value:await response.json() as unknown};
}
async function prepare(s:Screen,intent:StaffStockIntent){const r=await request(s,intent,'prepare');expect(r.status,JSON.stringify(r.value)).toBe(200);return parseStaffStockPrepared(r.value,intent,await staffStockIntentHash(intent));}
const finish=async(s:Screen,intent:StaffStockIntent,quote:StaffStockPrepared)=>{const r=await request(s,intent,'commit',quote);expect(r.status,JSON.stringify(r.value)).toBe(200);return parseOwnStaffStockOutcome(r.value,intent,await staffStockIntentHash(intent));};
async function counts(){const row=(await f.db.query<{moves:number;receipts:number;closures:number;quantity:string|null}>(`select (select count(*)::integer from public.stock_moves) moves,(select count(*)::integer from private.staff_stock_receipts) receipts,(select count(*)::integer from private.staff_stock_closures) closures,(select on_hand::text from public.stock_items order by id limit 1) quantity`)).rows[0];return {...row,quantity:row.quantity===null?null:Number(row.quantity)};}
async function ownerWithdrawal(){
 const business=decodeCommandRecord('businesses',(await f.db.query<Record<string,unknown>>('select * from public.businesses where id=$1',[id(1)])).rows[0]) as unknown as Business;
 const outlet=decodeCommandRecord('outlets',(await f.db.query<Record<string,unknown>>('select * from public.outlets where id=$1',[id(11)])).rows[0]) as unknown as Outlet;
 const stock=decodeCommandRecord('stockItems',(await f.db.query<Record<string,unknown>>('select * from public.stock_items order by id limit 1')).rows[0]) as unknown as StockItem;
 const c:Extract<StaffStockCommand,{type:'stock.adjust'}>={id:newInboxId(),type:'stock.adjust',outletId:id(11),occurredAt:Date.now(),moveId:newInboxId(),change:{id:stock.id,revision:stock.revision,reason:'used',quantity:2,source:'manual',note:'Original pending owner movement'}};
 const context:StockWriteContext={setup:{business,outlet,owner:{id:id(101),businessId:id(1),active:true,outletIds:[id(11)]}},items:[stock],moves:[],suppliers:[]},change=adjustStockCommand(c.change,context,c.occurredAt,undefined,kind=>kind==='move'?c.moveId:c.id);
 const packet=parseStockReviewRequest({id:newInboxId(),replacementId:newInboxId(),command:c,sourceHash:await staffStockHash({command:c,events:change.events}),sourceJson:JSON.stringify({v:1,entryId:newInboxId(),sequence:1,commandIndex:0,at:c.occurredAt,events:stockReviewSourceAudits(c,change.events)})},false);
 const prepared=await f.asRole<{done:boolean;token:string}>(1,'authenticated','select public.prepare_stock_review($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) data',[packet.id,packet.replacementId,c.id,c.type,c.outletId,JSON.stringify(stockWritePlan(c)),await stockFingerprint(c),c.occurredAt,JSON.stringify(packet.command),packet.sourceHash,packet.sourceJson,JSON.stringify(stockReviewUnitFacts(packet))]);
 expect(prepared.done).toBe(false);await f.asRole(null,'service_role','select public.finish_stock_review($1,$2,$3,$4,$5,$6,$7) data',[packet.id,prepared.token,'withdrawn',null,null,null,null]);
}

it('prepares an actual PIN review without changing stock, then commits one member-authored quantity and complete audit',async()=>{
 const s=await screen();await seedStock();const intent=await original(s),before=await counts(),quote=await prepare(s,intent);expect(await counts()).toEqual(before);
 expect(quote.review.lines).toMatchObject([{before:10.005,after:9,revision:1}]);
 const accepted=await finish(s,intent,quote);expect(accepted.state).toBe('applied');expect(accepted.receipt).toMatchObject({memberId:id(105),sessionId:s.session.id,command:{id:intent.command.id,results:[{onHand:9,revision:2}]}});
 const audit=(await f.db.query<{actor_id:string;before_data:unknown;after_data:{item:{name:string};move:{createdBy:string;note:string}}}>('select actor_id,before_data,after_data from public.events where id=$1',[intent.command.id])).rows[0];
 expect(audit.actor_id).toBe(id(105));expect(audit.after_data.move.createdBy).toBe(id(105));expect(audit.after_data.move.note).toBe('literal\u0000\ud800\nnot an instruction');expect(await counts()).toEqual({moves:1,receipts:1,closures:0,quantity:9});
 const saved=(await f.db.query<{original_json:string}>('select original_json from private.staff_stock_receipts')).rows[0].original_json;expect(saved).toBe(JSON.stringify(intent));
});
it('matches the canonical stock domain audit and complete original actor without owner Auth',async()=>{
 const s=await screen();await seedStock();const intent=await original(s),quote=await prepare(s,intent);
 const business=decodeCommandRecord('businesses',(await f.db.query<Record<string,unknown>>('select * from public.businesses where id=$1',[id(1)])).rows[0]) as unknown as Business;
 const outlet=decodeCommandRecord('outlets',(await f.db.query<Record<string,unknown>>('select * from public.outlets where id=$1',[id(11)])).rows[0]) as unknown as Outlet;
 const stock=decodeCommandRecord('stockItems',(await f.db.query<Record<string,unknown>>('select * from public.stock_items')).rows[0]) as unknown as StockItem;
 const context:StockWriteContext={setup:{business,outlet,owner:{id:id(105),businessId:id(1),active:true,outletIds:[id(11)]}},items:[stock],moves:[],suppliers:[]};
 if(intent.command.type!=='stock.adjust')throw Error('Fixture command');const command=intent.command;
 const expected=adjustStockCommand(command.change,context,command.occurredAt,undefined,kind=>kind==='move'?command.moveId:command.id);
 for(const item of expected.items)item.updatedAt=Math.max(quote.review.at,item.createdAt,command.occurredAt);for(const move of expected.moves)move.updatedAt=Math.max(quote.review.at,command.occurredAt);for(const event of expected.events)event.at=quote.review.at;
 await finish(s,intent,quote);const actual=decodeCommandRecord('events',(await f.db.query<Record<string,unknown>>('select * from public.events where id=$1',[command.id])).rows[0]);expect(actual).toEqual(JSON.parse(JSON.stringify(expected.events[0])));
});
it('recovers a lost successful reply through inspection and commit retry without applying twice',async()=>{
 const s=await screen();await seedStock();const intent=await original(s),quote=await prepare(s,intent),first=await finish(s,intent,quote);
 expect(await finish(s,intent,quote)).toEqual(first);expect(await request(s,intent,'inspect')).toEqual({status:200,value:first});expect(await counts()).toMatchObject({moves:1,receipts:1,closures:0});
});
it('closes a saved original after Team No, preserves its bytes, reserves all new IDs and defeats a late prepared commit',async()=>{
 const s=await screen();await seedStock();const intent=await original(s),quote=await prepare(s,intent),before=await counts();await f.configure(id(105),{permissions:{...permissions,updateStock:false}});
 const closed=await request(s,intent,'close');expect(closed.status).toBe(200);expect(parseOwnStaffStockOutcome(closed.value,intent,await staffStockIntentHash(intent)).state).toBe('closed');
 expect(await counts()).toEqual({...before,closures:1});expect((await f.db.query<{original_json:string}>('select original_json from private.staff_stock_closures')).rows[0].original_json).toBe(JSON.stringify(intent));
 await f.configure(id(105),{permissions});expect((await request(s,intent,'commit',quote)).value).toEqual(closed.value);
 expect((await f.db.query<{n:number}>('select count(*)::integer n from private.staff_stock_reserved_ids')).rows[0].n).toBe(2);
 await expect(f.db.query("insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at) values($1,$2,$3,'system',$4,'fixture','null','null',2)",[intent.command.id,id(1),id(11),id(999)])).rejects.toThrow(/closed stock/);
});
it('later PIN recovery preserves the originating session and closes an unsent request without changing a quantity',async()=>{
 const s=await screen();await seedStock();const intent=await original(s);s.session=await login(s.secret);await f.configure(id(105),{permissions:{...permissions,updateStock:false}});
 const outcome=await request(s,intent,'close');expect(outcome.status).toBe(200);expect(await counts()).toMatchObject({moves:0,receipts:0,closures:1});
 const saved=(await f.db.query<{original_session_id:string;review_session_id:string}>('select original_session_id,review_session_id from private.staff_stock_closures')).rows[0];expect(saved.original_session_id).toBe(intent.origin.sessionId);expect(saved.review_session_id).toBe(s.session.id);expect(saved.original_session_id).not.toBe(saved.review_session_id);
});
it('denies another current PIN member inspection, closure and reuse of a known original ID',async()=>{
 const s=await screen(),other=await screen(id(104));await seedStock();const intent=await original(s);await prepare(s,intent);
 for(const operation of ['inspect','close','prepare'] as const)expect((await request(other,intent,operation)).status).toBe(401);
 expect(await counts()).toMatchObject({moves:0,receipts:0,closures:0});
});
it('rejects source edits under an already prepared original identity',async()=>{
 const s=await screen();await seedStock();const intent=await original(s);await prepare(s,intent);const changed={...intent,outletName:intent.outletName+' edited'};
 expect((await request(s,changed,'inspect')).status).toBe(409);expect((await request(s,changed,'close')).status).toBe(409);expect(await counts()).toMatchObject({moves:0,receipts:0,closures:0});
});
it('permission No blocks confirmation and No then Yes requires a new explicit comparison',async()=>{
 const s=await screen();await seedStock();const intent=await original(s),quote=await prepare(s,intent);await f.configure(id(105),{permissions:{...permissions,updateStock:false}});
 expect((await request(s,intent,'commit',quote)).status).toBe(401);await f.configure(id(105),{permissions});expect((await request(s,intent,'commit',quote)).status).toBe(409);
 const fresh=await prepare(s,intent);expect(fresh.review.id).not.toBe(quote.review.id);await finish(s,intent,fresh);expect(await counts()).toMatchObject({moves:1,receipts:1});
});
it('an actual later stock change invalidates the comparison without replacing the original request',async()=>{
 const s=await screen();await seedStock();const first=await original(s),source=JSON.stringify(first),quote=await prepare(s,first),second=await original(s);await finish(s,second,await prepare(s,second));
 expect((await request(s,first,'commit',quote)).status).toBe(409);const current=await prepare(s,first);expect(current.review.lines[0]).toMatchObject({revision:2,before:9,after:7.995});expect(JSON.stringify(first)).toBe(source);
 await finish(s,first,current);expect(await counts()).toMatchObject({moves:2,receipts:2,quantity:7.995});
});
it('undo restores only this member’s real original movement once and retains original receipt identity',async()=>{
 const s=await screen();await seedStock();const first=await original(s),applied=await finish(s,first,await prepare(s,first));
 const current=await original(s);current.command={id:newInboxId(),outletId:id(11),occurredAt:Date.now(),type:'stock.undo',stockItemId:id(301),revision:current.items[0].revision,undoMoveId:applied.receipt!.command.results[0].moveId!,moveId:newInboxId()};current.undo=applied.receipt;
 const undo=parseStaffStockIntent(current);const accepted=await finish(s,undo,await prepare(s,undo));expect(accepted.receipt?.command.results[0].onHand).toBe(10.005);
 const again={...undo,command:{...undo.command,id:newInboxId(),moveId:newInboxId()}};expect((await request(s,again,'prepare')).status).toBe(409);expect(await counts()).toMatchObject({moves:2,receipts:2});
});
it('a forged own-undo parent cannot grant access to another member’s actual movement',async()=>{
 const owner=await screen(id(104)),s=await screen();await seedStock();const first=await original(owner),applied=await finish(owner,first,await prepare(owner,first)),current=await original(s);
 current.command={id:newInboxId(),outletId:id(11),occurredAt:Date.now(),type:'stock.undo',stockItemId:id(301),revision:2,undoMoveId:applied.receipt!.command.results[0].moveId!,moveId:newInboxId()};current.undo={...applied.receipt!,memberId:id(105)};
 expect((await request(s,parseStaffStockIntent(current),'prepare')).status).toBe(409);expect(await counts()).toMatchObject({moves:1,receipts:1,quantity:9});
});
it('a full 1,000-line physical count commits every item, genuine movement and audit atomically',async()=>{
 const s=await screen();await seedStock(1000);const intent=await original(s,items=>{const eventIds=items.map(()=>newInboxId());return {id:eventIds[0],type:'stock.batch',outletId:id(11),occurredAt:Date.now(),count:true,batchId:newInboxId(),changes:items.map((item,i)=>({id:item.id,revision:item.revision,reason:'count',quantity:1.005,source:'count',note:'',eventId:eventIds[i],moveId:newInboxId()}))};});
 const quote=await prepare(s,intent),accepted=await finish(s,intent,quote);expect(accepted.receipt!.command.results).toHaveLength(1000);
 expect((await f.db.query<{n:number;quantity:string}>('select count(*)::integer n,sum(on_hand)::text quantity from public.stock_items where revision=2')).rows[0]).toEqual({n:1000,quantity:'1005.000'});expect(await counts()).toMatchObject({moves:1000,receipts:1});
},120000);
it('keeps million-character literal labels and notes intact through quantity writes and complete native JSON audits',async()=>{
 const s=await screen();await seedStock();const label='\0'.repeat(1_000_000);await f.db.query('update public.stock_items set name=$1,name_local=$2,unit=$3',[JSON.stringify(label),JSON.stringify(label),JSON.stringify('\ud800'.repeat(1_000_000))]);
 const intent=await original(s),quote=await prepare(s,intent);expect(quote.review.items[0].name).toBe(label);await finish(s,intent,quote);
 const row=(await f.db.query<{name:string;name_local:string}>('select name,name_local from public.stock_items')).rows[0];expect(row.name).toBe(label);expect(row.name_local).toBe(label);
 const audit=(await f.db.query<{before_data:{name:string};after_data:{item:{name:string;unit:string};move:{name:string}}}>('select before_data,after_data from public.events where id=$1',[intent.command.id])).rows[0];expect(audit.before_data.name).toBe(label);expect(audit.after_data.item.name).toBe(label);expect(audit.after_data.move.name).toBe(label);expect(audit.after_data.item.unit).toBe(intent.items[0].unit);
},60000);
it.each([false,null,'yes',0])('an explicit non-true quantity permission %j denies a write while own closure remains available',async deny=>{
 const s=await screen();await seedStock();const intent=await original(s);await f.db.query('update public.members set permissions=$1 where id=$2',[JSON.stringify({'stock.adjust':deny}),id(105)]);
 expect((await request(s,intent,'prepare')).status).toBe(401);expect((await request(s,intent,'close')).status).toBe(200);expect(await counts()).toMatchObject({moves:0,receipts:0,closures:1});
});
it('a later PIN must review again and the resulting receipt preserves its genuinely older originating session',async()=>{
 const s=await screen();await seedStock();const intent=await original(s),old=await prepare(s,intent),originalSession=intent.origin.sessionId;s.session=await login(s.secret);
 expect((await request(s,intent,'commit',old)).status).toBe(409);const current=await prepare(s,intent);expect(current.review.access.sessionId).toBe(s.session.id);
 const outcome=await finish(s,intent,current);expect(outcome.receipt!.sessionId).toBe(originalSession);
 const saved=(await f.db.query<{original_session_id:string;review_session_id:string}>('select original_session_id,review_session_id from private.staff_stock_receipts')).rows[0];expect(saved).toEqual({original_session_id:originalSession,review_session_id:s.session.id});
});
it('a stale absolute count needs a new actual comparison and retains its real original physical time',async()=>{
 const s=await screen();await seedStock();const count=await original(s,items=>({id:newInboxId(),outletId:id(11),occurredAt:Date.now(),type:'stock.adjust',moveId:newInboxId(),change:{id:items[0].id,revision:1,reason:'count',quantity:7.005,source:'count',note:''}})),source=JSON.stringify(count);
 const other=await original(s);await finish(s,other,await prepare(s,other));const quote=await prepare(s,count);expect(quote.review.lines[0]).toMatchObject({revision:2,before:9,after:7.005});
 const outcome=await finish(s,count,quote);expect(outcome.receipt!.command).toMatchObject({occurredAt:count.command.occurredAt,results:[{revision:3,onHand:7.005}]});
 const actual=(await f.db.query<{last_counted_at:number}>('select last_counted_at from public.stock_items')).rows[0];expect(Number(actual.last_counted_at)).toBe(count.command.occurredAt);expect(JSON.stringify(count)).toBe(source);
});
it('a later genuine physical count blocks undo of an older movement',async()=>{
 const s=await screen();await seedStock();const first=await original(s),saved=await finish(s,first,await prepare(s,first));
 const count=await original(s,items=>({id:newInboxId(),outletId:id(11),occurredAt:Date.now(),type:'stock.adjust',moveId:newInboxId(),change:{id:items[0].id,revision:items[0].revision,reason:'count',quantity:15,source:'count',note:''}}));await finish(s,count,await prepare(s,count));
 const originalUndo=await original(s);originalUndo.command={id:newInboxId(),outletId:id(11),occurredAt:Date.now(),type:'stock.undo',stockItemId:id(301),revision:3,undoMoveId:saved.receipt!.command.results[0].moveId!,moveId:newInboxId()};originalUndo.undo=saved.receipt;
 expect((await request(s,parseStaffStockIntent(originalUndo),'prepare')).status).toBe(409);expect(await counts()).toMatchObject({moves:2,receipts:2,quantity:15});
});
it('expiry during the actual write rolls every quantity, movement, audit and receipt back',async()=>{
 const s=await screen();await seedStock();const intent=await original(s),quote=await prepare(s,intent),before=await counts(),expires=(await f.db.query<{expires_at:number}>('select expires_at from private.devices where id=$1',[s.device.id])).rows[0].expires_at;
 await f.db.exec(`create function public.stock_fixture_expire() returns trigger language plpgsql as $$begin update private.devices set expires_at=created_at+1 where id='${s.device.id}';return new;end$$;create trigger stock_fixture_expire after update of on_hand on public.stock_items for each row execute function public.stock_fixture_expire();`);
 try{expect((await request(s,intent,'commit',quote)).status).toBe(409);expect(await counts()).toEqual(before);expect((await f.db.query<{expires_at:number}>('select expires_at from private.devices where id=$1',[s.device.id])).rows[0].expires_at).toBe(expires);}
 finally{await f.db.exec('drop trigger stock_fixture_expire on public.stock_items;drop function public.stock_fixture_expire()');}
});
it('PIN revision changes revoke a prepared confirmation without any stock effect',async()=>{
 const s=await screen();await seedStock();const intent=await original(s),quote=await prepare(s,intent),before=await counts();await f.db.query('update private.staff_pins set revision=$1 where member_id=$2',[newInboxId(),id(105)]);
 expect((await request(s,intent,'commit',quote)).status).toBe(401);expect(await counts()).toEqual(before);
});
it('all current client roles are denied the new RPCs and private tables, including spoofed owner metadata',async()=>{
 const s=await screen();for(const role of ['anon','authenticated'] as const){
  for(const table of ['staff_stock_tickets','staff_stock_receipts','staff_stock_closures','staff_stock_reserved_ids'])await expect(f.asRole(1,role,'select count(*) data from private.'+table)).rejects.toThrow(/permission denied/);
  await expect(f.asRole(1,role,'select public.admit_staff_stock_body($1,$2) data',[s.secret,600])).rejects.toThrow(/permission denied/);
  const allowed=await f.asRole<boolean>(1,role,"select has_function_privilege(current_user,'public.visit_staff_stock_original(text,text,text,jsonb,public.ulid,text,jsonb,jsonb,jsonb,public.utc_ms,text,text,public.ulid)','execute') or has_function_privilege(current_user,'public.finish_staff_stock_action(text,text,public.ulid,text,text,text)','execute') data");expect(allowed).toBe(false);
 }
 const protectedRows=(await f.db.query<{n:number}>('select count(*)::integer n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=\'private\' and c.relname=any($1) and c.relrowsecurity and c.relforcerowsecurity',[['staff_stock_tickets','staff_stock_receipts','staff_stock_closures','staff_stock_reserved_ids']])).rows[0];expect(protectedRows.n).toBe(4);
});
it('body admission uses a real unexpired enrollment and one shared bounded budget across its PIN sessions',async()=>{
 const s=await screen();await f.db.exec('delete from private.staff_stock_budget');expect(await store.admit(s.secret,1)).toEqual({state:'allowed'});s.session=await login(s.secret);
 expect(await store.admit(s.secret,1)).toMatchObject({state:'limited'});await f.db.exec('update private.staff_stock_budget set window_at=0');expect(await store.admit(s.secret,1)).toEqual({state:'allowed'});
 expect(await store.admit('Z'.repeat(43),600)).toEqual({state:'missing'});for(const budget of [0,60001])expect(await store.admit(s.secret,budget)).toEqual({state:'missing'});
 await f.db.query('update private.devices set expires_at=created_at+1 where id=$1',[s.device.id]);expect(await store.admit(s.secret,600)).toEqual({state:'missing'});
});
it('a new actual owner withdrawal invalidates an older review and appears in the next explicit comparison',async()=>{
 const s=await screen();await seedStock();const intent=await original(s),quote=await prepare(s,intent);expect(quote.review.withdrawn).toEqual([]);const source=JSON.stringify(intent);
 await ownerWithdrawal();expect(await counts()).toMatchObject({moves:0,receipts:0,quantity:10.005});expect((await request(s,intent,'commit',quote)).status).toBe(409);
 const current=await prepare(s,intent);expect(current.review.withdrawn).toEqual([id(301)]);expect(JSON.stringify(intent)).toBe(source);await finish(s,intent,current);expect(await counts()).toMatchObject({moves:1,receipts:1,quantity:9});
});
it('an applied original remains recoverable under a later PIN with no current work permission and cannot be relabelled closed',async()=>{
 const s=await screen();await seedStock();const intent=await original(s),accepted=await finish(s,intent,await prepare(s,intent));
 await f.configure(id(105),{methods:[],permissions:{...permissions,updateStock:false}});await f.db.query('update public.members set permissions=$1 where id=$2',[JSON.stringify({'orders.read':false}),id(105)]);s.session=await login(s.secret);
 const access=await f.asRole<{permissions:string[]}>(null,'service_role','select public.read_device_session($1,$2) data',[s.secret,s.session.token]);expect(access.permissions).toEqual([]);
 expect((await request(s,intent,'inspect')).value).toEqual(accepted);expect((await request(s,intent,'close')).value).toEqual(accepted);expect(await counts()).toMatchObject({moves:1,receipts:1,closures:0,quantity:9});
});
