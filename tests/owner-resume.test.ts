import 'fake-indexeddb/auto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {ownerApplyFixture} from './owner-apply-fixture';
import {CloudUploadJournal} from '../apps/web/src/data/cloud-upload';
import {resumeOriginalOwner,cancelOwnerResume,type OwnerResumeOptions} from '../apps/web/src/data/owner-resume';
import {lockLocalOperator} from '../apps/web/src/data/operator-state';
import {backupToken} from '../packages/core/backup';
import {parseOwnerResumeSession} from '../packages/core/owner-resume';
import {adoptOwnerUpload} from '../apps/web/src/data/cloud-sync-apply';
import type {CommandAuthorization} from '../apps/web/src/data/command-request';
const fixtures:{close:()=>Promise<void>}[]=[];
afterEach(async()=>{for(const f of fixtures.splice(0))await f.close();});
async function createFixture(){
 const base='/owner-test/app/',f=await ownerApplyFixture('7',false,base),journal=new CloudUploadJournal(f.db.name+'-journal');
 fixtures.push({close:async()=>{await journal.delete();await f.close();}});
 const snapshot=await journal.addSnapshot(f.upload.plan);await journal.acknowledge(snapshot.id,{id:snapshot.id,manifestHash:snapshot.manifestHash,received:snapshot.manifest.chunks.map(part=>part.index),receipt:f.upload.receipt});
 await lockLocalOperator(f.db,f.selected.revision);let identity:CommandAuthorization={...(await f.auth()),generation:1};const calls:string[]=[];
 const auth={key:f.target&&f.input.authKey,commandAuthorization:async()=>({...identity}),assertCommandAuthorization:(value:CommandAuthorization)=>{if(value.userId!==identity.userId||value.jwt!==identity.jwt||value.generation!==identity.generation)throw Object.assign(new Error('Original account changed'),{kind:'auth'});}};
 const send:typeof fetch=async(url,init)=>{if(new URL(String(url)).pathname==='/functions/v1/migration-upload'){const body=JSON.parse(init?.body as string);calls.push(body.action);expect(body).toEqual({action:'status',id:snapshot.id});return Response.json({id:snapshot.id,manifestHash:snapshot.manifestHash,received:snapshot.manifest.chunks.map(part=>part.index),receipt:f.upload.receipt});}return f.send(url,init);};
 const options:OwnerResumeOptions={base,config:f.config,journal,auth,send,connectionCurrent:()=>true};
 return {...f,journal,calls,options,revoke:()=>{identity={...identity,generation:identity.generation+1};},wrongAccount:()=>{identity={...identity,userId:'00000000-0000-4000-8000-000000000099',generation:identity.generation+1};}};
}
let current:Awaited<ReturnType<typeof createFixture>>;
// Cold PostgreSQL/WASM startup and all migrations are fixture work; the actual
// recovery operation retains Vitest's normal test timeout.
beforeEach(async()=>{current=await createFixture();},30000);
const boot=()=>current;
async function working(f:Awaited<ReturnType<typeof boot>>){return {backup:backupToken(await f.db.readBackup()),binding:await f.db.cloudState.get('binding'),queue:await f.db.outbox.toArray()};}
it('restores the genuinely selected original owner without replacing the shop, uploading again or manufacturing admission',async()=>{
 const f=await boot(),before=await working(f),old=await f.db.operatorState.get('active'),ready=await resumeOriginalOwner(f.db,f.options);
 expect(ready.phase).toBe('ready');expect(await working(f)).toEqual(before);expect(f.calls).toEqual(['status']);expect((await f.db.operatorState.get('active'))?.phase).toBe('active');expect(ready.operatorRevision).toBe(old!.revision+1);expect(await f.db.syncCanonical.count()).toBe(0);expect(await f.db.syncAdmissions.count()).toBe(0);expect(await f.db.joinSessions.count()).toBe(0);expect((await f.db.syncSessions.get('active'))?.paused).toBe(false);expect((await f.journal.readSnapshot(f.upload.plan.manifest.id)).progress?.receipt).toEqual(before.binding?.receipt);expect(JSON.stringify(ready)).not.toMatch(/apiUrl|publishableKey|userId|jwt|access_token|refresh_token/);
});
it('rejects another account and another connection before upload status traffic or operator writes',async()=>{
 const f=await boot(),before=await working(f),operator=await f.db.operatorState.get('active');f.wrongAccount();await expect(resumeOriginalOwner(f.db,f.options)).rejects.toMatchObject({kind:'auth'});expect(f.calls).toEqual([]);expect(await f.db.operatorState.get('active')).toEqual(operator);expect(await working(f)).toEqual(before);
 await expect(resumeOriginalOwner(f.db,{...f.options,config:{...f.config,apiUrl:'https://other.test'}})).rejects.toMatchObject({kind:'auth'});expect(f.calls).toEqual([]);expect(await f.db.scopeRecoveries.count()).toBe(0);
});
it('keeps the complete shop, image bytes, queue and lock when the original compressed source is missing',async()=>{
 const f=await boot(),before=await working(f),operator=await f.db.operatorState.get('active');await f.journal.uploads.delete(f.upload.plan.manifest.id);await expect(resumeOriginalOwner(f.db,f.options)).rejects.toMatchObject({kind:'integrity'});expect(await working(f)).toEqual(before);expect(await f.db.operatorState.get('active')).toEqual(operator);expect(f.calls).toEqual([]);expect(await f.db.syncSessions.count()).toBe(0);
});
it('refuses a different server receipt before restoring any operator or local sync session',async()=>{
 const f=await boot(),before=await working(f),operator=await f.db.operatorState.get('active');
 const send:typeof fetch=async(url,init)=>{if(new URL(String(url)).pathname==='/functions/v1/migration-upload')return Response.json({id:f.upload.plan.manifest.id,manifestHash:before.binding!.manifestHash,received:f.upload.plan.manifest.chunks.map(part=>part.index),receipt:{...f.upload.receipt,at:f.upload.receipt.at+1}});return f.options.send!(url,init);};
 await expect(resumeOriginalOwner(f.db,{...f.options,send})).rejects.toMatchObject({kind:'review'});expect(await working(f)).toEqual(before);expect(await f.db.operatorState.get('active')).toEqual(operator);expect(await f.db.scopeRecoveries.count()).toBe(0);expect(await f.db.syncSessions.count()).toBe(0);
});
it('rolls native operator selection back when the actual original sign-in changes inside its writer',async()=>{
 const f=await boot(),before=await working(f),operator=await f.db.operatorState.get('active');let changed=false;const revoke=(changes:{phase?:string})=>{if(changes.phase==='active'){changed=true;f.revoke();}};f.db.operatorState.hook('updating',revoke);
 try{await expect(resumeOriginalOwner(f.db,f.options)).rejects.toThrow();}finally{f.db.operatorState.hook('updating').unsubscribe(revoke);}
 expect(changed).toBe(true);expect(await f.db.operatorState.get('active')).toEqual(operator);expect(await working(f)).toEqual(before);expect(await f.db.syncSessions.count()).toBe(0);expect(parseOwnerResumeSession(await f.db.scopeRecoveries.get('owner:active')).phase).toBe('pending');
});
it('rolls session activation back when the account changes during the native session insert',async()=>{
 const f=await boot(),before=await working(f);let changed=false;const revoke=()=>{changed=true;f.revoke();};f.db.syncSessions.hook('creating',revoke);
 try{await expect(resumeOriginalOwner(f.db,f.options)).rejects.toThrow();}finally{f.db.syncSessions.hook('creating').unsubscribe(revoke);}
 expect(changed).toBe(true);expect(await f.db.syncSessions.count()).toBe(0);expect(await working(f)).toEqual(before);expect(parseOwnerResumeSession(await f.db.scopeRecoveries.get('owner:active')).phase).toBe('pending');
});
it('resumes the same durable operation after lost ready completion without rewriting domain rows or the session identity',async()=>{
 const f=await boot(),before=await working(f),fail=(changes:{phase?:string})=>{if(changes.phase==='ready')throw new DOMException('Storage full','QuotaExceededError');};f.db.scopeRecoveries.hook('updating',fail);
 try{await expect(resumeOriginalOwner(f.db,f.options)).rejects.toThrow('Storage full');}finally{f.db.scopeRecoveries.hook('updating').unsubscribe(fail);}
 const pending=parseOwnerResumeSession(await f.db.scopeRecoveries.get('owner:active')),sync=await f.db.syncSessions.get('active');expect(pending.phase).toBe('pending');expect(await working(f)).toEqual(before);
 const ready=await resumeOriginalOwner(f.db,f.options);expect(ready.operationId).toBe(pending.operationId);expect(ready.phase).toBe('ready');expect((await f.db.syncSessions.get('active'))?.sessionId).toBe(sync?.sessionId);expect(await working(f)).toEqual(before);expect(await f.db.scopeRecoveries.count()).toBe(1);
});
it('finishes a pending restore after another authorized tab already adopted the real original upload',async()=>{
 const f=await boot(),fail=(changes:{phase?:string})=>{if(changes.phase==='ready')throw new DOMException('Lost completion','QuotaExceededError');};f.db.scopeRecoveries.hook('updating',fail);try{await expect(resumeOriginalOwner(f.db,f.options)).rejects.toThrow();}finally{f.db.scopeRecoveries.hook('updating').unsubscribe(fail);}
 const input=await f.stage();await adoptOwnerUpload(f.db,input,f.upload.plan,f.uploadCoverage,f.coverage,f.refresh);const before=await working(f),ready=await resumeOriginalOwner(f.db,f.options);expect(ready.phase).toBe('ready');expect(await working(f)).toEqual(before);expect(await f.db.syncAdmissions.count()).toBe(1);
});
it('cancels a pending restore without deleting the original source or queued work',async()=>{
 const f=await boot(),before=await working(f),fail=(changes:{phase?:string})=>{if(changes.phase==='ready')throw new DOMException('Lost completion','QuotaExceededError');};f.db.scopeRecoveries.hook('updating',fail);try{await expect(resumeOriginalOwner(f.db,f.options)).rejects.toThrow();}finally{f.db.scopeRecoveries.hook('updating').unsubscribe(fail);}
 await cancelOwnerResume(f.db);expect(parseOwnerResumeSession(await f.db.scopeRecoveries.get('owner:active')).phase).toBe('cancelled');expect((await f.db.syncSessions.get('active'))?.paused).toBe(true);expect(await working(f)).toEqual(before);expect(await f.journal.uploads.count()).toBe(1);
});
