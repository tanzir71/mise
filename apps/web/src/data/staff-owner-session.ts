import type {CloudConnection,KeyStorage} from '@mise/core/cloud-connection';
import {newInboxId} from '@mise/core/inbox';
import {saveStaffMember,type StaffDraft,type StaffScope} from '@mise/core/staff';
import {attendanceCommand,manualAttendanceContext,type CheckInType} from '@mise/core/staff-attendance';
import {parseStaffBoardPage,parseStaffOwnerAction,parseStaffOwnerContext,parseStaffOwnerOutcome,type StaffOwnerAction,type StaffOwnerContext,type StaffOwnerOutcome} from '@mise/core/staff-protocol';
import {assertLiveCommandReceipt,bindCommandReceipt,CommandRequestError,createStaffOwnerRequest,type CommandAccount,type StaffOwnerRpc} from './command-request';

export interface SavedStaffAction {action:StaffOwnerAction;closeRequested:boolean;outcome:StaffOwnerOutcome|null}
interface Journal {v:1;actions:SavedStaffAction[]}
export type StaffOwnerChange={kind:'save';draft:StaffDraft}|{kind:'check-in';type:CheckInType;occurredAt:number};
const bad=()=>new CommandRequestError('review'),maximum=8*1024*1024,bytes=(raw:string)=>new TextEncoder().encode(raw).byteLength;

