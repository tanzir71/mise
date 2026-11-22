import {isDeviceId} from './device-access';
export interface DeskPushSubscription {endpoint:string;expirationTime:number|null;keys:{p256dh:string;auth:string}}
export interface KitchenPushNotice {v:1;type:'kitchen-alarm';subscriptionId:string;businessId:string;outletId:string;taskId:string;generation:number}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const invalid=()=>Error('Enable notifications again on this desk device.');
function bytes(value:unknown,length:number){
 if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value))throw invalid();
 const raw=atob(value.replaceAll('-','+').replaceAll('_','/'));if(raw.length!==length||btoa(raw).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')!==value)throw invalid();
 return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
/** Restrict server-side delivery to browser push providers, never an arbitrary
 * owner-supplied URL. Credentials are supplied only in the encrypted protocol. */
export function parseDeskPushSubscription(input:unknown):DeskPushSubscription {
 if(!object(input)||!exact(input,'endpoint,expirationTime,keys')||typeof input.endpoint!=='string'||input.endpoint.length>4096||
  input.expirationTime!==null&&(typeof input.expirationTime!=='number'||!Number.isSafeInteger(input.expirationTime)||input.expirationTime<0)||
  !object(input.keys)||!exact(input.keys,'p256dh,auth'))throw invalid();
 const url=new URL(input.endpoint),host=url.hostname;
 if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port||url.pathname==='/'||
  !(host==='fcm.googleapis.com'||host==='updates.push.services.mozilla.com'||host.endsWith('.push.services.mozilla.com')||host==='web.push.apple.com'||host.endsWith('.notify.windows.com')))throw invalid();
 if(bytes(input.keys.p256dh,65)[0]!==4)throw invalid();bytes(input.keys.auth,16);
 return {endpoint:input.endpoint,expirationTime:input.expirationTime as number|null,keys:{p256dh:input.keys.p256dh as string,auth:input.keys.auth as string}};
}
/** Generic payload. Order numbers, customer text, money, credentials and URLs
 * are read only after the desk reauthorizes the notification's target outlet. */
export function parseKitchenPushNotice(input:unknown):KitchenPushNotice {
 if(!object(input)||!exact(input,'v,type,subscriptionId,businessId,outletId,taskId,generation')||input.v!==1||input.type!=='kitchen-alarm'||
  ![input.subscriptionId,input.businessId,input.outletId,input.taskId].every(isDeviceId)||typeof input.generation!=='number'||!Number.isSafeInteger(input.generation)||input.generation<1)throw invalid();
 return {v:1,type:'kitchen-alarm',subscriptionId:input.subscriptionId as string,businessId:input.businessId as string,outletId:input.outletId as string,taskId:input.taskId as string,generation:input.generation};
}
