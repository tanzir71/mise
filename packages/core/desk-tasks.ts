import {isDeviceId} from './device-access';
import {parseDeskPushContext,type DeskPushContext} from './desk-push';
import {parseKitchenAlarmSettings,type KitchenAlarmSettings} from './kitchen-alarms';
export interface DeskAlarmSettings extends KitchenAlarmSettings {revision:number}
export interface DeskTaskCursor {dueAt:number;id:string}
export interface DeskAlarmTask {id:string;orderId:string;contentHash:string;sourceRevision:number;generation:number;title:string;body:string;copyText:string;dueAt:number;raisedAt:number;updatedAt:number}
export interface DeskTaskPage {v:1;access:DeskPushContext;at:number;version:number;settings:DeskAlarmSettings;tasks:DeskAlarmTask[];next:DeskTaskCursor|null}
export interface DeskTaskList extends Omit<DeskTaskPage,'next'> {next:null}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const ordinal=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const time=(v:unknown):v is number=>ordinal(v)&&v<=8640000000000000;
const invalid=()=>Error('Keep the complete task list with its original phone account and outlet.');
const compare=(a:DeskTaskCursor,b:DeskTaskCursor)=>a.dueAt===b.dueAt?(a.id===b.id?0:a.id<b.id?-1:1):a.dueAt<b.dueAt?-1:1;
function textJson(value:unknown):string {
 if(typeof value!=='string'||value.length>32768)throw invalid();const result:unknown=JSON.parse(value);if(typeof result!=='string')throw invalid();return result;
}
export function parseDeskAlarmSettings(value:unknown):DeskAlarmSettings {
 if(!object(value)||!exact(value,'enabled,minutes,revision')||!ordinal(value.revision))throw invalid();
 return {...parseKitchenAlarmSettings({enabled:value.enabled,minutes:value.minutes}),revision:value.revision};
}
export function parseDeskTaskCursor(value:unknown):DeskTaskCursor|null {
 if(value===null)return null;if(!object(value)||!exact(value,'dueAt,id')||!time(value.dueAt)||!isDeviceId(value.id))throw invalid();return {dueAt:value.dueAt,id:value.id};
}
function task(value:unknown):DeskAlarmTask {
 if(!object(value)||!exact(value,'id,orderId,contentHash,sourceRevision,generation,titleJson,bodyJson,actionsJson,dueAt,raisedAt,updatedAt')||
  !isDeviceId(value.id)||!isDeviceId(value.orderId)||typeof value.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(value.contentHash)||
  !ordinal(value.sourceRevision)||value.sourceRevision<1||!ordinal(value.generation)||value.generation<1||![value.dueAt,value.raisedAt,value.updatedAt].every(time)||
  (value.dueAt as number)>(value.raisedAt as number)||(value.raisedAt as number)>(value.updatedAt as number)||typeof value.actionsJson!=='string'||value.actionsJson.length>32768)throw invalid();
 const actions:unknown=JSON.parse(value.actionsJson);
 if(!Array.isArray(actions)||actions.length!==2)throw invalid();
 const open=actions.find(v=>object(v)&&v.kind==='open-order'),copy=actions.find(v=>object(v)&&v.kind==='copy');
 if(!object(open)||!exact(open,'kind,orderId')||open.orderId!==value.orderId||!object(copy)||!exact(copy,'kind,text')||typeof copy.text!=='string'||copy.text.length>32768)throw invalid();
 return {id:value.id,orderId:value.orderId,contentHash:value.contentHash,sourceRevision:value.sourceRevision,generation:value.generation,
  title:textJson(value.titleJson),body:textJson(value.bodyJson),copyText:copy.text,dueAt:value.dueAt as number,raisedAt:value.raisedAt as number,updatedAt:value.updatedAt as number};
}
/** A page is bound to its actual requested cursor and current phone context.
 * A capped first page can never be passed off as a complete cache replacement. */
export function parseDeskTaskPage(value:unknown,scope:DeskPushContext,after:DeskTaskCursor|null=null,limit=50):DeskTaskPage {
 if(!object(value)||!exact(value,'v,access,at,version,settings,tasks,next')||value.v!==1||!time(value.at)||!ordinal(value.version)||!Array.isArray(value.tasks)||
  !Number.isInteger(limit)||limit<1||value.tasks.length>limit)throw invalid();
 const access=parseDeskPushContext(value.access),expected=parseDeskPushContext(scope);
 if(JSON.stringify(access)!==JSON.stringify(expected))throw invalid();
 const settings=parseDeskAlarmSettings(value.settings),next=parseDeskTaskCursor(value.next),tasks=value.tasks.map(task),ids=new Set<string>(),orders=new Set<string>();let previous=after;
 for(const row of tasks){if(ids.has(row.id)||orders.has(row.orderId)||previous&&compare(previous,row)>=0||row.updatedAt>value.at)throw invalid();ids.add(row.id);orders.add(row.orderId);previous=row;}
 if(after!==null&&!tasks.length||next&&(!tasks.length||compare(next,tasks.at(-1)!)!==0))throw invalid();
 return {v:1,access,at:value.at,version:value.version,settings,tasks,next};
}
export function appendDeskTaskPage(current:DeskTaskPage,page:DeskTaskPage):DeskTaskPage {
 if(current.next===null||current.version!==page.version||JSON.stringify(current.access)!==JSON.stringify(page.access)||JSON.stringify(current.settings)!==JSON.stringify(page.settings)||page.at<current.at||
  page.tasks.length&&compare(current.next,page.tasks[0])>=0)throw invalid();
 const ids=new Set(current.tasks.map(x=>x.id)),orders=new Set(current.tasks.map(x=>x.orderId));
 if(page.tasks.some(x=>ids.has(x.id)||orders.has(x.orderId)))throw invalid();
 return {...page,tasks:[...current.tasks,...page.tasks]};
}
export function completeDeskTaskList(page:DeskTaskPage):DeskTaskList {if(page.next!==null)throw invalid();return {...page,next:null};}
export function deskTaskListWire(list:DeskTaskList){
 return {...list,tasks:list.tasks.map(row=>({id:row.id,orderId:row.orderId,contentHash:row.contentHash,sourceRevision:row.sourceRevision,generation:row.generation,
  titleJson:JSON.stringify(row.title),bodyJson:JSON.stringify(row.body),actionsJson:JSON.stringify([{kind:'open-order',orderId:row.orderId},{kind:'copy',text:row.copyText}]),dueAt:row.dueAt,raisedAt:row.raisedAt,updatedAt:row.updatedAt}))};
}
export function parseDeskTaskList(value:unknown,scope:DeskPushContext):DeskTaskList {
 return completeDeskTaskList(parseDeskTaskPage(value,scope,null,Number.MAX_SAFE_INTEGER));
}
