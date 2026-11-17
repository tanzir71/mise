import 'fake-indexeddb/auto';
import { expect,test } from 'vitest';
import { readFileSync } from 'node:fs';
import { appManifest } from '../apps/web/pwa-manifest';
import { LocalStore } from '../apps/web/src/data/local-store';
import { captureDatabaseInbox } from '../apps/web/src/data/inbox';
import { maxShareBodyBytes,receiveSharedRequest,sharedRequestInput } from '../apps/web/src/data/share-target';
import { newInboxId } from '../packages/core/inbox';
import { inboxImageFile,inboxPng } from './inbox-fixture';

function request(form:FormData,base='/mise/app/'){return new Request(`https://example.com${base}inbox/receive`,{method:'POST',body:form});}
test('only the opt-in manifest advertises the portable POST image target',()=>{
  expect(appManifest('/mise/app/')).not.toHaveProperty('share_target');
  expect(JSON.parse(readFileSync('apps/web/public/manifest-share.webmanifest','utf8'))).toEqual(appManifest('./',true));
  for(const base of ['/app/','/mise/app/'])expect(appManifest(base,true)).toMatchObject({id:base,start_url:`${base}inbox?flags=shareTarget`,share_target:{action:`${base}inbox/receive`,method:'POST',enctype:'multipart/form-data',params:{text:'text',url:'url',files:[{name:'images',accept:['image/jpeg','image/png','image/webp']}]}}});
});
test('multipart text, links and files reach the real shared store before the 303 redirect',async()=>{
  const store=new LocalStore(`mise-share-${newInboxId()}`),form=new FormData();form.set('title','ছবি');form.set('text','  ২ কেজি চাল\r\n');form.set('url','javascript:untrusted');form.append('images',inboxImageFile());
  try{const response=await receiveSharedRequest(request(form),'/mise/app/',input=>captureDatabaseInbox(store,input));expect(response.status).toBe(303);const item=(await store.inboxItems.toArray())[0];expect(response.headers.get('location')).toBe(`https://example.com/mise/app/inbox/${item.id}?flags=shareTarget`);expect(item.text).toBe('  ২ কেজি চাল\r\n');expect(item.outletId).toBeNull();expect([...new Uint8Array(await item.images[0].blob.arrayBuffer())]).toEqual([...inboxPng]);expect(await store.events.count()).toBe(0);}finally{await store.delete();}
});
test('duplicate text fields, binary text, unsupported fields, malformed multipart and wrong content type fail before saving',async()=>{
  const forms=[new FormData(),new FormData(),new FormData()];forms[0].append('text','first');forms[0].append('text','second');forms[1].append('text',inboxImageFile());forms[2].append('unknown','value');
  let saves=0;const save=async()=>{saves++;return {id:newInboxId()};};
  for(const form of forms)expect((await receiveSharedRequest(request(form),'/app/',save)).status).toBe(400);
  for(const req of [new Request('https://example.com/app/inbox/receive',{method:'POST',body:'broken',headers:{'content-type':'multipart/form-data; boundary=missing'}}),new Request('https://example.com/app/inbox/receive',{method:'POST',body:'text=x'})])expect((await receiveSharedRequest(req,'/app/',save)).status).toBe(400);
  expect(saves).toBe(0);
});
test('an oversized stream is cancelled before multipart parsing or storage',async()=>{
  let cancelled=false,saves=0;const stream=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}}),req=new Request('https://example.com/app/inbox/receive',{method:'POST',headers:{'content-type':'multipart/form-data; boundary=x'},body:stream,duplex:'half'} as RequestInit&{duplex:'half'});
  const response=await receiveSharedRequest(req,'/app/',async()=>{saves++;return {id:newInboxId()};});expect(response.status).toBe(413);expect(cancelled).toBe(true);expect(saves).toBe(0);expect(maxShareBodyBytes).toBeLessThan(11*1024*1024);
});
test('storage failure returns a script-free manual fallback without claiming success',async()=>{
  const form=new FormData();form.set('text','<script>customer text</script>');const response=await receiveSharedRequest(request(form),'/mise/app/',async()=>{throw new Error('Quota exceeded');});expect(response.status).toBe(503);expect(response.headers.get('location')).toBeNull();expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");const html=await response.text();expect(html).toContain('/mise/app/inbox/new?flags=shareTarget');expect(html).not.toContain('<script>');expect(html).toContain('not saved');
});
test('an empty file chooser is omitted while all nonempty source files retain their bytes',async()=>{
  const form=new FormData();form.set('text','Rice');form.append('images',new File([],''));expect((await sharedRequestInput(request(form))).files).toEqual([]);
});
