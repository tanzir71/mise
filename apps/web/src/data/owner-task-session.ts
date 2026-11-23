import type {CloudConnection,KeyStorage} from '@mise/core/cloud-connection';
import {parseDeskPushContext,type DeskPushContext} from '@mise/core/desk-push';
import {createOwnerTaskIntent,changeOwnerTaskIntent,parseOwnerTask,parseOwnerTaskPage,parseOwnerTaskReceipt,type OwnerTask,type OwnerTaskAction,type OwnerTaskPage} from '@mise/core/owner-tasks';
import {createOwnerTaskRequest,bindCommandReceipt,assertLiveCommandReceipt,CommandRequestError,type CommandAccount,type OwnerTaskRpc} from './command-request';
import {ownerTaskJournalKey,parseOwnerTaskJournal,ownerTaskJournalMaximum,ownerTaskJournalBytes,type OwnerTaskJournal as Journal} from './owner-task-journal';
export type {SavedOwnerTask} from './owner-task-journal';
import {createOwnerTaskArchives} from './owner-task-archive';
const bad=()=>new CommandRequestError('review'),maximum=ownerTaskJournalMaximum,bytes=ownerTaskJournalBytes;
export function createOwnerTaskSession(config:CloudConnection,account:CommandAccount,context:DeskPushContext,deps:{storage:KeyStorage;assertScope:()=>Promise<void>;assertDraftAccount:()=>void;locks?:Pick<LockManager,'request'>;send?:typeof fetch}){
 const scope=parseDeskPushContext(context),key=ownerTaskJournalKey(account,scope),requests=new Map<OwnerTaskRpc,ReturnType<typeof createOwnerTaskRequest>>(),controller=new AbortController(),listeners=new Set<()=>void>();let active=true;
 function current(){if(!active)throw new CommandRequestError('auth');deps.assertDraftAccount();}
 async function local(){current();await deps.assertScope();current();return current;}
 function saved():Journal {current();return parseOwnerTaskJournal(deps.storage.getItem(key),scope);}
 async function persist(before:Journal,next:Journal,proof?:object){
  await local();if(proof)assertLiveCommandReceipt(proof);const raw=JSON.stringify(next);if(bytes(raw)>maximum||JSON.stringify(saved())!==JSON.stringify(before))throw bad();current();
  try{deps.storage.setItem(key,raw);if(deps.storage.getItem(key)!==raw)throw bad();}catch{throw bad();}await local();if(proof)assertLiveCommandReceipt(proof);for(const listener of listeners)listener();
 }
 const exclusive=async<T>(run:()=>Promise<T>):Promise<T>=>{const locks=deps.locks??globalThis.navigator?.locks;if(!locks)throw bad();return await locks.request(key,{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock)throw new CommandRequestError('retry');await local();return run();});};
 async function request<T extends object>(rpc:OwnerTaskRpc,body:Record<string,unknown>,parse:(v:unknown)=>T,signal?:AbortSignal){
  await local();let send=requests.get(rpc);if(!send){send=createOwnerTaskRequest(config,account,rpc,deps.send??fetch);requests.set(rpc,send);}const response=await send(JSON.stringify(body),{'Content-Type':'application/json'},20000,signal?AbortSignal.any([controller.signal,signal]):controller.signal);
  response.guard();let result:T;try{result=parse(response.value);}catch{throw bad();}await local();response.guard();const image=JSON.stringify(result);
  return bindCommandReceipt(result,()=>{current();response.guard();if(JSON.stringify(result)!==image)throw bad();});
 }
 async function read(filter:'active'|'resolved'='active',signal?:AbortSignal):Promise<OwnerTaskPage>{
  if(!['active','resolved'].includes(filter))throw bad();const proofs:OwnerTaskPage[]=[],tasks:OwnerTask[]=[];let after:OwnerTaskPage['next']=null,version:number|null=null,first:OwnerTaskPage|null=null;
  for(;;){const page:OwnerTaskPage=await request('read_owner_task_page',{p_outlet_id:scope.outletId,p_filter:filter,p_after_at:after?.sortAt??null,p_after_id:after?.id??null,p_version:version,p_limit:50},v=>parseOwnerTaskPage(v,scope,{filter,after,version}),signal);assertLiveCommandReceipt(page);proofs.push(page);
   if(first&&JSON.stringify(first.counts)!==JSON.stringify(page.counts))throw bad();first??=page;version=page.version;tasks.push(...page.tasks);
   if(tasks.length>first.counts.total||bytes(JSON.stringify(tasks))>maximum||new Set(tasks.map(t=>t.id)).size!==tasks.length||page.next!==null&&!page.tasks.length)throw bad();
   after=page.next;if(after===null)break;
  }
  if(!first||tasks.length!==first.counts.total||tasks.filter(t=>t.urgent).length!==first.counts.urgent||(['question','failure','chat','check'] as const).some(kind=>tasks.filter(t=>t.kind===kind).length!==first!.counts[kind]))throw bad();
  const guard=()=>{current();for(const proof of proofs)assertLiveCommandReceipt(proof);};guard();
  for(const task of tasks){const image=JSON.stringify(task);bindCommandReceipt(task,()=>{guard();if(JSON.stringify(task)!==image)throw bad();});}
  const result:OwnerTaskPage={...first,tasks,next:null},image=JSON.stringify(result);return bindCommandReceipt(result,()=>{guard();if(JSON.stringify(result)!==image)throw bad();});
 }
 async function prepareCreate(draft:Parameters<typeof createOwnerTaskIntent>[1]){return exclusive(async()=>{const before=saved();if(before.actions.length>=200||before.actions.some(a=>!a.receipt||a.receipt.state==='pending'))throw bad();const intent=createOwnerTaskIntent(scope,draft);await persist(before,{v:1,actions:[...before.actions,{intent,closeRequested:false,receipt:null}]});return intent;});}
 async function prepare(task:OwnerTask,action:OwnerTaskAction,reply=''){return exclusive(async()=>{
  assertLiveCommandReceipt(task);parseOwnerTask(task,scope);const before=saved();if(before.actions.length>=200||before.actions.some(a=>!a.receipt||a.receipt.state==='pending'))throw bad();const intent=changeOwnerTaskIntent(scope,task,action,reply);await persist(before,{v:1,actions:[...before.actions,{intent,closeRequested:false,receipt:null}]},task);return intent;
 });}
 async function call(id:string,operation:'submit'|'inspect'|'close',signal?:AbortSignal){return exclusive(async()=>{
  if(!['submit','inspect','close'].includes(operation))throw bad();let before=saved(),row=before.actions.at(-1);if(!row||row.intent.id!==id)throw bad();
  if(operation==='close'&&!row.closeRequested){const next=structuredClone(before);next.actions.at(-1)!.closeRequested=true;await persist(before,next);before=next;row=next.actions.at(-1)!;}
  const intent=row.intent,effect=row.closeRequested&&operation==='submit'?'close':operation;if(effect==='submit'&&intent.scope.role!==scope.role)throw bad();
  const receipt=await request('act_owner_task',{p_outlet_id:scope.outletId,p_operation:effect,p_intent_json:JSON.stringify(intent)},v=>parseOwnerTaskReceipt(v,intent),signal);
  if(row.receipt&&row.receipt.state!=='pending'&&JSON.stringify(row.receipt)!==JSON.stringify(receipt))throw bad();const next=structuredClone(before);next.actions.at(-1)!.receipt=receipt;await persist(before,next,receipt);return receipt;
 });}
 const archives=createOwnerTaskArchives({key,current,local,saved,exclusive,persist,inspect:(intent,signal)=>request('act_owner_task',{p_outlet_id:scope.outletId,p_operation:'inspect',p_intent_json:JSON.stringify(intent)},value=>parseOwnerTaskReceipt(value,intent),signal)});
 return {key,saved,read,prepare,prepareCreate,call,...archives,assertCurrent:local,subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},stop(){active=false;controller.abort();listeners.clear();}};
}
export type OwnerTaskSession=ReturnType<typeof createOwnerTaskSession>;
