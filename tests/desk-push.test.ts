import {createECDH,randomBytes,hkdfSync,createDecipheriv,createPublicKey,verify} from 'node:crypto';
import {generateRequestDetails,generateVAPIDKeys} from 'web-push';
import {afterEach,expect,it,vi} from 'vitest';
import {parseDeskPushSubscription,parseKitchenPushNotice} from '../packages/core/desk-push';
import {createDeskPushSender} from '../supabase/functions/_shared/desk-push-sender';
const id=(n:number)=>String(n).padStart(26,'0'),notice={v:1 as const,type:'kitchen-alarm' as const,subscriptionId:id(1),businessId:id(2),outletId:id(3),taskId:id(4),generation:1};
function fixture(){
 const browser=createECDH('prime256v1');browser.generateKeys();const auth=randomBytes(16),vapid={subject:'https://desk.test/contact',...generateVAPIDKeys()};
 const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/synthetic-test-only',expirationTime:null,keys:{p256dh:browser.getPublicKey().toString('base64url'),auth:auth.toString('base64url')}};
 return {browser,auth,vapid,subscription};
}
afterEach(()=>vi.useRealTimers());
it('encrypts a real request that an independent browser key decrypts and signs the actual provider audience',async()=>{
 const f=fixture();let captured:RequestInit|undefined;
 const send:typeof fetch=async(url,options)=>{expect(url).toBe(f.subscription.endpoint);captured=options;return new Response(null,{status:201});};
 expect(await createDeskPushSender(generateRequestDetails,f.vapid,send)(f.subscription,notice)).toBe('sent');
 const request=captured!,headers=new Headers(request.headers),body=Buffer.from(request.body as ArrayBuffer);
 expect(request).toMatchObject({method:'POST',redirect:'error'});expect(headers.get('TTL')).toBe('30');expect(headers.get('Urgency')).toBe('high');expect(headers.get('Content-Encoding')).toBe('aes128gcm');expect(headers.get('Topic')).toBe(notice.taskId);
 expect(body.toString()).not.toContain(JSON.stringify(notice));
 const salt=body.subarray(0,16),keyLength=body[20],sender=body.subarray(21,21+keyLength),encrypted=body.subarray(21+keyLength),shared=f.browser.computeSecret(sender);
 const ikm=Buffer.from(hkdfSync('sha256',shared,f.auth,Buffer.concat([Buffer.from('WebPush: info\0'),f.browser.getPublicKey(),sender]),32));
 const cek=hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0'),16),nonce=hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: nonce\0'),12);
 const decipher=createDecipheriv('aes-128-gcm',Buffer.from(cek),Buffer.from(nonce));decipher.setAuthTag(encrypted.subarray(-16));const plain=Buffer.concat([decipher.update(encrypted.subarray(0,-16)),decipher.final()]);
 expect(plain.at(-1)).toBe(2);expect(JSON.parse(plain.subarray(0,-1).toString())).toEqual(notice);
 const authorization=headers.get('authorization')!,match=authorization.match(/^vapid t=([^,]+), k=(.+)$/)!;expect(match[2]).toBe(f.vapid.publicKey);
 const [head,claims,signature]=match[1].split('.'),payload=JSON.parse(Buffer.from(claims,'base64url').toString());
 expect(payload).toMatchObject({aud:'https://fcm.googleapis.com',sub:f.vapid.subject});expect(payload.exp).toBeGreaterThan(Date.now()/1000);expect(payload.exp).toBeLessThan(Date.now()/1000+86401);
 const publicBytes=Buffer.from(f.vapid.publicKey,'base64url'),publicKey=createPublicKey({format:'jwk',key:{kty:'EC',crv:'P-256',x:publicBytes.subarray(1,33).toString('base64url'),y:publicBytes.subarray(33).toString('base64url')}});
 expect(verify('sha256',Buffer.from(head+'.'+claims),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url'))).toBe(true);
});
it.each(['https://127.0.0.1/private','https://fcm.googleapis.com.evil.test/send/a','https://web.push.apple.com@evil.test/a','http://fcm.googleapis.com/send/a','https://fcm.googleapis.com:444/send/a','https://fcm.googleapis.com/send/a#token'])('rejects an arbitrary or ambiguous destination before HTTP: %s',async endpoint=>{
 const f=fixture(),send=vi.fn<typeof fetch>(),sender=createDeskPushSender(generateRequestDetails,f.vapid,send);
 expect(await sender({...f.subscription,endpoint},notice)).toBe('retry');expect(send).not.toHaveBeenCalled();
});
it.each([404,410])('retires expired provider subscriptions after HTTP %s',async status=>{
 const f=fixture();expect(await createDeskPushSender(generateRequestDetails,f.vapid,async()=>new Response(null,{status}))(f.subscription,notice)).toBe('expired');
});
it.each([429,500,503])('keeps a notification for retry after provider HTTP %s',async status=>{
 const f=fixture();expect(await createDeskPushSender(generateRequestDetails,f.vapid,async()=>new Response('PRIVATE PROVIDER DETAIL',{status}))(f.subscription,notice)).toBe('retry');
});
it('does not send an already expired subscription',async()=>{
 const f=fixture(),send=vi.fn<typeof fetch>();expect(await createDeskPushSender(generateRequestDetails,f.vapid,send)({...f.subscription,expirationTime:Date.now()-1},notice)).toBe('expired');expect(send).not.toHaveBeenCalled();
});
it('bounds a hung provider request and aborts its HTTP transport',async()=>{
 vi.useFakeTimers();const f=fixture();let signal:AbortSignal|undefined;
 const send:typeof fetch=async(_url,init)=>{signal=init?.signal??undefined;return new Promise(()=>{});};
 const pending=createDeskPushSender(generateRequestDetails,f.vapid,send)(f.subscription,notice);await vi.advanceTimersByTimeAsync(5000);expect(await pending).toBe('retry');expect(signal?.aborted).toBe(true);
});
it('rejects extra notification data and malformed browser keys',()=>{
 const f=fixture();expect(()=>parseKitchenPushNotice({...notice,orderNumber:'PRIVATE'})).toThrow();expect(()=>parseDeskPushSubscription({...f.subscription,keys:{...f.subscription.keys,auth:'short'}})).toThrow();
});
it('uses an HTTPS VAPID contact rather than an email address',()=>{
 const f=fixture();expect(()=>createDeskPushSender(generateRequestDetails,{...f.vapid,subject:'mailto:someone@example.test'})).toThrow();
});
