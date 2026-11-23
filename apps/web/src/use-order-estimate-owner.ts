import {useEffect,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {readCloudConnection,cloudConnectionTarget} from '@mise/core/cloud-connection';
import {operatorAccountHash} from '@mise/core/operators';
import type {Order,SetupSnapshot} from '@mise/core/models';
import type {EstimateContext} from '@mise/core/order-estimates';
import {db} from './data/db';
import {resolveCloudAuthScope} from './data/cloud-auth-scope';
import {getPhoneAuth} from './data/phone-auth';
import {CommandRequestError,type CommandAccount} from './data/command-request';
import {createOrderEstimateSession,type OrderEstimateSession} from './data/order-estimate-session';
const identity=(s:SetupSnapshot)=>[s.business.id,s.outlet.id,s.owner.id,s.owner.role].join(':');
interface Owner {session:OrderEstimateSession;signal:AbortSignal;active:()=>boolean;ticket:string}
export function useOrderEstimateOwner(setup:SetupSnapshot,order:Order){
 const selection=useLiveQuery(()=>db.operatorState.get('active')),selectionToken=JSON.stringify(selection??null),localScope=identity(setup),[version,setVersion]=useState(0),[ready,setReady]=useState<Owner|null>(null),[context,setContext]=useState<EstimateContext|null>(null),[error,setError]=useState(''),[checking,setChecking]=useState(false),ticket=JSON.stringify([localScope,order.id,order.revision,order.type,selectionToken,version]);
 useEffect(()=>{const changed=()=>setVersion(v=>v+1);window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed);},[]);
 useEffect(()=>{
  let active=true,session:OrderEstimateSession|undefined,unsubscribe:(()=>void)|undefined;const controller=new AbortController();setReady(null);setContext(null);setError('');setChecking(true);
  const stop=()=>{active=false;controller.abort();session?.stop();unsubscribe?.();};
  if(!['owner','manager'].includes(setup.owner.role)){setChecking(false);return stop;}
  void(async()=>{
   const config=readCloudConnection(localStorage);if(!config)throw new CommandRequestError('auth');
   const assertLocal=async()=>{if(!active||JSON.stringify(readCloudConnection(localStorage))!==JSON.stringify(config))throw new CommandRequestError('auth');const [fresh,selected,currentOrder]=await Promise.all([db.setup(),db.operatorState.get('active'),db.orders.get(order.id)]);if(!active||!fresh||identity(fresh)!==localScope||JSON.stringify(selected??null)!==selectionToken||!currentOrder||currentOrder.outletId!==setup.outlet.id||currentOrder.revision!==order.revision||currentOrder.type!==order.type)throw new CommandRequestError('review');};
   const authScope=await resolveCloudAuthScope(config,import.meta.env.BASE_URL,setup.business.id,selection?.connection?.authKey),manager=await getPhoneAuth(config,authScope),original=await manager.commandAuthorization();await assertLocal();
   const [accountHash,targetHash]=await Promise.all([operatorAccountHash(original.userId),cloudConnectionTarget(config,authScope,original.userId)]);
   if(selection?.connection&&(selection.connection.authKey!==manager.key||selection.connection.accountHash!==accountHash||selection.connection.targetHash!==targetHash))throw new CommandRequestError('auth');
   const assertCurrent:CommandAccount['assertCurrent']=auth=>{if(!active||auth.userId!==original.userId||auth.generation!==original.generation||JSON.stringify(readCloudConnection(localStorage))!==JSON.stringify(config))throw new CommandRequestError('auth');manager.assertCommandAuthorization(auth);};
   const account:CommandAccount={scope:authScope,accountHash,targetHash,getAuth:async()=>{await assertLocal();const auth=await manager.commandAuthorization();assertCurrent(auth);return auth;},assertCurrent};
   session=createOrderEstimateSession(config,account,{businessId:setup.business.id,outletId:setup.outlet.id,orderId:order.id,actorId:setup.owner.id,actorRole:setup.owner.role as 'owner'|'manager'},{storage:localStorage,assertScope:assertLocal,assertDraftAccount:()=>assertCurrent(original)});session.saved();
   const owner:Owner={session,signal:controller.signal,active:()=>active,ticket};if(!active)return;setReady(owner);
   unsubscribe=manager.subscribe(()=>{const state=manager.getSnapshot();if(active&&(['signed-out','closed','code'].includes(state.phase)||state.userId&&state.userId!==original.userId)){stop();setReady(null);setChecking(false);setError('Phone sign-in changed. Refresh access with the original account.');}});
   const next=await session.read(controller.signal);if(active)setContext(next);
  })().catch(e=>{const authFailure=e!==null&&typeof e==='object'&&'kind' in e&&e.kind==='auth';if(active)setError(authFailure?'Configure this installation and sign in with its owner or assigned manager in Sync setup.':'Connect and refresh access to read the current estimate. Saved original changes are retained.');}).finally(()=>{if(active)setChecking(false);});
  return stop;
 },[ticket]);
 const current=ready?.ticket===ticket&&ready.active()?ready:null;
 return {ready:current,context:current?context:null,error,checking,refresh:()=>setVersion(v=>v+1)};
}
