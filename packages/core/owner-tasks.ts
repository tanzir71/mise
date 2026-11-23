import {isDeviceId} from './device-access';
import {parseDeskPushContext,type DeskPushContext} from './desk-push';
import {newInboxId} from './inbox';

export type OwnerTaskKind='question'|'failure'|'chat'|'check';
export type OwnerTaskMode='decision'|'message'|'check'|'source';
export type OwnerTaskAction='allow'|'no'|'reply-myself'|'sent'|'fixed'|'reopen'|'undo';
export type OwnerTaskTarget={kind:'customer';customerId:string;accountId:string;entryId:string|null}|{kind:'order';orderId:string}|{kind:'payment';paymentId:string};
/** Literal JSON stays encoded through the wire and native original. This also
 * preserves legacy NUL and surrogate data without PostgreSQL jsonb coercion. */
export interface OwnerTask {
 id:string;businessId:string;outletId:string;kind:OwnerTaskKind;titleJson:string;bodyJson:string;
 status:'open'|'waiting'|'resolved';dueAt:number|null;createdAt:number;updatedAt:number;
 source:'manual'|'khata'|'kitchen'|'payment'|'unknown';mode:OwnerTaskMode;recipient:string|null;
 preparedJson:string;authorJson:string|null;target:OwnerTaskTarget|null;fingerprint:string;
 lastActionId:string|null;undoable:boolean;decision:string|null;replyJson:string|null;urgent:boolean;actions:OwnerTaskAction[];
}
export interface OwnerTaskCursor {sortAt:number;id:string}
export interface OwnerTaskPage {
 v:1;access:DeskPushContext;at:number;version:number;filter:'active'|'resolved';
 counts:{question:number;failure:number;chat:number;check:number;total:number;urgent:number};
 tasks:OwnerTask[];next:OwnerTaskCursor|null;
}
interface TaskOriginal {v:1;id:string;eventId:string;scope:DeskPushContext;at:number}
export interface OwnerTaskCreate extends TaskOriginal {
 type:'create';taskId:string;kind:OwnerTaskKind;mode:Exclude<OwnerTaskMode,'source'>;
 titleJson:string;bodyJson:string;recipient:string|null;preparedJson:string;urgent:boolean;
}
export interface OwnerTaskChange extends TaskOriginal {
 type:'act';task:OwnerTask;action:OwnerTaskAction;replyJson:string;undoOf:string|null;
}
export type OwnerTaskIntent=OwnerTaskCreate|OwnerTaskChange;
export interface OwnerTaskReceipt {
 v:1;state:'pending'|'applied'|'closed';intent:OwnerTaskIntent;at:number|null;before:OwnerTask|null;after:OwnerTask|null;
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const time=(v:unknown):v is number=>integer(v)&&v<=8640000000000000;
const phone=(v:unknown):v is string|null=>v===null||typeof v==='string'&&/^\+[1-9][0-9]{6,14}$/.test(v);
const nullableId=(v:unknown):v is string|null=>v===null||isDeviceId(v);
const kinds:OwnerTaskKind[]=['question','failure','chat','check'];
const actions:OwnerTaskAction[]=['allow','no','reply-myself','sent','fixed','reopen','undo'];
const bad=()=>Error('Keep the complete original task and choice with its phone account and outlet.');
export function ownerTaskText(value:unknown,maximum=16000):string {
 if(typeof value!=='string')throw bad();const text:unknown=JSON.parse(value);
 if(typeof text!=='string'||text.length>maximum)throw bad();return text;
}
function target(value:unknown):OwnerTaskTarget|null {
 if(value===null)return null;if(!object(value))throw bad();
 if(value.kind==='customer'&&exact(value,'kind,customerId,accountId,entryId')&&isDeviceId(value.customerId)&&isDeviceId(value.accountId)&&nullableId(value.entryId))return {kind:'customer',customerId:value.customerId,accountId:value.accountId,entryId:value.entryId};
 if(value.kind==='order'&&exact(value,'kind,orderId')&&isDeviceId(value.orderId))return {kind:'order',orderId:value.orderId};
 if(value.kind==='payment'&&exact(value,'kind,paymentId')&&isDeviceId(value.paymentId))return {kind:'payment',paymentId:value.paymentId};
 throw bad();
}
export function ownerTaskActions(task:Pick<OwnerTask,'source'|'status'|'mode'|'lastActionId'|'undoable'>):OwnerTaskAction[] {
 if(task.mode==='source'||['kitchen','payment','unknown'].includes(task.source))return [];
 const available:OwnerTaskAction[]=task.status==='resolved'?['reopen']:task.mode==='decision'&&task.status==='open'?['allow','no','reply-myself']:task.mode==='check'?['fixed']:['sent'];
 if(task.lastActionId&&task.undoable)available.push('undo');return available;
}
export function parseOwnerTask(value:unknown,scope?:Pick<DeskPushContext,'businessId'|'outletId'>):OwnerTask {
 if(!object(value)||!exact(value,'id,businessId,outletId,kind,titleJson,bodyJson,status,dueAt,createdAt,updatedAt,source,mode,recipient,preparedJson,authorJson,target,fingerprint,lastActionId,undoable,decision,replyJson,urgent,actions')||
  ![value.id,value.businessId,value.outletId].every(isDeviceId)||scope&&(value.businessId!==scope.businessId||value.outletId!==scope.outletId)||
  !kinds.includes(value.kind as OwnerTaskKind)||!['open','waiting','resolved'].includes(value.status as string)||value.dueAt!==null&&!time(value.dueAt)||!time(value.createdAt)||!time(value.updatedAt)||value.updatedAt<value.createdAt||
  !['manual','khata','kitchen','payment','unknown'].includes(value.source as string)||!['decision','message','check','source'].includes(value.mode as string)||!phone(value.recipient)||
  typeof value.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(value.fingerprint)||!nullableId(value.lastActionId)||typeof value.undoable!=='boolean'||value.undoable&&value.lastActionId===null||value.decision!==null&&!['allow','no','reply-myself','sent','fixed','reopen'].includes(value.decision as string)||typeof value.urgent!=='boolean'||!Array.isArray(value.actions)||value.actions.some(a=>!actions.includes(a)))throw bad();
 for(const field of ['titleJson','bodyJson','preparedJson'])ownerTaskText(value[field],field==='titleJson'?200:16000);
 if(value.authorJson!==null)ownerTaskText(value.authorJson,200);if(value.replyJson!==null)ownerTaskText(value.replyJson,4000);
 const expected=ownerTaskActions(value as unknown as OwnerTask);if(JSON.stringify(value.actions)!==JSON.stringify(expected))throw bad();
 const source=value.source as OwnerTask['source'],destination=target(value.target);
 if(source==='khata'&&(destination?.kind!=='customer'||value.mode!=='message')||source==='kitchen'&&(destination?.kind!=='order'||value.mode!=='source')||source==='payment'&&(destination?.kind!=='payment'||value.mode!=='source')||source==='unknown'&&(destination!==null||value.mode!=='source')||source==='manual'&&destination!==null)throw bad();
 return {id:value.id as string,businessId:value.businessId as string,outletId:value.outletId as string,kind:value.kind as OwnerTaskKind,titleJson:value.titleJson as string,bodyJson:value.bodyJson as string,status:value.status as OwnerTask['status'],dueAt:value.dueAt as number|null,createdAt:value.createdAt,updatedAt:value.updatedAt,source,mode:value.mode as OwnerTaskMode,recipient:value.recipient,preparedJson:value.preparedJson as string,authorJson:value.authorJson as string|null,target:destination,fingerprint:value.fingerprint,lastActionId:value.lastActionId,undoable:value.undoable,decision:value.decision as string|null,replyJson:value.replyJson as string|null,urgent:value.urgent,actions:[...expected]};
}
export function parseOwnerTaskIntent(value:unknown):OwnerTaskIntent {
 if(!object(value)||value.v!==1||!['create','act'].includes(value.type as string)||![value.id,value.eventId].every(isDeviceId)||value.id===value.eventId||!time(value.at))throw bad();
 const scope=parseDeskPushContext(value.scope),common={v:1 as const,id:value.id as string,eventId:value.eventId as string,scope,at:value.at};
 if(value.type==='create'){
  if(!exact(value,'v,id,eventId,scope,at,type,taskId,kind,mode,titleJson,bodyJson,recipient,preparedJson,urgent')||!isDeviceId(value.taskId)||[value.id,value.eventId].includes(value.taskId)||!kinds.includes(value.kind as OwnerTaskKind)||!['decision','message','check'].includes(value.mode as string)||!phone(value.recipient)||typeof value.urgent!=='boolean')throw bad();
  if(!ownerTaskText(value.titleJson,200).trim()||!ownerTaskText(value.bodyJson,12000).trim())throw bad();ownerTaskText(value.preparedJson,4000);
  return {...common,type:'create',taskId:value.taskId,kind:value.kind as OwnerTaskKind,mode:value.mode as OwnerTaskCreate['mode'],titleJson:value.titleJson as string,bodyJson:value.bodyJson as string,recipient:value.recipient,preparedJson:value.preparedJson as string,urgent:value.urgent};
 }
 if(!exact(value,'v,id,eventId,scope,at,type,task,action,replyJson,undoOf')||!actions.includes(value.action as OwnerTaskAction)||!nullableId(value.undoOf))throw bad();
 const task=parseOwnerTask(value.task,scope),action=value.action as OwnerTaskAction;ownerTaskText(value.replyJson,4000);
 if(!task.actions.includes(action)||(action==='undo'?value.undoOf!==task.lastActionId:value.undoOf!==null)||(action==='sent'?!ownerTaskText(value.replyJson).trim():ownerTaskText(value.replyJson)!==''))throw bad();
 return {...common,type:'act',task,action,replyJson:value.replyJson as string,undoOf:value.undoOf};
}
export function createOwnerTaskIntent(scope:DeskPushContext,draft:{kind:OwnerTaskKind;mode:OwnerTaskCreate['mode'];title:string;body:string;recipient?:string|null;prepared?:string;urgent?:boolean},at=Date.now()):OwnerTaskCreate {
 return parseOwnerTaskIntent({v:1,id:newInboxId(),eventId:newInboxId(),scope,at,type:'create',taskId:newInboxId(),kind:draft.kind,mode:draft.mode,titleJson:JSON.stringify(draft.title),bodyJson:JSON.stringify(draft.body),recipient:draft.recipient??null,preparedJson:JSON.stringify(draft.prepared??''),urgent:draft.urgent??false}) as OwnerTaskCreate;
}
export function changeOwnerTaskIntent(scope:DeskPushContext,task:OwnerTask,action:OwnerTaskAction,reply='',at=Date.now()):OwnerTaskChange {
 return parseOwnerTaskIntent({v:1,id:newInboxId(),eventId:newInboxId(),scope,at,type:'act',task,action,replyJson:JSON.stringify(reply),undoOf:action==='undo'?task.lastActionId:null}) as OwnerTaskChange;
}
export function parseOwnerTaskReceipt(value:unknown,intent:OwnerTaskIntent):OwnerTaskReceipt {
 const original=parseOwnerTaskIntent(intent);
 if(!object(value)||!exact(value,'v,state,intent,at,before,after')||value.v!==1||!['pending','applied','closed'].includes(value.state as string)||JSON.stringify(parseOwnerTaskIntent(value.intent))!==JSON.stringify(original)||
  (value.state==='pending'?value.at!==null:!time(value.at)))throw bad();
 const before=value.before===null?null:parseOwnerTask(value.before,original.scope),after=value.after===null?null:parseOwnerTask(value.after,original.scope),taskId=original.type==='create'?original.taskId:original.task.id;
 if(value.state==='applied'?after===null||after.id!==taskId||after.lastActionId!==original.id||original.type==='act'&&JSON.stringify(before)!==JSON.stringify(original.task)||original.type==='create'&&before!==null:before!==null||after!==null)throw bad();
 if(value.state==='applied'&&after){
  if(original.type==='create'){
   if(after.source!=='manual'||after.status!=='open'||after.undoable||after.decision!==null||after.replyJson!==null||['kind','mode','titleJson','bodyJson','recipient','preparedJson'].some(key=>after[key as keyof OwnerTask]!==original[key as keyof OwnerTaskCreate]))throw bad();
  }else if(original.action!=='undo'){
   const status=original.action==='reply-myself'?'waiting':original.action==='reopen'?'open':'resolved';
   if(after.status!==status||after.decision!==original.action||!after.undoable||after.replyJson!==(original.action==='sent'?original.replyJson:null))throw bad();
  }
 }
 return {v:1,state:value.state as OwnerTaskReceipt['state'],intent:original,at:value.at as number|null,before,after};
}
export function parseOwnerTaskPage(value:unknown,scope:DeskPushContext,request:{filter:'active'|'resolved';after:OwnerTaskCursor|null;version:number|null;limit?:number}):OwnerTaskPage {
 if(!object(value)||!exact(value,'v,access,at,version,filter,counts,tasks,next')||value.v!==1||JSON.stringify(parseDeskPushContext(value.access))!==JSON.stringify(parseDeskPushContext(scope))||!time(value.at)||!integer(value.version)||request.version!==null&&value.version!==request.version||value.filter!==request.filter||!object(value.counts)||!exact(value.counts,'question,failure,chat,check,total,urgent')||Object.values(value.counts).some(n=>!integer(n))||!Array.isArray(value.tasks)||value.tasks.length>(request.limit??50))throw bad();
 const counts=value.counts as OwnerTaskPage['counts'];if(counts.total!==counts.question+counts.failure+counts.chat+counts.check||counts.urgent>counts.total)throw bad();
 let previous=request.after;const tasks=value.tasks.map(row=>{const parsed=parseOwnerTask(row,scope),sortAt=parsed.dueAt??8640000000000000;if(request.filter==='active'?(parsed.status==='resolved'):parsed.status!=='resolved')throw bad();if(previous&&(sortAt<previous.sortAt||sortAt===previous.sortAt&&parsed.id<=previous.id))throw bad();previous={sortAt,id:parsed.id};return parsed;});
 let next:OwnerTaskCursor|null=null;if(value.next!==null){if(!object(value.next)||!exact(value.next,'sortAt,id')||!time(value.next.sortAt)||!isDeviceId(value.next.id)||tasks.length!==(request.limit??50)||value.next.sortAt!==previous?.sortAt||value.next.id!==previous?.id)throw bad();next={sortAt:value.next.sortAt,id:value.next.id};}
 return {v:1,access:parseDeskPushContext(value.access),at:value.at,version:value.version,filter:request.filter,counts:{...counts},tasks,next};
}
