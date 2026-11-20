import {supplierMessageWritePlan} from '../../../packages/core/supplier-message-commands.ts';
import {supplierMessageFingerprint,supplierMessageWriteFields,SupplierMessageMutationInvalid,SupplierMessageMutationConflict} from './supplier-message-write.ts';
import {parseShopCommand,parseShopCommandReceipt,isCustomerCommand,isMoneyCommand,isStockCommand,isPurchaseCommand,isOrderCommand,isClosingCommand,isHandoffCommand,isSupplierMessageCommand,isInboxCommand,type ShopCommand} from '../../../packages/core/shop-commands.ts';
import {inboxBodyHeader,inboxBodyLimit,inboxWritePlan} from '../../../packages/core/inbox-commands.ts';
import {inboxFingerprint,inboxWriteFields,InboxMutationInvalid,InboxMutationConflict} from './inbox-write.ts';
import {settingsWritePlan} from '../../../packages/core/settings-commands.ts';
import {isSettingsCommand} from '../../../packages/core/shop-commands.ts';
import {settingsFingerprint,settingsWriteFields,SettingsMutationInvalid,SettingsMutationConflict} from './settings-write.ts';
import {isProfileCommand} from '../../../packages/core/shop-commands.ts';
import {profileWritePlan} from '../../../packages/core/profile-commands.ts';
import {profileFingerprint,profileWriteFields,ProfileMutationInvalid,ProfileMutationConflict} from './profile-write.ts';
import {isLinkCommand} from '../../../packages/core/shop-commands.ts';
import {linkBodyHeader,linkBodyLimit,linkWritePlan} from '../../../packages/core/link-commands.ts';
import {linkFingerprint,linkWriteFields,LinkMutationInvalid,LinkMutationConflict} from './link-write.ts';
import {handoffBodyHeader,handoffBodyLimit,handoffWritePlan} from '../../../packages/core/handoff-commands.ts';
import {handoffFingerprint,handoffWriteFields,HandoffMutationInvalid,HandoffMutationConflict} from './handoff-write.ts';
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
import {savedCurrencyHeader,validSavedCurrency,proposedOrderCurrencyMatches} from '../../../packages/core/order-currency.ts';
import {proposedMoneyCurrencyMatches} from '../../../packages/core/money-currency.ts';
import {isCatalogueWrite,catalogueRecordPlan} from '../../../packages/core/cloud-commands.ts';
import {catalogueFingerprint,catalogueWriteFields,CatalogueMutationInvalid,CatalogueMutationConflict} from './catalogue-write.ts';
import {customerFingerprint,customerWriteFields,CustomerMutationInvalid} from './customer-write.ts';
import {deviceAuthId} from './device-pin-handler.ts';
export class CommandDenied extends Error {constructor(readonly status:401|403=403){super('Command access denied.');}}
export class CommandConflict extends Error {}
class CatalogueSnapshotChanged extends Error {}
export interface CommandStore {apply(jwt:string,command:ShopCommand,currency?:string):Promise<unknown>;admitStockBatch?(jwt:string,outletId:string):Promise<void>;admitPurchaseRecord?(jwt:string,outletId:string):Promise<void>;admitOrderWrite?(jwt:string,outletId:string):Promise<void>;admitHandoffWrite?(jwt:string,outletId:string):Promise<void>;admitInboxWrite?(jwt:string,outletId:string):Promise<void>;admitLinkWrite?(jwt:string,outletId:string):Promise<void>}
export function createCommandsHandler(deps:{store:CommandStore;origins:ReadonlySet<string>}){
  const origins=new Set(deps.origins);
  return async(request:Request):Promise<Response>=>{
    const {reply,blocked}=authHttp(request,origins,[savedCurrencyHeader.toLowerCase(),stockBatchHeader.toLowerCase(),purchaseBodyHeader.toLowerCase(),orderBodyHeader.toLowerCase(),handoffBodyHeader.toLowerCase(),inboxBodyHeader.toLowerCase(),linkBodyHeader.toLowerCase()]);if(blocked)return blocked;
    const auth=request.headers.get('authorization')||'',jwt=auth.length<=8192?auth.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1]:undefined;
    if(!jwt)return reply(401,{error:'Sign in again to make this change.'});
    if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return reply(415,{error:'Use JSON.'});
    const currency=request.headers.get(savedCurrencyHeader);if(currency!==null&&!validSavedCurrency(currency))return reply(400,{error:'Keep the saved currency.'});
    const batchOutlet=request.headers.get(stockBatchHeader),purchaseOutlet=request.headers.get(purchaseBodyHeader),orderOutlet=request.headers.get(orderBodyHeader),handoffOutlet=request.headers.get(handoffBodyHeader),inboxOutlet=request.headers.get(inboxBodyHeader),linkOutlet=request.headers.get(linkBodyHeader),admittedOutlet=batchOutlet??purchaseOutlet??orderOutlet??handoffOutlet??inboxOutlet??linkOutlet;
    if([batchOutlet,purchaseOutlet,orderOutlet,handoffOutlet,inboxOutlet,linkOutlet].filter(v=>v!==null).length>1)return reply(400,{error:'Choose one reviewed large command.'});
    if(admittedOutlet!==null){
      if(!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(admittedOutlet))return reply(400,{error:'Check the reviewed outlet.'});
      try{const admit=batchOutlet!==null?deps.store.admitStockBatch:purchaseOutlet!==null?deps.store.admitPurchaseRecord:orderOutlet!==null?deps.store.admitOrderWrite:handoffOutlet!==null?deps.store.admitHandoffWrite:inboxOutlet!==null?deps.store.admitInboxWrite:deps.store.admitLinkWrite;if(!admit)throw new CommandDenied();await admit(jwt,admittedOutlet);}catch(error){return reply(error instanceof CommandDenied?error.status:503,{error:'Large changes are unavailable for this account.'});}
    }
    let raw:unknown;try{raw=await readAuthBody(request,batchOutlet!==null?stockBatchBodyLimit:purchaseOutlet!==null?purchaseBodyLimit:orderOutlet!==null?orderBodyLimit:handoffOutlet!==null?handoffBodyLimit:inboxOutlet!==null?inboxBodyLimit:linkOutlet!==null?linkBodyLimit:32000,batchOutlet!==null?30000:purchaseOutlet!==null?15000:orderOutlet!==null||handoffOutlet!==null||inboxOutlet!==null||linkOutlet!==null?20000:5000);}catch(error){return reply(error instanceof AuthBodyError?error.status:400,{error:'Check the command request.'});}
    let command:ShopCommand;try{command=parseShopCommand(raw);}catch{return reply(400,{error:'Choose a supported shop action and its exact fields.'});}
    if(batchOutlet!==null&&(command.type!=='stock.batch'||command.outletId!==batchOutlet))return reply(400,{error:'Keep the admitted stock batch and outlet.'});
    if(purchaseOutlet!==null&&(command.type!=='purchase.record'||command.outletId!==purchaseOutlet))return reply(400,{error:'Keep the admitted invoice and outlet.'});
    if(orderOutlet!==null&&(!isOrderCommand(command)||!isOrderSave(command)||command.outletId!==orderOutlet))return reply(400,{error:'Keep the admitted order save and outlet.'});
    if(handoffOutlet!==null&&(!['handoff.prepare','supplier-message.record'].includes(command.type)||command.outletId!==handoffOutlet))return reply(400,{error:'Keep the admitted message attempt and outlet.'});
    if(inboxOutlet!==null&&(command.type!=='inbox.capture'||command.outletId!==inboxOutlet))return reply(400,{error:'Keep the admitted Inbox capture and outlet.'});
    if(linkOutlet!==null&&(command.type!=='shopLink.generate'||command.outletId!==linkOutlet))return reply(400,{error:'Keep the admitted frozen link and outlet.'});
    if(currency!==null&&!isOrderCommand(command)&&(!isMoneyCommand(command)||command.type==='khata.communication'))return reply(400,{error:'Keep the saved currency with its original financial action.'});
    try{return reply(200,parseShopCommandReceipt(await (currency===null?deps.store.apply(jwt,command):deps.store.apply(jwt,command,currency)),command));}
    catch(error){return error instanceof SupplierMessageMutationInvalid?reply(400,{error:error.message}):error instanceof SupplierMessageMutationConflict?reply(409,{error:error.message}):error instanceof LinkMutationInvalid?reply(400,{error:error.message}):error instanceof LinkMutationConflict?reply(409,{error:error.message}):error instanceof ProfileMutationInvalid?reply(400,{error:error.message}):error instanceof ProfileMutationConflict?reply(409,{error:error.message}):error instanceof SettingsMutationInvalid?reply(400,{error:error.message}):error instanceof SettingsMutationConflict?reply(409,{error:error.message}):error instanceof CatalogueMutationInvalid?reply(400,{error:error.message}):error instanceof CatalogueMutationConflict?reply(409,{error:error.message}):error instanceof CommandDenied?reply(error.status,{error:'This change is unavailable for this account.'}):error instanceof InboxMutationInvalid?reply(400,{error:error.message}):error instanceof InboxMutationConflict?reply(409,{error:error.message}):error instanceof HandoffMutationInvalid?reply(400,{error:error.message}):error instanceof HandoffMutationConflict?reply(409,{error:error.message}):error instanceof ClosingMutationInvalid?reply(400,{error:error.message}):error instanceof ClosingMutationConflict?reply(409,{error:error.message}):error instanceof OrderMutationInvalid?reply(400,{error:error.message}):error instanceof OrderMutationConflict?reply(409,{error:error.message}):error instanceof PurchaseMutationInvalid?reply(400,{error:error.message}):error instanceof PurchaseMutationConflict?reply(409,{error:error.message}):error instanceof MoneyMutationInvalid?reply(400,{error:error.message}):error instanceof MoneyMutationConflict?reply(409,{error:error.message}):error instanceof StockMutationInvalid?reply(400,{error:error.message}):error instanceof StockMutationConflict?reply(409,{error:error.message}):error instanceof CustomerMutationInvalid?reply(400,{error:'Check the customer, credit terms or opening balance. Settle all khata before archiving.'}):error instanceof CommandConflict?reply(409,{error:'This command conflicts with an existing or newer change. Refresh before trying again.'}):reply(503,{error:'Changes are unavailable. Try again with the same command ID.'});}
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
    if(r.status===400&&(name==='prepare_supplier_message_write'||name==='finish_supplier_message_write')){let code:unknown;try{code=(await r.json()).code;}catch{/* Backend details remain private. */}if(code==='22023')throw new SupplierMessageMutationInvalid('Review the original supplier, message and stock identities.');}
    if(r.status===400&&(name==='prepare_handoff_write'||name==='finish_handoff_write')){let code:unknown;try{code=(await r.json()).code;}catch{/* Backend messages and details stay private. */}if(code==='22023')throw new HandoffMutationInvalid('Review the exact message source, choice and companion records.');}
    if(r.status===400&&(name==='prepare_inbox_write'||name==='finish_inbox_write')){let code:unknown;try{code=(await r.json()).code;}catch{/* Backend messages and details stay private. */}if(code==='22023')throw new InboxMutationInvalid('Review the exact original source, images and manual Inbox action.');}
    if(r.status===400&&(name==='prepare_settings_write'||name==='finish_settings_write')){let code:unknown;try{code=(await r.json()).code;}catch{/* Backend details stay private. */}if(code==='22023')throw new SettingsMutationInvalid('Review the exact reminder wording or prepared-export metadata.');}
    if(r.status===400&&(name==='prepare_profile_write'||name==='finish_profile_write')){let code:unknown;try{code=(await r.json()).code;}catch{/* Backend details stay private. */}if(code==='22023')throw new ProfileMutationInvalid('Review the original business, contact and market settings.');}
    if(r.status===400&&(name==='prepare_catalogue_intent'||name==='finish_catalogue_intent')){let code:unknown;try{code=(await r.json()).code;}catch{/* Backend details stay private. */}if(code==='22023')throw new CatalogueMutationInvalid('Review the exact catalogue source, category and original IDs.');}
    if(r.status===400&&(name==='prepare_shop_link_write'||name==='finish_shop_link_write')){let code:unknown;try{code=(await r.json()).code;}catch{/* Backend details stay private. */}if(code==='22023')throw new LinkMutationInvalid('Review the exact frozen link or original generation.');}
    if(r.status===409){let code:unknown,details:unknown;try{const error=await r.json();code=error.code;details=error.details;}catch{/* Only the fixed error tag controls retry; backend details remain private. */}if(retryTag&&code==='PT409'&&details===retryTag)throw new CatalogueSnapshotChanged();throw new CommandConflict();}
    if(!r.ok)throw new Error('Command unavailable');return r.json();
  }
  return {admitLinkWrite:async(jwt,outletId)=>{if(await rpc('admit_shop_link_write',{p_outlet_id:outletId},publishableKey,jwt)!==true)throw new CommandDenied();},admitInboxWrite:async(jwt,outletId)=>{if(await rpc('admit_inbox_write',{p_outlet_id:outletId},publishableKey,jwt)!==true)throw new CommandDenied();},admitHandoffWrite:async(jwt,outletId)=>{if(await rpc('admit_handoff_write',{p_outlet_id:outletId},publishableKey,jwt)!==true)throw new CommandDenied();},admitStockBatch:async(jwt,outletId)=>{if(await rpc('admit_stock_batch',{p_outlet_id:outletId},publishableKey,jwt)!==true)throw new CommandDenied();},admitPurchaseRecord:async(jwt,outletId)=>{if(await rpc('admit_purchase_record',{p_outlet_id:outletId},publishableKey,jwt)!==true)throw new CommandDenied();},admitOrderWrite:async(jwt,outletId)=>{if(await rpc('admit_order_write',{p_outlet_id:outletId},publishableKey,jwt)!==true)throw new CommandDenied();},apply:async(jwt,value,currency)=>{
    const c=parseShopCommand(value);
    if(isLinkCommand(c)){
      if(!options.serviceKey||!/^sb_secret_[A-Za-z0-9_-]+$/.test(options.serviceKey))throw new Error('Shop-link writes unavailable');
      const hash=await linkFingerprint(c),newId=options.newId??deviceAuthId;
      for(let attempt=0;attempt<3;attempt++){
        const ticket=newId(),prepared=await rpc('prepare_shop_link_write',{p_id:c.id,p_ticket_id:ticket,p_type:c.type,p_outlet_id:c.outletId,p_owner_id:c.ownerId,p_plan:linkWritePlan(c),p_hash:hash,p_occurred_at:c.occurredAt},publishableKey,jwt,undefined,15000);
        if(prepared?.done===true)return prepared.receipt;
        const fields=linkWriteFields(prepared,c,ticket);
        try{return await rpc('finish_shop_link_write',fields,options.serviceKey,undefined,'shop_link_snapshot_changed',15000);}catch(error){if(!(error instanceof CatalogueSnapshotChanged))throw error;}
      }
      throw new CommandConflict();
    }
    if(isProfileCommand(c)){
      if(!options.serviceKey||!/^sb_secret_[A-Za-z0-9_-]+$/.test(options.serviceKey))throw new Error('Owner profile writes unavailable');
      const hash=await profileFingerprint(c),newId=options.newId??deviceAuthId;
      for(let attempt=0;attempt<3;attempt++){
        const ticket=newId();
        try{
          const prepared=await rpc('prepare_profile_write',{p_id:c.id,p_ticket_id:ticket,p_business_id:c.businessId,p_outlet_id:c.outletId,p_owner_id:c.ownerId,p_plan:profileWritePlan(c),p_hash:hash,p_occurred_at:c.occurredAt},publishableKey,jwt,'profile_snapshot_changed');
          if(prepared?.done===true)return prepared.receipt;
          return await rpc('finish_profile_write',profileWriteFields(prepared,c,ticket),options.serviceKey,undefined,'profile_snapshot_changed');
        }catch(error){if(!(error instanceof CatalogueSnapshotChanged))throw error;}
      }
      throw new CommandConflict();
    }
    if(isSettingsCommand(c)){
      if(!options.serviceKey||!/^sb_secret_[A-Za-z0-9_-]+$/.test(options.serviceKey))throw new Error('Settings writes unavailable');
      const hash=await settingsFingerprint(c),newId=options.newId??deviceAuthId;
      for(let attempt=0;attempt<3;attempt++){
        const ticket=newId(),prepared=await rpc('prepare_settings_write',{p_id:c.id,p_ticket_id:ticket,p_type:c.type,p_outlet_id:c.outletId,p_plan:settingsWritePlan(c),p_hash:hash,p_occurred_at:c.occurredAt},publishableKey,jwt);
        if(prepared?.done===true)return prepared.receipt;
        const fields=settingsWriteFields(prepared,c,ticket);
        try{return await rpc('finish_settings_write',fields,options.serviceKey,undefined,'settings_snapshot_changed');}catch(error){if(!(error instanceof CatalogueSnapshotChanged))throw error;}
      }
      throw new CommandConflict();
    }
    if(isInboxCommand(c)){
      if(!options.serviceKey||!/^sb_secret_[A-Za-z0-9_-]+$/.test(options.serviceKey))throw new Error('Inbox writes unavailable');
      const hash=await inboxFingerprint(c),newId=options.newId??deviceAuthId,deadline=c.type==='inbox.capture'?15000:5000;
      for(let attempt=0;attempt<3;attempt++){
        const ticket=newId(),prepared=await rpc('prepare_inbox_write',{p_id:c.id,p_ticket_id:ticket,p_type:c.type,p_outlet_id:c.outletId,p_plan:inboxWritePlan(c),p_hash:hash,p_occurred_at:c.occurredAt},publishableKey,jwt,undefined,deadline);
        if(prepared?.done===true)return prepared.receipt;
        const fields=inboxWriteFields(prepared,c,ticket);
        try{return await rpc('finish_inbox_write',fields,options.serviceKey,undefined,'inbox_snapshot_changed',deadline);}catch(error){if(!(error instanceof CatalogueSnapshotChanged))throw error;}
      }
      throw new CommandConflict();
    }
    if(isSupplierMessageCommand(c)){
      if(!options.serviceKey||!/^sb_secret_[A-Za-z0-9_-]+$/.test(options.serviceKey))throw new Error('Supplier message records unavailable');
      const hash=await supplierMessageFingerprint(c),newId=options.newId??deviceAuthId;
      for(let attempt=0;attempt<3;attempt++){
        const ticket=newId(),prepared=await rpc('prepare_supplier_message_write',{p_id:c.id,p_ticket_id:ticket,p_outlet_id:c.outletId,p_plan:supplierMessageWritePlan(c),p_hash:hash,p_occurred_at:c.occurredAt},publishableKey,jwt,undefined,15000);
        if(prepared?.done===true)return prepared.receipt;
        const fields=supplierMessageWriteFields(prepared,c,ticket);
        try{return await rpc('finish_supplier_message_write',fields,options.serviceKey,undefined,'supplier_message_snapshot_changed',15000);}catch(error){if(!(error instanceof CatalogueSnapshotChanged))throw error;}
      }
      throw new CommandConflict();
    }
    if(isHandoffCommand(c)){
      if(!options.serviceKey||!/^sb_secret_[A-Za-z0-9_-]+$/.test(options.serviceKey))throw new Error('Manual message writes unavailable');
      const hash=await handoffFingerprint(c),newId=options.newId??deviceAuthId,deadline=c.type==='handoff.prepare'?15000:5000;
      for(let attempt=0;attempt<3;attempt++){
        const ticket=newId(),prepared=await rpc('prepare_handoff_write',{p_id:c.id,p_ticket_id:ticket,p_type:c.type,p_outlet_id:c.outletId,p_plan:handoffWritePlan(c),p_hash:hash,p_occurred_at:c.occurredAt},publishableKey,jwt,undefined,deadline);
        if(prepared?.done===true)return prepared.receipt;
        const fields=handoffWriteFields(prepared,c,ticket);
        try{return await rpc('finish_handoff_write',fields,options.serviceKey,undefined,'handoff_snapshot_changed',deadline);}catch(error){if(!(error instanceof CatalogueSnapshotChanged))throw error;}
      }
      throw new CommandConflict();
    }
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
        if(!proposedOrderCurrencyMatches(c,fields.p_records,currency))throw new CommandConflict();
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
        if(!proposedMoneyCurrencyMatches(c,fields.p_records,currency))throw new CommandConflict();
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
    if(isCatalogueWrite(c)){
      if(!options.serviceKey||!/^sb_secret_[A-Za-z0-9_-]+$/.test(options.serviceKey))throw new Error('Catalogue writes unavailable');
      const hash=await catalogueFingerprint(c),newId=options.newId??deviceAuthId;
      for(let attempt=0;attempt<3;attempt++){
        const ticket=newId(),prepared=await rpc('prepare_catalogue_intent',{p_id:c.id,p_ticket_id:ticket,p_type:c.type,p_item_id:c.itemId,p_outlet_id:c.outletId,p_hash:hash,p_occurred_at:c.occurredAt,p_plan:catalogueRecordPlan(c)},publishableKey,jwt);
        if(prepared?.done===true)return prepared.receipt;
        const fields=catalogueWriteFields(prepared,c,ticket);
        try{return await rpc('finish_catalogue_intent',fields,options.serviceKey,undefined,'catalogue_snapshot_changed');}catch(error){if(!(error instanceof CatalogueSnapshotChanged))throw error;}
      }
      throw new CommandConflict();
    }
    return rpc('apply_catalogue_intent',{p_id:c.id,p_type:c.type,p_item_id:c.type==='catalogue.availability'?c.itemId:null,p_outlet_id:c.outletId,p_available:c.type==='catalogue.availability'?c.available:null,p_undo_of:c.type==='catalogue.undo'?c.undoOf:null,p_occurred_at:c.occurredAt},publishableKey,jwt);
  }};
}
