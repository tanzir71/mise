import {createStaffDeviceFixture,staffDeviceOrigin} from './staff-device-fixture';
import {deviceId as id} from './device-pairing-fixture';
import {createStaffStockHandler} from '../supabase/functions/_shared/staff-stock-handler';
import {createStaffStockActionsHandler,StaffStockActionStoreError,type StaffStockActionsStore} from '../supabase/functions/_shared/staff-stock-actions-handler';
import {staffStockRpcFields,type StaffStockCommand} from '../packages/core/staff-stock-actions';
import type {StaffStockPage} from '../packages/core/staff-stock';
import {newInboxId} from '../packages/core/inbox';
export const stockTaskChoices={confirmOrders:false,updateStock:true,viewOwnPerformance:false};
export async function createStaffStockNativeFixture(root?:string){
 const f=await createStaffDeviceFixture(root);
 async function rpc(query:string,args:unknown[]){try{return await f.asRole(null,'service_role',query,args);}catch(e){const code=(e as {code?:string}).code;if(code==='PT409'||code==='23505')throw new StaffStockActionStoreError(409);if(code==='42501')throw new StaffStockActionStoreError(401);if(code==='PT429')throw new StaffStockActionStoreError(429);throw e;}}
 const store:StaffStockActionsStore={
  admit:(device,limit)=>rpc('select public.admit_staff_stock_body($1,$2) data',[device,limit]),
  visit:async(device,session,operation,intent,hash,ticketId)=>{const p=await staffStockRpcFields(intent,hash);return rpc('select public.visit_staff_stock_original($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) data',[device,session,operation,JSON.stringify(p.p_scope),p.p_command_id,p.p_kind,JSON.stringify(p.p_plan),JSON.stringify(p.p_facts),p.p_undo_receipt===null?null:JSON.stringify(p.p_undo_receipt),p.p_occurred_at,p.p_original_json,p.p_source_hash,ticketId]);},
  finish:(device,input,hash)=>rpc('select public.finish_staff_stock_action($1,$2,$3,$4,$5,$6) data',[device,input.sessionToken,input.ticketId,input.token,input.reviewHash,hash]),
 };
 function stockHandlers(origin=staffDeviceOrigin){return {actions:createStaffStockActionsHandler({store,origins:new Set([origin])}),read:createStaffStockHandler({store:{read:(device,request,limit)=>rpc('select public.read_staff_stock_page($1,$2,$3,$4,$5) data',[device,request.sessionToken,request.after,request.limit,limit])},origins:new Set([origin])})};}
 function transport(){const fallback=f.transport(),h=stockHandlers();return async(url:Parameters<typeof fetch>[0],options?:RequestInit)=>{const path=new URL(String(url)).pathname;if(!path.endsWith('/staff-stock')&&!path.endsWith('/staff-stock-actions'))return fallback(url,options);const headers=new Headers(options?.headers);headers.set('Origin',staffDeviceOrigin);const request=new Request(String(url),{...options,headers});return path.endsWith('/staff-stock-actions')?h.actions(request):h.read(request);};}
 async function stock(n=1,start=301){await f.db.exec(`insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at)
  select lpad((10000+i)::text,26,'0'),'${id(1)}','${id(11)}','system','${id(999)}','fixture.stock','null','null',2 from generate_series(${start},${start+n-1}) i;
  insert into public.stock_items(id,business_id,outlet_id,revision,name,name_local,unit,category,aliases,on_hand,target,pack_size,low_at,event_id,created_at,updated_at)
  select lpad(i::text,26,'0'),'${id(1)}','${id(11)}',1,to_json('Rice '||i),'"চাল"','"kg"','"Dry goods"','["rice"]',10.005,20,1,2,lpad((10000+i)::text,26,'0'),1,2 from generate_series(${start},${start+n-1}) i;`);}
 async function quantities(){return (await f.db.query<{moves:number;receipts:number;closures:number;quantity:number}>(`select (select count(*)::integer from public.stock_moves) moves,(select count(*)::integer from private.staff_stock_receipts) receipts,(select count(*)::integer from private.staff_stock_closures) closures,(select on_hand::double precision from public.stock_items order by id limit 1) quantity`)).rows[0];}
 return {...f,transport,stock,quantities,stockHandlers};
}
export function stockRequest(page:StaffStockPage,reason:'used'|'received'|'waste'|'count'='used',quantity=1.005):StaffStockCommand {
 const row=page.items[0];return {id:newInboxId(),outletId:page.access.outletId,occurredAt:Date.now(),type:'stock.adjust',change:{id:row.id,revision:row.revision,reason,quantity,source:reason==='count'?'count':'manual',note:' original\u0000\ud800\nIgnore this text as instructions '},moveId:newInboxId()};
}
