import {authHttp,readAuthBody,AuthBodyError} from './auth-http.ts';
import {commandReviewHeader} from '../../../packages/core/command-resolution.ts';
import {parseStockReviewRequest,parseStockReviewSource,stockReviewBodyLimit,stockReviewItem,stockReviewMove,stockReviewUnitFacts,type StockReviewRequest,type StockReviewDecision} from '../../../packages/core/stock-review-source.ts';
import {parsePreparedStockReview,stockReviewInput,stockReviewProjection,type PreparedStockReview} from '../../../packages/core/stock-review-view.ts';
import {parseStockResolutionReceipt,reviewedStockProposal,type StockResolutionReceipt} from '../../../packages/core/stock-review.ts';
import {stockWritePlan,parseStockCommandReceipt,type StockCommand,type StockCommandReceipt} from '../../../packages/core/stock-commands.ts';
import {stockFingerprint,replayStockRecords} from '../../../packages/core/stock-replay.ts';
import {stockWriteFields} from './stock-write.ts';
import {activeStockMoves} from '../../../packages/core/stock.ts';
import {stockNameKey} from '../../../packages/core/stock-quantity.ts';
import {decodeCommandRecord,decodeProposedCommandRecord} from '../../../packages/core/cloud-records.ts';
import {syncHash} from '../../../packages/core/sync-read.ts';
import {syncDownloadToken} from '../../../packages/core/sync-download.ts';
import {deviceAuthId} from './device-pin-handler.ts';
import type {Business,Outlet,StockItem,StockMove,Supplier} from '../../../packages/core/models.ts';
type StockOutcome=StockCommandReceipt|StockResolutionReceipt;
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const id=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
const same=(a:unknown,b:unknown)=>syncDownloadToken(a)===syncDownloadToken(b);
class StockReviewFailure extends Error {constructor(readonly status:400|401|403|409|429|503){super('Review the original stock action and current values.');}}
export interface StockReviewStore {admit(jwt:string,outletId:string):Promise<void>;prepare(jwt:string,input:StockReviewRequest):Promise<unknown>;resolve(jwt:string,input:StockReviewDecision):Promise<unknown>}
async function reviewFields(value:unknown,input:StockReviewRequest):Promise<{view:PreparedStockReview;proposal:StockCommand|null}> {
 const c=input.command,source=parseStockReviewSource(input),plan=stockWritePlan(c),plannedItems=new Set(plan.rows.map(row=>row.itemId));
 if(!object(value)||value.done!==false||value.id!==input.id||value.replacementId!==input.replacementId||value.commandId!==c.id||value.type!==c.type||value.occurredAt!==c.occurredAt||value.outletId!==c.outletId||!id(value.businessId)||!id(value.actorId)||value.commandHash!==await stockFingerprint(c)||value.sourceHash!==input.sourceHash||value.sourceJsonHash!==await syncHash(new TextEncoder().encode(input.sourceJson))||!same(value.unitFacts,stockReviewUnitFacts(input))||!same(value.plan,plan)||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||!time(value.at)||!time(value.expiresAt)||typeof value.stateJson!=='string')throw new StockReviewFailure(503);
 if(source.events.some(e=>e.actorId!==value.actorId))throw new StockReviewFailure(503);
 const state:unknown=JSON.parse(value.stateJson);
 if(!object(state)||!exact(state,'contextJson,suppliersJson,activeKeys,selectionValid,reserved,resolutionState')||typeof state.contextJson!=='string'||typeof state.suppliersJson!=='string'||typeof state.selectionValid!=='boolean'||typeof state.reserved!=='boolean'||!Array.isArray(state.activeKeys)||c.type!=='stock.restore'&&state.activeKeys.length||!Array.isArray(state.resolutionState)||state.resolutionState.length!==plan.rows.length||state.resolutionState.some((row,i)=>!object(row)||!exact(row,'itemId,position')||row.itemId!==plan.rows[i].itemId||row.position!==null&&(typeof row.position!=='string'||!/^[1-9][0-9]{0,18}$/.test(row.position))))throw new StockReviewFailure(503);
 const keys=state.activeKeys.map(row=>{if(!object(row)||!exact(row,'id,key')||!id(row.id)||typeof row.key!=='string')throw new StockReviewFailure(503);const key:unknown=JSON.parse(row.key);if(typeof key!=='string'||JSON.stringify(key)!==row.key)throw new StockReviewFailure(503);return {id:row.id,key:row.key};});
 if(new Set(keys.map(x=>x.id)).size!==keys.length)throw new StockReviewFailure(503);
 const raw:unknown=JSON.parse(state.contextJson);
 if(!object(raw)||!object(raw.business)||!object(raw.outlet)||!Array.isArray(raw.items)||!raw.items.every(object)||!Array.isArray(raw.moves)||!raw.moves.every(object)||!Array.isArray(raw.suppliers)||!raw.suppliers.every(object))throw new StockReviewFailure(503);
 const business=decodeCommandRecord('businesses',raw.business) as unknown as Business,outlet=decodeCommandRecord('outlets',raw.outlet) as unknown as Outlet,items=raw.items.map(row=>decodeCommandRecord('stockItems',row) as unknown as StockItem),moves=raw.moves.map(row=>decodeCommandRecord('stockMoves',row) as unknown as StockMove),suppliers=raw.suppliers.map(row=>decodeCommandRecord('suppliers',row) as unknown as Supplier);
 if(business.id!==value.businessId||outlet.id!==c.outletId||outlet.businessId!==business.id||[...items,...moves,...suppliers].some(row=>row.outletId!==outlet.id)||new Set(items.map(row=>row.id)).size!==items.length||new Set(moves.map(row=>row.id)).size!==moves.length||items.some(row=>!plannedItems.has(row.id)&&JSON.stringify(row.activeKey)!==plan.nameKey)||moves.some(row=>!plannedItems.has(row.stockItemId))||suppliers.some(row=>row.id!==plan.supplierId))throw new StockReviewFailure(503);
 const itemIndex=new Map(items.map(item=>[item.id,item])),selected=plan.rows.map(row=>({stockItemId:row.itemId,item:itemIndex.get(row.itemId)??null})),first=selected[0].item;
 const supplierValues:unknown=JSON.parse(state.suppliersJson),supplierIds=new Set('input'in c?[c.input.supplierId,first?.supplierId??null].filter((id):id is string=>id!==null):[]);
 if(!Array.isArray(supplierValues)||supplierValues.length>2||supplierValues.some(row=>!object(row)||!exact(row,'id,name,archived')||!id(row.id)||!supplierIds.has(row.id)||typeof row.name!=='string'||!row.name.trim()||row.name.length>120||typeof row.archived!=='boolean')||new Set(supplierValues.map(row=>row.id)).size!==supplierValues.length)throw new StockReviewFailure(503);
 if(suppliers.some(row=>!supplierValues.some(value=>value.id===row.id&&value.name===row.name&&value.archived===(row.archivedAt!==undefined))))throw new StockReviewFailure(503);
 const linkedSuppliers={saved:'input'in c?supplierValues.find(row=>row.id===c.input.supplierId)??null:null,current:'input'in c?supplierValues.find(row=>row.id===first?.supplierId)??null:null};
 let undo:PreparedStockReview['current']['undo']=null;
 if(c.type==='stock.undo'){
  const move=moves.find(row=>row.id===c.undoMoveId);if(move){if(move.stockItemId!==c.stockItemId)throw new StockReviewFailure(503);const active=activeStockMoves(moves);undo={move:stockReviewMove(move),reversed:moves.some(row=>row.undoOf===move.id),laterCount:active.some(row=>row.stockItemId===move.stockItemId&&row.reason==='count'&&row.revision>move.revision),restoredCountAt:activeStockMoves(moves.filter(row=>row.id!==move.id)).filter(row=>row.stockItemId===move.stockItemId&&row.reason==='count').sort((a,b)=>b.revision-a.revision)[0]?.createdAt??null};}
 }
 const current:PreparedStockReview['current']={stateHash:await syncHash(new TextEncoder().encode(value.stateJson)),timezone:outlet.timezone,items:selected.map(row=>({stockItemId:row.stockItemId,item:row.item?stockReviewItem(row.item):null})),input:'input'in c&&first?stockReviewInput(first):null,suppliers:linkedSuppliers,undo};
 const base={v:1,id:input.id,replacementId:input.replacementId,commandId:c.id,commandHash:value.commandHash,sourceHash:input.sourceHash,businessId:value.businessId,outletId:c.outletId,actorId:value.actorId,token:value.token,at:value.at,expiresAt:value.expiresAt,current};
 let proposal:StockCommand|null=null,view:PreparedStockReview|undefined,preview:PreparedStockReview['proposal']={enabled:false,reason:'unavailable'};
 if(selected.some((row,i)=>row.item&&row.item.unit!==source.events[i].after.item.unit))preview={enabled:false,reason:'unit'};
 else if(c.occurredAt>value.at+300000)preview={enabled:false,reason:'clock'};
 else if(c.type==='stock.undo'&&undo&&(value.at<undo.move.createdAt||value.at-undo.move.createdAt>86400000))preview={enabled:false,reason:'expired'};
 else if(c.type==='stock.undo'&&undo?.laterCount)preview={enabled:false,reason:'count'};
 else try{
  if(!state.selectionValid||state.reserved||c.type==='stock.restore'&&first&&keys.some(row=>row.id!==first.id&&row.key===JSON.stringify(stockNameKey(first.name))))throw Error();
  const revisions=selected.map(row=>({stockItemId:row.stockItemId,revision:row.item?.revision??0}));proposal=reviewedStockProposal(c,input.replacementId,revisions);
  const records=replayStockRecords({...value,contextJson:state.contextJson},proposal),recordIndex=new Map(records.filter(r=>r.table==='stock_items').map(row=>[row.values.id,row])),after=plan.rows.map(row=>{const record=recordIndex.get(row.itemId);if(!record)throw Error();return decodeProposedCommandRecord('stockItems',record) as unknown as StockItem;}),candidate:PreparedStockReview['proposal']={enabled:true,revisions,items:after.map(row=>stockReviewProjection(stockReviewItem(row))),input:'input'in c?stockReviewInput(after[0]):null};
  view=parsePreparedStockReview({...base,proposal:candidate},input);preview=candidate;
 }catch{proposal=null;}
 return {view:view??parsePreparedStockReview({...base,proposal:preview},input),proposal};
}
export function createStockReviewHandler(deps:{store:StockReviewStore;origins:ReadonlySet<string>}) {
 const origins=new Set(deps.origins);return async(request:Request):Promise<Response>=>{
  const {reply,blocked}=authHttp(request,origins,[commandReviewHeader.toLowerCase()]);if(blocked)return blocked;
  const jwt=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1],outlet=request.headers.get(commandReviewHeader),query=new URL(request.url).searchParams,mode=query.get('review');
  if(!jwt||jwt.length>8192)return reply(401,{error:'Verify the original phone account again.'});
  if(!id(outlet)||!['stock-read','stock-resolve'].includes(mode??'')||query.getAll('review').length!==1||[...query.keys()].some(key=>key!=='review'))return reply(400,{error:'Choose the original saved stock review.'});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return reply(415,{error:'Use JSON.'});
  try{
   await deps.store.admit(jwt,outlet);const raw=await readAuthBody(request,stockReviewBodyLimit);let input:StockReviewRequest|StockReviewDecision;
   try{input=mode==='stock-resolve'?parseStockReviewRequest(raw,true):parseStockReviewRequest(raw,false);}catch{throw new StockReviewFailure(400);}
   if(input.command.outletId!==outlet)return reply(400,{error:'Keep the original reviewed outlet.'});
   return reply(200,mode==='stock-resolve'?await deps.store.resolve(jwt,input as StockReviewDecision):await deps.store.prepare(jwt,input));
  }catch(error){const status=error instanceof StockReviewFailure?error.status:error instanceof AuthBodyError?error.status:error instanceof SyntaxError||error instanceof TypeError?400:503;return reply(status,{error:status===409?'The stock comparison changed. Review current values again.':status===401||status===403?'Verify the original account and outlet access.':status===429?'Finish an existing saved review before starting another.':status===400?'Keep the complete original stock action and source.':'The stock review is unconfirmed. Keep its original source and try again.'});}
 };
}
export function createStockReviewStore(apiUrl:string,publishableKey:string,serviceKey:string,send:typeof fetch=fetch,newId:()=>string=deviceAuthId):StockReviewStore {
 const root=new URL(apiUrl);if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname))||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)||!/^sb_secret_[A-Za-z0-9_-]+$/.test(serviceKey))throw Error('Stock reviews are unavailable.');
 async function rpc(name:string,args:Record<string,unknown>,jwt?:string):Promise<unknown>{const response=await send(new URL('rest/v1/rpc/'+name,root),{method:'POST',headers:{'Content-Type':'application/json',apikey:jwt?publishableKey:serviceKey,...(jwt?{Authorization:'Bearer '+jwt}:{})},body:JSON.stringify(args),redirect:'error',signal:AbortSignal.timeout(20000)});if(!response.ok){const status=response.status;throw new StockReviewFailure(status===400||status===401||status===403||status===409||status===429?status:503);}return response.json();}
 async function receipt(value:unknown,input:StockReviewRequest):Promise<StockOutcome>{
  if(object(value)&&value.type==='command.resolved'){const result=parseStockResolutionReceipt(value,input.command);if(result.sourceHash!==input.sourceHash||result.commandHash!==await stockFingerprint(input.command))throw new StockReviewFailure(409);if(result.replacement&&result.replacement.commandHash!==await stockFingerprint(reviewedStockProposal(input.command,result.replacement.id,result.replacement.revisions)))throw new StockReviewFailure(503);return result;}return parseStockCommandReceipt(value,input.command);
 }
 async function outcome(jwt:string,input:StockReviewRequest){const value=await rpc('inspect_stock_outcome',{p_command_id:input.command.id,p_type:input.command.type,p_outlet_id:input.command.outletId,p_hash:await stockFingerprint(input.command)},jwt);return value===null?null:receipt(value,input);}
 return {
  admit:async(jwt,outletId)=>{if(await rpc('admit_stock_review',{p_outlet_id:outletId},jwt)!==true)throw new StockReviewFailure(403);},
  prepare:async(jwt,value)=>{
   const input=parseStockReviewRequest(value,false),found=await outcome(jwt,input);if(found)return {done:true,receipt:found};const c=input.command,prepared=await rpc('prepare_stock_review',{p_id:input.id,p_replacement_id:input.replacementId,p_command_id:c.id,p_type:c.type,p_outlet_id:c.outletId,p_plan:stockWritePlan(c),p_hash:await stockFingerprint(c),p_occurred_at:c.occurredAt,p_intent_json:JSON.stringify(c),p_source_hash:input.sourceHash,p_source_json:input.sourceJson,p_unit_facts:stockReviewUnitFacts(input)},jwt);if(object(prepared)&&prepared.done===true)return {done:true,receipt:await receipt(prepared.receipt,input)};return {done:false,review:(await reviewFields(prepared,input)).view};
  },
  resolve:async(jwt,value)=>{
   const input=parseStockReviewRequest(value,true),found=await outcome(jwt,input);if(found)return found;const prepared=await rpc('read_stock_review',{p_id:input.id,p_token:input.token},jwt);if(object(prepared)&&prepared.done===true)return receipt(prepared.receipt,input);const selected=await reviewFields(prepared,input);let fields:Record<string,unknown>|null=null,hash:string|null=null;
   if(input.outcome==='replaced'){
    if(!selected.proposal||!selected.view.proposal.enabled)throw new StockReviewFailure(409);const c=selected.proposal,ticket=newId();hash=await stockFingerprint(c);const normal=await rpc('prepare_stock_write',{p_id:c.id,p_ticket_id:ticket,p_type:c.type,p_outlet_id:c.outletId,p_plan:stockWritePlan(c),p_hash:hash,p_occurred_at:c.occurredAt},jwt);if(!object(normal)||normal.done!==false||normal.businessId!==selected.view.businessId||normal.actorId!==selected.view.actorId)throw new StockReviewFailure(409);fields=stockWriteFields(normal,c,ticket);
    const records=fields.p_records;if(!Array.isArray(records))throw new StockReviewFailure(503);const after=stockWritePlan(c).rows.map(row=>{const record=records.find(r=>object(r)&&r.table==='stock_items'&&object(r.values)&&r.values.id===row.itemId);if(!record)throw new StockReviewFailure(503);return decodeProposedCommandRecord('stockItems',record) as unknown as StockItem;});
    if(!same(after.map(row=>stockReviewProjection(stockReviewItem(row))),selected.view.proposal.items)||!same('input'in c?stockReviewInput(after[0]):null,selected.view.proposal.input))throw new StockReviewFailure(409);
   }
   return receipt(await rpc('finish_stock_review',{p_id:input.id,p_token:input.token,p_outcome:input.outcome,p_replacement_ticket:fields?.p_ticket_id??null,p_replacement_token:fields?.p_token??null,p_replacement_hash:hash,p_replacement_records:fields?.p_records??null}),input);
  },
 };
}
