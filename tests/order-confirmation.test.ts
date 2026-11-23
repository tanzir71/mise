import {it,expect} from 'vitest';
import {setupCommand} from '../packages/core/setup';
import {saveOrderCommand,changeOrderStatusCommand} from '../packages/core/orders';
import {saveCustomerCommand} from '../packages/core/customers';
import {defaultCreditTerms,saveCreditTermsCommand,openingBalanceCommand,creditBalance} from '../packages/core/khata';
import {newInboxId} from '../packages/core/inbox';
import {confirmOrderCommand,decidedQuote,parseOrderQuote,parseOrderConfirmation,parseCheckoutWallet,type OrderQuote,type OrderConfirmation} from '../packages/core/order-confirmation';

function fixture(){
  const setup=setupCommand({name:'Rahman Store',outletName:'Road 7',businessType:'corner_shop',marketCode:'BD',phone:'+14155550101'},null,1000).snapshot;
  const customer=saveCustomerCommand({name:'Sadia',nickname:'',phone:'+14155550150',address:'',notes:'',tags:[]},setup,[],null,1001).customer;
  const account=saveCreditTermsCommand({...defaultCreditTerms,allowed:true,limit:100000},customer,setup,null,1002).account;
  const entries=[openingBalanceCommand(40000,1000,{setup,customer,account,entries:[]},1003).entry];
  const order=saveOrderCommand({source:'other',sourceText:'2 kg rice and milk',customerId:customer.id,name:'Sadia',phone:customer.phone!,type:'pickup',address:'',table:'',lines:[{name:'Rice',unit:'kg',qty:2,unitPrice:10000},{name:'Soya milk',unit:'bottle',qty:1,unitPrice:5000,substitution:{from:'Fresh milk',accepted:false}}],deliveryFee:0,discount:0,payment:{method:'cash'}},{setup,customer,items:[],sequence:1},null,0,1004).order;
  const quote:OrderQuote={v:1,orderId:order.id,revision:order.revision,status:'requested',number:order.number,currency:order.currency,lines:order.lines,deliveryFee:0,discount:0,settingsRevision:1,wallets:[{id:newInboxId(),name:'bKash',phone:'+14155550199',url:'bkash://'}],credit:{revision:1,balance:40000,limit:100000,maximum:25000}};
  const intent:OrderConfirmation={v:1,id:newInboxId(),quoteHash:'a'.repeat(64),swaps:[{lineId:order.lines[1].id,accepted:true}],payment:{method:'cash',walletId:null},ids:{updateEventId:newInboxId(),pricedEventId:newInboxId(),acceptedEventId:newInboxId(),paymentEventId:newInboxId(),saleId:newInboxId(),saleEventId:newInboxId(),entryId:newInboxId(),creditEventId:newInboxId()}};
  return {setup,customer,account,entries,order,quote,intent,context:{setup,customer,items:[],sequence:1,ledger:{setup,customer,account,entries},quoteHash:intent.quoteHash}};
}
it('confirms actual quoted prices and an explicit swap through the normal Core status flow, without recording cash',()=>{
 const f=fixture(),before=JSON.stringify(f.order),result=confirmOrderCommand(f.order,f.quote,f.intent,f.context,2000);
 expect(result.order.status).toBe('accepted');expect(result.order.revision).toBe(4);expect(result.order.total).toBe(25000);expect(result.order.lines[1].substitution).toEqual({from:'Fresh milk',accepted:true,acceptedAt:2000});
 expect(result.order.payment).toEqual({method:'cash',wallet:undefined,status:'pending'});expect(result.sales).toEqual([]);expect(result.entries).toEqual([]);expect(result.events.map(e=>e.command)).toEqual(['order.update','order.status','order.status']);expect(result.events.every(e=>e.actor.type==='system'&&e.actor.id==='public-order-confirmation')).toBe(true);expect(JSON.stringify(f.order)).toBe(before);
});
it('excludes a declined substitute from the accepted order, retains its original audit image and does not treat omission as No',()=>{
 const f=fixture();f.intent.swaps[0].accepted=false;const result=confirmOrderCommand(f.order,f.quote,f.intent,f.context,2000);expect(result.order.total).toBe(20000);expect(result.order.lines).toHaveLength(1);expect(result.order.lines[0].name).toBe('Rice');expect((result.events[0].before as typeof f.order).lines[1]).toEqual(f.order.lines[1]);expect(f.quote.lines).toHaveLength(2);
 expect(()=>confirmOrderCommand(f.order,f.quote,{...f.intent,swaps:[]},f.context,2000)).toThrow();expect(decidedQuote(f.quote,[],0,false)).toMatchObject({total:null,undecided:1});
});
it('does not allow an empty retained order after all proposed items are declined',()=>{
 const f=fixture();f.order.lines[0].unavailable=true;f.order.subtotal=0;f.order.total=null;f.intent.swaps[0].accepted=false;expect(()=>confirmOrderCommand(f.order,f.quote,f.intent,f.context,2000)).toThrow('at least one');
});
it('records a wallet preference while keeping payment pending and creating no money',()=>{
 const f=fixture();f.intent.payment={method:'wallet',walletId:f.quote.wallets[0].id};const result=confirmOrderCommand(f.order,f.quote,f.intent,f.context,2000);expect(result.order.payment).toMatchObject({method:'wallet',wallet:'bKash',status:'pending'});expect(result.sales).toEqual([]);expect(result.entries).toEqual([]);
 f.intent.payment.walletId=newInboxId();expect(()=>confirmOrderCommand(f.order,f.quote,f.intent,f.context,2000)).toThrow();
});
it('uses actual Core credit settlement once, with its original sale, charge, limit and explicit public actor',()=>{
 const f=fixture();f.intent.payment={method:'credit',walletId:null};const result=confirmOrderCommand(f.order,f.quote,f.intent,f.context,2000);
 expect(result.order.status).toBe('accepted');expect(result.order.payment).toMatchObject({method:'credit',status:'credited',saleId:f.intent.ids.saleId});expect(result.sales).toHaveLength(1);expect(result.entries).toHaveLength(1);expect(result.entries[0]).toMatchObject({id:f.intent.ids.entryId,orderId:f.order.id,saleId:f.intent.ids.saleId,accountId:f.account.id,amount:25000,sequence:2});expect(creditBalance(f.account,[...f.entries,...result.entries])).toBe(65000);expect(result.events).toHaveLength(6);expect(result.events.every(e=>e.actor.type==='system')).toBe(true);
});
it('requires a shop grant and a still-current ledger rather than inferring credit permission from a customer phone',()=>{
 const f=fixture();f.intent.payment={method:'credit',walletId:null};
 expect(()=>confirmOrderCommand(f.order,{...f.quote,credit:null},f.intent,f.context,2000)).toThrow('khata');expect(()=>confirmOrderCommand(f.order,f.quote,f.intent,{...f.context,ledger:undefined},2000)).toThrow('khata');
 expect(()=>confirmOrderCommand(f.order,f.quote,f.intent,{...f.context,ledger:{...f.context.ledger,account:{...f.account,customerId:newInboxId()}}},2000)).toThrow('khata');
 f.account.allowed=false;expect(()=>confirmOrderCommand(f.order,f.quote,f.intent,f.context,2000)).toThrow('khata');
});
it('never accepts public over-limit consent, an increased quote above its grant, or another currency account',()=>{
 const f=fixture();f.intent.payment={method:'credit',walletId:null};
 expect(()=>confirmOrderCommand(f.order,{...f.quote,credit:{...f.quote.credit!,maximum:24000}},f.intent,f.context,2000)).toThrow('khata');
 f.account.limit=64000;f.quote.credit!.limit=64000;expect(()=>confirmOrderCommand(f.order,f.quote,f.intent,f.context,2000)).toThrow('khata');
 f.account.limit=100000;f.quote.credit!.limit=100000;f.account.currency='USD';expect(()=>confirmOrderCommand(f.order,f.quote,f.intent,f.context,2000)).toThrow('khata');
});
it('requires the exact original quoted order, version, digest and existing item prices',()=>{
 const f=fixture();expect(()=>confirmOrderCommand(f.order,{...f.quote,revision:f.quote.revision+1},f.intent,f.context,2000)).toThrow();expect(()=>confirmOrderCommand(f.order,f.quote,f.intent,{...f.context,quoteHash:'b'.repeat(64)},2000)).toThrow();
 const quote=structuredClone(f.quote);quote.lines[0].unitPrice=1;quote.lines[0].lineTotal=2;expect(()=>confirmOrderCommand(f.order,quote,f.intent,f.context,2000)).toThrow();
 expect(()=>confirmOrderCommand(f.order,f.quote,f.intent,f.context,1000)).toThrow();
});
it('does not reopen already accepted, cancelled, completed or paid orders',()=>{
 const f=fixture();for(const status of ['accepted','cancelled','done'] as const)expect(()=>confirmOrderCommand({...f.order,status},f.quote,f.intent,f.context,2000)).toThrow();expect(()=>confirmOrderCommand({...f.order,payment:{method:'cash',status:'paid'}},f.quote,f.intent,f.context,2000)).toThrow();
});
it('preserves an already priced normal order and advances it only once to accepted',()=>{
 const f=fixture();const lines=decidedQuote(f.quote,f.intent.swaps,1500).lines;const saved=saveOrderCommand({...f.order,source:f.order.source,name:f.order.customer.name,phone:f.order.customer.phone!,customerId:f.customer.id,lines,payment:{method:'cash'}},f.context,f.order,f.order.revision,1500).order;
 const priced=changeOrderStatusCommand(saved,'priced',f.setup,saved.revision,1501).order,quote={...f.quote,status:'priced' as const,revision:priced.revision,lines:priced.lines};const result=confirmOrderCommand(priced,quote,{...f.intent,swaps:[]},f.context,2000);expect(result.order.status).toBe('accepted');expect(result.order.revision).toBe(priced.revision+2);expect(result.events).toHaveLength(2);
});
it('rejects changed original identities, arbitrary swap lines and extra payment authority',()=>{
 const f=fixture();expect(()=>parseOrderConfirmation({...f.intent,ids:{...f.intent.ids,entryId:f.intent.ids.saleId}})).toThrow();expect(()=>parseOrderConfirmation({...f.intent,payment:{method:'credit',walletId:null,confirmation:{balance:40000,limit:100000}}})).toThrow();expect(()=>parseOrderConfirmation({...f.intent,payment:{method:'cash',walletId:newInboxId()}})).toThrow();expect(()=>parseOrderConfirmation({...f.intent,payment:{method:'wallet',walletId:null}})).toThrow();expect(()=>parseOrderConfirmation({...f.intent,swaps:[...f.intent.swaps,...f.intent.swaps]})).toThrow();expect(()=>confirmOrderCommand(f.order,f.quote,{...f.intent,swaps:[{lineId:f.order.lines[0].id,accepted:true}]},f.context,2000)).toThrow();
});
it('validates wallet targets and quote data without accepting executable URLs, credentials, unpriced items or extra private data',()=>{
 const f=fixture(),wallet=f.quote.wallets[0];for(const url of ['javascript:alert(1)','data:text/html,x','https://user:pass@shop.example.invalid/pay','http://shop.example.invalid/pay'])expect(()=>parseCheckoutWallet({...wallet,url})).toThrow();expect(parseCheckoutWallet(wallet)).toEqual(wallet);
 expect(()=>parseOrderQuote({...f.quote,privateCustomerPhone:'hidden'})).toThrow();expect(()=>parseOrderQuote({...f.quote,lines:[{...f.quote.lines[0],unitPrice:null,lineTotal:null}]})).toThrow();expect(()=>parseOrderQuote({...f.quote,wallets:[wallet,wallet]})).toThrow();
});
