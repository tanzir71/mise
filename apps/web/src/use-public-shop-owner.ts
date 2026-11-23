import {useEffect,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {readCloudConnection,cloudConnectionTarget,type CloudConnection} from '@mise/core/cloud-connection';
import {operatorAccountHash} from '@mise/core/operators';
import type {SetupSnapshot} from '@mise/core/models';
import type {PublicShopPage} from '@mise/core/public-shop-admin';
import {db} from './data/db';
import {resolveCloudAuthScope} from './data/cloud-auth-scope';
import {getPhoneAuth} from './data/phone-auth';
import {CommandRequestError,type CommandAccount} from './data/command-request';
import {createPublicShopSession,type PublicShopSession} from './data/public-shop-session';
const identity=(s:SetupSnapshot)=>[s.business.id,s.outlet.id,s.owner.id,s.owner.role].join(':');
interface Owner {session:PublicShopSession;config:CloudConnection;page:PublicShopPage;signal:AbortSignal;active:()=>boolean;ticket:string}
export function usePublicShopOwner(setup:SetupSnapshot,online:boolean){
 const selection=useLiveQuery(()=>db.operatorState.get('active')),selectionToken=JSON.stringify(selection??null),context=identity(setup),[version,setVersion]=useState(0),[ready,setReady]=useState<Owner|null>(null),[error,setError]=useState(''),[checking,setChecking]=useState(false),ticket=JSON.stringify([context,selectionToken,version,online]);
 useEffect(()=>{const change=()=>setVersion(v=>v+1);window.addEventListener('storage',change);return()=>window.removeEventListener('storage',change);},[]);
 useEffect(()=>{
  let active=true,session:PublicShopSession|undefined,unsubscribe:(()=>void)|undefined;const controller=new AbortController();setReady(null);setError('');setChecking(true);
  const stop=()=>{active=false;controller.abort();session?.stop();unsubscribe?.();};
  if(!online||!['owner','manager'].includes(setup.owner.role)){setChecking(false);return stop;}
  void(async()=>{
   const config=readCloudConnection(localStorage);if(!config)throw new CommandRequestError('auth');
   const assertLocal=async()=>{if(!active||JSON.stringify(readCloudConnection(localStorage))!==JSON.stringify(config))throw new CommandRequestError('auth');const [fresh,selected]=await Promise.all([db.setup(),db.operatorState.get('active')]);if(!active||!fresh||identity(fresh)!==context||JSON.stringify(selected??null)!==selectionToken)throw new CommandRequestError('review');};
   const scope=await resolveCloudAuthScope(config,import.meta.env.BASE_URL,setup.business.id,selection?.connection?.authKey),manager=await getPhoneAuth(config,scope),original=await manager.commandAuthorization();await assertLocal();
   const [accountHash,targetHash]=await Promise.all([operatorAccountHash(original.userId),cloudConnectionTarget(config,scope,original.userId)]);
   if(selection?.connection&&(selection.connection.authKey!==manager.key||selection.connection.accountHash!==accountHash||selection.connection.targetHash!==targetHash))throw new CommandRequestError('auth');
   const assertCurrent:CommandAccount['assertCurrent']=auth=>{if(!active||auth.userId!==original.userId||auth.generation!==original.generation||JSON.stringify(readCloudConnection(localStorage))!==JSON.stringify(config))throw new CommandRequestError('auth');manager.assertCommandAuthorization(auth);};
   const account:CommandAccount={scope,accountHash,targetHash,getAuth:async()=>{await assertLocal();const auth=await manager.commandAuthorization();assertCurrent(auth);return auth;},assertCurrent};
   session=createPublicShopSession(config,account,{businessId:setup.business.id,outletId:setup.outlet.id,actorId:setup.owner.id,actorRole:setup.owner.role as 'owner'|'manager'},{storage:localStorage,assertScope:async()=>{await assertLocal();assertCurrent(await manager.commandAuthorization());}});
   const page=await session.page(null,50,controller.signal);session.saved();if(!active)return;setReady({session,config,page,signal:controller.signal,active:()=>active,ticket});
   unsubscribe=manager.subscribe(()=>{const state=manager.getSnapshot();if(active&&(['signed-out','closed','code'].includes(state.phase)||state.userId&&state.userId!==original.userId)){stop();setReady(null);setError('Phone sign-in changed. Refresh access with the original account.');}});
  })().catch(e=>{if(active)setError(e instanceof CommandRequestError&&e.kind==='auth'?'Configure this installation and sign in with its owner or assigned manager in Sync setup.':'Sync the current shop link and catalogue, then refresh access with its owner or assigned manager.');}).finally(()=>{if(active)setChecking(false);});
  return stop;
 },[ticket]);
 return {ready:ready?.ticket===ticket&&ready.active()?ready:null,error,checking,refresh:()=>setVersion(v=>v+1)};
}
