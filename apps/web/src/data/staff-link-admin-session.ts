import type {CloudConnection,KeyStorage} from '@mise/core/cloud-connection';
import {newInboxId} from '@mise/core/inbox';
import {newDeviceSecret,deviceSecretHash} from '@mise/core/device-access';
import {parseStaffLinkAction,parseStaffLinkContext,parseStaffLinkOutcome,staffToken,type StaffLinkAction,type StaffLinkContext,type StaffLinkOutcome} from '@mise/core/staff-links';
import type {StaffScope} from '@mise/core/staff';
import {assertLiveCommandReceipt,bindCommandReceipt,CommandRequestError,createStaffOwnerRequest,type CommandAccount,type StaffOwnerRpc} from './command-request';
export interface SavedStaffLinkAction {action:StaffLinkAction;token:string|null;closeRequested:boolean;outcome:StaffLinkOutcome|null}
interface Journal {v:1;actions:SavedStaffLinkAction[]}
const bad=()=>new CommandRequestError('review'),bytes=(s:string)=>new TextEncoder().encode(s).byteLength,maximum=8*1024*1024;
export function createStaffLinkAdminSession(config:CloudConnection,account:CommandAccount,scope:StaffScope&{memberId:string},deps:{storage:KeyStorage;assertScope:()=>Promise<void>;assertDraftAccount:()=>void;locks?:Pick<LockManager,'request'>;send?:typeof fetch}){
 const key=['mise.staff-link-admin.v1',account.targetHash,account.accountHash,scope.businessId,scope.outletId,scope.actorId,scope.memberId].join(':'),requests=new Map<StaffOwnerRpc,ReturnType<typeof createStaffOwnerRequest>>();let active=true;
 async function local(){if(!active)throw bad();await deps.assertScope();deps.assertDraftAccount();if(!active)throw bad();return ()=>{if(!active)throw bad();deps.assertDraftAccount();};}
 function saved():Journal {
  try{const raw=deps.storage.getItem(key);if(raw===null)return {v:1,actions:[]};if(bytes(raw)>maximum)throw bad();const v=JSON.parse(raw);
   if(!v||Object.keys(v).sort().join(',')!=='actions,v'||v.v!==1||!Array.isArray(v.actions)||v.actions.length>200)throw bad();
   const actions:SavedStaffLinkAction[]=v.actions.map((value:unknown)=>{if(!value||typeof value!=='object'||Object.keys(value).sort().join(',')!=='action,closeRequested,outcome,token')throw bad();
    const r=value as Record<string,unknown>,action=parseStaffLinkAction(r.action);
    if(action.businessId!==scope.businessId||action.outletId!==scope.outletId||action.actorId!==scope.actorId||action.actorRole!==scope.actorRole||action.memberId!==scope.memberId||typeof r.closeRequested!=='boolean'||
     (action.kind==='issue'?!staffToken(r.token):r.token!==null))throw bad();
    return {action,token:r.token as string|null,closeRequested:r.closeRequested,outcome:r.outcome===null?null:parseStaffLinkOutcome(r.outcome,action)};
   });
   if(new Set(actions.map(r=>r.action.id)).size!==actions.length||actions.slice(0,-1).some(r=>!r.outcome||r.outcome.state==='pending'))throw bad();return {v:1,actions};
  }catch{throw bad();}
 }
 async function persist(before:Journal,next:Journal,proof?:object){const guard=await local();if(proof)assertLiveCommandReceipt(proof);const raw=JSON.stringify(next);
  if(bytes(raw)>maximum||JSON.stringify(saved())!==JSON.stringify(before))throw bad();guard();try{deps.storage.setItem(key,raw);if(deps.storage.getItem(key)!==raw)throw bad();}catch{throw bad();}guard();if(proof)assertLiveCommandReceipt(proof);
 }
 const exclusive=<T>(run:()=>Promise<T>)=>{const locks=deps.locks??globalThis.navigator?.locks;if(!locks)throw bad();return locks.request(key,{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock)throw new CommandRequestError('retry');await local();return run();});};
 async function request<T extends object>(rpc:StaffOwnerRpc,body:Record<string,unknown>,parse:(v:unknown)=>T,signal?:AbortSignal){await local();let send=requests.get(rpc);if(!send){send=createStaffOwnerRequest(config,account,rpc,deps.send??fetch);requests.set(rpc,send);}
  const response=await send(JSON.stringify(body),{'Content-Type':'application/json'},20000,signal);response.guard();let value:T;try{value=parse(response.value);}catch{throw bad();}const guard=await local();response.guard();return bindCommandReceipt(value,()=>{response.guard();guard();});
 }
 async function read(after:string|null=null,signal?:AbortSignal){return request('read_staff_links',{p_outlet_id:scope.outletId,p_member_id:scope.memberId,p_after:after},v=>parseStaffLinkContext(v,scope,scope.memberId,after),signal);}
 async function prepare(kind:'issue'|'revoke',context:StaffLinkContext,options:{days?:number;linkId?:string}={}){return exclusive(async()=>{
  assertLiveCommandReceipt(context);parseStaffLinkContext(context,scope,scope.memberId);const before=saved();
  if(before.actions.length>=200||before.actions.some(r=>!r.outcome||r.outcome.state==='pending'))throw bad();
  const token=kind==='issue'?newDeviceSecret():null,days=options.days??30;
  if(kind==='issue'&&(!Number.isInteger(days)||days<1||days>90)||kind==='revoke'&&!context.links.some(link=>link.id===options.linkId))throw bad();
  const action=parseStaffLinkAction({...scope,v:1,id:newInboxId(),eventId:newInboxId(),linkId:kind==='issue'?newInboxId():options.linkId,kind,
   expected:kind==='issue'?context.current:null,tokenHash:token===null?null:await deviceSecretHash(token),expiresAt:kind==='issue'?context.serverAt+days*86400000:null});
  await persist(before,{v:1,actions:[...before.actions,{action,token,closeRequested:false,outcome:null}]},context);return action;
 });}
 async function call(id:string,operation:'submit'|'inspect'|'close',signal?:AbortSignal){return exclusive(async()=>{
  let before=saved(),original=before.actions.at(-1);if(!original||original.action.id!==id)throw bad();
  if(operation==='close'&&!original.closeRequested){const next=structuredClone(before);next.actions.at(-1)!.closeRequested=true;await persist(before,next);before=next;original=next.actions.at(-1)!;}
  const effect=original.closeRequested&&operation==='submit'?'close':operation,action=original.action;
  const outcome=await request('change_staff_link',{p_outlet_id:scope.outletId,p_action_json:JSON.stringify(action),p_operation:effect},v=>parseStaffLinkOutcome(v,action),signal);
  if(original.outcome&&original.outcome.state!=='pending'&&JSON.stringify(original.outcome)!==JSON.stringify(outcome))throw bad();
  const next=structuredClone(before);next.actions.at(-1)!.outcome=outcome;await persist(before,next,outcome);return outcome;
 });}
 async function originalToken(linkId:string){await local();const row=saved().actions.find(r=>r.action.kind==='issue'&&r.action.linkId===linkId&&r.outcome?.state==='applied');
  if(!row?.token||await deviceSecretHash(row.token)!==row.action.tokenHash)throw bad();await local();return row.token;
 }
 return {key,saved,read,prepare,call,originalToken,assertCurrent:local,stop(){active=false;}};
}
export type StaffLinkAdminSession=ReturnType<typeof createStaffLinkAdminSession>;
