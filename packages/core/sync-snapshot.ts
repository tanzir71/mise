/** PostgreSQL top-level transaction visibility, never an authorization decision.
 * A largest row ID or timestamp alone can skip a transaction that commits late.
 * Keep xid8 values as decimal strings/BigInt; JavaScript numbers lose precision.
 */
export interface SyncSnapshot {readonly text:string;readonly xmin:bigint;readonly xmax:bigint;readonly inProgress:readonly bigint[]}
const maximum=(1n<<64n)-1n;
function xid(value:unknown):bigint {
 if(typeof value!=='string'||!/^(?:0|[1-9][0-9]{0,19})$/.test(value))throw new Error('Keep the original transaction cursor.');
 const parsed=BigInt(value);if(parsed>maximum)throw new Error('The transaction cursor is out of range.');return parsed;
}
export function parseSyncSnapshot(value:unknown):SyncSnapshot {
 if(typeof value!=='string'||value.length>65536||!/^\d+:\d+:(?:\d+(?:,\d+)*)?$/.test(value))throw new Error('Keep the complete sync snapshot.');
 const [low,high,pending]=value.split(':'),xmin=xid(low),xmax=xid(high),inProgress=pending?pending.split(',').map(xid):[];
 if(xmin===0n||xmax===0n||xmin>xmax||inProgress.some((v,i)=>v<xmin||v>=xmax||i>0&&v<=inProgress[i-1]))throw new Error('The sync snapshot bounds or transaction order changed.');
 return Object.freeze({text:value,xmin,xmax,inProgress:Object.freeze(inProgress)});
}
function visible(transaction:bigint,snapshot:SyncSnapshot):boolean {
 return transaction<snapshot.xmin||transaction<snapshot.xmax&&!snapshot.inProgress.includes(transaction);
}
/** Match pg_visible_in_snapshot for top-level xids, including pending commits. */
export function syncTransactionVisible(transaction:unknown,snapshot:unknown):boolean {return visible(xid(transaction),parseSyncSnapshot(snapshot));}
/** A new snapshot must preserve every transaction already observed as complete. */
export function syncSnapshotDelta(transaction:unknown,previous:unknown|null,current:unknown):boolean {
 const next=parseSyncSnapshot(current),before=previous===null?null:parseSyncSnapshot(previous),id=xid(transaction);
 if(before&&(next.xmin<before.xmin||next.xmax<before.xmax||next.inProgress.some(value=>visible(value,before))))throw new Error('The sync snapshot moved backwards. Keep the last accepted cursor.');
 return visible(id,next)&&(!before||!visible(id,before));
}
