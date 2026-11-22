import {isDeviceToken} from '../../../packages/core/device-access.ts';

export interface KitchenDispatchPermit {nonce:string;issuedAt:number;limit:number}
const integer=(value:number)=>Number.isSafeInteger(value)&&value>=0&&value<=8640000000000000;
/** Queued authorization is an expiring, body-bound HMAC, never the reusable
 * worker key. Before side effects, the caller must ALSO consume this exact
 * nonce/clock/limit in the private SQL grant ledger. HMAC alone is replayable. */
export function createKitchenDispatchAuthorization(key:string){
 if(!isDeviceToken(key))throw Error('Kitchen dispatch authorization unavailable.');
 const encoder=new TextEncoder(),signingKey=crypto.subtle.importKey('raw',encoder.encode(key),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 return async(authorization:string|null,limit:number,at=Date.now()):Promise<KitchenDispatchPermit|null>=>{
  if(!integer(at)||!Number.isInteger(limit)||limit<1||limit>25)return null;
  const parts=authorization?.match(/^Bearer v1\.([1-9][0-9]{0,15})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{64})$/);
  if(!parts)return null;
  const issuedAt=Number(parts[1]),nonce=parts[2];
  if(!integer(issuedAt)||issuedAt>at+5000||at-issuedAt>60000)return null;
  const signature=Uint8Array.from(parts[3].match(/../g)!,byte=>parseInt(byte,16));
  const message=encoder.encode('mise:kitchen-dispatch:v1\n'+issuedAt+'\n'+nonce+'\n'+limit);
  if(!await crypto.subtle.verify('HMAC',await signingKey,signature,message))return null;
  return {nonce,issuedAt,limit};
 };
}
