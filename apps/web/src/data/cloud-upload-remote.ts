import type {CloudUploadRemote} from '@mise/core/cloud-upload-runner';
import {CLOUD_UPLOAD_MAX_CHUNK_BYTES} from '@mise/core/cloud-upload';
import {inboxImageBase64} from '@mise/core/inbox';
import {parseCloudConnection} from '@mise/core/cloud-connection';
import {createAccountJsonRequest,CommandRequestError,type CommandAccount} from './command-request';
export interface CloudUploadTransport extends CloudUploadRemote {assertCurrent():void;status(id:string,signal?:AbortSignal):Promise<unknown>;cancel(id:string,signal?:AbortSignal):Promise<{id:string;canceled:true}>}
export class CloudUploadError extends Error {constructor(readonly kind:'auth'|'review'|'retry'){super(kind==='auth'?'Sign in with the original account to resume this upload.':'Upload is unconfirmed. Keep your local records and the original saved review.');}}
/** The original account/connection is pinned across every snapshot request and reply. */
export function createCloudUploadRemote(apiUrl:string,publishableKey:string,account:CommandAccount,send:typeof fetch=fetch):CloudUploadTransport {
 let config;try{config=parseCloudConnection({apiUrl,publishableKey});}catch{throw new Error('Cloud uploads are not configured.');}const call=createAccountJsonRequest(config,account,'migration-upload',send);let guard:(()=>void)|undefined;
 async function request(body:unknown,signal?:AbortSignal){const frozen=JSON.stringify(body);try{const result=await call(frozen,{'Content-Type':'application/json'},120000,signal);guard=result.guard;return result.value;}catch(error){throw new CloudUploadError(error instanceof CommandRequestError?error.kind:'retry');}}
 return {assertCurrent(){if(!guard)throw new CloudUploadError('auth');guard();},begin:(manifest,manifestHash,signal)=>request({action:'begin',manifest,manifestHash},signal),put:async(id,index,data,signal)=>{if(data.size>CLOUD_UPLOAD_MAX_CHUNK_BYTES)throw new Error('Use a prepared upload chunk.');return request({action:'put',id,index,data:inboxImageBase64(new Uint8Array(await data.arrayBuffer()))},signal);},finish:(id,manifestHash,signal)=>request({action:'finish',id,manifestHash},signal),status:(id,signal)=>request({action:'status',id},signal),cancel:async(id,signal)=>{const value=await request({action:'cancel',id},signal);if(!value||typeof value!=='object'||!('id'in value)||value.id!==id||!('canceled'in value)||value.canceled!==true)throw new CloudUploadError('review');return {id,canceled:true};}};
}
