import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {setupCommand} from '../packages/core/setup';
import {emptyBackupTables} from '../packages/core/backup-tables';
import {createBackup} from '../packages/core/backup';
import {prepareCloudMigration,type CloudRecord} from '../packages/core/cloud-records';
import {itemAvailabilityCommand} from '../packages/core/catalogue';
import {newInboxId} from '../packages/core/inbox';
import {parseCloudCommand,type CatalogueWrite,type CloudCommand,type CloudCommandReceipt} from '../packages/core/cloud-commands';
import {catalogueFingerprint,catalogueWriteFields} from '../supabase/functions/_shared/catalogue-write';
import {createCommandsHandler,createCommandStore} from '../supabase/functions/_shared/commands-handler';
import type {Item,SetupCommand} from '../packages/core/models';
const uid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,origin='https://shop.test';
const literal='পণ্য\u0000'+String.fromCharCode(0xd800);let db:PGlite,source:SetupCommand,branch:SetupCommand,foreign:SetupCommand;
const actors:{n:number;id:string;role:string;outlet:string;business:string}[]=[];
const initialCatalogue:CloudRecord[]=[];
async function asRole<T>(n:number|null,role:'anon'|'authenticated'|'service_role',query:string,args:unknown[]=[]){return db.transaction(async sql=>{
  await sql.exec(`set local role ${role}`);await sql.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role,...(n?{sub:uid(n)}:{}),user_metadata:{role:'owner',businessId:'spoof'}})]);return (await sql.query<T>(query,args)).rows;
});}
async function rpc(n:number,c:CloudCommand){return (await asRole<{data:CloudCommandReceipt}>(n,'authenticated','select public.apply_catalogue_command($1,$2,$3,$4,$5) as data',[c.id,c.type,c.type==='catalogue.availability'?c.itemId:null,c.type==='catalogue.availability'?c.available:null,c.type==='catalogue.undo'?c.undoOf:null]))[0].data;}
const change=(available=false,itemId=source.items[0].id,id=newInboxId()):CloudCommand=>({id,type:'catalogue.availability',itemId,available});
const undo=(undoOf:string,id=newInboxId()):CloudCommand=>({id,type:'catalogue.undo',undoOf});
function nativeStore(beforeFinish?:(fields:Record<string,unknown>)=>Promise<void>){return createCommandStore('https://database.test','sb_publishable_test_only',async(url,options)=>{
  const name=new URL(String(url)).pathname.split('/').at(-1)!,headers=new Headers(options?.headers),args=JSON.parse(options?.body as string),service=headers.get('apikey')==='sb_secret_test_only',n=service?null:Number(headers.get('Authorization')!.split('.')[1]);
  const fields:Record<string,string[]>={apply_catalogue_command:['p_id','p_type','p_item_id','p_available','p_undo_of'],prepare_catalogue_write:['p_id','p_ticket_id','p_type','p_item_id','p_outlet_id','p_hash'],finish_catalogue_write:['p_ticket_id','p_token','p_name_json','p_local_json','p_unit_json','p_price','p_category_id','p_new_category_json','p_available','p_often_bought']};
  if(!fields[name])throw new Error('Unexpected RPC');if(name==='finish_catalogue_write'){expect(service).toBe(true);expect(headers.has('Authorization')).toBe(false);await beforeFinish?.(args);}else expect(service).toBe(false);
  try{const result=await asRole<{data:unknown}>(n,service?'service_role':'authenticated',`select public.${name}(${fields[name].map((_,i)=>`$${i+1}`).join(',')}) as data`,fields[name].map(k=>args[k]));return new Response(JSON.stringify(result[0].data));}
  catch(error){const {code,detail:details}=error as {code:string;detail?:string};return new Response(JSON.stringify({code,details}),{status:code==='42501'?403:code==='23505'||code==='PT409'?409:code==='22023'?400:500});}
}, {serviceKey:'sb_secret_test_only'});}
async function http(n:number,c:unknown,beforeFinish?:(fields:Record<string,unknown>)=>Promise<void>){const handler=createCommandsHandler({origins:new Set([origin]),store:nativeStore(beforeFinish)});return handler(new Request('https://api.test/commands',{method:'POST',headers:{Authorization:`Bearer user.${n}.signature`,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(c)}));}
async function counts(){return (await db.query<{receipts:number;events:number}>("select (select count(*)::integer from private.command_receipts) as receipts,(select count(*)::integer from public.events where command like 'catalogue.%') as events")).rows[0];}
async function item(){return (await db.query<{available:boolean;updated_at:number}>('select available,updated_at from public.items where id=$1',[source.items[0].id])).rows[0];}
beforeAll(async()=>{
  db=await PGlite.create();for(const name of ['supabase-auth.sql','supabase-storage.sql'])await db.exec(readFileSync(new URL('./fixtures/'+name,import.meta.url),'utf8'));
  const dir=new URL('../supabase/migrations/',import.meta.url);for(const name of readdirSync(dir).filter(n=>n.endsWith('.sql')).sort())await db.exec(readFileSync(new URL(name,dir),'utf8'));
  for(const n of [1,2,3,4,5,6,7])await db.query('insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,now())',[uid(n),`1415555010${n}`]);
  const input={businessType:'corner_shop' as const,marketCode:'BD' as const,name:'Catalogue',phone:'01712345482'};
  source=setupCommand(input);source.items[0].name=literal;branch=setupCommand({...input,name:'Branch'});foreign=setupCommand({...input,name:'Foreign'});
  branch.snapshot.business=source.snapshot.business;branch.snapshot.outlet.businessId=source.snapshot.business.id;branch.snapshot.owner={...source.snapshot.owner,outletIds:[branch.snapshot.outlet.id]};
  for(const [setup,n,skip] of [[source,1,false],[branch,1,true],[foreign,4,false]] as const){const t=emptyBackupTables();t.businesses.push(setup.snapshot.business);t.outlets.push(setup.snapshot.outlet);t.members.push(setup.snapshot.owner);t.items.push(...setup.items);t.categories.push(...setup.categories);const plan=await prepareCloudMigration(createBackup(t),uid(n));initialCatalogue.push(...plan.records.filter(r=>r.table==='items'||r.table==='categories'));await db.transaction(async sql=>{for(const record of plan.records){if(skip&&['businesses','members'].includes(record.table))continue;const keys=Object.keys(record.values);await sql.query(`insert into public.${record.table}(${keys.join(',')}) values(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(record.values));}});}
  actors.push({n:1,id:source.snapshot.owner.id,role:'owner',outlet:source.snapshot.outlet.id,business:source.snapshot.business.id},{n:4,id:foreign.snapshot.owner.id,role:'owner',outlet:foreign.snapshot.outlet.id,business:foreign.snapshot.business.id});
  for(const [n,role,outlet] of [[2,'manager',source.snapshot.outlet.id],[3,'manager',branch.snapshot.outlet.id],[5,'staff',source.snapshot.outlet.id],[6,'agent',source.snapshot.outlet.id]] as const){const id=newInboxId();await db.query('insert into public.members(id,business_id,auth_user_id,name,role,created_at,updated_at) values($1,$2,$3,$4,$5,1,1)',[id,source.snapshot.business.id,uid(n),'"Person"',role]);actors.push({n,id,role,outlet,business:source.snapshot.business.id});await db.query('insert into public.member_outlets values($1,$2,$3)',[source.snapshot.business.id,id,outlet]);}
},30_000);
beforeEach(async()=>{
  await db.exec("delete from private.catalogue_write_tickets;delete from private.command_receipts;delete from public.events where command like 'catalogue.%';delete from public.items;delete from public.categories;update auth.users set phone='1415555010'||right(id::text,1),phone_confirmed_at=now(),banned_until=null,deleted_at=null;update public.members set active=true");
  for(const a of actors){await db.query('update public.members set role=$1,auth_user_id=$2 where id=$3',[a.role,uid(a.n),a.id]);await db.query('insert into public.member_outlets values($1,$2,$3) on conflict do nothing',[a.business,a.id,a.outlet]);}
  for(const record of initialCatalogue){const keys=Object.keys(record.values);await db.query(`insert into public.${record.table}(${keys.join(',')}) values(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(record.values));}
});
afterAll(async()=>{await db?.close();});
it.each([1,2])('operator %s applies one availability intent and its core-compatible audit in one transaction',async n=>{
  const command=change(),response=await http(n,command);expect(response.status).toBe(200);const result=await response.json() as CloudCommandReceipt;expect(result).toMatchObject({id:command.id,type:command.type,itemId:source.items[0].id,outletId:source.snapshot.outlet.id,available:false,undoOf:null});expect(result.sequence).toBeGreaterThan(0);expect((await item()).available).toBe(false);expect(await counts()).toEqual({receipts:1,events:1});
  const event=(await db.query<{before_data:Item;after_data:Item;actor_id:string;at:number}>('select before_data,after_data,actor_id,at from public.events where id=$1',[command.id])).rows[0],expected=itemAvailabilityCommand(event.before_data,false,event.actor_id,result.itemUpdatedAt);
  expect(event.before_data.name).toBe(literal);expect(event.after_data).toEqual(expected.item);expect(event.at).toBe(result.at);expect(event.actor_id).toBe(actors.find(a=>a.n===n)!.id);
});
it('identical retries return the same receipt and do not repeat writes or audits',async()=>{const c=change(),first=await rpc(1,c),second=await rpc(1,c);expect(second).toEqual(first);expect(await counts()).toEqual({receipts:1,events:1});});
it('replaying an older accepted command never overwrites a newer catalogue change',async()=>{const c=change(false),first=await rpc(1,c);await rpc(1,change(true));expect(await rpc(1,c)).toEqual(first);expect((await item()).available).toBe(true);expect(await counts()).toEqual({receipts:2,events:2});});
it.each(['value','target','type'])('a reused ID with different %s intent is rejected without another change',async field=>{const c=change();await rpc(1,c);const next=field==='value'?change(true,source.items[0].id,c.id):field==='target'?change(false,source.items[1].id,c.id):undo(c.id,c.id);expect((await http(1,next)).status).toBe(409);expect(await counts()).toEqual({receipts:1,events:1});});
it('another assigned operator cannot take over a receipt ID',async()=>{const c=change();await rpc(1,c);expect((await http(2,c)).status).toBe(403);expect(await counts()).toEqual({receipts:1,events:1});});
it.each([3,4,5,6,7])('operator %s cannot change another outlet/business or bypass their role',async n=>{expect((await http(n,change())).status).toBe(403);expect(await counts()).toEqual({receipts:0,events:0});expect((await item()).available).toBe(source.items[0].available);});
it('owners cover their branch and managers remain assigned to the correct branch',async()=>{expect((await http(1,change(false,branch.items[0].id))).status).toBe(200);expect((await http(3,change(true,branch.items[0].id))).status).toBe(200);expect((await http(2,change(false,branch.items[0].id))).status).toBe(403);expect((await http(4,change(false,foreign.items[0].id))).status).toBe(200);});
it.each(['anon','service_role'] as const)('%s cannot invoke command mutations or inspect receipts',async role=>{await expect(asRole(null,role,"select public.apply_catalogue_command($1,'catalogue.availability',$2,false,null)",[newInboxId(),source.items[0].id])).rejects.toMatchObject({code:'42501'});await expect(asRole(null,role,'select * from private.command_receipts')).rejects.toMatchObject({code:'42501'});});
it('sets use the latest committed state, preserve the losing value and retain ordered receipts',async()=>{const a=await rpc(1,change(false)),b=await rpc(2,change(true));expect(b.sequence).toBeGreaterThan(a.sequence);expect(b.at).toBeGreaterThanOrEqual(a.at);expect((await item()).available).toBe(true);const event=(await db.query<{before_data:Item;after_data:Item}>('select before_data,after_data from public.events where id=$1',[b.id])).rows[0];expect(event.before_data.available).toBe(false);expect(event.after_data.available).toBe(true);});
it('guarded undo restores the previous flag, logs its actor/source, and is idempotent',async()=>{const c=await rpc(1,change(false)),u=undo(c.id),result=await rpc(2,u);expect(result.available).toBe(source.items[0].available);expect(result.undoOf).toBe(c.id);expect(await rpc(2,u)).toEqual(result);expect(await counts()).toEqual({receipts:2,events:2});const row=(await db.query<{undo_of:string;command:string}>('select undo_of,command from public.events where id=$1',[u.id])).rows[0];expect(row).toEqual({undo_of:c.id,command:'catalogue.availability.undo'});});
it('undo cannot erase a newer intent, even when it requested the same value',async()=>{const c=await rpc(1,change(false));await rpc(1,change(false));expect((await http(1,undo(c.id))).status).toBe(409);expect((await item()).available).toBe(false);expect(await counts()).toEqual({receipts:2,events:2});});
it('an undo cannot be undone again or applied across an unauthorized outlet',async()=>{const c=await rpc(1,change(false)),u=await rpc(1,undo(c.id));expect((await http(1,undo(u.id))).status).toBe(403);expect((await http(3,undo(c.id))).status).toBe(403);});
it('audit ID collisions roll back the item and receipt together',async()=>{const event=newInboxId();await db.query("insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at) values($1,$2,$3,'member',$4,'fixture','null','null',1)",[event,source.snapshot.business.id,source.snapshot.outlet.id,source.snapshot.owner.id]);await expect(rpc(1,change(false,source.items[0].id,event))).rejects.toMatchObject({code:'23505'});expect(await counts()).toEqual({receipts:0,events:0});expect((await item()).available).toBe(source.items[0].available);});
it.each(['active','phone','ban','deleted','assignment'])('live %s revocation denies both a write and a receipt replay',async reason=>{const c=change();await rpc(2,c);if(reason==='active')await db.query('update public.members set active=false where auth_user_id=$1',[uid(2)]);else if(reason==='assignment')await db.query('delete from public.member_outlets where member_id=$1',[actors.find(a=>a.n===2)!.id]);else await db.query(reason==='phone'?'update auth.users set phone_confirmed_at=null where id=$1':reason==='ban'?"update auth.users set banned_until=now()+interval '1 day' where id=$1":'update auth.users set deleted_at=now() where id=$1',[uid(2)]);expect((await http(2,c)).status).toBe(403);expect((await http(2,change(true))).status).toBe(403);expect(await counts()).toEqual({receipts:1,events:1});});
it('availability preserves unrelated data, and legacy future creation times do not falsify audit server time',async()=>{const future=Date.now()+86400000;await db.query('update public.items set created_at=$1,updated_at=$1,variants=$2,photo_ref=$3 where id=$4',[future,JSON.stringify([{name:literal,price:1234}]),'kept/photo',source.items[0].id]);const result=await rpc(1,change(false));expect(result.at).toBeLessThan(future);expect(result.itemUpdatedAt).toBe(future);const row=(await db.query<{variants:unknown;photo_ref:string}>('select variants,photo_ref from public.items where id=$1',[source.items[0].id])).rows[0];expect(row).toEqual({variants:[{name:literal,price:1234}],photo_ref:'kept/photo'});});
it('raw authenticated writes and receipt reads remain denied',async()=>{await expect(asRole(1,'authenticated','update public.items set available=false where id=$1',[source.items[0].id])).rejects.toMatchObject({code:'42501'});await expect(asRole(1,'authenticated','select * from private.command_receipts')).rejects.toMatchObject({code:'42501'});});
it.each([{}, {id:'bad',type:'catalogue.availability'}, {id:'0'.repeat(26),type:'catalogue.availability',itemId:'0'.repeat(26),available:'false'}, {id:'0'.repeat(26),type:'catalogue.undo',undoOf:'0'.repeat(26),role:'owner'}])('shared validation refuses unsupported or spoofed intent %j',async value=>{expect(()=>parseCloudCommand(value)).toThrow();expect((await http(1,value)).status).toBe(400);expect(await counts()).toEqual({receipts:0,events:0});});

const input=()=>({name:` ${literal} `,nameLocal:literal,price:1234,unit:' pc ',category:' New Drinks ',available:true,oftenBought:false});
const create=():CatalogueWrite=>({id:newInboxId(),type:'catalogue.create',itemId:newInboxId(),outletId:source.snapshot.outlet.id,input:input()});
interface Prepared {done:false;ticketId:string;token:string;outletId:string;actorId:string;at:number;itemJson:string;categoriesJson:string}
async function prepare(n:number,c:CatalogueWrite){return (await asRole<{data:Prepared}>(n,'authenticated','select public.prepare_catalogue_write($1,$2,$3,$4,$5,$6) as data',[c.id,newInboxId(),c.type,c.itemId,c.type==='catalogue.create'?c.outletId:null,await catalogueFingerprint(parseCloudCommand(c) as CatalogueWrite)]))[0].data;}
function finishFields(p:Prepared,c:CatalogueWrite){return catalogueWriteFields(p,parseCloudCommand(c) as CatalogueWrite,p.ticketId,newInboxId);}
async function finish(p:Prepared,c:CatalogueWrite,role:'authenticated'|'service_role'='service_role'){
  const f=finishFields(p,c),keys=['p_ticket_id','p_token','p_name_json','p_local_json','p_unit_json','p_price','p_category_id','p_new_category_json','p_available','p_often_bought'];
  return asRole<{data:CloudCommandReceipt}>(role==='authenticated'?1:null,role,'select public.finish_catalogue_write('+keys.map((_,i)=>`$${i+1}`).join(',')+') as data',keys.map(k=>f[k]));
}
it.each([1,2])('operator %s creates and edits with shared Unicode validation and normalized category reuse',async n=>{
  const c=create(),created=await http(n,c);expect(created.status).toBe(200);const receipt=await created.json();expect(receipt.type).toBe('catalogue.create');
  const before=(await db.query<{name:string;category_id:string;created_at:number}>('select name,category_id,created_at from public.items where id=$1',[c.itemId])).rows[0];expect(before.name).toBe(literal);
  const edited=await http(n,{id:newInboxId(),type:'catalogue.update',itemId:c.itemId,input:{...input(),price:4567,category:'Ｎｅｗ Ｄｒｉｎｋｓ',available:false}});expect(edited.status).toBe(200);
  const after=(await db.query<{category_id:string;price:number;created_at:number;available:boolean}>('select category_id,price,created_at,available from public.items where id=$1',[c.itemId])).rows[0];expect(after).toEqual({category_id:before.category_id,price:4567,created_at:before.created_at,available:false});expect(await counts()).toEqual({receipts:2,events:2});
});
it('create, edit and delete replay their original receipts without recreating a deleted item',async()=>{
  const c=create(),first=await nativeStore().apply('user.1.signature',parseCloudCommand(c));expect(await nativeStore().apply('user.1.signature',parseCloudCommand(c))).toEqual(first);
  const edit:CatalogueWrite={id:newInboxId(),type:'catalogue.update',itemId:c.itemId,input:{...input(),available:false}};await nativeStore().apply('user.1.signature',parseCloudCommand(edit));expect(await nativeStore().apply('user.1.signature',parseCloudCommand(c))).toEqual(first);
  const remove:CatalogueWrite={id:newInboxId(),type:'catalogue.delete',itemId:c.itemId},deleted=await nativeStore().apply('user.1.signature',remove);expect((deleted as CloudCommandReceipt).available).toBeNull();expect(await nativeStore().apply('user.1.signature',remove)).toEqual(deleted);
  expect((await db.query('select id from public.items where id=$1',[c.itemId])).rows).toEqual([]);expect(await counts()).toEqual({receipts:3,events:3});
});
it.each([3,4,5,6,7])('operator %s cannot prepare a foreign/unassigned create or supply service mutations',async n=>{expect((await http(n,create())).status).toBe(403);expect((await db.query('select id from private.catalogue_write_tickets')).rows).toEqual([]);expect(await counts()).toEqual({receipts:0,events:0});});
it('ordinary authenticated callers cannot finish even their own valid ticket',async()=>{const c=create(),p=await prepare(1,c);await expect(finish(p,c,'authenticated')).rejects.toMatchObject({code:'42501'});expect(await counts()).toEqual({receipts:0,events:0});});
it('context changes rebase the original set intent and audit the latest state',async()=>{
  let calls=0;const c:CatalogueWrite={id:newInboxId(),type:'catalogue.update',itemId:source.items[0].id,input:input()};
  expect((await http(1,c,async()=>{if(calls++===0)await rpc(1,change(false));})).status).toBe(200);expect(calls).toBe(2);
  const e=(await db.query<{before_data:Item;after_data:{item:Item}}>('select before_data,after_data from public.events where id=$1',[c.id])).rows[0];expect(e.before_data.available).toBe(false);expect(e.after_data.item.available).toBe(true);expect(await counts()).toEqual({receipts:2,events:2});
});
it('a concurrent normalized category creation is reused after bounded re-preparation',async()=>{
  let calls=0;const c=create();expect((await http(1,c,async()=>{if(calls++===0){const other=create();expect((await http(1,other)).status).toBe(200);}})).status).toBe(200);expect(calls).toBe(2);
  const rows=(await db.query<{name:string}>('select name from public.categories where outlet_id=$1',[source.snapshot.outlet.id])).rows;expect(rows.filter(r=>r.name.normalize('NFKC').toLowerCase()==='new drinks')).toHaveLength(1);
});
it('expired or invalid tickets and private snapshots cannot bypass the one-minute scope proof',async()=>{
  const c=create(),p=await prepare(1,c);const row=(await db.query<{token_hash:Uint8Array;expires_at:number}>('select token_hash,expires_at from private.catalogue_write_tickets where id=$1',[p.ticketId])).rows[0];expect(row.expires_at-p.at).toBe(60000);expect(JSON.stringify(row)).not.toContain(p.token);
  await expect(asRole(1,'authenticated','select * from private.catalogue_write_tickets')).rejects.toMatchObject({code:'42501'});await expect(asRole(null,'service_role','select * from private.catalogue_write_tickets')).rejects.toMatchObject({code:'42501'});
  await expect(finish({...p,token:'A'.repeat(43)},c)).rejects.toMatchObject({code:'PT409',detail:'catalogue_snapshot_changed'});await db.query('update private.catalogue_write_tickets set expires_at=1 where id=$1',[p.ticketId]);await expect(finish(p,c)).rejects.toMatchObject({code:'PT409',detail:'catalogue_snapshot_changed'});expect(await counts()).toEqual({receipts:0,events:0});
});
it('live authorization is checked again by the service commit rather than its own identity',async()=>{const c=create();expect((await http(2,c,async()=>{await db.query('update public.members set active=false where auth_user_id=$1',[uid(2)]);})).status).toBe(403);expect(await counts()).toEqual({receipts:0,events:0});});
it('persistent snapshot races stop after three attempts without an accepted mutation',async()=>{let calls=0;expect((await http(1,create(),async()=>{calls++;await db.exec('update private.catalogue_write_tickets set expires_at=1');})).status).toBe(409);expect(calls).toBe(3);expect(await counts()).toEqual({receipts:0,events:0});});
it('audit collisions roll back a newly created category, item and receipt as one transaction',async()=>{
  const c=create(),before=(await db.query<{count:number}>('select count(*)::integer as count from public.categories')).rows[0].count;
  await db.query("insert into public.events(id,business_id,outlet_id,actor_type,actor_id,command,before_data,after_data,at) values($1,$2,$3,'member',$4,'fixture','null','null',1)",[c.id,source.snapshot.business.id,source.snapshot.outlet.id,source.snapshot.owner.id]);
  expect((await http(1,c)).status).toBe(409);expect((await db.query('select id from public.items where id=$1',[c.itemId])).rows).toEqual([]);expect((await db.query<{count:number}>('select count(*)::integer as count from public.categories')).rows[0].count).toBe(before);expect(await counts()).toEqual({receipts:0,events:0});
});
it('edit retains unsupported variants/photos and delete retains the full original row privately',async()=>{
  await db.query('update public.items set variants=$1,photo_ref=$2 where id=$3',[JSON.stringify([{name:literal,price:1234}]),'original/photo',source.items[0].id]);
  const c:CatalogueWrite={id:newInboxId(),type:'catalogue.update',itemId:source.items[0].id,input:input()};expect((await http(1,c)).status).toBe(200);
  const after=(await db.query<{variants:unknown;photo_ref:string}>('select variants,photo_ref from public.items where id=$1',[c.itemId])).rows[0];expect(after).toEqual({variants:[{name:literal,price:1234}],photo_ref:'original/photo'});
  const remove:CatalogueWrite={id:newInboxId(),type:'catalogue.delete',itemId:c.itemId};expect((await http(1,remove)).status).toBe(200);
  const retained=(await db.query<{before_record:{variants:unknown;photo_ref:string};after_record:unknown}>('select before_record,after_record from private.command_receipts where id=$1',[remove.id])).rows[0];expect(retained.before_record.variants).toEqual(after.variants);expect(retained.before_record.photo_ref).toBe(after.photo_ref);expect(retained.after_record).toBeNull();
});
it('valid maximum-length escaped Unicode fits the bounded command request and round-trips',async()=>{
  const c=create();if(c.type!=='catalogue.create')throw new Error('Expected create');c.input={name:'\0'.repeat(120),nameLocal:String.fromCharCode(0xd800).repeat(120),unit:'\0'.repeat(16),category:'\0'.repeat(80),price:Number.MAX_SAFE_INTEGER,available:true,oftenBought:false};
  expect(new TextEncoder().encode(JSON.stringify(c)).byteLength).toBeGreaterThan(2048);expect((await http(1,c)).status).toBe(200);
  const row=(await db.query<{name:string;name_local:string;unit:string;price:number}>('select name,name_local,unit,price from public.items where id=$1',[c.itemId])).rows[0];expect(row).toEqual({name:c.input.name,name_local:c.input.nameLocal,unit:c.input.unit,price:c.input.price});
});
async function revokeCatalogueAccess(reason:string){
  const actor=actors.find(a=>a.n===2)!;
  if(reason==='active')await db.query('update public.members set active=false where id=$1',[actor.id]);
  else if(reason==='assignment')await db.query('delete from public.member_outlets where member_id=$1',[actor.id]);
  else if(reason==='role')await db.query("update public.members set role='staff' where id=$1",[actor.id]);
  else if(reason==='subject')await db.query('update public.members set auth_user_id=$1 where id=$2',[uid(7),actor.id]);
  else await db.query(reason==='phone'?'update auth.users set phone_confirmed_at=null where id=$1':reason==='phone-number'?"update auth.users set phone='' where id=$1":reason==='ban'?"update auth.users set banned_until=now()+interval '1 day' where id=$1":'update auth.users set deleted_at=now() where id=$1',[uid(2)]);
}
it.each(['active','assignment','role','subject','phone','phone-number','ban','deleted'])('a prepared ticket cannot outlive live %s authorization',async reason=>{
  const c=create(),p=await prepare(2,c);await revokeCatalogueAccess(reason);await expect(finish(p,c)).rejects.toMatchObject({code:'42501'});
  expect((await http(2,c)).status).toBe(403);expect((await db.query('select id from public.items where id=$1',[c.itemId])).rows).toEqual([]);expect(await counts()).toEqual({receipts:0,events:0});
});
it.each(['active','assignment','role','subject','phone','phone-number','ban','deleted'])('accepted create receipts remain private after %s revocation',async reason=>{
  const c=create();expect((await http(2,c)).status).toBe(200);await revokeCatalogueAccess(reason);expect((await http(2,c)).status).toBe(403);
  if(reason==='subject')expect((await http(7,c)).status).toBe(403);expect(await counts()).toEqual({receipts:1,events:1});
});
it('create/update/delete IDs bind the exact normalized request and original operator',async()=>{
  const c=create();expect((await http(1,c)).status).toBe(200);
  expect((await http(1,{...c,input:{...input(),price:999}})).status).toBe(409);expect((await http(2,c)).status).toBe(403);
  expect((await http(1,{id:c.id,type:'catalogue.delete',itemId:c.itemId})).status).toBe(409);
  expect((await http(1,{...c,itemId:newInboxId()})).status).toBe(409);expect(await counts()).toEqual({receipts:1,events:1});
});
it('catalogue edits prevent an older availability undo from erasing a newer intent',async()=>{
  const old=await rpc(1,change(false));expect((await http(1,{id:newInboxId(),type:'catalogue.update',itemId:old.itemId,input:{...input(),available:false}})).status).toBe(200);
  expect((await http(1,undo(old.id))).status).toBe(409);expect(await counts()).toEqual({receipts:2,events:2});
});
