import {isDeviceId} from './device-access';
import {parseStaffStockIntent,parseOwnStaffStockOutcome,staffStockIntentHash,type StaffStockIntent,type OwnStaffStockOutcome} from './staff-stock-actions';

export interface StaffStockScope {businessId:string;outletId:string;deviceId:string;memberId:string}
export interface StaffStockReadStatus {sessionId:string;revision:string;denied:boolean}
export interface StaffStockOriginal {intent:StaffStockIntent;intentHash:string;closeRequested:boolean;outcome:OwnStaffStockOutcome|null}
export interface StaffStockJournal {v:1;id:string;revision:string;readStatus:StaffStockReadStatus|null;actions:StaffStockOriginal[]}
export const staffStockOriginalLimit=200;
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const bad=()=>Error('Keep this member’s complete original stock requests on their own screen.');
export function staffStockJournalId(scope:StaffStockScope):string {
 if(!object(scope)||!exact(scope,'businessId,outletId,deviceId,memberId')||!Object.values(scope).every(isDeviceId))throw bad();
 return scope.deviceId+':'+scope.memberId;
}
export async function parseStaffStockJournal(value:unknown,scope:StaffStockScope):Promise<StaffStockJournal> {
 const id=staffStockJournalId(scope);
 if(!object(value)||!exact(value,'v,id,revision,readStatus,actions')||value.v!==1||value.id!==id||!isDeviceId(value.revision)||!Array.isArray(value.actions)||value.actions.length>staffStockOriginalLimit)throw bad();
 const raw=value.readStatus;let readStatus:StaffStockReadStatus|null=null;
 if(raw!==null){if(!object(raw)||!exact(raw,'sessionId,revision,denied')||!isDeviceId(raw.sessionId)||!isDeviceId(raw.revision)||typeof raw.denied!=='boolean')throw bad();readStatus={sessionId:raw.sessionId,revision:raw.revision,denied:raw.denied};}
 const revision=value.revision,originals=value.actions.map(row=>structuredClone(row)),ids=new Set<string>(),actions:StaffStockOriginal[]=[];
 // Each original keeps its existing 50 MiB budget. Do not impose a smaller
 // aggregate limit that would reject one valid imported request or evict history.
 for(const row of originals){
  if(!object(row)||!exact(row,'intent,intentHash,closeRequested,outcome')||typeof row.closeRequested!=='boolean')throw bad();
  const intent=parseStaffStockIntent(row.intent),a=intent.origin,intentHash=await staffStockIntentHash(intent);
  if(a.businessId!==scope.businessId||a.outletId!==scope.outletId||a.deviceId!==scope.deviceId||a.memberId!==scope.memberId||row.intentHash!==intentHash||ids.has(intent.command.id))throw bad();ids.add(intent.command.id);
  actions.push({intent,intentHash,closeRequested:row.closeRequested,outcome:row.outcome===null?null:parseOwnStaffStockOutcome(row.outcome,intent,intentHash)});
 }
 if(actions.slice(0,-1).some(a=>!a.outcome||a.outcome.state==='pending'))throw bad();
 return {v:1,id,revision,readStatus,actions};
}
/** Native writers use this after decoding both records. History is append-only;
 * original source and terminal outcomes cannot be rewritten by a stale tab. */
export function staffStockJournalTransition(before:StaffStockJournal|null,after:StaffStockJournal):{append:boolean;outcome:boolean;restoreRead:boolean} {
 const previous=before?.actions??[];
 if(before&&(before.id!==after.id||before.revision===after.revision)||after.actions.length<previous.length||after.actions.length>previous.length+1)throw bad();
 let outcome=false;
 for(let i=0;i<previous.length;i++){
  const a=previous[i],b=after.actions[i];
  if(JSON.stringify(a.intent)!==JSON.stringify(b.intent)||a.intentHash!==b.intentHash||a.closeRequested&&!b.closeRequested)throw bad();
  if(a.outcome&&a.outcome.state!=='pending'&&JSON.stringify(a.outcome)!==JSON.stringify(b.outcome)||a.outcome&&!b.outcome)throw bad();
  if(JSON.stringify(a.outcome)!==JSON.stringify(b.outcome))outcome=true;
 }
 const append=after.actions.length>previous.length;
 if(append&&(after.actions.at(-1)!.closeRequested||after.actions.at(-1)!.outcome!==null||previous.some(a=>!a.outcome||a.outcome.state==='pending')))throw bad();
 if(before?.readStatus&&after.readStatus===null)throw bad();
 return {append,outcome,restoreRead:after.readStatus!==null&&!after.readStatus.denied&&JSON.stringify(before?.readStatus??null)!==JSON.stringify(after.readStatus)};
}