export function createStaffOwnerSession(config:CloudConnection,account:CommandAccount,scope:StaffScope,deps:{storage:KeyStorage;assertScope:()=>Promise<void>;assertDraftAccount:()=>void;locks?:Pick<LockManager,'request'>;send?:typeof fetch}){
 const key=['mise.staff-owner.v1',account.targetHash,account.accountHash,scope.businessId,scope.outletId,scope.actorId].join(':'),requests=new Map<StaffOwnerRpc,ReturnType<typeof createStaffOwnerRequest>>();let active=true;
 const sameScope=(value:StaffScope)=>value.businessId===scope.businessId&&value.outletId===scope.outletId&&value.actorId===scope.actorId&&value.actorRole===scope.actorRole;
 async function local(){if(!active)throw bad();await deps.assertScope();deps.assertDraftAccount();if(!active)throw bad();return ()=>{if(!active)throw bad();deps.assertDraftAccount();};}
 function saved():Journal {
  try{
   const raw=deps.storage.getItem(key);if(raw===null)return {v:1,actions:[]};if(bytes(raw)>maximum)throw bad();
   const value=JSON.parse(raw);if(!value||Object.keys(value).sort().join(',')!=='actions,v'||value.v!==1||!Array.isArray(value.actions)||value.actions.length>200)throw bad();
   const actions:SavedStaffAction[]=value.actions.map((v:unknown)=>{
    if(!v||typeof v!=='object'||Object.keys(v).sort().join(',')!=='action,closeRequested,outcome')throw bad();
    const row=v as Record<string,unknown>,action=parseStaffOwnerAction(row.action);if(!sameScope(action)||typeof row.closeRequested!=='boolean')throw bad();
    return {action,closeRequested:row.closeRequested,outcome:row.outcome===null?null:parseStaffOwnerOutcome(row.outcome,action)};
   });
   if(new Set(actions.map(a=>a.action.id)).size!==actions.length||actions.slice(0,-1).some(a=>!a.outcome||a.outcome.state==='pending'))throw bad();
   return {v:1,actions};
  }catch{throw bad();}
 }
 async function persist(before:Journal,next:Journal,proof?:object){
  const guard=await local();if(proof)assertLiveCommandReceipt(proof);const raw=JSON.stringify(next);
  if(bytes(raw)>maximum||JSON.stringify(saved())!==JSON.stringify(before))throw bad();guard();
  try{deps.storage.setItem(key,raw);if(deps.storage.getItem(key)!==raw)throw bad();}catch{throw bad();}
  guard();if(proof)assertLiveCommandReceipt(proof);
 }
 async function request<T extends object>(rpc:StaffOwnerRpc,body:Record<string,unknown>,parse:(value:unknown)=>T,signal?:AbortSignal){
  await local();let send=requests.get(rpc);if(!send){send=createStaffOwnerRequest(config,account,rpc,deps.send??fetch);requests.set(rpc,send);}
  const response=await send(JSON.stringify(body),{'Content-Type':'application/json'},20000,signal);response.guard();
  let value:T;try{value=parse(response.value);}catch{throw bad();}const guard=await local();response.guard();
  return bindCommandReceipt(value,()=>{response.guard();guard();});
 }
 const exclusive=<T>(run:()=>Promise<T>)=>{const locks=deps.locks??globalThis.navigator?.locks;if(!locks)throw bad();return locks.request(key,{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock)throw new CommandRequestError('retry');await local();return run();});};
 async function read(memberId:string,signal?:AbortSignal){return request('read_staff_context',{p_outlet_id:scope.outletId,p_member_id:memberId},v=>parseStaffOwnerContext(v,scope,memberId),signal);}
 async function page(after:string|null=null,limit=40,signal?:AbortSignal){return request('read_staff_board',{p_outlet_id:scope.outletId,p_after:after,p_page_size:limit},v=>parseStaffBoardPage(v,scope,after,limit),signal);}
 async function prepare(change:StaffOwnerChange,context:StaffOwnerContext){return exclusive(async()=>{
  assertLiveCommandReceipt(context);parseStaffOwnerContext(context,scope,context.memberId);const before=saved();
  if(before.actions.length>=200||before.actions.some(a=>!a.outcome||a.outcome.state==='pending'))throw bad();
  const id=newInboxId(),eventId=newInboxId(),memberId=context.memberId;
  const checkIn=change.kind==='check-in'?{v:1 as const,id:newInboxId(),eventId,memberId,outletId:scope.outletId,type:change.type,occurredAt:change.occurredAt,expectedLastId:context.latest?.id??null}:null;
  const action=parseStaffOwnerAction({...scope,v:1,id,eventId,memberId,kind:change.kind,expected:context.current,
   latest:change.kind==='check-in'?context.latest:null,draft:change.kind==='save'?change.draft:null,checkIn});
  if(action.kind==='save')saveStaffMember(action.draft!,{...scope,current:context.current,serverAt:context.serverAt},{memberId,eventId});
  else{if(!context.current||!checkIn)throw bad();attendanceCommand(checkIn,manualAttendanceContext(scope,context.current,context.latest,context.serverAt));}
  await persist(before,{v:1,actions:[...before.actions,{action,closeRequested:false,outcome:null}]},context);return action;
 });}
 async function call(id:string,operation:'submit'|'inspect'|'close',signal?:AbortSignal){return exclusive(async()=>{
  let before=saved(),original=before.actions.at(-1);if(!original||original.action.id!==id)throw bad();
  if(operation==='close'&&!original.closeRequested){const next=structuredClone(before);next.actions.at(-1)!.closeRequested=true;await persist(before,next);before=next;original=next.actions.at(-1)!;}
  const action=original.action,effect=original.closeRequested&&operation==='submit'?'close':operation;
  const outcome=await request('change_staff_action',{p_outlet_id:scope.outletId,p_action_json:JSON.stringify(action),p_operation:effect},v=>parseStaffOwnerOutcome(v,action),signal);
  if(original.outcome&&original.outcome.state!=='pending'&&JSON.stringify(outcome)!==JSON.stringify(original.outcome))throw bad();
  const next=structuredClone(before);next.actions.at(-1)!.outcome=outcome;await persist(before,next,outcome);return outcome;
 });}
 return {key,saved,read,page,prepare,call,assertCurrent:local,stop(){active=false;}};
}
export type StaffOwnerSession=ReturnType<typeof createStaffOwnerSession>;
