import {liveStoreFixture} from './live-store-fixture';
import {deviceId} from './device-pairing-fixture';
import {createOwnerTaskIntent,changeOwnerTaskIntent,parseOwnerTaskPage,parseOwnerTaskReceipt,type OwnerTask,type OwnerTaskIntent,type OwnerTaskAction,type OwnerTaskCursor} from '../packages/core/owner-tasks';
import type {DeskPushContext} from '../packages/core/desk-push';
export async function ownerTasksFixture(){
 const f=await liveStoreFixture();
 const scope=(n=1,outlet=11):DeskPushContext=>({v:1,businessId:deviceId(1),outletId:deviceId(outlet),memberId:deviceId(n===1?101:n===2?102:103),role:n===1?'owner':'manager'});
 const readRaw=(n=1,outlet=11,filter:'active'|'resolved'='active',after:OwnerTaskCursor|null=null,version:number|null=null,limit=50)=>f.asRole(n,'authenticated','select public.read_owner_task_page($1,$2,$3,$4,$5,$6) data',[deviceId(outlet),filter,after?.sortAt??null,after?.id??null,version,limit]);
 const read=async(n=1,outlet=11,filter:'active'|'resolved'='active',after:OwnerTaskCursor|null=null,version:number|null=null,limit=50)=>parseOwnerTaskPage(await readRaw(n,outlet,filter,after,version,limit),scope(n,outlet),{filter,after,version,limit});
 const callRaw=(intent:OwnerTaskIntent,operation:'submit'|'inspect'|'close'='submit',n=1)=>f.asRole(n,'authenticated','select public.act_owner_task($1,$2,$3) data',[intent.scope.outletId,operation,JSON.stringify(intent)]);
 const call=async(intent:OwnerTaskIntent,operation:'submit'|'inspect'|'close'='submit',n=1)=>parseOwnerTaskReceipt(await callRaw(intent,operation,n),intent);
 const draft=(patch:Partial<Parameters<typeof createOwnerTaskIntent>[1]>={},n=1,outlet=11)=>createOwnerTaskIntent(scope(n,outlet),{kind:'question',mode:'decision',title:'Can we close early?',body:'A literal request for a person.',...patch});
 const change=(task:OwnerTask,action:OwnerTaskAction,reply='',n=1)=>changeOwnerTaskIntent(scope(n),task,action,reply);
 return {...f,scope,readRaw,read,callRaw,call,draft,change,async seed(){await f.seed();await f.db.exec('truncate private.owner_task_actions');}};
}
