import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {createPublicOrderDatabase} from './public-order-fixture';
import {deviceId} from './device-pairing-fixture';
import {newInboxId} from '../packages/core/inbox';
import {parseOrderQuote,type OrderConfirmation} from '../packages/core/order-confirmation';
import {orderConfirmationRecords} from '../packages/core/order-confirmation-projection';
import {publicOrderHash} from '../packages/core/public-order-submission';
import {saveCustomerCommand} from '../packages/core/customers';
import {defaultCreditTerms,saveCreditTermsCommand,openingBalanceCommand} from '../packages/core/khata';
import {saveOrderCommand,type OrderInput} from '../packages/core/orders';
import {decodeCommandRecord,encodeCommandRecord,type CloudRecord} from '../packages/core/cloud-records';
import type {Order} from '../packages/core/models';
import fc from 'fast-check';
import {parseCheckoutPolicyContext,parseCheckoutPolicyAction,parseCheckoutPolicyOutcome} from '../packages/core/checkout-policy';
let f:Awaited<ReturnType<typeof createPublicOrderDatabase>>,orderId:string;
beforeAll(async()=>{f=await createPublicOrderDatabase();},30000);
beforeEach(async()=>{await f.seed();await f.db.exec('update private.order_confirmation_budget set window_at=0,requests=0');await f.publish();const request=await f.intent();await f.finish(request,await f.prepare(request));orderId=request.source.orderId;});
afterAll(async()=>{await f?.db.close();});
const token='T'.repeat(43);
const call=(operation:string,source:OrderConfirmation|null=null,secret=token,global=1000,limit=30)=>f.asRole<Record<string,unknown>>(null,'service_role','select public.prepare_order_confirmation($1,$2,$3,$4,$5) data',[secret,source===null?null:JSON.stringify(source),operation,global,limit]);
async function intent():Promise<OrderConfirmation>{const q=await call('quote');expect(q.state).toBe('quote');return {v:1,id:newInboxId(),quoteHash:q.quoteHash as string,swaps:[],payment:{method:'cash',walletId:null},ids:{updateEventId:newInboxId(),pricedEventId:newInboxId(),acceptedEventId:newInboxId(),paymentEventId:newInboxId(),saleId:newInboxId(),saleEventId:newInboxId(),entryId:newInboxId(),creditEventId:newInboxId()}};}
const finish=async(i:OrderConfirmation,p:Record<string,unknown>,records?:unknown)=>f.asRole<Record<string,unknown>>(null,'service_role','select public.finish_order_confirmation($1,$2,$3) data',[i.id,p.ticketToken,JSON.stringify(records??await orderConfirmationRecords(p,i))]);
const wallet=()=>({id:newInboxId(),name:'bKash',phone:'+14155550199',url:'bkash://'});
const walletAction=(wallets:unknown[],revision=0)=>({v:1,id:newInboxId(),kind:'wallets',revision,orderId:null,orderRevision:null,wallets,enabled:null,maximum:null});
const policy=(action:unknown,operation='submit',actor=1)=>f.asRole<Record<string,unknown>>(actor,'authenticated','select public.change_checkout_policy($1,$2,$3) data',[deviceId(11),JSON.stringify(action),operation]);
async function priced(swap=true,literal=false){
 return f.db.transaction(async tx=>{
 const insert=async(r:CloudRecord)=>tx.query(`insert into public.${r.table}(${Object.keys(r.values).join(',')}) values(${Object.keys(r.values).map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(r.values));
 const setup=f.setup,at=Date.now(),customerChange=saveCustomerCommand({name:'Sadia',nickname:'',phone:'+14155550150',address:'PRIVATE ADDRESS',notes:'PRIVATE KHATA NOTE',tags:[]},setup,[],null,at),customer=customerChange.customer;
 const terms=saveCreditTermsCommand({...defaultCreditTerms,allowed:true,limit:100000},customer,setup,null,at),account=terms.account;
 const opening=openingBalanceCommand(40000,at,{setup,customer,account,entries:[]},at),entry=opening.entry;
 await insert(encodeCommandRecord('customers',customer,setup.business.id));
 await tx.query('insert into public.customer_outlets(business_id,outlet_id,customer_id) values($1,$2,$3)',[setup.business.id,setup.outlet.id,customer.id]);
 for(const [table,value]of [['events',customerChange.event],['creditAccounts',account],['events',terms.event],['creditEntries',entry],['events',opening.event]]as const)await insert(encodeCommandRecord(table,value,setup.business.id));
 const before=decodeCommandRecord('orders',(await tx.query<{data:Record<string,unknown>}>('select row_to_json(o) data from public.orders o where id=$1',[orderId])).rows[0].data) as unknown as Order;
 const input:OrderInput={source:before.source,sourceText:literal?'Original \u0000 and \ud800 source <script>do not execute</script>':before.sourceText,customerId:customer.id,name:customer.name,phone:customer.phone!,type:before.type,address:before.address,table:before.table,lines:[...before.lines,...(swap?[{name:'Soya milk',unit:'bottle',qty:1,unitPrice:5000,note:literal?'Literal \u0000 \ud800 note':'',substitution:{from:'Fresh milk',accepted:false}}]:[])],deliveryFee:before.deliveryFee,discount:before.discount,payment:{method:'cash'}};
 const change=saveOrderCommand(input,{setup,customer,items:[f.item],sequence:before.sequence},before,before.revision,at),r=encodeCommandRecord('orders',change.order,setup.business.id),values=Object.entries(r.values).filter(([k])=>k!=='id');
 await tx.query(`update public.orders set ${values.map(([k],i)=>k+'=$'+(i+1)).join(',')} where id=$${values.length+1}`,[...values.map(([,v])=>v),orderId]);await insert(encodeCommandRecord('events',change.event,setup.business.id));
 return {customer,account,entry,order:change.order,grant:{v:1,id:newInboxId(),kind:'credit',revision:0,orderId,orderRevision:change.order.revision,wallets:null,enabled:true,maximum:25000}};
 });
}

it('returns a current quote only for the original public order tracker, with no account permission inferred from its contact phone',async()=>{
 const q=await call('quote'),parsed=parseOrderQuote(JSON.parse(q.quoteJson as string));expect(parsed.orderId).toBe(orderId);expect(parsed.lines[0].lineTotal).toBe(20000);expect(parsed.wallets).toEqual([]);expect(parsed.credit).toBeNull();expect(q.quoteHash).toBe(await publicOrderHash(q.quoteJson as string));expect(JSON.stringify(q)).not.toContain(deviceId(101));
 expect((await call('quote',null,'X'.repeat(43))).state).toBe('missing');
 const readLink=await f.asRole<Record<string,unknown>>(1,'authenticated','select public.create_public_link($1,$2,$3,$4,$5) data',[newInboxId(),newInboxId(),'order',orderId,null]);
 expect((await call('quote',null,readLink.token as string)).state).toBe('unavailable');
});
it('commits actual Core order and status images once while cash stays unpaid, then returns the historical outcome after a lost reply',async()=>{
 const i=await intent(),p=await call('submit',i),records=await orderConfirmationRecords(p,i),result=await finish(i,p,records);expect(result.state).toBe('applied');expect(result.receipt).toMatchObject({orderId,revision:4,total:20000,paymentStatus:'pending',saleId:null,entryId:null});
 expect(await finish(i,p,records)).toEqual(result);expect(await call('inspect',i)).toEqual(result);expect(await call('close',i)).toEqual(result);
 expect((await f.db.query<{n:number}>('select count(*) n from public.sales')).rows[0].n).toBe(0);expect((await f.db.query<{n:number}>('select count(*) n from public.events where order_id=$1',[orderId])).rows[0].n).toBe(5);
});
it('retains the exact original source, rejects replacement bytes and fences a delayed submit after closure',async()=>{
 const i=await intent(),p=await call('submit',i);expect(p.state).toBe('prepared');const changed={...i,payment:{method:'credit' as const,walletId:null}};expect((await call('inspect',changed)).state).toBe('changed');
 const closed=await call('close',i);expect(closed.state).toBe('closed');expect(await call('submit',i)).toEqual(closed);expect((await finish(i,p,await orderConfirmationRecords(p,i))).state).toBe('conflict');
 expect((await f.db.query<{status:string}>('select status from public.orders where id=$1',[orderId])).rows[0].status).toBe('requested');
});
it('closes an original even before its first request and never accepts another link’s saved identity',async()=>{
 const i=await intent();expect((await call('inspect',i)).state).toBe('pending');const closed=await call('close',i);expect(await call('submit',i)).toEqual(closed);
 const other=await f.intent('U'.repeat(43));await f.finish(other,await f.prepare(other));expect((await call('inspect',i,other.trackingToken)).state).toBe('missing');
});
it('requires the unchanged quote and complete current context at final completion',async()=>{
 const i=await intent(),p=await call('submit',i),records=await orderConfirmationRecords(p,i);await f.db.query('update public.orders set revision=revision+1 where id=$1',[orderId]);expect((await finish(i,p,records)).state).toBe('conflict');expect((await call('submit',i)).state).toBe('changed');expect((await call('close',i)).state).toBe('closed');
});
it('immediately blocks quotation, pending completion and historical inspection when the actual tracker is revoked',async()=>{
 const i=await intent(),p=await call('submit',i),records=await orderConfirmationRecords(p,i);const link=(await f.db.query<{id:string}>('select id from private.public_links where order_id=$1',[orderId])).rows[0];await f.asRole(1,'authenticated','select public.revoke_public_link($1,$2) data',[link.id,newInboxId()]);expect((await call('quote')).state).toBe('missing');expect((await call('inspect',i)).state).toBe('missing');expect((await finish(i,p,records)).state).toBe('missing');
});
it('retains public wallet settings with actor-bound original receipts and does not create any finance',async()=>{
 const w=wallet(),a=walletAction([w]);const result=await policy(a);expect(result).toMatchObject({state:'applied',value:{revision:1,wallets:[w]}});expect(await policy(a)).toEqual(result);expect(await policy(a,'inspect')).toEqual(result);expect(await policy(a,'close')).toEqual(result);
 await expect(policy({...a,wallets:[]})).rejects.toMatchObject({code:'23505'});await expect(policy(a,'inspect',2)).rejects.toMatchObject({code:'42501'});const q=await call('quote');expect(parseOrderQuote(JSON.parse(q.quoteJson as string)).wallets).toEqual([w]);
});
it('keeps wallet closure durable and enforces revision, supported provider, public target and actual outlet permissions',async()=>{
 const a=walletAction([wallet()]);const closed=await policy(a,'close');expect(closed.state).toBe('closed');expect(await policy(a)).toEqual(closed);const next=walletAction([wallet()]);await policy(next);await expect(policy(walletAction([]))).rejects.toMatchObject({code:'PT409'});
 for(const actor of [3,4,5])await expect(policy(walletAction([],1),'submit',actor)).rejects.toMatchObject({code:'42501'});
 for(const w of [{...wallet(),url:'javascript:alert(1)'},{...wallet(),url:'https://private:secret@shop.example.invalid/pay'},{...wallet(),name:'Another wallet'}])await expect(policy(walletAction([w],1))).rejects.toMatchObject({code:'22023'});
});
it('keeps raw metadata and customer completion unavailable to API roles that lack the exact purpose',async()=>{
 for(const role of ['anon','authenticated','service_role'] as const)for(const name of ['checkout_policy_actions','outlet_checkout_settings','order_credit_permissions','order_confirmation_actions','order_confirmation_budget'])await expect(f.asRole(role==='authenticated'?1:null,role,`select count(*) data from private.${name}`)).rejects.toMatchObject({code:'42501'});
 for(const role of ['anon','authenticated'] as const)await expect(f.asRole(role==='authenticated'?1:null,role,"select public.prepare_order_confirmation($1,null,'quote',1000,30) data",[token])).rejects.toMatchObject({code:'42501'});
 for(const role of ['anon','service_role'] as const)await expect(f.asRole(null,role,'select public.read_checkout_policy($1,null) data',[deviceId(11)])).rejects.toMatchObject({code:'42501'});
});
it('uses separate global and link budgets without changing the established customer read budget',async()=>{
 expect((await call('quote',null,token,1000,1)).state).toBe('quote');expect(await call('quote',null,token,1000,1)).toMatchObject({state:'limited'});const old=(await f.db.query<{n:number}>('select read_count n from private.public_links where order_id=$1',[orderId])).rows[0];expect(old.n).toBe(0);
 await f.db.exec('update private.order_confirmation_budget set window_at=0,requests=0');expect((await call('quote',null,'X'.repeat(43),1,30)).state).toBe('missing');expect((await call('quote',null,token,1,30)).state).toBe('limited');
});
it('applies both explicit swap outcomes against real priced Core orders and retains the complete source',async()=>{
 const data=await priced(),i=await intent();i.swaps=[{lineId:data.order.lines[1].id,accepted:false}];const p=await call('submit',i),result=await finish(i,p);expect(result.state).toBe('applied');expect(result.receipt).toMatchObject({total:20000,paymentStatus:'pending'});
 const row=(await f.db.query<{lines:string;source:string}>('select lines::text lines,source_text::text source from public.orders where id=$1',[orderId])).rows[0];expect(JSON.parse(row.lines)).toHaveLength(1);expect(JSON.parse(row.source)).toBe(data.order.sourceText);
 const audit=(await f.db.query<{before:string}>('select before_data::text before from public.events where id=$1',[i.ids.updateEventId])).rows[0];expect(JSON.parse(audit.before).lines[1]).toEqual(data.order.lines[1]);
});
it('accepts a proposed substitute and an installation wallet while leaving actual money pending',async()=>{
 const data=await priced(),w=wallet();await policy(walletAction([w]));const i=await intent();i.swaps=[{lineId:data.order.lines[1].id,accepted:true}];i.payment={method:'wallet',walletId:w.id};const result=await finish(i,await call('submit',i));expect(result).toMatchObject({state:'applied',receipt:{total:25000,paymentStatus:'pending',saleId:null,entryId:null}});expect((await f.db.query<{n:number}>('select count(*) n from public.sales')).rows[0].n).toBe(0);
});
it('requires explicit scoped permission before revealing khata terms and commits exactly one real in-limit credit sale',async()=>{
 const data=await priced();expect(parseOrderQuote(JSON.parse((await call('quote')).quoteJson as string)).credit).toBeNull();await policy(data.grant);const quote=await call('quote');expect(parseOrderQuote(JSON.parse(quote.quoteJson as string)).credit).toEqual({revision:1,balance:40000,limit:100000,maximum:25000});expect(quote.quoteJson).not.toContain('PRIVATE');expect(quote.quoteJson).not.toContain(data.account.id);
 const i=await intent();i.swaps=[{lineId:data.order.lines[1].id,accepted:true}];i.payment={method:'credit',walletId:null};const p=await call('submit',i),result=await finish(i,p);expect(result).toMatchObject({state:'applied',receipt:{total:25000,paymentStatus:'credited',saleId:i.ids.saleId,entryId:i.ids.entryId}});expect(await call('submit',i)).toEqual(result);
 expect((await f.db.query<{amount:number;account:string}>('select amount,account_id account from public.credit_entries where id=$1',[i.ids.entryId])).rows[0]).toEqual({amount:25000,account:data.account.id});expect((await f.db.query<{n:number}>('select count(*) n from public.sales')).rows[0].n).toBe(1);
});
it('fences a prepared credit confirmation after revocation, actual ledger changes or a lower shop allowance',async()=>{
 const data=await priced();await policy(data.grant);const i=await intent();i.swaps=[{lineId:data.order.lines[1].id,accepted:true}];i.payment={method:'credit',walletId:null};const p=await call('submit',i),records=await orderConfirmationRecords(p,i);
 await policy({...data.grant,id:newInboxId(),revision:1,enabled:false});expect((await finish(i,p,records)).state).toBe('conflict');expect((await call('close',i)).state).toBe('closed');expect((await f.db.query<{n:number}>('select count(*) n from public.sales')).rows[0].n).toBe(0);
 const q=parseOrderQuote(JSON.parse((await call('quote')).quoteJson as string));expect(q.credit).toBeNull();
});
it('preserves literal NUL, surrogate and markup source data through the actual SQL confirmation without executing it',async()=>{
 const data=await priced(true,true),i=await intent();i.swaps=[{lineId:data.order.lines[1].id,accepted:true}];const result=await finish(i,await call('submit',i));expect(result.state).toBe('applied');const row=(await f.db.query<{source:string;lines:string}>('select source_text::text source,lines::text lines from public.orders where id=$1',[orderId])).rows[0];expect(JSON.parse(row.source)).toBe(data.order.sourceText);expect(JSON.parse(row.lines)[1].note).toBe(data.order.lines[1].note);
});
it('compares canonical nested JSON independently of object key order and keeps structural characters inside strings inert',async()=>{
 const examples=[{},[],{note:'বাংলা 😀 \u0000 \ud800 \\"},:[',nested:[true,null,1.5,{id:'original'}]},...fc.sample(fc.jsonValue(),{seed:1147,numRuns:50})];
 for(const value of examples){
  const raw=JSON.stringify(value),normalized:unknown=JSON.parse(raw),expected=normalized!==null&&typeof normalized==='object'?Object.entries(normalized):[],actual=(await f.db.query<{key:string;value:string}>('select key,value::text value from private.confirmation_json_fields($1::json)',[raw])).rows;
  expect(actual.map(r=>[r.key,JSON.parse(r.value)])).toEqual(expected);
  const rearranged=value!==null&&typeof value==='object'&&!Array.isArray(value)?JSON.stringify(Object.fromEntries(Object.entries(value).reverse())):raw;
  expect((await f.db.query<{same:boolean}>('select private.confirmation_json_equal($1::json,$2::json) same',[raw,rearranged])).rows[0].same).toBe(true);
 }
 expect((await f.db.query<{same:boolean}>(`select private.confirmation_json_equal('{"value":"original"}'::json,'{"value":"changed"}'::json) same`)).rows[0].same).toBe(false);
});
it('atomically rejects changed prices, financial records, tenants and audit images in a prepared Core record set',async()=>{
 const i=await intent(),p=await call('submit',i),records=await orderConfirmationRecords(p,i);
 for(const mutate of [(rows:CloudRecord[])=>{rows[0].values.total='1';},(rows:CloudRecord[])=>{rows[0].values.business_id=deviceId(2);},(rows:CloudRecord[])=>{rows[1].values.after_data='null';}]){
  const changed=structuredClone(records);mutate(changed);await expect(finish(i,p,changed)).rejects.toMatchObject({code:expect.stringMatching(/22023|42501/)});expect((await call('inspect',i)).state).toBe('pending');
 }
 expect((await finish(i,p,records)).state).toBe('applied');
});
it('validates actual owner configuration and order permission metadata without giving serialized data account authority',async()=>{
 const scope={businessId:deviceId(1),outletId:deviceId(11),orderId:null,actorId:deviceId(101),actorRole:'owner' as const};
 const raw=await f.asRole(1,'authenticated','select public.read_checkout_policy($1,null) data',[deviceId(11)]),context=parseCheckoutPolicyContext(raw,scope);expect(context).toMatchObject({marketCode:'BD',settings:{revision:0,wallets:[]},order:null});
 const data=await priced(),orderScope={...scope,orderId},order=parseCheckoutPolicyContext(await f.asRole(1,'authenticated','select public.read_checkout_policy($1,$2) data',[deviceId(11),orderId]),orderScope);
 expect(order.order).toMatchObject({customerId:data.customer.id,ledger:{balance:40000,limit:100000},credit:{revision:0,enabled:false}});expect(JSON.parse(order.order!.customerNameJson)).toBe('Sadia');
 const action=parseCheckoutPolicyAction(data.grant),result=await policy(action);expect(parseCheckoutPolicyOutcome(result,action)).toMatchObject({state:'applied',value:{revision:1,enabled:true,maximum:25000}});
 expect(()=>parseCheckoutPolicyContext(raw,{...scope,actorId:deviceId(102)})).toThrow();expect(()=>parseCheckoutPolicyOutcome({...result,value:{revision:1,enabled:true,maximum:1,orderRevision:data.order.revision}},action)).toThrow();
});
it('keeps an offline wallet closure valid after the installation changes market, without applying an unsupported target',async()=>{
 const original=walletAction([wallet()]);await f.db.query("update public.businesses set market_code='ID' where id=$1",[deviceId(1)]);await expect(policy(original)).rejects.toMatchObject({code:'22023'});const closed=await policy(original,'close');expect(closed.state).toBe('closed');expect(await policy(original)).toEqual(closed);expect((await f.db.query<{n:number}>('select count(*) n from private.outlet_checkout_settings')).rows[0].n).toBe(0);
});
it('preserves the actual customer-outlet parent and requires the manager’s current outlet assignment for ledger reads and grants',async()=>{
 const data=await priced();await expect(f.db.query('delete from public.customer_outlets where business_id=$1 and outlet_id=$2 and customer_id=$3',[deviceId(1),deviceId(11),data.customer.id])).rejects.toMatchObject({code:'23503'});await f.db.query('delete from public.member_outlets where business_id=$1 and outlet_id=$2 and member_id=$3',[deviceId(1),deviceId(11),deviceId(102)]);await expect(f.asRole(2,'authenticated','select public.read_checkout_policy($1,$2) data',[deviceId(11),orderId])).rejects.toMatchObject({code:'42501'});await expect(policy(data.grant,'submit',2)).rejects.toMatchObject({code:'42501'});expect(parseOrderQuote(JSON.parse((await call('quote')).quoteJson as string)).credit).toBeNull();
});
