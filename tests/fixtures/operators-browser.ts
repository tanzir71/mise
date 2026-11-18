import {MiseDatabase} from '../../apps/web/src/data/db';
import {parseLocalOperatorState,operatorAccountHash} from '../../packages/core/operators';
import {readCloudConnection,cloudConnectionTarget} from '../../packages/core/cloud-connection';
import {operatorBackupFixture} from '../operator-backup-fixture';

const api={
 async restoreFixture(){const db=new MiseDatabase('mise-local:'+location.pathname.replace(/\/app\/.*$/,'/app/'));try{const source=operatorBackupFixture();await db.restoreBackup(source,await db.previewRestore(source));}finally{db.close();}},
 async inspect(){const db=new MiseDatabase('mise-local:'+location.pathname.replace(/\/app\/.*$/,'/app/'));try{return {selection:await db.operatorState.get('active'),sales:await db.sales.toArray(),events:await db.events.toArray(),members:await db.members.toArray(),schema:db.verno,stores:db.tables.length};}finally{db.close();}},
 /** Native test only: bind the actual intercepted SDK session to the chosen
  * cached member. This synthetic fixture is not hosted owner HTTP acceptance. */
 async bindInterceptedSession(){
  const db=new MiseDatabase('mise-local:'+location.pathname.replace(/\/app\/.*$/,'/app/'));try{const saved=parseLocalOperatorState(await db.operatorState.get('active')),config=readCloudConnection(localStorage);if(!config)throw Error('Configure the intercepted test connection first.');
   const authKey=Object.keys(localStorage).find(k=>/^mise\.cloud\.auth\.[a-f0-9]{64}$/.test(k)&&JSON.parse(localStorage.getItem(k)!).user?.id);if(!authKey)throw Error('Verify the intercepted test phone first.');
   const session=JSON.parse(localStorage.getItem(authKey)!),accountHash=await operatorAccountHash(session.user.id),targetHash=await cloudConnectionTarget(config,new URL(location.href).pathname.split('/settings/')[0]+'/'+saved.businessId,session.user.id);
   await db.operatorState.put({...saved,revision:saved.revision+1,connection:{authKey,accountHash,targetHash,epoch:'00000000-0000-4000-8000-000000000001',scopeVersion:'00000000-0000-4000-8000-000000000002'}});return {authKey};
  }finally{db.close();}
 },
 async revokeManager(){const db=new MiseDatabase('mise-local:'+location.pathname.replace(/\/app\/.*$/,'/app/'));try{const saved=parseLocalOperatorState(await db.operatorState.get('active'));await db.members.update(saved.actorId,{outletIds:[]});}finally{db.close();}}
};
declare global {interface Window {miseOperatorsTest:typeof api}}
window.miseOperatorsTest=api;
