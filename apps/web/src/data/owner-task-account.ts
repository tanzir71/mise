import {cloudConnectionTarget,parseCloudConnection,type CloudConnection} from '@mise/core/cloud-connection';
import {operatorAccountHash,type LocalOperatorState} from '@mise/core/operators';
import {CommandRequestError,type CommandAccount} from './command-request';
import type {PhoneAuth} from './phone-auth';

/** Opens only this saved account's original journal while offline. New HTTP
 * requests and their results still require fresh server verification. */
export async function createOwnerTaskAccount(input:CloudConnection,scope:string,manager:PhoneAuth,expected:LocalOperatorState['connection'],assertLocal:()=>void){
 const config=parseCloudConnection(input),identity=manager.journalIdentity();
 const assertDraftAccount=()=>{assertLocal();manager.assertJournalIdentity(identity);};
 assertDraftAccount();
 const [accountHash,targetHash]=await Promise.all([operatorAccountHash(identity.userId),cloudConnectionTarget(config,scope,identity.userId)]);
 assertDraftAccount();
 if(expected&&(expected.authKey!==manager.key||expected.accountHash!==accountHash||expected.targetHash!==targetHash))throw new CommandRequestError('auth');
 const assertCurrent:CommandAccount['assertCurrent']=auth=>{
  assertDraftAccount();if(auth.userId!==identity.userId)throw new CommandRequestError('auth');manager.assertCommandAuthorization(auth);
 };
 const account:CommandAccount={scope,accountHash,targetHash,assertCurrent,getAuth:async()=>{assertDraftAccount();const auth=await manager.commandAuthorization();assertCurrent(auth);return auth;}};
 return {account,assertDraftAccount};
}
