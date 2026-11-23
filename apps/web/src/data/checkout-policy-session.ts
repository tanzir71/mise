import type {CloudConnection,KeyStorage} from '@mise/core/cloud-connection';
import {newInboxId} from '@mise/core/inbox';
import {parseCheckoutPolicyAction,parseCheckoutPolicyContext,parseCheckoutPolicyOutcome,type CheckoutPolicyAction,type CheckoutPolicyContext,type CheckoutPolicyOutcome,type CheckoutPolicyScope} from '@mise/core/checkout-policy';
import type {CheckoutWallet} from '@mise/core/order-confirmation';
import {assertLiveCommandReceipt,bindCommandReceipt,CommandRequestError,createCheckoutPolicyRequest,type CheckoutPolicyRpc,type CommandAccount} from './command-request';
export interface SavedCheckoutPolicyAction {action:CheckoutPolicyAction;closeRequested:boolean;outcome:CheckoutPolicyOutcome|null}
interface Journal {v:1;actions:SavedCheckoutPolicyAction[]}
export type CheckoutPolicyChange={kind:'wallets';wallets:CheckoutWallet[]}|{kind:'credit';enabled:boolean;maximum:number};
const bad=()=>new CommandRequestError('review');
export function createCheckoutPolicySession(config:CloudConnection,account:CommandAccount,scope:CheckoutPolicyScope,deps:{storage:KeyStorage;assertScope:()=>Promise<void>;assertDraftAccount:()=>void;locks?:Pick<LockManager,'request'>;send?:typeof fetch}){
 const key=['mise.checkout-policy.v1',account.targetHash,account.accountHash,scope.businessId,scope.outletId,scope.orderId??'wallets',scope.actorId].join(':'),requests=new Map<CheckoutPolicyRpc,ReturnType<typeof createCheckoutPolicyRequest>>();let active=true;
 async function local(){if(!active)throw bad();await deps.assertScope();deps.assertDraftAccount();if(!active)throw bad();return ()=>{if(!active)throw bad();deps.assertDraftAccount();};}
 function saved():Journal{
  try{const raw=deps.storage.getItem(key);if(raw===null)return {v:1,actions:[]};if(raw.length>1000000)throw bad();const value=JSON.parse(raw);if(!value||Object.keys(value).sort().join(',')!=='actions,v'||value.v!==1||!Array.isArray(value.actions)||value.actions.length>200)throw bad();
   const actions:SavedCheckoutPolicyAction[]=value.actions.map((v:unknown)=>{if(!v||typeof v!=='object'||Object.keys(v).sort().join(',')!=='action,closeRequested,outcome')throw bad();const row=v as Record<string,unknown>,action=parseCheckoutPolicyAction(row.action);if(action.orderId!==scope.orderId||typeof row.closeRequested!=='boolean')throw bad();return {action,closeRequested:row.closeRequested,outcome:row.outcome===null?null:parseCheckoutPolicyOutcome(row.outcome,action)};});
   if(new Set(actions.map(a=>a.action.id)).size!==actions.length||actions.slice(0,-1).some(a=>!a.outcome||a.outcome.state==='pending'))throw bad();return {v:1,actions};
  }catch{throw bad();}
 }
 async function persist(before:Journal,next:Journal,proof?:object){const guard=await local();if(proof)assertLiveCommandReceipt(proof);const raw=JSON.stringify(next);if(raw.length>1000000||JSON.stringify(saved())!==JSON.stringify(before))throw bad();guard();try{deps.storage.setItem(key,raw);if(deps.storage.getItem(key)!==raw)throw bad();}catch{throw bad();}guard();if(proof)assertLiveCommandReceipt(proof);}
 async function request<T extends object>(rpc:CheckoutPolicyRpc,body:Record<string,unknown>,parse:(v:unknown)=>T,signal?:AbortSignal){await local();let send=requests.get(rpc);if(!send){send=createCheckoutPolicyRequest(config,account,rpc,deps.send??fetch);requests.set(rpc,send);}const response=await send(JSON.stringify(body),{'Content-Type':'application/json'},20000,signal);response.guard();let value:T;try{value=parse(response.value);}catch{throw bad();}const guard=await local();response.guard();return bindCommandReceipt(value,()=>{response.guard();guard();});}
 const exclusive=<T>(run:()=>Promise<T>)=>{const locks=deps.locks??globalThis.navigator?.locks;if(!locks)throw bad();return locks.request(key,{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock)throw new CommandRequestError('retry');await local();return run();});};
 async function read(signal?:AbortSignal){return request('read_checkout_policy',{p_outlet_id:scope.outletId,p_order_id:scope.orderId},v=>parseCheckoutPolicyContext(v,scope),signal);}
 async function prepare(change:CheckoutPolicyChange,context:CheckoutPolicyContext){return exclusive(async()=>{
  assertLiveCommandReceipt(context);parseCheckoutPolicyContext(context,scope);const before=saved();if(before.actions.length>=200||before.actions.some(a=>!a.outcome||a.outcome.state==='pending')||(change.kind==='credit')!==(scope.orderId!==null))throw bad();
  const action=parseCheckoutPolicyAction(change.kind==='wallets'?{v:1,id:newInboxId(),kind:'wallets',revision:context.settings.revision,orderId:null,orderRevision:null,wallets:change.wallets,enabled:null,maximum:null}:{v:1,id:newInboxId(),kind:'credit',revision:context.order?.credit.revision,orderId:scope.orderId,orderRevision:context.order?.revision,wallets:null,enabled:change.enabled,maximum:change.maximum});
  await persist(before,{v:1,actions:[...before.actions,{action,closeRequested:false,outcome:null}]},context);return action;
 });}
 async function call(id:string,operation:'submit'|'inspect'|'close',signal?:AbortSignal){return exclusive(async()=>{
  let before=saved(),original=before.actions.at(-1);if(!original||original.action.id!==id)throw bad();
  if(operation==='close'&&!original.closeRequested){const next=structuredClone(before);next.actions.at(-1)!.closeRequested=true;await persist(before,next);before=next;original=next.actions.at(-1)!;}
  const action=original.action,effect=original.closeRequested&&operation==='submit'?'close':operation,outcome=await request('change_checkout_policy',{p_outlet_id:scope.outletId,p_action:action,p_operation:effect},v=>parseCheckoutPolicyOutcome(v,action),signal);
  if(original.outcome&&original.outcome.state!=='pending'&&JSON.stringify(outcome)!==JSON.stringify(original.outcome))throw bad();const next=structuredClone(before);next.actions.at(-1)!.outcome=outcome;await persist(before,next,outcome);return outcome;
 });}
 return {key,saved,read,prepare,call,assertCurrent:local,stop(){active=false;}};
}
export type CheckoutPolicySession=ReturnType<typeof createCheckoutPolicySession>;
