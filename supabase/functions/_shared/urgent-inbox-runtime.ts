import {isDeviceToken} from '../../../packages/core/device-access.ts';
import {parseDeskApplicationKey} from '../../../packages/core/desk-push.ts';
/** Private readiness only. The owner endpoint returns the public application
 * key, never this object or any privileged value. Missing delivery config must
 * not disable original inspection/withdrawal. */
export function urgentInboxRuntime(get:(name:string)=>string|undefined){
 if(get('MISE_URGENT_INBOX_ENABLED')!=='true')return null;
 try{
  const key=get('MISE_URGENT_INBOX_KEY')??'',publicKey=parseDeskApplicationKey(get('MISE_WEB_PUSH_VAPID_PUBLIC_KEY')),privateKey=get('MISE_WEB_PUSH_VAPID_PRIVATE_KEY')??'',subject=get('MISE_WEB_PUSH_VAPID_SUBJECT')??'',serviceKey=get('MISE_SERVICE_API_KEY')??'',url=new URL(subject);
  if(!isDeviceToken(key)||!/^[A-Za-z0-9_-]{43}$/.test(privateKey)||!/^sb_secret_[A-Za-z0-9_-]+$/.test(serviceKey)||url.protocol!=='https:'||url.username||url.password||url.search||url.hash)return null;
  return {key,publicKey,privateKey,subject,serviceKey};
 }catch{return null;}
}
