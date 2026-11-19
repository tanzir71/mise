import Dexie from 'dexie';
import {MiseDatabase} from '../../apps/web/src/data/db';
import {joinCanonicalDevice,type JoinCanonicalInput} from '../../apps/web/src/data/cloud-sync-join';
import {prepareSyncDownload,runSyncDownload} from '../../apps/web/src/data/cloud-sync-journal';
import {downloadSyncImages} from '../../apps/web/src/data/cloud-sync-images';
import {selectCloudOperator,lockLocalOperator} from '../../apps/web/src/data/operator-state';
import {parseSyncScope} from '../../packages/core/sync-read';
import {syncJoinFixture} from '../sync-join-fixture';
import type {OperatorContext} from '../../packages/core/operators';
type Fixture=Awaited<ReturnType<typeof syncJoinFixture>>;
interface Wire {id:'join';fixture:Fixture;input:JoinCanonicalInput;context:OperatorContext}
class Receiver extends Dexie {wire!:Dexie.Table<Wire,string>;constructor(name:string){super(name);this.version(1).stores({wire:'id'});}}
async function use<T>(run:(db:MiseDatabase,receiver:Receiver)=>Promise<T>){const base=location.pathname.replace(/\/app\/.*$/,'/app/'),db=new MiseDatabase('mise-local:'+base),receiver=new Receiver('mise-join-receiver:'+base);try{return await run(db,receiver);}finally{db.close();receiver.close();}}
async function wire(receiver:Receiver){const w=await receiver.wire.get('join');if(!w)throw Error('Prepare the native join fixture.');return w;}
export const api={
 prepare:(manager=false)=>use(async(db,receiver)=>{
  const fixture=await syncJoinFixture(manager),authKey='mise.cloud.auth.'+'c'.repeat(64),context:OperatorContext={...parseSyncScope(fixture.window),version:1,businessName:null,outletName:null,actorName:null};localStorage.setItem(authKey,JSON.stringify({user:{id:'00000000-0000-4000-8000-000000000001'}}));
  const operator=await selectCloudOperator(db,context,{authKey,targetHash:fixture.target.targetHash},null,async()=>context),input={readId:fixture.window.id,target:fixture.target,authKey,expectedOperatorRevision:operator.revision};
  await receiver.wire.put({id:'join',fixture,input,context});await prepareSyncDownload(db,{id:fixture.window.id,target:fixture.target,previousCursor:null});await runSyncDownload(db,fixture.window.id,fixture.target,{begin:async()=>fixture.window,page:async(_w,i)=>fixture.pages[i]});await downloadSyncImages(db,fixture.window.id,fixture.target,{get:async source=>new Blob([new Uint8Array(fixture.imageBytes).buffer],{type:source.image.type})});return {role:fixture.target.role,actorId:fixture.target.actorId,ownerId:fixture.backup.tables.events[0].actor.id};
 }),
 join:()=>use(async(db,receiver)=>{const w=await wire(receiver);return joinCanonicalDevice(db,w.input,async()=>w.context);}),
 inspect:()=>use(async db=>({binding:await db.cloudState.get('binding'),operator:await db.operatorState.get('active'),base:await db.syncCanonical.get('active'),backup:await db.readBackup(),queue:await db.outbox.toArray(),imageSizes:await Promise.all((await db.inboxItems.toArray()).flatMap(i=>i.images.map(async image=>(await image.blob.arrayBuffer()).byteLength)))})),
 quota:()=>use(async(db,receiver)=>{const w=await wire(receiver),fail=()=>{throw new DOMException('Synthetic quota','QuotaExceededError');};db.syncCanonical.hook('creating',fail);try{await joinCanonicalDevice(db,w.input,async()=>w.context);throw Error('Expected quota rejection.');}catch(error){if(!(error instanceof DOMException)&&!(error instanceof Error))throw error;return {businesses:await db.businesses.count(),fences:await db.cloudState.count(),bases:await db.syncCanonical.count(),phase:(await db.operatorState.get('active'))?.phase,stagedImages:await db.syncImages.count()};}finally{db.syncCanonical.hook('creating').unsubscribe(fail);}}),
 revoke:()=>use(async db=>{const operator=await db.operatorState.get('active');if(!operator)throw Error('Missing original operator.');await lockLocalOperator(db,operator.revision);}),
};
declare global {interface Window {miseSyncJoinTest:typeof api}}
window.miseSyncJoinTest=api;
