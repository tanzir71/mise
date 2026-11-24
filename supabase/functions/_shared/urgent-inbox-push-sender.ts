import type {generateRequestDetails} from 'web-push';
import {parseDeskPushSubscription} from '../../../packages/core/desk-push.ts';
import {parseUrgentInboxNotice} from '../../../packages/core/urgent-inbox.ts';
import type {DeskVapidDetails} from './desk-push-sender.ts';
/** Same reviewed pinned Web Push encryption protocol as kitchen delivery, with
 * its own closed payload parser and topic. The kitchen sender stays unchanged. */
export function createUrgentInboxPushSender(build:typeof generateRequestDetails,vapid:DeskVapidDetails,send:typeof fetch=fetch){
 const subject=new URL(vapid.subject);
 if(subject.protocol!=='https:'||subject.username||subject.password||subject.search||subject.hash||!/^[A-Za-z0-9_-]{87}$/.test(vapid.publicKey)||!/^[A-Za-z0-9_-]{43}$/.test(vapid.privateKey))throw Error('Configure the private urgent notification service.');
 const details={...vapid};
 return async(subscription:unknown,notice:unknown):Promise<'sent'|'expired'|'retry'>=>{
  const controller=new AbortController();let response:Response|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const target=parseDeskPushSubscription(subscription),payload=parseUrgentInboxNotice(notice);
   if(target.expirationTime!==null&&target.expirationTime<=Date.now())return 'expired';
   const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(['mise.urgent.v1',payload.consentId,payload.taskId,payload.generation].join(':'))));
   const topic=btoa(String.fromCharCode(...digest)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','').slice(0,32);
   const request=build(target,JSON.stringify(payload),{vapidDetails:details,contentEncoding:'aes128gcm',TTL:30,urgency:'high',topic});
   const headers=new Headers();for(const [key,value] of Object.entries(request.headers))headers.set(key,String(value));
   const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Urgent notification deadline.'));},2500);});
   response=await Promise.race([send(target.endpoint,{method:'POST',redirect:'error',signal:controller.signal,headers,body:request.body?new Uint8Array(request.body).buffer:null}),deadline]);
   if(response.status===404||response.status===410)return 'expired';return response.ok?'sent':'retry';
  }catch{return 'retry';}
  finally{clearTimeout(timer);controller.abort();void response?.body?.cancel().catch(()=>{});}
 };
}
