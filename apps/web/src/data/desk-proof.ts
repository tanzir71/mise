import {parseDeskPushContext,type DeskPushContext} from '@mise/core/desk-push';
import {assertLiveCommandReceipt,bindCommandReceipt,CommandRequestError} from './command-request';
export interface DeskProofIdentity {accountHash:string;targetHash:string;scope:DeskPushContext}
const identities=new WeakMap<object,{identity:DeskProofIdentity;source:string}>();
function identity(value:DeskProofIdentity):DeskProofIdentity {
 if(!/^[a-f0-9]{64}$/.test(value.accountHash)||!/^[a-f0-9]{64}$/.test(value.targetHash))throw new CommandRequestError('auth');
 return {accountHash:value.accountHash,targetHash:value.targetHash,scope:parseDeskPushContext(value.scope)};
}
/** Runtime-only proof. JSON/IndexedDB copies cannot recreate it or change the
 * original phone account, connection target or authorized outlet/member. */
export function bindDeskReceipt<T extends object>(value:T,guard:()=>void,source:DeskProofIdentity):T {
 const binding=identity(source);guard();identities.set(value,{identity:binding,source:JSON.stringify(value)});return bindCommandReceipt(value,guard);
}
export function assertDeskReceipt(value:object,source:DeskProofIdentity):void {
 assertLiveCommandReceipt(value);const proof=identities.get(value);if(!proof||JSON.stringify(proof.identity)!==JSON.stringify(identity(source)))throw new CommandRequestError('auth');
 if(proof.source!==JSON.stringify(value))throw new CommandRequestError('review');assertLiveCommandReceipt(value);
}
