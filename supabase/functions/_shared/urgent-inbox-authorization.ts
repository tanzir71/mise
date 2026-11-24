import {isDeviceToken} from '../../../packages/core/device-access.ts';
/** A queued proof expires and is body-bound. SQL must also consume its exact
 * one-use nonce before work; the reusable key never enters the Net queue. */
export function createUrgentInboxAuthorization(key:string){
 if(!isDeviceToken(key))throw Error('Configure the private urgent notification worker.');
 const encoder=new TextEncoder(),signingKey=crypto.subtle.importKey('raw',encoder.encode(key),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 return async(header:string|null,limit:number,at=Date.now()):Promise<{nonce:string;issuedAt:number;limit:number}|null>=>{
  if(!Number.isSafeInteger(at)||at<0||at>8640000000000000||!Number.isInteger(limit)||limit<1||limit>25)return null;
  const parts=header?.match(/^Bearer v1\.([1-9][0-9]{0,15})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{64})$/);if(!parts)return null;
  const issuedAt=Number(parts[1]),nonce=parts[2];if(!Number.isSafeInteger(issuedAt)||issuedAt>8640000000000000||issuedAt>at+5000||at-issuedAt>60000)return null;
  const signature=Uint8Array.from(parts[3].match(/../g)!,b=>parseInt(b,16)),message=encoder.encode('mise:urgent-inbox:v1\n'+issuedAt+'\n'+nonce+'\n'+limit);
  return await crypto.subtle.verify('HMAC',await signingKey,signature,message)?{nonce,issuedAt,limit}:null;
 };
}
