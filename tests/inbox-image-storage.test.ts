import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createCloudImageRemote} from '../apps/web/src/data/cloud-image-remote';
import {cloudConnectionTarget} from '../packages/core/cloud-connection';
import {operatorAccountHash} from '../packages/core/operators';
import type {SyncImageSource} from '../packages/core/sync-images';
import {shopDataFixture} from './shop-data-fixture';
import {prepareCloudMigration} from '../packages/core/cloud-records';
import {createBackup} from '../packages/core/backup';
import {emptyBackupTables,type MiseBackup} from '../packages/core/backup-tables';
import {captureInboxCommand,newInboxId} from '../packages/core/inbox';
import {inboxPng} from './inbox-fixture';
import {createInboxImageHandler,ImageAccessDenied,type ImageContext,type InboxImageStore} from '../supabase/functions/_shared/inbox-image-handler';
const uid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,jwt=(n:number)=>`owner.${n}.signature`,origin='https://shop.test';
let db:PGlite,source:MiseBackup,foreign:MiseBackup,branch:string,image:string;const objects=new Map<string,Uint8Array>();
async function asRole<T>(n:number|null,role:'anon'|'authenticated'|'service_role',query:string,args:unknown[]=[]){return db.transaction(async sql=>{
  await sql.exec(`set local role ${role}`);await sql.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role,...(n?{sub:uid(n)}:{}),user_metadata:{role:'owner'}})]);return (await sql.query<T>(query,args)).rows;
});}
async function rpc(n:number,name:string,args:unknown[]){return (await asRole<{data:unknown}>(n,'authenticated',`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) as data`,args))[0].data;}
async function storagePut(meta:ImageContext,bytes:Uint8Array){
  if(objects.has(meta.path))return false;
  await db.query('insert into storage.objects(bucket_id,name,metadata,user_metadata) values($1,$2,$3,$4)',['mise-inbox',meta.path,JSON.stringify({size:bytes.length,mimetype:meta.type}),JSON.stringify({sha256:meta.sha256})]);objects.set(meta.path,new Uint8Array(bytes));return true;
}
function store(overrides:Partial<InboxImageStore>={}):InboxImageStore {
  async function call(token:string,name:string,args:unknown[]){try{return await rpc(Number(token.split('.')[1]),name,args);}catch(error){if((error as {code:string}).code==='42501')throw new ImageAccessDenied();throw error;}}
  return {context:(token,id)=>call(token,'inbox_image_context',[id]),complete:(token,id,event)=>call(token,'complete_inbox_image',[id,event]),put:storagePut,get:async meta=>{const bytes=objects.get(meta.path);if(!bytes)throw new Error('missing');return new Uint8Array(bytes);},...overrides};
}
function request(n=1,method='PUT',body:Uint8Array|undefined=inboxPng,id=image,type='image/png'){
  return new Request(`https://api.test/inbox-image?image=${id}`,{method,headers:{Authorization:'Bearer '+jwt(n),Origin:origin,'Content-Type':type},...(method==='PUT'?{body:body?new Uint8Array(body).buffer:undefined}:{})});
}
function handler(overrides:Partial<InboxImageStore>={},event?:string){return createInboxImageHandler({store:store(overrides),origins:new Set([origin]),...(event?{newId:()=>event}:{})});}
async function context(n=1,id=image){return rpc(n,'inbox_image_context',[id]) as Promise<ImageContext>;}
async function uploadCount(){return (await db.query<{count:number}>("select count(*)::integer as count from public.events where command='inbox.image.upload'")).rows[0].count;}
beforeAll(async()=>{
  db=await PGlite.create();for(const name of ['supabase-auth.sql','supabase-storage.sql'])await db.exec(readFileSync(new URL('./fixtures/'+name,import.meta.url),'utf8'));
  const dir=new URL('../supabase/migrations/',import.meta.url);for(const name of readdirSync(dir).filter(n=>n.endsWith('.sql')).sort())await db.exec(readFileSync(new URL(name,dir),'utf8'));
  await db.exec("insert into storage.buckets values('mise-inbox','mise-inbox',false),('unrelated','unrelated',false)");
  source=await shopDataFixture();foreign=await shopDataFixture();image=source.tables.inboxItems[0].images[0].id;
  const b=emptyBackupTables(),setup={business:source.tables.businesses[0],outlet:{...source.tables.outlets[0],id:newInboxId()},owner:{...source.tables.members[0],outletIds:[] as string[]}};branch=setup.outlet.id;setup.owner.outletIds=[branch];
  const captured=captureInboxCommand({title:'Branch',text:'',url:'',images:[{...source.tables.inboxItems[0].images[0],id:newInboxId()}]},setup);
  b.businesses.push(setup.business);b.outlets.push(setup.outlet);b.members.push(setup.owner);b.inboxItems.push(captured.item);b.events.push(captured.event!);
  for(const n of [1,2,3,4,5,6])await db.query('insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,now())',[uid(n),`1415555010${n}`]);
  for(const [backup,n,skip] of [[source,1,false],[foreign,4,false],[createBackup(b),1,true]] as const){const plan=await prepareCloudMigration(backup,uid(n));await db.transaction(async sql=>{for(const record of plan.records){if(skip&&['businesses','members'].includes(record.table))continue;const keys=Object.keys(record.values);await sql.query(`insert into public.${record.table}(${keys.join(',')}) values(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(record.values));}});}
  for(const [n,role,outlet] of [[2,'manager',source.tables.outlets[0].id],[3,'manager',branch],[5,'staff',source.tables.outlets[0].id]] as const){const member=newInboxId();await db.query('insert into public.members(id,business_id,auth_user_id,name,role,created_at,updated_at) values($1,$2,$3,$4,$5,1,1)',[member,source.tables.businesses[0].id,uid(n),'"Person"',role]);await db.query('insert into public.member_outlets values($1,$2,$3)',[source.tables.businesses[0].id,member,outlet]);}
},30_000);
beforeEach(async()=>{objects.clear();await db.exec("delete from storage.objects;delete from public.events where command='inbox.image.upload';update public.inbox_images set uploaded_at=null;update auth.users set banned_until=null,deleted_at=null,is_anonymous=false,phone_confirmed_at=now();update public.members set active=true;update storage.buckets set public=false");});
afterAll(async()=>{await db?.close();});
it.each([1,2])('verified operator %s derives only the image metadata and canonical scoped path',async n=>{const meta=await context(n);expect(meta.path).toBe(`${meta.businessId}/${meta.outletId}/${meta.inboxId}/${meta.id}`);expect(meta.size).toBe(inboxPng.length);expect(meta.type).toBe('image/png');expect(meta).not.toHaveProperty('name');expect(meta).not.toHaveProperty('text');});
it.each([3,4,5,6])('operator %s cannot access an unassigned, foreign or unprivileged image',async n=>{await expect(context(n)).rejects.toMatchObject({code:'42501'});expect((await handler()(request(n))).status).toBe(403);expect(objects.size).toBe(0);});
it.each(['anon','service_role'] as const)('%s cannot invoke owner metadata or completion functions',async role=>{await expect(asRole(null,role,'select public.inbox_image_context($1)',[image])).rejects.toMatchObject({code:'42501'});await expect(asRole(null,role,'select public.complete_inbox_image($1,$2)',[image,newInboxId()])).rejects.toMatchObject({code:'42501'});});
it.each([1,2])('operator %s upload verifies actual bytes, records one atomic event, and downloads the identical original',async n=>{
  const h=handler(),upload=await h(request(n));expect(upload.status).toBe(200);expect(await upload.json()).toMatchObject({id:image,uploadedAt:expect.any(Number)});expect(await uploadCount()).toBe(1);
  const download=await h(request(n,'GET'));expect(download.status).toBe(200);expect(download.headers.get('cache-control')).toBe('no-store');expect(download.headers.get('x-content-type-options')).toBe('nosniff');expect(new Uint8Array(await download.arrayBuffer())).toEqual(inboxPng);
  const event=(await db.query<{after_data:unknown}>("select after_data from public.events where command='inbox.image.upload'")).rows[0];expect(event.after_data).toMatchObject({imageId:image});expect(event.after_data).not.toHaveProperty('sha256');expect(event.after_data).not.toHaveProperty('name');
});
it('lost upload responses and repeated uploads reuse verified immutable bytes and one completion event',async()=>{
  const h=handler({put:async(meta,bytes)=>{await storagePut(meta,bytes);throw new Error('lost response');}});
  expect((await h(request())).status).toBe(200);expect((await h(request())).status).toBe(200);expect(objects.size).toBe(1);expect(await uploadCount()).toBe(1);
});
it('audit failure leaves completion unset and the private object retryable',async()=>{
  const conflict=source.tables.events[0].id;expect((await handler({},conflict)(request())).status).toBe(503);expect((await context()).uploadedAt).toBeNull();expect(await uploadCount()).toBe(0);expect(objects.size).toBe(1);expect((await handler()(request())).status).toBe(200);expect(await uploadCount()).toBe(1);
});
it.each(['size','type','sha256'])('caller completion cannot bypass missing/wrong server object %s proof',async field=>{
  const meta=await context();await storagePut(meta,inboxPng);const metadata={size:field==='size'?1:meta.size,mimetype:field==='type'?'image/jpeg':meta.type};await db.query('update storage.objects set metadata=$1,user_metadata=$2',[JSON.stringify(metadata),JSON.stringify({sha256:field==='sha256'?'a'.repeat(64):meta.sha256})]);
  await expect(rpc(1,'complete_inbox_image',[image,newInboxId()])).rejects.toMatchObject({code:'55000'});expect((await context()).uploadedAt).toBeNull();expect(await uploadCount()).toBe(0);
});
it('missing objects cannot be marked uploaded directly',async()=>{await expect(rpc(1,'complete_inbox_image',[image,newInboxId()])).rejects.toMatchObject({code:'55000'});expect(await uploadCount()).toBe(0);});
it('hash mismatch, truncated/oversized bytes and wrong MIME never reach Storage',async()=>{
  const changed=new Uint8Array(inboxPng);changed[changed.length-1]^=1;expect((await handler()(request(1,'PUT',changed))).status).toBe(422);
  expect((await handler()(request(1,'PUT',inboxPng.subarray(0,8)))).status).toBe(400);expect((await handler()(request(1,'PUT',new Uint8Array(inboxPng.length+1)))).status).toBe(413);expect((await handler()(request(1,'PUT',inboxPng,image,'image/jpeg'))).status).toBe(415);expect(objects.size).toBe(0);expect(await uploadCount()).toBe(0);
});
it('member revocation during upload is checked again before completion',async()=>{
  const h=handler({put:async(meta,bytes)=>{await storagePut(meta,bytes);await db.query('update public.members set active=false where auth_user_id=$1',[uid(1)]);return true;}});expect((await h(request())).status).toBe(403);expect(await uploadCount()).toBe(0);expect(objects.size).toBe(1);
});
it('Auth revocation during download prevents returning the already fetched bytes',async()=>{
  const meta=await context();await storagePut(meta,inboxPng);const h=handler({get:async()=>{await db.query("update auth.users set banned_until=now()+interval '1 day' where id=$1",[uid(1)]);return new Uint8Array(inboxPng);}});const result=await h(request(1,'GET'));expect(result.status).toBe(403);expect(result.headers.get('content-type')).toContain('application/json');
});
it('downloaded or pre-existing corrupted bytes fail closed without overwrite or confirmation',async()=>{
  const meta=await context(),changed=new Uint8Array(inboxPng);changed[changed.length-1]^=1;await storagePut(meta,changed);
  expect((await handler()(request(1,'GET'))).status).toBe(503);expect((await handler()(request())).status).toBe(503);expect((await context()).uploadedAt).toBeNull();expect(objects.get(meta.path)).toEqual(changed);
});
it('restrictive bucket policy defeats permissive policies for reads/writes but preserves unrelated buckets',async()=>{
  const meta=await context();await storagePut(meta,inboxPng);
  for(const role of ['anon','authenticated'] as const){expect(await asRole(1,role,"select name from storage.objects where bucket_id='mise-inbox'")).toEqual([]);await expect(asRole(1,role,"insert into storage.objects(bucket_id,name) values('mise-inbox','new')")).rejects.toMatchObject({code:'42501'});expect(await asRole(1,role,"update storage.objects set name='changed' where bucket_id='mise-inbox' returning name")).toEqual([]);expect(await asRole(1,role,"delete from storage.objects where bucket_id='mise-inbox' returning name")).toEqual([]);}
  expect(await asRole(1,'authenticated',"insert into storage.objects(bucket_id,name) values('unrelated','ok') returning name")).toEqual([{name:'ok'}]);
});
it('public bucket drift refuses context and completion',async()=>{await db.exec("update storage.buckets set public=true where id='mise-inbox'");await expect(context()).rejects.toMatchObject({code:'55000'});await expect(rpc(1,'complete_inbox_image',[image,newInboxId()])).rejects.toMatchObject({code:'55000'});expect((await handler()(request())).status).toBe(503);});

it('rejects an anonymous account even if it has a confirmed phone and an owner membership',async()=>{
 const meta=await context();await storagePut(meta,inboxPng);await db.query('update auth.users set is_anonymous=true where id=$1',[uid(1)]);await expect(context()).rejects.toMatchObject({code:'42501'});await expect(rpc(1,'complete_inbox_image',[image,newInboxId()])).rejects.toMatchObject({code:'42501'});expect((await handler()(request(1,'GET'))).status).toBe(403);expect((await handler()(request())).status).toBe(403);expect(await uploadCount()).toBe(0);
});
it('rechecks anonymous-account drift after fetching bytes and before upload completion',async()=>{
 const meta=await context();await storagePut(meta,inboxPng);const h=handler({get:async()=>{await db.query('update auth.users set is_anonymous=true where id=$1',[uid(1)]);return new Uint8Array(inboxPng);}});expect((await h(request(1,'GET'))).status).toBe(403);expect(await uploadCount()).toBe(0);
 await db.query('update auth.users set is_anonymous=false where id=$1',[uid(1)]);const put=handler({put:async()=>{await db.query('update auth.users set is_anonymous=true where id=$1',[uid(1)]);return false;}});expect((await put(request())).status).toBe(403);expect((await db.query<{uploaded_at:number|null}>('select uploaded_at from public.inbox_images where id=$1',[image])).rows[0].uploaded_at).toBeNull();
});
async function withImageHttp<T>(run:(apiUrl:string)=>Promise<T>){
 const h=handler();let apiUrl='';const server=createServer(async(req,res)=>{try{const headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);const response=await h(new Request(apiUrl+req.url,{method:req.method,headers}));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch{res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"Unavailable"}');}});
 server.listen(0,'127.0.0.1');await once(server,'listening');apiUrl='http://127.0.0.1:'+(server.address() as {port:number}).port;try{return await run(apiUrl);}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
async function clientSource(n:number,apiUrl:string):Promise<SyncImageSource>{
 const meta=await context(),member=(await db.query<{id:string;role:string}>('select id,role from public.members where auth_user_id=$1',[uid(n)])).rows[0],scope='/mise/app/'+meta.businessId,config={apiUrl,publishableKey:'sb_publishable_test_only'};
 return {version:1,readId:newInboxId(),sourceHash:'a'.repeat(64),readSeal:'b'.repeat(64),changeId:'1',recordHash:'c'.repeat(64),target:{targetHash:await cloudConnectionTarget(config,scope,uid(n)),accountHash:await operatorAccountHash(uid(n)),businessId:meta.businessId,outletId:meta.outletId,actorId:member?.id??newInboxId(),role:member?.role==='owner'?'owner':'manager'},image:{id:meta.id,businessId:meta.businessId,outletId:meta.outletId,inboxId:meta.inboxId,type:meta.type,size:meta.size,sha256:meta.sha256}};
}
it.each([1,2])('operator %s downloads original bytes through real client HTTP, image handler and SQL access checks',async n=>{
 const meta=await context();await storagePut(meta,inboxPng);await rpc(1,'complete_inbox_image',[image,newInboxId()]);const before=await uploadCount();await withImageHttp(async apiUrl=>{const source=await clientSource(n,apiUrl),config={apiUrl,publishableKey:'sb_publishable_test_only'},remote=createCloudImageRemote(config,'/mise/app/'+meta.businessId,async()=>({jwt:jwt(n),userId:uid(n)})),blob=await remote.get(source);expect(new Uint8Array(await blob.arrayBuffer())).toEqual(inboxPng);expect(blob.type).toBe('image/png');});expect(await uploadCount()).toBe(before);
});
it.each([3,4,5,6])('client HTTP still denies forbidden operator %s when it knows an image ID and hash',async n=>{
 const meta=await context();await storagePut(meta,inboxPng);await withImageHttp(async apiUrl=>{const source=await clientSource(n,apiUrl),remote=createCloudImageRemote({apiUrl,publishableKey:'sb_publishable_test_only'},'/mise/app/'+meta.businessId,async()=>({jwt:jwt(n),userId:uid(n)}));await expect(remote.get(source)).rejects.toMatchObject({kind:'auth'});});expect(await uploadCount()).toBe(0);
});
