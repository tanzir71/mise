import type {generateRequestDetails} from 'web-push';
import {parseDeskPushSubscription,parseKitchenPushNotice} from '../../../packages/core/desk-push.ts';
export interface DeskVapidDetails {subject:string;publicKey:string;privateKey:string}
/** The reviewed Web Push library builds RFC 8291 encryption and RFC 8292 VAPID.
 * Transport stays here so deadlines, redirects and provider errors are bounded. */
export function createDeskPushSender(build:typeof generateRequestDetails,vapid:DeskVapidDetails,send:typeof fetch=fetch){
 const subject=new URL(vapid.subject);
 if(subject.protocol!=='https:'||subject.username||subject.password||subject.search||subject.hash||!/^[A-Za-z0-9_-]{87}$/.test(vapid.publicKey)||!/^[A-Za-z0-9_-]{43}$/.test(vapid.privateKey))throw Error('Configure the private desk notification service.');
 const details={...vapid};
 return async(subscription:unknown,notice:unknown):Promise<'sent'|'expired'|'retry'>=>{
  let response:Response|undefined,timer:ReturnType<typeof setTimeout>|undefined;const controller=new AbortController();
  try{
   const target=parseDeskPushSubscription(subscription),payload=parseKitchenPushNotice(notice);
   if(target.expirationTime!==null&&target.expirationTime<=Date.now())return 'expired';
   const request=build(target,JSON.stringify(payload),{vapidDetails:details,contentEncoding:'aes128gcm',TTL:30,urgency:'high',topic:payload.taskId});
   const headers=new Headers();for(const [name,value]of Object.entries(request.headers))headers.set(name,String(value));
   const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Desk notification deadline.'));},5000);});
   response=await Promise.race([send(target.endpoint,{method:'POST',redirect:'error',signal:controller.signal,headers,body:request.body?new Uint8Array(request.body).buffer:null}),deadline]);
   if(response.status===404||response.status===410)return 'expired';return response.ok?'sent':'retry';
  }catch{return 'retry';}
  finally{clearTimeout(timer);controller.abort();void response?.body?.cancel().catch(()=>{});}
 };
}
