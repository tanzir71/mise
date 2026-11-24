import {openScreenJournal,assertBlankScreenProfile,screenJournalDatabaseName} from '../../apps/web/src/data/device-screen-journal';
import {createDeviceScreenSession} from '../../apps/web/src/data/device-screen-session';
import {deviceVerification,deviceSecretHash} from '../../packages/core/device-access';
const base='/mise/app/',ownerName='mise-local:'+base,connection={apiUrl:'https://screen.test',publishableKey:'sb_publishable_test_only'},parent='00000000000000000000000010';
let requests=0;
async function open(){return openScreenJournal(base);}
async function prepare(){
 const journal=await open();try{const screen=createDeviceScreenSession(journal,{send:async()=>{requests++;throw Error('No HTTP expected');}}),saved=await screen.prepare(await screen.load(),connection,'১২৩ ৪৫৬',parent);if(saved.state.phase!=='pairing')throw Error();screen.dispose();return {requestId:saved.state.source.requestId,revision:saved.revision,tokenHash:saved.state.source.tokenHash,verification:deviceVerification(saved.state.source.tokenHash),requests};}finally{journal.close();}
}
async function inspect(){
 const journal=await open();try{const saved=await journal.read();return {phase:saved.state.phase,revision:saved.revision,...(saved.state.phase==='pairing'?{requestId:saved.state.source.requestId,tokenHash:saved.state.source.tokenHash,code:saved.state.source.code}:{}),names:(await indexedDB.databases()).map(v=>v.name)};}finally{journal.close();}
}
async function competingTabs(){
 const a=await open(),b=await open();try{const empty=await a.read(),one=createDeviceScreenSession(a),two=createDeviceScreenSession(b),result=await Promise.allSettled([one.prepare(empty,connection,'123456',parent),two.prepare(empty,connection,'123456',parent)]);one.dispose();two.dispose();return {accepted:result.filter(r=>r.status==='fulfilled').length,rejected:result.filter(r=>r.status==='rejected').length,phase:(await a.read()).state.phase};}finally{a.close();b.close();}
}
async function quota(){
 const journal=await open(),original=IDBObjectStore.prototype.put;
 try{const empty=await journal.read(),screen=createDeviceScreenSession(journal);IDBObjectStore.prototype.put=function(){throw new DOMException('Storage full','QuotaExceededError');};let rejected=false;try{await screen.prepare(empty,connection,'123456',parent);}catch{rejected=true;}IDBObjectStore.prototype.put=original;const current=await journal.read();screen.dispose();return {rejected,originalRetained:JSON.stringify(current)===JSON.stringify(empty),phase:current.state.phase};}
 finally{IDBObjectStore.prototype.put=original;journal.close();}
}
async function stoppedWrite(){
 const journal=await open();try{const empty=await journal.read();let active=true;const work=journal.replace(empty,{phase:'empty'},{assertCurrent:()=>{if(!active)throw Error('Screen closed');}});active=false;let rejected=false;try{await work;}catch{rejected=true;}return {rejected,originalRetained:JSON.stringify(await journal.read())===JSON.stringify(empty)};}finally{journal.close();}
}
async function staleResponse(){
 const journal=await open(),other=await open();try{
  let release!:()=>void,started!:()=>void;const reached=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const screen=createDeviceScreenSession(journal,{send:async()=>{started();await gate;const saved=await journal.read();void saved;return new Response(JSON.stringify({v:1,id:requestId,state:'waiting',verification,expiresAt:Date.now()+600000}));}}),prepared=await screen.prepare(await screen.load(),connection,'123456',parent);if(prepared.state.phase!=='pairing')throw Error();const requestId=prepared.state.source.requestId,verification=deviceVerification(prepared.state.source.tokenHash),pending=screen.pair(prepared).then(()=>false,()=>true);await reached;
  const second=createDeviceScreenSession(other),cleared=await second.forgetPairing(prepared);release();const rejected=await pending,current=await journal.read();screen.dispose();second.dispose();return {rejected,phase:current.state.phase,tombstoneRetained:current.revision===cleared.revision};
 }finally{journal.close();other.close();}
}
async function occupy(){
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(ownerName,1);request.onupgradeneeded=()=>request.result.createObjectStore('inboxItems',{keyPath:'id'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('inboxItems','readwrite');tx.objectStore('inboxItems').put({id:'original',text:'Unassigned original share'});tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});}finally{db.close();}
}
async function ownerGuard(){
 await occupy();let blocked=false;try{await assertBlankScreenProfile();}catch{blocked=true;}
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(ownerName);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 try{const row=await new Promise<unknown>(resolve=>{const r=db.transaction('inboxItems').objectStore('inboxItems').get('original');r.onsuccess=()=>resolve(r.result);});return {blocked,row,requests};}finally{db.close();}
}
async function authGuard(){
 localStorage.setItem('mise.cloud.auth.original','Private runtime sign-in');try{let blocked=false;try{await prepare();}catch{blocked=true;}return {blocked,kept:localStorage.getItem('mise.cloud.auth.original')==='Private runtime sign-in',requests};}finally{localStorage.removeItem('mise.cloud.auth.original');}
}
async function upgradeStockStorage(){
 const name=screenJournalDatabaseName(base),token='D'.repeat(43),state={v:1,id:'current',revision:'00000000000000000000900001',state:{phase:'pairing',source:{connection,requestId:'00000000000000000000000005',token,tokenHash:await deviceSecretHash(token),code:'123456',pairingId:parent},receipt:null}};
 const kitchen={id:'00000000000000000000000005',original:'পূর্ণ\u0000\ud800 original kitchen history'},attendance={id:'device:member',original:['own attendance',0,'কর্মী'],outcome:null};
 const old=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(name,3);r.onupgradeneeded=()=>{for(const table of ['state','kitchen','attendance'])r.result.createObjectStore(table,{keyPath:'id'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 await new Promise<void>((resolve,reject)=>{const tx=old.transaction(['state','kitchen','attendance'],'readwrite');tx.objectStore('state').put(state);tx.objectStore('kitchen').put(kitchen);tx.objectStore('attendance').put(attendance);tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});old.close();
 const journal=await open(),saved=await journal.read(),raw=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 try{const kept=await Promise.all([['kitchen',kitchen.id],['attendance',attendance.id]].map(([table,id])=>new Promise<unknown>((resolve,reject)=>{const tx=raw.transaction(table),r=tx.objectStore(table).get(id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);})));return {version:raw.version,tables:Array.from(raw.objectStoreNames),statePreserved:JSON.stringify(saved)===JSON.stringify(state),kitchenPreserved:JSON.stringify(kept[0])===JSON.stringify(kitchen),attendancePreserved:JSON.stringify(kept[1])===JSON.stringify(attendance)};}finally{raw.close();journal.close();}
}
async function cleanup(){
 // Only the two explicit, synthetic fixture databases; never discover/delete
 // other databases or any filesystem path.
 for(const name of [screenJournalDatabaseName(base),ownerName])await new Promise<void>((resolve,reject)=>{const request=indexedDB.deleteDatabase(name);request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);request.onblocked=()=>reject(Error('Fixture database still open'));});
}
window.miseDeviceScreenTest={prepare,inspect,competingTabs,quota,stoppedWrite,staleResponse,ownerGuard,authGuard,upgradeStockStorage,cleanup};
declare global {interface Window {miseDeviceScreenTest:{prepare:typeof prepare;inspect:typeof inspect;competingTabs:typeof competingTabs;quota:typeof quota;stoppedWrite:typeof stoppedWrite;staleResponse:typeof staleResponse;ownerGuard:typeof ownerGuard;authGuard:typeof authGuard;upgradeStockStorage:typeof upgradeStockStorage;cleanup:typeof cleanup}}}
