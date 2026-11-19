import type {BackupTable, MiseBackup} from './backup-tables';
import {encodeCommandRecord} from './cloud-records';
import {isClosingCommand,isCustomerCommand,isHandoffCommand,isInboxCommand,isLinkCommand,isOrderCommand,isProfileCommand,isPurchaseCommand,isSettingsCommand,isSupplierMessageCommand,type ShopCommand} from './shop-commands';
import {creditBalance} from './khata';
import {replayCustomerRecords} from './customer-replay';
import {replayPurchaseRecords} from './purchase-replay';
import {replayOrderRecords} from './order-replay';
import {replayClosingRecords} from './closing-replay';
import {replayHandoffRecords} from './handoff-replay';
import {replayInboxRecords} from './inbox-replay';
import {purchaseWritePlan} from './purchase-commands';
import {isOrderSave,orderWritePlan} from './order-commands';
import {handoffEventSession,handoffSourceTables,handoffTopic} from './handoff';
import {inboxImageBytes} from './inbox';
import {syncHash} from './sync-read';
import {saveCatalogueItem} from './catalogue-save';
import {setupCommand} from './setup';
import {saveCreditMessagingCommand} from './khata-messages';
import {exportPreparedCommand} from './export-audit';
import {publishedLink} from './link-commands';
import {generateReviewedShopLinkCommand,undoShopLinkCommand} from './shop-links';
import {recordSupplierMessageCommand} from './supplier-drafts';
import type {AuditEvent,Item,Member} from './models';
import {PendingReplayError,replaySqlRow,type ReplayProjection} from './replay-records';
import {syncDownloadToken} from './sync-download';

