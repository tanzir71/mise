import type {CloudConnection,KeyStorage} from '@mise/core/cloud-connection';
import {newInboxId} from '@mise/core/inbox';
import {parseEstimateAction,parseEstimateChange,parseEstimateContext,parseEstimateOutcome,type EstimateAction,type EstimateChange,type EstimateContext,type EstimateOutcome,type EstimateScope} from '@mise/core/order-estimates';
import {assertLiveCommandReceipt,bindCommandReceipt,CommandRequestError,createOrderEstimateRequest,type CommandAccount,type OrderEstimateRpc} from './command-request';
export interface SavedEstimateAction {action:EstimateAction;closeRequested:boolean;outcome:EstimateOutcome|null}
interface Journal {v:1;actions:SavedEstimateAction[]}
const bad=()=>new CommandRequestError('review');
export function createOrderEstimateSession(config:CloudConnection,account:CommandAccount,scope:EstimateScope,deps:{storage:KeyStorage;assertScope:()=>Promise<void>;assertDraftAccount:()=>void;locks?:Pick<LockManager,'request'>;send?:typeof fetch}){
 const key=['mise.order-estimates.v1',account.targetHash,account.accountHash,scope.businessId,scope.outletId,scope.orderId,scope.actorId].join(':'),requests=new Map<OrderEstimateRpc,ReturnType<typeof createOrderEstimateRequest>>();let active=true;
 // A local intent is not server authority. Use the still-current original SDK
 // account locally; every HTTP effect and receipt retains full live verification.
 async function local(){if(!active)throw bad();await deps.assertScope();deps.assertDraftAccount();if(!active)throw bad();return ()=>{if(!active)throw bad();deps.assertDraftAccount();};}
 function saved():Journal {
  try{const raw=deps.storage.getItem(key);if(raw===null)return {v:1,actions:[]};if(raw.length>1000000)throw bad();const v=JSON.parse(raw);if(!v||Object.keys(v).sort().join(',')!=='actions,v'||v.v!==1||!Array.isArray(v.actions)||v.actions.length>200)throw bad();
   const actions:SavedEstimateAction[]=v.actions.map((value:unknown)=>{if(!value||typeof value!=='object'||Object.keys(value).sort().join(',')!=='action,closeRequested,outcome')throw bad();const p=value as Record<string,unknown>,action=parseEstimateAction(p.action);if(action.orderId!==scope.orderId||typeof p.closeRequested!=='boolean')throw bad();return {action,closeRequested:p.closeRequested,outcome:p.outcome===null?null:parseEstimateOutcome(p.outcome,action)};});
   if(new Set(actions.map(a=>a.action.id)).size!==actions.length||actions.slice(0,-1).some(a=>!a.outcome||a.outcome.state==='pending'))throw bad();return {v:1,actions};
  }catch{throw bad();}
 }
 async function persist(before:Journal,next:Journal,proof?:object){const guard=await local();if(proof)assertLiveCommandReceipt(proof);const raw=JSON.stringify(next);if(raw.length>1000000||JSON.stringify(saved())!==JSON.stringify(before))throw bad();guard();try{deps.storage.setItem(key,raw);if(deps.storage.getItem(key)!==raw)throw bad();}catch{throw bad();}guard();if(proof)assertLiveCommandReceipt(proof);}
 async function request<T extends object>(rpc:OrderEstimateRpc,body:Record<string,unknown>,parse:(v:unknown)=>T,signal?:AbortSignal){await local();let send=requests.get(rpc);if(!send){send=createOrderEstimateRequest(config,account,rpc,deps.send??fetch);requests.set(rpc,send);}const response=await send(JSON.stringify(body),{'Content-Type':'application/json'},20000,signal);response.guard();let value:T;try{value=parse(response.value);}catch{throw bad();}const guard=await local();response.guard();return bindCommandReceipt(value,()=>{response.guard();guard();});}
 const exclusive=<T>(run:()=>Promise<T>)=>{const locks=deps.locks??globalThis.navigator?.locks;if(!locks)throw bad();return locks.request(key,{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock)throw new CommandRequestError('retry');await local();return run();});};
 async function read(signal?:AbortSignal){return request('read_order_estimate',{p_order_id:scope.orderId},v=>parseEstimateContext(v,scope),signal);}
 async function prepare(value:EstimateChange,context:EstimateContext){return exclusive(async()=>{assertLiveCommandReceipt(context);parseEstimateContext(context,scope);const before=saved();if(before.actions.length>=200||before.actions.some(a=>!a.outcome||a.outcome.state==='pending'))throw bad();const action=parseEstimateAction({v:1,id:newInboxId(),orderId:scope.orderId,orderRevision:context.orderRevision,revision:context.estimate?.revision??0,change:parseEstimateChange(value)});await persist(before,{v:1,actions:[...before.actions,{action,closeRequested:false,outcome:null}]},context);return action;});}
 async function call(id:string,operation:'submit'|'inspect'|'close',signal?:AbortSignal){return exclusive(async()=>{
  let before=saved(),original=before.actions.at(-1);if(!original||original.action.id!==id||operation==='submit'&&(original.closeRequested||original.outcome?.state==='closed'))throw bad();
  if(operation==='close'&&!original.closeRequested){const next=structuredClone(before);next.actions.at(-1)!.closeRequested=true;await persist(before,next);before=next;original=next.actions.at(-1)!;}
  const action=original.action,outcome=await request('change_order_estimate',{p_order_id:action.orderId,p_action_id:action.id,p_order_revision:action.orderRevision,p_estimate_revision:action.revision,p_change:action.change,p_operation:operation},v=>parseEstimateOutcome(v,action),signal);
  if(original.outcome&&original.outcome.state!=='pending'&&JSON.stringify(outcome)!==JSON.stringify(original.outcome))throw bad();
  const next=structuredClone(before);next.actions.at(-1)!.outcome=outcome;await persist(before,next,outcome);return outcome;
 });}
 return {key,saved,read,prepare,call,assertCurrent:local,stop(){active=false;}};
}
export type OrderEstimateSession=ReturnType<typeof createOrderEstimateSession>;
