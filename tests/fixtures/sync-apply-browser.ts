import Dexie from 'dexie';
import {MiseDatabase} from '../../apps/web/src/data/db';
import {createOperatorRemote} from '../../apps/web/src/data/operator-remote';
import {selectCloudOperator} from '../../apps/web/src/data/operator-state';
import {joinCanonicalDevice} from '../../apps/web/src/data/cloud-sync-join';
import {applyCanonicalDownload} from '../../apps/web/src/data/cloud-sync-apply';
import {prepareSyncDownload,runSyncDownload} from '../../apps/web/src/data/cloud-sync-journal';
import {downloadSyncImages} from '../../apps/web/src/data/cloud-sync-images';
import {createCloudSyncRemote} from '../../apps/web/src/data/cloud-sync-remote';
import {createCloudImageRemote} from '../../apps/web/src/data/cloud-image-remote';
import {createCloudCoverageRemote} from '../../apps/web/src/data/cloud-coverage-remote';
import {createShopCommandRemote} from '../../apps/web/src/data/shop-command-remote';
import {deliverLocalOutbox} from '../../apps/web/src/data/local-outbox';
import {cloudConnectionTarget} from '../../packages/core/cloud-connection';
import {operatorAccountHash} from '../../packages/core/operators';
import {newInboxId} from '../../packages/core/inbox';
interface Config {apiUrl:string;publishableKey:string;userId:string;jwt:string;businessId:string;outletId:string;actorId:string;stockId:string}
interface Wire {id:'wire';config:Config;scope:string;target:Awaited<ReturnType<typeof target>>;authKey:string;joinId:string;pendingRead:string|null}
class Receiver extends Dexie {wire!:Dexie.Table<Wire,string>;constructor(name:string){super(name);this.version(1).stores({wire:'id'});}}
const connection=(config:Config)=>({apiUrl:config.apiUrl,publishableKey:config.publishableKey});
async function target(config:Config,scope:string,role:'owner'|'manager'){return {businessId:config.businessId,outletId:config.outletId,actorId:config.actorId,accountHash:await operatorAccountHash(config.userId),targetHash:await cloudConnectionTarget(connection(config),scope,config.userId),role};}
async function use<T>(run:(db:MiseDatabase,receiver:Receiver)=>Promise<T>){const base=location.pathname.replace(/\/app\/.*$/,'/app/'),db=new MiseDatabase('mise-local:'+base),receiver=new Receiver('mise-native-sync:'+base);try{return await run(db,receiver);}finally{db.close();receiver.close();}}
function clients(w:Wire){const auth=async()=>({jwt:w.config.jwt,userId:w.config.userId}),c=connection(w.config);return {operator:createOperatorRemote(c,auth),read:createCloudSyncRemote(c,async()=>w.config.jwt),images:createCloudImageRemote(c,w.scope,auth),coverage:createCloudCoverageRemote(c,w.scope,auth),commands:createShopCommandRemote(w.config.apiUrl,w.config.publishableKey,async()=>w.config.jwt)};}
async function wire(receiver:Receiver){const w=await receiver.wire.get('wire');if(!w)throw Error('Initialize native sync first');return w;}
const api={
 initialize:(config:Config)=>use(async(db,receiver)=>{const scope=location.pathname.replace(/\/app\/.*$/,'/app/')+config.businessId,operator=createOperatorRemote(connection(config),async()=>({jwt:config.jwt,userId:config.userId})),page=await operator.list(),context=page.contexts.find(c=>c.businessId===config.businessId&&c.outletId===config.outletId&&c.actorId===config.actorId);if(!context)throw Error('No actual permitted outlet');const t=await target(config,scope,context.role),authKey='mise.cloud.auth.'+t.targetHash;localStorage.setItem(authKey,JSON.stringify({user:{id:config.userId}}));const selected=await selectCloudOperator(db,context,{authKey,targetHash:t.targetHash},null,c=>operator.select(c)),w:Wire={id:'wire',config,scope,target:t,authKey,joinId:newInboxId(),pendingRead:null};await receiver.wire.put(w);const c=clients(w);await prepareSyncDownload(db,{id:w.joinId,target:t,previousCursor:null});await runSyncDownload(db,w.joinId,t,c.read);await downloadSyncImages(db,w.joinId,t,c.images);return joinCanonicalDevice(db,{readId:w.joinId,target:t,authKey,expectedOperatorRevision:selected.revision},context=>operator.select(context));}),
 deliver:()=>use(async(db,receiver)=>{const w=await wire(receiver),c=clients(w);return deliverLocalOutbox(db,w.target.targetHash,command=>c.commands.apply(command));}),
 pull:()=>use(async(db,receiver)=>{const w=await wire(receiver),c=clients(w);if(!w.pendingRead){const base=await db.syncCanonical.get('active');w.pendingRead=newInboxId();await prepareSyncDownload(db,{id:w.pendingRead,target:w.target,previousCursor:base!.snapshot.cursor});await receiver.wire.put(w);}await runSyncDownload(db,w.pendingRead,w.target,c.read);await downloadSyncImages(db,w.pendingRead,w.target,c.images);const selected=(await db.operatorState.get('active'))!,result=await applyCanonicalDownload(db,{readId:w.pendingRead,target:w.target,authKey:w.authKey,expectedOperatorRevision:selected.revision},c.coverage,context=>c.operator.select(context));await receiver.wire.put({...w,pendingRead:null});return result;}),
 stock:(reason:'used'|'received',quantity:number)=>use(async(db,receiver)=>{const w=await wire(receiver),item=(await db.stockItems.get(w.config.stockId))!;return db.adjustStock({id:item.id,revision:item.revision,reason,quantity});}),
 cash:(expression:string)=>use(db=>db.recordSale({expression,method:'cash'})),
 inspect:()=>use(async db=>({backup:await db.readBackup(),queue:await db.outbox.toArray(),binding:await db.cloudState.get('binding'),base:await db.syncCanonical.get('active'),applications:await db.syncApplications.toArray(),operator:await db.operatorState.get('active'),imageSizes:await Promise.all((await db.inboxItems.toArray()).flatMap(item=>item.images.map(async image=>(await image.blob.arrayBuffer()).byteLength)))})),
 quota:()=>use(async(db,receiver)=>{const w=await wire(receiver),base=await db.syncCanonical.get('active');if(!w.pendingRead){w.pendingRead=newInboxId();await prepareSyncDownload(db,{id:w.pendingRead,target:w.target,previousCursor:base!.snapshot.cursor});await receiver.wire.put(w);}const c=clients(w);await runSyncDownload(db,w.pendingRead,w.target,c.read);await downloadSyncImages(db,w.pendingRead,w.target,c.images);const fail=()=>{throw new DOMException('Storage full','QuotaExceededError');};db.syncApplications.hook('creating',fail);try{const operator=(await db.operatorState.get('active'))!;await applyCanonicalDownload(db,{readId:w.pendingRead,target:w.target,authKey:w.authKey,expectedOperatorRevision:operator.revision},c.coverage,context=>c.operator.select(context));return {rejected:false};}catch{return {rejected:true,applications:await db.syncApplications.count(),queue:await db.outbox.count(),base:await db.syncCanonical.get('active')};}finally{db.syncApplications.hook('creating').unsubscribe(fail);}}),
};
declare global {interface Window {miseSyncApplyTest:typeof api}}
window.miseSyncApplyTest=api;