/** Only verified snapshot facts enter the existing shared domain calculations. */
export async function replayOtherPending(backup:MiseBackup,c:ShopCommand,actor:Member,at:number):Promise<ReplayProjection> {
  const t=backup.tables,business=t.businesses[0],outlet=t.outlets[0],setup={business,outlet,owner:actor};
  const row=(table:BackupTable,value:unknown|null)=>replaySqlRow(table,value,business.id),rows=(table:BackupTable,values:unknown[])=>values.map(value=>row(table,value));
  const envelope=(raw:Record<string,unknown>)=>({businessId:business.id,outletId:outlet.id,actorId:actor.id,at,contextJson:JSON.stringify({business:row('businesses',business),outlet:row('outlets',outlet),...raw})});
  const record=(table:BackupTable,value:unknown)=>encodeCommandRecord(table,value,business.id);
  const stamp=<T extends {createdAt:number;updatedAt:number}>(value:T,occurredAt:number):T=>({...value,updatedAt:Math.max(at,occurredAt,value.createdAt,value.updatedAt)});
  if(isCustomerCommand(c)){
    const customer=t.customers.find(customer=>customer.id===c.customerId)??null,accounts=t.creditAccounts.filter(account=>account.customerId===c.customerId);
    if('ids'in c && c.type==='khata.settings' && c.accountId===null && accounts.some(account=>account.currency===outlet.currency&&account.id!==c.ids.accountId))throw new PendingReplayError();
    return {records:replayCustomerRecords(envelope({customer:row('customers',customer),accounts:rows('creditAccounts',accounts),hasBalance:accounts.some(account=>creditBalance(account,t.creditEntries)!==0)}),c)};
  }
  if(isPurchaseCommand(c)){
    const plan=purchaseWritePlan(c);
    if(c.type==='supplier.create'&&t.suppliers.some(s=>s.id===c.supplierId)||c.type==='purchase.record'&&t.purchases.some(p=>p.id===c.purchaseId))throw new PendingReplayError();
    return {records:replayPurchaseRecords(envelope({supplier:row('suppliers',t.suppliers.find(s=>s.id===plan.supplierId)??null),purchase:row('purchases',t.purchases.find(p=>p.id===plan.purchaseId)??null),stock:rows('stockItems',t.stockItems.filter(item=>plan.stockItemIds.includes(item.id)))}),c)};
  }
  if(isOrderCommand(c)){
    const plan=orderWritePlan(c),order=t.orders.find(order=>order.id===plan.orderId)??null,refund=t.orderRefunds.find(refund=>refund.id===plan.refundId)??null;
    const sale=t.sales.find(sale=>sale.id===(plan.sourceSaleId??refund?.saleId))??null;
    const customer=t.customers.find(customer=>customer.id===(isOrderSave(c)?c.input.customerId:order?.customer.id))??null;
    const account=t.creditAccounts.find(account=>account.id===(plan.accountId??sale?.creditAccountId??refund?.accountId))??(plan.bindings.method==='credit'?t.creditAccounts.find(account=>account.customerId===customer?.id&&account.currency===(order?.currency??outlet.currency)):null)??null;
    return {records:replayOrderRecords(envelope({order:row('orders',order),customer:row('customers',customer),account:row('creditAccounts',account),sale:row('sales',sale),refund:row('orderRefunds',refund),statusEvent:row('events',c.type==='order.status-undo'?t.events.find(event=>event.id===order?.statusEventId)??null:null),items:rows('items',t.items.filter(item=>plan.itemIds.includes(item.id))),entries:rows('creditEntries',t.creditEntries.filter(entry=>entry.accountId===account?.id)),sequence:c.type==='order.create'?t.orders.reduce((n,order)=>Math.max(n,order.sequence),0)+1:order?.sequence??1}),c)};
  }
  if(isClosingCommand(c)){
    const closing=t.dayClosings.find(closing=>closing.id===c.closingId)??null;
    return {records:replayClosingRecords(envelope({actorName:actor.name,closing:row('dayClosings',closing),sale:row('sales',t.sales.find(sale=>sale.id===closing?.addedSaleId)??null),sales:rows('sales',t.sales),orders:rows('orders',t.orders),refunds:rows('orderRefunds',t.orderRefunds),accounts:rows('creditAccounts',t.creditAccounts),entries:rows('creditEntries',t.creditEntries),customers:rows('customers',t.customers),stock:rows('stockItems',t.stockItems),closings:rows('dayClosings',t.dayClosings)}),c)};
  }
  if(isHandoffCommand(c)){
    let root:AuditEvent|null=null,previousRoot:AuditEvent|null=null,latest:AuditEvent|null=null,generation=1;
    if(c.type==='handoff.prepare'){
      const topic=handoffTopic(c.draft),roots=t.events.filter(event=>event.command==='handoff.prepare'&&handoffTopic(handoffEventSession(event).draft)===topic).sort((a,b)=>handoffEventSession(b).generation-handoffEventSession(a).generation);
      previousRoot=roots[0]??null;if(previousRoot)generation=handoffEventSession(previousRoot).generation+1;
    }else if(c.type==='handoff.change'){
      root=t.events.find(event=>event.id===c.handoffId&&event.command==='handoff.prepare')??null;
      if(!root)throw new PendingReplayError();generation=handoffEventSession(root).generation;
    }
    const parent=root??previousRoot;
    if(parent)latest=t.events.filter(event=>event.handoffId===parent.id).sort((a,b)=>(b.handoffRevision??0)-(a.handoffRevision??0))[0]??null;
    const draft=c.type==='handoff.prepare'?c.draft:root?handoffEventSession(root).draft:null,sourceKind=draft?.source.kind??null,sourceId=draft?.source.id??null;
    const source=sourceKind?t[handoffSourceTables[sourceKind]].find(value=>value.id===sourceId)??null:null;
    const account=sourceKind==='credit'?t.creditAccounts.find(account=>account.id===sourceId):undefined;
    const related=c.type==='handoff.change'?c.related?.recordId:c.type==='supplier-message.undo'?c.messageId:null;
    return {records:replayHandoffRecords(envelope({root:row('events',root),previousRoot:row('events',previousRoot),latest:row('events',latest),generation,sourceKind,sourceId,source:sourceKind?row(handoffSourceTables[sourceKind],source):null,customer:row('customers',t.customers.find(customer=>customer.id===account?.customerId)??null),entries:rows('creditEntries',t.creditEntries.filter(entry=>entry.accountId===account?.id)),items:rows('stockItems',c.type==='handoff.change'&&c.completion?.kind==='supplier'?t.stockItems.filter(item=>c.completion?.kind==='supplier'&&c.completion.stockItemIds.includes(item.id)):[]),message:row('supplierMessages',t.supplierMessages.find(message=>message.id===related)??null)}),c)};
  }
  if(isInboxCommand(c)){
    const item=t.inboxItems.find(item=>item.id===c.itemId)??null,images=await Promise.all((item?.images??[]).map(async(image,position)=>({id:image.id,business_id:business.id,outlet_id:outlet.id,inbox_item_id:c.itemId,position,name:image.name,type:image.type,size:image.size,sha256:await syncHash(inboxImageBytes(image))})));
    return {records:replayInboxRecords(envelope({item:row('inboxItems',item),images,latest:row('events',t.events.find(event=>event.inboxId===item?.id&&event.inboxRevision===item?.revision&&event.at===item?.updatedAt)??null)}),c)};
  }
  if(isSettingsCommand(c)){
    if(c.occurredAt>at+300000)throw new PendingReplayError();
    if(c.type==='export.prepare')return {records:[record('events',{...exportPreparedCommand({...c.input,outletId:outlet.id,actorId:actor.id},setup,c.occurredAt,()=>c.id),at})]};
    const change=saveCreditMessagingCommand(c.input,setup,c.occurredAt,()=>c.id),updated=stamp(change.outlet,c.occurredAt);
    return {records:[record('outlets',updated),record('events',{...change.event,at,after:updated})]};
  }
  if(isProfileCommand(c)){
    if(actor.role!=='owner'||c.businessId!==business.id||c.ownerId!==actor.id||c.occurredAt>at+300000)throw new PendingReplayError();
    const change=setupCommand(c.input,setup,c.occurredAt,()=>c.id),snapshot={business:stamp(change.snapshot.business,c.occurredAt),outlet:stamp(change.snapshot.outlet,c.occurredAt),owner:stamp(change.snapshot.owner,c.occurredAt)};
    return {records:[record('businesses',snapshot.business),record('outlets',snapshot.outlet),record('members',snapshot.owner),record('events',{...change.event,at,after:snapshot})]};
  }
  if(isLinkCommand(c)){
    if(c.ownerId!==actor.id||c.occurredAt>at+300000)throw new PendingReplayError();
    let url:string|null,event:AuditEvent;
    if(c.type==='shopLink.generate'){
      const {base,shop}=publishedLink(c.url),frozen=JSON.parse(c.review.sourceToken);
      if(frozen.businessId!==business.id)throw new PendingReplayError();
      const reviewed={business:{...business,marketCode:shop.market},outlet:{...outlet,name:shop.name,address:shop.address,currency:shop.currency,timezone:shop.timezone,shopLink:c.review.previousUrl??undefined},owner:{...actor,phone:frozen.ownerPhone}};
      const change=generateReviewedShopLinkCommand({phone:shop.phone,hours:shop.hours,deliveryNote:shop.deliveryNote,mode:shop.mode,itemIds:shop.items.map(item=>item.id)},reviewed,shop.items,c.review,base,c.occurredAt,{code:shop.code,edition:shop.edition,eventId:c.id});
      if(change.outlet.shopLink!==c.url)throw new PendingReplayError();url=c.url;event={...change.event,before:{url:outlet.shopLink??null},at};
    }else{
      const source=t.events.find(event=>event.id===c.sourceId);
      if(!source||t.events.some(event=>event.undoOf===source.id))throw new PendingReplayError();
      // Server audit time can differ from the physical publication time.
      const published=(source.after as {url?:unknown})?.url,occurred=typeof published==='string'?publishedLink(published).shop.publishedAt:NaN;
      const change=undoShopLinkCommand({...source,at:occurred},setup,c.occurredAt,()=>c.id);url=change.outlet.shopLink??null;event={...change.event,at};
    }
    const next=stamp(outlet,c.occurredAt);if(url===null)delete next.shopLink;else next.shopLink=url;
    return {records:[record('outlets',next),record('events',event)]};
  }
  if(isSupplierMessageCommand(c)){
    if(c.occurredAt>at+300000||t.supplierMessages.some(message=>message.id===c.message.id))throw new PendingReplayError();
    const change=recordSupplierMessageCommand({...c.message,supplierId:c.message.supplierId??undefined,phone:c.message.phone??undefined},{setup,items:t.stockItems,suppliers:t.suppliers},c.occurredAt,()=>c.id);
    const message=stamp(change.message,c.occurredAt);
    return {records:[record('supplierMessages',message),record('events',{...change.event,at,after:message})]};
  }
  if(c.type.startsWith('catalogue.')){
    if(!('occurredAt'in c)||c.occurredAt>at+300000)throw new PendingReplayError();
    const source=c.type==='catalogue.undo'?t.events.find(event=>event.id===c.undoOf):null;
    const id='itemId'in c?c.itemId:(source?.after as Item|null)?.id,before=t.items.find(item=>item.id===id)??null;
    if(c.type==='catalogue.create'||c.type==='catalogue.update'){
      if(c.type==='catalogue.create'?before!==null:before===null)throw new PendingReplayError();
      const change=saveCatalogueItem(c.input,{outletId:outlet.id,actorId:actor.id,categories:t.categories},before,c.occurredAt,kind=>kind==='item'?c.itemId:kind==='event'?c.id:c.categoryId);
      if(change.item.categoryId!==c.categoryId||change.category&&t.categories.some(category=>category.id===change.category?.id))throw new PendingReplayError();
      change.item=stamp(change.item,c.occurredAt);if(change.category)change.category=stamp(change.category,c.occurredAt);
      return {records:[...(change.category?[record('categories',change.category)]:[]),record('items',change.item),record('events',{...change.event,at,after:{item:change.item,category:change.category??null}})]};
    }
    if(!before)throw new PendingReplayError();
    if(c.type==='catalogue.delete'||c.type==='catalogue.remove-sample'){
      if(c.type==='catalogue.remove-sample'&&!before.isSample)throw new PendingReplayError();
      return {records:[record('events',{id:c.id,outletId:outlet.id,actor:{type:'member',id:actor.id},command:c.type,before,after:null,at} satisfies AuditEvent)],deleted:[{table:'items',id:before.id}]};
    }
    if(c.type==='catalogue.availability'||c.type==='catalogue.undo'){
      let available:boolean;
      if(c.type==='catalogue.availability')available=c.available;
      else{
        if(!source||source.command!=='catalogue.availability'||source.outletId!==outlet.id||t.events.some(event=>event.undoOf===source.id)||syncDownloadToken(source.after)!==syncDownloadToken(before)||typeof (source.before as Item|null)?.available!=='boolean')throw new PendingReplayError();
        available=(source.before as Item).available;
      }
      const next=stamp({...before,available},c.occurredAt);
      return {records:[record('items',next),record('events',{id:c.id,outletId:outlet.id,actor:{type:'member',id:actor.id},command:c.type==='catalogue.undo'?'catalogue.availability.undo':c.type,before,after:next,at,...(c.type==='catalogue.undo'?{undoOf:c.undoOf}:{})} satisfies AuditEvent)]};
    }
  }
  throw new PendingReplayError('retained');
}
