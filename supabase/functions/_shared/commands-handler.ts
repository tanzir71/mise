import {parseShopCommand,parseShopCommandReceipt,isCustomerCommand,isMoneyCommand,isStockCommand,isPurchaseCommand,isOrderCommand,isClosingCommand,type ShopCommand} from '../../../packages/core/shop-commands.ts';
import {closingWritePlan} from '../../../packages/core/closing-commands.ts';
import {closingFingerprint,closingWriteFields,ClosingMutationInvalid,ClosingMutationConflict} from './closing-write.ts';
import {orderBodyHeader,orderBodyLimit,orderWritePlan,isOrderSave} from '../../../packages/core/order-commands.ts';
import {orderFingerprint,orderWriteFields,OrderMutationConflict,OrderMutationInvalid} from './order-write.ts';
import {purchaseBodyHeader,purchaseBodyLimit,purchaseWritePlan} from '../../../packages/core/purchase-commands.ts';
import {purchaseFingerprint,purchaseWriteFields,PurchaseMutationConflict,PurchaseMutationInvalid} from './purchase-write.ts';
import {stockBatchBodyLimit,stockBatchHeader,stockWritePlan} from '../../../packages/core/stock-commands.ts';
import {stockFingerprint,stockWriteFields,StockMutationConflict,StockMutationInvalid} from './stock-write.ts';
import {moneyWritePlan} from '../../../packages/core/money-commands.ts';
import {moneyFingerprint,moneyWriteFields,MoneyMutationInvalid,MoneyMutationConflict} from './money-write.ts';
import {authHttp,AuthBodyError,readAuthBody} from './auth-http.ts';
import {catalogueFingerprint,catalogueWriteFields} from './catalogue-write.ts';
import {customerFingerprint,customerWriteFields,CustomerMutationInvalid} from './customer-write.ts';
import {deviceAuthId} from './device-pin-handler.ts';
export class CommandDenied extends Error {constructor(readonly status:401|403=403){super('Command access denied.');}}
export class CommandConflict extends Error {}
class CatalogueSnapshotChanged extends Error {}
export interface CommandStore {apply(jwt:string,command:ShopCommand):Promise<unknown>;admitStockBatch?(jwt:string,outletId:string):Promise<void>;admitPurchaseRecord?(jwt:string,outletId:string):Promise<void>;admitOrderWrite?(jwt:string,outletId:string):Promise<void>}
export function createCommandsHandler(deps:{store:CommandStore;origins:ReadonlySet<string>}){
  const origins=new Set(deps.origins);
  return async(request:Request):Promise<Response>=>{
    const {reply,blocked}=authHttp(request,origins,[stockBatchHeader.toLowerCase(),purchaseBodyHeader.toLowerCase(),orderBodyHeader.toLowerCase()]);if(blocked)return blocked;
    const auth=request.headers.get('authorization')||'',jwt=auth.length<=8192?auth.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1]:undefined;
    if(!jwt)return reply(401,{error:'Sign in again to make this change.'});
    if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return reply(415,{error:'Use JSON.'});
    const batchOutlet=request.headers.get(stockBatchHeader),purchaseOutlet=request.headers.get(purchaseBodyHeader),orderOutlet=request.headers.get(orderBodyHeader),admittedOutlet=batchOutlet??purchaseOutlet??orderOutlet;
    if([batchOutlet,purchaseOutlet,orderOutlet].filter(v=>v!==null).length>1)return reply(400,{error:'Choose one reviewed large command.'});
    if(admittedOutlet!==null){
      if(!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(admittedOutlet))return reply(400,{error:'Check the reviewed outlet.'});
      try{const admit=batchOutlet!==null?deps.store.admitStockBatch:purchaseOutlet!==null?deps.store.admitPurchaseRecord:deps.store.admitOrderWrite;if(!admit)throw new CommandDenied();await admit(jwt,admittedOutlet);}catch(error){return reply(error instanceof CommandDenied?error.status:503,{error:'Large changes are unavailable for this account.'});}
    }
    let raw:unknown;try{raw=await readAuthBody(request,batchOutlet!==null?stockBatchBodyLimit:purchaseOutlet!==null?purchaseBodyLimit:orderOutlet!==null?orderBodyLimit:32000,batchOutlet!==null?30000:purchaseOutlet!==null?15000:orderOutlet!==null?20000:5000);}catch(error){return reply(error instanceof AuthBodyError?error.status:400,{error:'Check the command request.'});}
    let command:ShopCommand;try{command=parseShopCommand(raw);}catch{return reply(400,{error:'Choose a supported shop action and its exact fields.'});}
    if(batchOutlet!==null&&(command.type!=='stock.batch'||command.outletId!==batchOutlet))return reply(400,{error:'Keep the admitted stock batch and outlet.'});
    if(purchaseOutlet!==null&&(command.type!=='purchase.record'||command.outletId!==purchaseOutlet))return reply(400,{error:'Keep the admitted invoice and outlet.'});
    if(orderOutlet!==null&&(!isOrderCommand(command)||!isOrderSave(command)||command.outletId!==orderOutlet))return reply(400,{error:'Keep the admitted order save and outlet.'});
    try{return reply(200,parseShopCommandReceipt(await deps.store.apply(jwt,command),command));}
    catch(error){return error instanceof CommandDenied?reply(error.status,{error:'This change is unavailable for this account.'}):error instanceof ClosingMutationInvalid?reply(400,{error:error.message}):error instanceof ClosingMutationConflict?reply(409,{error:error.message}):error instanceof OrderMutationInvalid?reply(400,{error:error.message}):error instanceof OrderMutationConflict?reply(409,{error:error.message}):error instanceof PurchaseMutationInvalid?reply(400,{error:error.message}):error instanceof PurchaseMutationConflict?reply(409,{error:error.message}):error instanceof MoneyMutationInvalid?reply(400,{error:error.message}):error instanceof MoneyMutationConflict?reply(409,{error:error.message}):error instanceof StockMutationInvalid?reply(400,{error:error.message}):error instanceof StockMutationConflict?reply(409,{error:error.message}):error instanceof CustomerMutationInvalid?reply(400,{error:'Check the customer, credit terms or opening balance. Settle all khata before archiving.'}):error instanceof CommandConflict?reply(409,{error:'This command conflicts with an existing or newer change. Refresh before trying again.'}):reply(503,{error:'Changes are unavailable. Try again with the same command ID.'});}
  };
}
export function createCommandStore(apiUrl:string,publishableKey:string,send:typeof fetch=fetch,options:{serviceKey?:string;newId?:()=>string}={}):CommandStore {
  const root=new URL(apiUrl);
  if(root.username||root.password||root.search||root.hash||root.pathname!=='/'||(root.protocol!=='https:'&&!(root.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(root.hostname)))||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey))throw new Error('Commands are not configured.');
  async function rpc(name:string,args:Record<string,unknown>,key:string,jwt?:string,retryTag?:string,deadlineMs=5000){
    const headers:Record<string,string>={apikey:key,'Content-Type':'application/json'};if(jwt)headers.Authorization='Bearer '+jwt;
    const r=await send(new URL('rest/v1/rpc/'+name,root),{method:'POST',redirect:'error',signal:AbortSignal.timeout(deadlineMs),headers,body:JSON.stringify(args)});
    if(r.status===401&&!jwt)throw new Error('Server command credentials unavailable');
    if(r.status===401||r.status===403)throw new CommandDenied(r.status);
    if(r.status===409){let code:unknown,details:unknown;try{const error=await r.json();code=error.code;details=error.details;}catch{/* Only the fixed error tag controls retry; backend details remain private. */}if(retryTag&&code==='PT409'&&details===retryTag)throw new CatalogueSnapshotChanged();throw new CommandConflict();}
    if(!r.ok)throw new Error('Command unavailable');return r.json();
  }
  return {admitStockBatch:async(jwt,outletId)=>{if(await rpc('admit_stock_batch',{p_outlet_id:outletId},publishableKey,jwt)!==true)throw new CommandDenied();},admitPurchaseRecord:async(jwt,outletId)=>{if(await rpc('admit_purchase_record',{p_outlet_id:outletId},publishableKey,jwt)!==true)throw new CommandDenied();},admitOrderWrite:async(jwt,outletId)=>{if(await rpc('admit_order_write',{p_outlet_id:outletId},publishableKey,jwt)!==true)throw new CommandDenied();},apply:async(jwt,value)=>{
    const c=parseShopCommand(value);
    if(isClosingCommand(c)){
      if(!options.serviceKey||!/^sb_secret_[A-Za-z0-9_-]+$/.test(options.serviceKey))throw new Error('Closing writes unavailable');
      const hash=await closingFingerprint(c),newId=options.newId??deviceAuthId;
      for(let attempt=0;attempt<3;attempt++){
        const ticket=newId(),prepared=await rpc('prepare_closing_write',{p_id:c.id,p_ticket_id:ticket,p_type:c.type,p_outlet_id:c.outletId,p_plan:closingWritePlan(c),p_hash:hash,p_occurred_at:c.occurredAt},publishableKey,jwt);
        if(prepared?.done===true)return prepared.receipt;
        const fields=closingWriteFields(prepared,c,ticket);
        try{return await rpc('finish_closing_write',fields,options.serviceKey,undefined,'closing_snapshot_changed');}catch(error){if(!(error instanceof CatalogueSnapshotChanged))throw error;}
      }
      throw new CommandConflict();
    }
    if(isOrderCommand(c)){
      if(!options.serviceKey||!/^sb_secret_[A-Za-z0-9_-]+$/.test(options.serviceKey))throw new Error('Order writes unavailable');
      const hash=await orderFingerprint(c),newId=options.newId??deviceAuthId,deadline=isOrderSave(c)?15000:5000;
      for(let attempt=0;attempt<3;attempt++){
        const ticket=newId(),prepared=await rpc('prepare_order_write',{p_id:c.id,p_ticket_id:ticket,p_type:c.type,p_outlet_id:c.outletId,p_plan:orderWritePlan(c),p_hash:hash,p_occurred_at:c.occurredAt},publishableKey,jwt,undefined,deadline);
        if(prepared?.done===true)return prepared.receipt;
        const fields=orderWriteFields(prepared,c,ticket);
        try{return await rpc('finish_order_write',fields,options.serviceKey,undefined,'order_snapshot_changed',deadline);}catch(error){if(!(error instanceof CatalogueSnapshotChanged))throw error;}
      }
      throw new CommandConflict();
    }
    if(isPurchaseCommand(c)){
      if(!options.serviceKey||!/^sb_secret_[A-Za-z0-9_-]+$/.test(options.serviceKey))throw new Error('Supplier/invoice writes unavailable');
      const hash=await purchaseFingerprint(c),newId=options.newId??deviceAuthId,deadline=c.type==='purchase.record'?15000:5000;
      for(let attempt=0;attempt<3;attempt++){
        const ticket=newId(),prepared=await rpc('prepare_purchase_write',{p_id:c.id,p_ticket_id:ticket,p_type:c.type,p_outlet_id:c.outletId,p_plan:purchaseWritePlan(c),p_hash:hash,p_occurred_at:c.occurredAt},publishableKey,jwt,undefined,deadline);
        if(prepared?.done===true)return prepared.receipt;
        const fields=purchaseWriteFields(prepared,c,ticket);
        try{return await rpc('finish_purchase_write',fields,options.serviceKey,undefined,'purchase_snapshot_changed',deadline);}catch(error){if(!(error instanceof CatalogueSnapshotChanged))throw error;}
      }
      throw new CommandConflict();
    }
    if(isStockCommand(c)){
      if(!options.serviceKey||!/^sb_secret_[A-Za-z0-9_-]+$/.test(options.serviceKey))throw new Error('Stock writes unavailable');
      const hash=await stockFingerprint(c),newId=options.newId??deviceAuthId,deadline=c.type==='stock.batch'?45000:5000;
      for(let attempt=0;attempt<3;attempt++){
        const ticket=newId(),prepared=await rpc('prepare_stock_write',{p_id:c.id,p_ticket_id:ticket,p_type:c.type,p_outlet_id:c.outletId,p_plan:stockWritePlan(c),p_hash:hash,p_occurred_at:c.occurredAt},publishableKey,jwt,undefined,deadline);
        if(prepared?.done===true)return prepared.receipt;
        const fields=stockWriteFields(prepared,c,ticket);
        try{return await rpc('finish_stock_write',fields,options.serviceKey,undefined,'stock_snapshot_changed',deadline);}catch(error){if(!(error instanceof CatalogueSnapshotChanged))throw error;}
      }
      throw new CommandConflict();
    }
    if(isMoneyCommand(c)){
      if(!options.serviceKey||!/^sb_secret_[A-Za-z0-9_-]+$/.test(options.serviceKey))throw new Error('Money writes unavailable');
      const hash=await moneyFingerprint(c),newId=options.newId??deviceAuthId;
      for(let attempt=0;attempt<3;attempt++){
        const ticket=newId(),prepared=await rpc('prepare_money_write',{p_id:c.id,p_ticket_id:ticket,p_type:c.type,p_outlet_id:c.outletId,p_plan:moneyWritePlan(c),p_hash:hash,p_occurred_at:c.occurredAt},publishableKey,jwt);
        if(prepared?.done===true)return prepared.receipt;
        const fields=moneyWriteFields(prepared,c,ticket);
        try{return await rpc('finish_money_write',fields,options.serviceKey,undefined,'money_snapshot_changed');}catch(error){if(!(error instanceof CatalogueSnapshotChanged))throw error;}
      }
      throw new CommandConflict();
    }
    if(isCustomerCommand(c)){
      if(!options.serviceKey||!/^sb_secret_[A-Za-z0-9_-]+$/.test(options.serviceKey))throw new Error('Customer writes unavailable');
      const hash=await customerFingerprint(c),newId=options.newId??deviceAuthId;
      for(let attempt=0;attempt<3;attempt++){
        const ticket=newId(),prepared=await rpc('prepare_customer_intent',{p_id:c.id,p_ticket_id:ticket,p_type:c.type,p_customer_id:c.customerId,p_outlet_id:c.outletId,p_account_id:c.type==='khata.settings'?c.accountId:null,p_hash:hash,p_ids:'ids'in c?c.ids:null},publishableKey,jwt);
        if(prepared?.done===true)return prepared.receipt;
        const fields=customerWriteFields(prepared,c,ticket);
        try{return await rpc('finish_customer_write',fields,options.serviceKey,undefined,'customer_snapshot_changed');}catch(error){if(!(error instanceof CatalogueSnapshotChanged))throw error;}
      }
      throw new CommandConflict();
    }
    if(c.type==='catalogue.create'||c.type==='catalogue.update'||c.type==='catalogue.delete'){
      if(!options.serviceKey||!/^sb_secret_[A-Za-z0-9_-]+$/.test(options.serviceKey))throw new Error('Catalogue writes unavailable');
      const hash=await catalogueFingerprint(c),newId=options.newId??deviceAuthId;
      for(let attempt=0;attempt<3;attempt++){
        const ticket=newId(),prepared=await rpc('prepare_catalogue_write',{p_id:c.id,p_ticket_id:ticket,p_type:c.type,p_item_id:c.itemId,p_outlet_id:c.type==='catalogue.create'?c.outletId:null,p_hash:hash},publishableKey,jwt);
        if(prepared?.done===true)return prepared.receipt;
        const fields=catalogueWriteFields(prepared,c,ticket,newId);
        try{return await rpc('finish_catalogue_write',fields,options.serviceKey,undefined,'catalogue_snapshot_changed');}catch(error){if(!(error instanceof CatalogueSnapshotChanged))throw error;}
      }
      throw new CommandConflict();
    }
    return rpc('apply_catalogue_command',{p_id:c.id,p_type:c.type,p_item_id:c.type==='catalogue.availability'?c.itemId:null,p_available:c.type==='catalogue.availability'?c.available:null,p_undo_of:c.type==='catalogue.undo'?c.undoOf:null},publishableKey,jwt);
  }};
}
