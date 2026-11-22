import {createECDH,randomBytes} from 'node:crypto';
import {generateVAPIDKeys} from 'web-push';
import {expect,it,vi} from 'vitest';
import {createDeskBrowserPush,type DeskPushEnvironment,type DeskPushRegistration,type DeskPushSubscriptionView} from '../apps/web/src/data/desk-browser-push';
const origin='https://desk.test',base='/mise/app/';
const bytes=(value:Uint8Array)=>Uint8Array.from(value).buffer;
function subscription(key:string):DeskPushSubscriptionView {const point=createECDH('prime256v1');point.generateKeys();const publicPoint=bytes(point.getPublicKey()),auth=bytes(randomBytes(16));return {endpoint:'https://fcm.googleapis.com/fcm/send/explicit-browser-fixture',expirationTime:null,options:{applicationServerKey:bytes(Buffer.from(key,'base64url'))},getKey:name=>name==='p256dh'?publicPoint:auth,unsubscribe:vi.fn(async()=>true)};}
function fixture(permission:NotificationPermission='default'){
 const key=generateVAPIDKeys().publicKey,created=subscription(key),old=subscription(key);let tail:Promise<unknown>=Promise.resolve();
 const requestPermission=vi.fn(async()=> 'granted' as const),environment:DeskPushEnvironment={permission:()=>permission,requestPermission,locked:<T>(_name:string,work:()=>Promise<T>)=>{const next=tail.then(work);tail=next.catch(()=>{});return next;}};
 const registration:DeskPushRegistration={scope:origin+base,pushManager:{getSubscription:vi.fn(async()=>old),subscribe:vi.fn(async()=>created)}};
 const port=createDeskBrowserPush(registration,origin,base,environment);return {key,created,old,environment,registration,port,requestPermission};
}
it('starts permission synchronously on explicit Enable and never prompts during passive subscription reads',async()=>{
 const f=fixture(),authorize=vi.fn(async()=>{}),save=vi.fn(async()=> 'original-journal-event');expect(await f.port.read()).toBeNull();expect(f.requestPermission).not.toHaveBeenCalled();
 const pending=f.port.enable(f.key,authorize,save);expect(f.requestPermission).toHaveBeenCalledTimes(1);expect(authorize).not.toHaveBeenCalled();expect(await pending).toBe('original-journal-event');expect(save).toHaveBeenCalledTimes(1);expect(f.old.unsubscribe).toHaveBeenCalledTimes(1);
});
it('leaves Inbox as the fallback when permission is denied, without replacing or registering a browser capability',async()=>{
 const f=fixture('denied'),save=vi.fn(async()=>{});await expect(f.port.enable(f.key,async()=>{},save)).rejects.toMatchObject({kind:'denied'});expect(f.requestPermission).not.toHaveBeenCalled();expect(f.old.unsubscribe).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();
});
it('rejects a changed original native choice after permission and before any PushManager mutation',async()=>{
 const f=fixture(),save=vi.fn(async()=>{});await expect(f.port.enable(f.key,async()=>{throw Error('Later Disable');},save)).rejects.toThrow('Later Disable');expect(f.old.unsubscribe).not.toHaveBeenCalled();expect(f.registration.pushManager.subscribe).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();
});
it('keeps the origin-wide browser lock until its new subscription has been saved in the original journal',async()=>{
 const f=fixture('granted');let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 const first=f.port.enable(f.key,async()=>{},async()=>{entered();await gate;return 'saved';});await started;const read=f.port.read();await Promise.resolve();expect(f.registration.pushManager.getSubscription).toHaveBeenCalledTimes(1);release();expect(await first).toBe('saved');expect(await read).not.toBeNull();expect(f.registration.pushManager.getSubscription).toHaveBeenCalledTimes(2);
});
it('retains the old setup when browser unsubscription cannot confirm and refuses a different returned application key',async()=>{
 const f=fixture('granted'),save=vi.fn(async()=>{});vi.mocked(f.old.unsubscribe).mockResolvedValue(false);await expect(f.port.enable(f.key,async()=>{},save)).rejects.toMatchObject({kind:'changed'});expect(f.registration.pushManager.subscribe).not.toHaveBeenCalled();
 vi.mocked(f.old.unsubscribe).mockResolvedValue(true);vi.mocked(f.registration.pushManager.subscribe).mockResolvedValue(subscription(generateVAPIDKeys().publicKey));await expect(f.port.enable(f.key,async()=>{},save)).rejects.toMatchObject({kind:'changed'});expect(save).not.toHaveBeenCalled();
});
it('accepts only the current registration origin/base and reads the browser-owned canonical source without copying it to storage',async()=>{
 const f=fixture('granted');expect((await f.port.read())?.applicationKey).toBe(f.key);
 expect(()=>createDeskBrowserPush({...f.registration,scope:origin+'/other/app/'},origin,base,f.environment)).toThrow();expect(()=>createDeskBrowserPush(f.registration,origin+'/other',base,f.environment)).toThrow();expect(()=>createDeskBrowserPush(f.registration,origin,base,null)).toThrow();
});
