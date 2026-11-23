import {useEffect,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {readCloudConnection,cloudConnectionTarget} from '@mise/core/cloud-connection';
import {operatorAccountHash} from '@mise/core/operators';
import type {SetupSnapshot} from '@mise/core/models';
import {db} from './data/db';
import {resolveCloudAuthScope} from './data/cloud-auth-scope';
import {getPhoneAuth} from './data/phone-auth';
import {CommandRequestError,type CommandAccount} from './data/command-request';
import {createStaffOwnerSession,type StaffOwnerSession} from './data/staff-owner-session';
import {createStaffLinkAdminSession,type StaffLinkAdminSession} from './data/staff-link-admin-session';
const identity=(setup:SetupSnapshot)=>[setup.business.id,setup.outlet.id,setup.owner.id,setup.owner.role].join(':');
export interface StaffOwner {session:StaffOwnerSession;links:(memberId:string)=>StaffLinkAdminSession;signal:AbortSignal;active:()=>boolean;ticket:string;apiUrl:string}

export function useStaffOwner(setup:SetupSnapshot){
 const selection=useLiveQuery(()=>db.operatorState.get('active')),selectionToken=JSON.stringify(selection??null),localScope=identity(setup);
 const [version,setVersion]=useState(0),[ready,setReady]=useState<StaffOwner|null>(null),[error,setError]=useState(''),[checking,setChecking]=useState(false);
 const ticket=JSON.stringify([localScope,selectionToken,version]);
 useEffect(()=>{const changed=()=>setVersion(v=>v+1);window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed);},[]);
 useEffect(()=>{
  let active=true,session:StaffOwnerSession|undefined,unsubscribe:(()=>void)|undefined;const linkSessions=new Map<string,StaffLinkAdminSession>();
  const controller=new AbortController();setReady(null);setError('');setChecking(true);
  const stop=()=>{active=false;controller.abort();session?.stop();for(const link of linkSessions.values())link.stop();unsubscribe?.();};
  if(!['owner','manager'].includes(setup.owner.role)){setChecking(false);setError('Ask the owner or assigned manager to open Team.');return stop;}
  void(async()=>{
   const config=readCloudConnection(localStorage);if(!config)throw new CommandRequestError('auth');
   const assertLocal=async()=>{
    if(!active||JSON.stringify(readCloudConnection(localStorage))!==JSON.stringify(config))throw new CommandRequestError('auth');
    const [fresh,selected]=await Promise.all([db.setup(),db.operatorState.get('active')]);
    if(!active||!fresh||identity(fresh)!==localScope||JSON.stringify(selected??null)!==selectionToken)throw new CommandRequestError('review');
   };
   const authScope=await resolveCloudAuthScope(config,import.meta.env.BASE_URL,setup.business.id,selection?.connection?.authKey),manager=await getPhoneAuth(config,authScope),original=await manager.commandAuthorization();await assertLocal();
   const [accountHash,targetHash]=await Promise.all([operatorAccountHash(original.userId),cloudConnectionTarget(config,authScope,original.userId)]);
   if(selection?.connection&&(selection.connection.authKey!==manager.key||selection.connection.accountHash!==accountHash||selection.connection.targetHash!==targetHash))throw new CommandRequestError('auth');
   const assertCurrent:CommandAccount['assertCurrent']=auth=>{
    if(!active||auth.userId!==original.userId||auth.generation!==original.generation||JSON.stringify(readCloudConnection(localStorage))!==JSON.stringify(config))throw new CommandRequestError('auth');
    manager.assertCommandAuthorization(auth);
   };
   const account:CommandAccount={scope:authScope,accountHash,targetHash,getAuth:async()=>{await assertLocal();const auth=await manager.commandAuthorization();assertCurrent(auth);return auth;},assertCurrent};
   session=createStaffOwnerSession(config,account,{businessId:setup.business.id,outletId:setup.outlet.id,actorId:setup.owner.id,actorRole:setup.owner.role as 'owner'|'manager'},
    {storage:localStorage,assertScope:assertLocal,assertDraftAccount:()=>assertCurrent(original)});
   const links=(memberId:string)=>{let value=linkSessions.get(memberId);if(!value){value=createStaffLinkAdminSession(config,account,{businessId:setup.business.id,outletId:setup.outlet.id,actorId:setup.owner.id,actorRole:setup.owner.role as 'owner'|'manager',memberId},
    {storage:localStorage,assertScope:assertLocal,assertDraftAccount:()=>assertCurrent(original)});linkSessions.set(memberId,value);}return value;};
   session.saved();const owner:StaffOwner={session,links,apiUrl:config.apiUrl,signal:controller.signal,active:()=>active,ticket};if(active)setReady(owner);
   unsubscribe=manager.subscribe(()=>{const state=manager.getSnapshot();if(active&&(['signed-out','closed','code'].includes(state.phase)||state.userId&&state.userId!==original.userId)){
    stop();setReady(null);setChecking(false);setError('Phone sign-in changed. Refresh access with the original account.');
   }});
  })().catch(error=>{
   const authFailure=error!==null&&typeof error==='object'&&'kind'in error&&error.kind==='auth';
   if(active)setError(authFailure?'Configure this installation and sign in with its owner or assigned manager in Sync setup.':'Refresh access with the original account. Saved team changes are retained.');
  }).finally(()=>{if(active)setChecking(false);});
  return stop;
 },[ticket]);
 const current=ready?.ticket===ticket&&ready.active()?ready:null;
 return {ready:current,error,checking,refresh:()=>setVersion(v=>v+1)};
}
