import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {newInboxId} from '../packages/core/inbox';
import type {CustomerLink,CustomerLinkRequest} from '../packages/core/customer-links';
import {createPublicReadDatabase,type PublicReadDatabase} from './public-read-fixture';
let fixture:PublicReadDatabase;
beforeAll(async()=>{fixture=await createPublicReadDatabase();},30000);
afterAll(async()=>{await fixture?.db.close();});
beforeEach(async()=>{await fixture.resetBudgets();});
const request=(value:unknown)=>new Request('https://backend.example/functions/v1/public-read',{method:'POST',headers:{Origin:'https://shop.example','Content-Type':'application/json'},body:JSON.stringify(value)});

it.each(['order','khata']as const)('%s HTTP capability is confined to the original resource across two outlets and two businesses',async kind=>{
 const handler=fixture.handler(),snapshots=[fixture.source,fixture.branch,fixture.foreign];
 for(const [index,backup]of snapshots.entries()){
  const resource=kind==='order'?backup.tables.orders[0].id:backup.tables.creditAccounts[0].id,link=await fixture.issue(index===2?4:1,kind,resource),before=await fixture.fingerprint();
  const response=await handler(request({kind,token:link.token}));expect(response.status).toBe(200);const data=await response.json()as CustomerLink;
  expect(data.kind==='order'?data.order.id:data.account.id).toBe(resource);
  const wire=JSON.stringify(data);for(const privateValue of [link.token,'PRIVATE SOURCE','PRIVATE BRANCH NOTE'])expect(wire).not.toContain(privateValue);
  expect(data).not.toHaveProperty('businessId');expect(data).not.toHaveProperty('outletId');expect(data).not.toHaveProperty('events');
  expect((await handler(request({kind:kind==='order'?'khata':'order',token:link.token}))).status).toBe(404);
  expect((await handler(request({kind,token:link.token,resourceId:snapshots[(index+1)%3].tables.orders[0].id}))).status).toBe(400);
  expect(await fixture.fingerprint()).toBe(before);
 }
});
it('pages the exact khata entries without private notes or reminder records',async()=>{
 const account=fixture.source.tables.creditAccounts[0],link=await fixture.issue(2,'khata',account.id),handler=fixture.handler(),collected:string[]=[];let afterSequence=0,hasMore=true;
 while(hasMore){const response=await handler(request({kind:'khata',token:link.token,afterSequence,pageSize:2}));expect(response.status).toBe(200);const value=await response.json()as Extract<CustomerLink,{kind:'khata'}>;
  expect(value.account.entries.length).toBeLessThanOrEqual(2);for(const entry of value.account.entries){expect(entry).not.toHaveProperty('note');expect(entry).not.toHaveProperty('createdBy');collected.push(entry.id);}afterSequence=value.account.nextSequence;hasMore=value.account.hasMore;}
 expect(collected).toEqual(fixture.source.tables.creditEntries.filter(x=>x.accountId===account.id&&x.type!=='reminder').sort((a,b)=>a.sequence-b.sequence).map(x=>x.id));
});
it('one link is throttled across repeated and concurrent reads while another grant remains usable',async()=>{
 const resource=fixture.source.tables.orders[0].id,link=await fixture.issue(1,'order',resource),other=await fixture.issue(1,'order',resource),handler=fixture.handler({global:60,link:3}),before=await fixture.fingerprint();
 const responses=await Promise.all(Array.from({length:9},()=>handler(request({kind:'order',token:link.token}))));
 expect(responses.map(x=>x.status).sort()).toEqual([200,200,200,429,429,429,429,429,429]);
 for(const response of responses.filter(x=>x.status===429)){expect(Number(response.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);expect(Number(response.headers.get('Retry-After'))).toBeLessThanOrEqual(60);expect(await response.text()).not.toContain(link.token);}
 expect((await handler(request({kind:'order',token:other.token}))).status).toBe(200);expect(await fixture.fingerprint()).toBe(before);
 expect((await fixture.db.query<{read_count:number}>('select read_count from private.public_links where id=$1',[link.id])).rows[0].read_count).toBe(3);
});
it('unknown-token traffic shares a fixed installation budget without growing a table of random request identifiers',async()=>{
 const handler=fixture.handler({global:2,link:60});
 for(const token of ['a'.repeat(43),'b'.repeat(43)])expect((await handler(request({kind:'order',token}))).status).toBe(404);
 expect((await handler(request({kind:'order',token:'c'.repeat(43)}))).status).toBe(429);
 expect((await fixture.db.query<{n:number}>('select count(*)::integer n from private.public_read_budget')).rows).toEqual([{n:1}]);
 expect((await fixture.db.query<{requests:number}>('select requests from private.public_read_budget')).rows[0].requests).toBe(2);
});
it('a safely unavailable oversized ledger still consumes its budget instead of reopening unlimited failed reads',async()=>{
 const account=(await fixture.db.query<{account_id:string}>("select account_id from public.credit_entries where business_id=$1 group by account_id having count(*) filter(where type in('charge','adjustment'))>=2 limit 1",[fixture.source.tables.businesses[0].id])).rows[0];
 if(!account)throw Error('Use the original multi-debit ledger fixture.');
 const original=(await fixture.db.query<{id:string;amount:number}>('select id,amount from public.credit_entries where account_id=$1',[account.account_id])).rows,link=await fixture.issue(1,'khata',account.account_id),handler=fixture.handler({global:10,link:1});
 try{
  await fixture.db.query("update public.credit_entries set amount=case when type in('charge','adjustment') then 9007199254740991 when type='reminder' then 0 else 1 end where account_id=$1",[account.account_id]);
  const first=await handler(request({kind:'khata',token:link.token}));expect(first.status).toBe(503);expect(await first.text()).not.toContain(link.token);
  expect((await handler(request({kind:'khata',token:link.token}))).status).toBe(429);
  expect((await fixture.db.query<{read_count:number}>('select read_count from private.public_links where id=$1',[link.id])).rows[0].read_count).toBe(1);
 }finally{for(const row of original)await fixture.db.query('update public.credit_entries set amount=$2 where id=$1',[row.id,row.amount]);}
});
it('server windows reset counters without accepting a caller-selected clock or budget',async()=>{
 const link=await fixture.issue(1,'order',fixture.source.tables.orders[0].id),handler=fixture.handler({global:2,link:1});
 expect((await handler(request({kind:'order',token:link.token}))).status).toBe(200);expect((await handler(request({kind:'order',token:link.token}))).status).toBe(429);
 await fixture.db.exec('update private.public_read_budget set window_at=0,requests=60000;update private.public_links set read_window_at=0,read_count=60000;');
 expect((await handler(request({kind:'order',token:link.token}))).status).toBe(200);
 for(const addition of [{now:0},{globalLimit:60000},{linkLimit:60000}])expect((await handler(request({kind:'order',token:link.token,...addition}))).status).toBe(400);
});
it('expiry and completed revocation override an exhausted link budget on the next read',async()=>{
 const resource=fixture.source.tables.orders[0].id,expired=await fixture.issue(1,'order',resource),revoked=await fixture.issue(1,'order',resource),other=await fixture.issue(1,'order',resource),handler=fixture.handler({global:60,link:1});
 expect((await handler(request({kind:'order',token:revoked.token}))).status).toBe(200);
 await fixture.asRole(2,'authenticated','select public.revoke_public_link($1,$2) data',[revoked.id,newInboxId()]);
 await fixture.db.query('update private.public_links set created_at=created_at-172800000,expires_at=created_at-1 where id=$1',[expired.id]);
 for(const token of [expired.token,revoked.token,'x'.repeat(43)]){const response=await handler(request({kind:'order',token}));expect(response.status).toBe(404);expect(await response.json()).toEqual({error:'This link is unavailable. Ask the shop for a current link.'});}
 expect((await handler(request({kind:'order',token:other.token}))).status).toBe(200);
});
it.each(['anon','authenticated','service_role']as const)('%s cannot use unmetered legacy readers or write budget/capability rows',async role=>{
 const queries=['select public.read_order_link($1) data','select public.read_khata_link($1,0,50) data',"select private.read_public_link($1,'order',0,50) data"];
 for(const query of queries)await expect(fixture.asRole(role==='authenticated'?1:null,role,query,['a'.repeat(43)])).rejects.toMatchObject({code:'42501'});
 for(const table of ['public_links','public_read_budget'])for(const action of [`select * from private.${table}`,`delete from private.${table}`])await expect(fixture.asRole(role==='authenticated'?1:null,role,action)).rejects.toMatchObject({code:'42501'});
 if(role!=='service_role')await expect(fixture.asRole(role==='authenticated'?1:null,role,"select public.read_public_capability($1,'order') data",['a'.repeat(43)])).rejects.toMatchObject({code:'42501'});
});
it('invalid service pages and installation budgets fail atomically before consuming a read',async()=>{
 const input:CustomerLinkRequest={kind:'order',token:'a'.repeat(43),afterSequence:0,pageSize:50};
 for(const bad of [{...input,pageSize:1},{...input,afterSequence:1}])await expect(fixture.read(bad)).rejects.toMatchObject({code:'22023'});
 for(const limits of [{global:0,link:60},{global:60001,link:60},{global:60,link:0},{global:60,link:60001}])await expect(fixture.read(input,limits)).rejects.toMatchObject({code:'22023'});
 expect((await fixture.db.query<{requests:number}>('select requests from private.public_read_budget')).rows[0].requests).toBe(0);
});
it('the budget uses forced RLS and public endpoints remain invokers with no public definers',async()=>{
 expect((await fixture.db.query<{relrowsecurity:boolean;relforcerowsecurity:boolean}>("select relrowsecurity,relforcerowsecurity from pg_class where oid='private.public_read_budget'::regclass")).rows).toEqual([{relrowsecurity:true,relforcerowsecurity:true}]);
 expect((await fixture.db.query<{n:number}>("select count(*)::integer n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef")).rows).toEqual([{n:0}]);
});
