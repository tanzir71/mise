/** Shop promises have their own revision. Editing prices or status must never
 * silently erase the original deadline used by the customer's delay notice. */
export interface OrderEstimate {revision:number;start:number|null;end:number|null;firstEnd:number|null;note:string;updatedAt:number}
export interface EstimateScope {businessId:string;outletId:string;orderId:string;actorId:string;actorRole:'owner'|'manager'}
export interface EstimateContext extends EstimateScope {v:1;orderRevision:number;status:string;type:'delivery'|'pickup'|'dine_in';estimate:OrderEstimate|null;lastActionId:string|null;serverAt:number}
export interface EstimateChange {kind:'set'|'clear'|'undo';start:number|null;end:number|null;note:string;undoOf:string|null}
export interface EstimateAction {v:1;id:string;orderId:string;orderRevision:number;revision:number;change:EstimateChange}
export interface EstimateOutcome {v:1;action:EstimateAction;state:'pending'|'closed'|'applied';at:number|null;estimate:OrderEstimate|null}
export const estimateId=(v:unknown):v is string=>typeof v==='string'&&/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(v);
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const int=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const time=(v:unknown):v is number=>int(v,0,8640000000000000);
const note=(v:unknown):v is string=>typeof v==='string'&&v===v.trim()&&Array.from(v).length<=300&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
const bad=()=>Error('Review the original arrival estimate before trying again.');
export function parseOrderEstimate(v:unknown):OrderEstimate {
 if(!record(v)||!exact(v,'revision,start,end,firstEnd,note,updatedAt')||!int(v.revision,1)||!time(v.updatedAt)||!note(v.note)||
  v.firstEnd!==null&&!time(v.firstEnd)||(v.start===null)!==(v.end===null)||v.start!==null&&(!time(v.start)||!time(v.end)||v.end<v.start||v.end-v.start>86400000||v.firstEnd===null))throw bad();
 return {revision:v.revision,start:v.start as number|null,end:v.end as number|null,firstEnd:v.firstEnd as number|null,note:v.note,updatedAt:v.updatedAt};
}
export function parseEstimateChange(v:unknown):EstimateChange {
 if(!record(v)||!exact(v,'kind,start,end,note,undoOf')||!['set','clear','undo'].includes(v.kind as string)||!note(v.note))throw bad();
 if(v.kind==='set'? !time(v.start)||!time(v.end)||v.end<v.start||v.end-v.start>86400000||v.undoOf!==null:
  v.start!==null||v.end!==null||(v.kind==='undo'? !estimateId(v.undoOf)||v.note!=='':v.undoOf!==null))throw bad();
 return {kind:v.kind as EstimateChange['kind'],start:v.start as number|null,end:v.end as number|null,note:v.note,undoOf:v.undoOf as string|null};
}
export function parseEstimateAction(v:unknown):EstimateAction {
 if(!record(v)||!exact(v,'v,id,orderId,orderRevision,revision,change')||v.v!==1||!estimateId(v.id)||!estimateId(v.orderId)||v.id===v.orderId||!int(v.orderRevision,1,Number.MAX_SAFE_INTEGER-1)||!int(v.revision,0,Number.MAX_SAFE_INTEGER-1))throw bad();
 return {v:1,id:v.id,orderId:v.orderId,orderRevision:v.orderRevision,revision:v.revision,change:parseEstimateChange(v.change)};
}
export function parseEstimateContext(v:unknown,scope:EstimateScope):EstimateContext {
 if(!record(v)||!exact(v,'v,businessId,outletId,orderId,actorId,actorRole,orderRevision,status,type,estimate,lastActionId,serverAt')||v.v!==1||
  Object.entries(scope).some(([k,value])=>v[k]!==value)||!Object.entries(scope).filter(([k])=>k!=='actorRole').every(([,value])=>estimateId(value))||
  !int(v.orderRevision,1)||typeof v.status!=='string'||!['delivery','pickup','dine_in'].includes(v.type as string)||!time(v.serverAt)||v.lastActionId!==null&&!estimateId(v.lastActionId))throw bad();
 const estimate=v.estimate===null?null:parseOrderEstimate(v.estimate);if((estimate===null)!==(v.lastActionId===null))throw bad();
 return {...scope,v:1,orderRevision:v.orderRevision,status:v.status,type:v.type as EstimateContext['type'],estimate,lastActionId:v.lastActionId as string|null,serverAt:v.serverAt};
}
export function parseEstimateOutcome(v:unknown,original:EstimateAction):EstimateOutcome {
 if(!record(v)||!exact(v,'v,action,state,at,estimate')||v.v!==1||!['pending','closed','applied'].includes(v.state as string)||JSON.stringify(parseEstimateAction(v.action))!==JSON.stringify(original))throw bad();
 const estimate=v.estimate===null?null:parseOrderEstimate(v.estimate);
 if(v.state==='pending'?v.at!==null||estimate!==null:!time(v.at)||v.state==='applied'&&(estimate===null||estimate.revision!==original.revision+1||estimate.updatedAt!==v.at)||v.state==='closed'&&estimate!==null)throw bad();
 return {v:1,action:original,state:v.state as EstimateOutcome['state'],at:v.at as number|null,estimate};
}
export const estimateFinished=(status:string)=>['cancelled','delivered','returned','collected','done'].includes(status);
/** Derive delay only at the successful read time, never from an unchecked clock
 * tick while offline. Moving an estimate later retains the first promise. */
export function estimateDelay(estimate:OrderEstimate|null|undefined,status:string,checkedAt:number):number|null {
 if(!estimate||estimateFinished(status)||estimate.firstEnd===null||!time(checkedAt))return null;
 const deadline=estimate.end===null?estimate.firstEnd:Math.min(estimate.firstEnd,estimate.end);
 return checkedAt<=deadline?null:Math.max(1,Math.floor((checkedAt-deadline)/60000));
}
