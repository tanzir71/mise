import type { HandoffDraft,HandoffSession } from '@mise/core/handoff';
import type { HandoffChoice } from '@mise/core/handoff-progress';
import Dexie, { type EntityTable } from 'dexie';
import type { Business, Outlet, Member, Category, Item, Sale, Customer, CreditAccount, CreditEntry, CreditMessaging, PaymentMethod, AuditEvent, SetupSnapshot, SetupInput, Order, OrderNote, OrderCommunication, OrderStatus, OrderRefund, StockItem, StockMove, Supplier, SupplierMessage } from '@mise/core/models';
import { setupCommand } from '@mise/core/setup';
import { removeSampleCommand, saveItemCommand, itemAvailabilityCommand, deleteItemCommand, type ItemInput } from '@mise/core/catalogue';
import { recordSaleCommand, undoSaleCommand, type SaleInput } from '@mise/core/sales';
import { marketPacks } from '@mise/core/packs';
import { saveCustomerCommand, archiveCustomerCommand, type CustomerInput } from '@mise/core/customers';
import { creditBalance, defaultCreditTerms, saveCreditTermsCommand, openingBalanceCommand, recordCreditPaymentCommand, undoCreditEntryCommand, recordCommunicationCommand, type CreditTermsInput, type LedgerContext } from '@mise/core/khata';
import { recordCreditSaleCommand, undoCreditSaleCommand, type CreditSaleInput } from '@mise/core/credit-sales';
import { saveCreditMessagingCommand } from '@mise/core/khata-messages';
import { settleOrderCommand, undoOrderPaymentCommand, cancelOrderCommand, undoOrderCancellationCommand, refundOrderCommand, undoOrderRefundCommand, type OrderMoneyChange, type OrderMoneyContext, type OrderSettlementInput, type OrderRefundInput } from '@mise/core/order-payments';
import { saveOrderCommand, changeOrderStatusCommand, undoOrderStatusCommand, addOrderNoteCommand, recordOrderCommunicationCommand, saveOrderWarningCommand, type OrderInput } from '@mise/core/orders';
import { saveStockItemCommand, adjustStockCommand, stockBatchCommand, undoStockMoveCommand, archiveStockItemCommand, saveSupplierCommand, archiveSupplierCommand, type StockInput, type StockContext, type StockChange, type StockAdjustment, type SupplierInput } from '@mise/core/stock';
import { recordSupplierMessageCommand, sameSupplierMessage, undoSupplierMessageCommand, type SupplierMessageInput } from '@mise/core/supplier-drafts';
import { closeDayCommand, sameClosingRequest, undoClosingCommand, type ClosingInput } from '@mise/core/closing';
import type { DayClosing } from '@mise/core/models';
import type { TodayContext } from '@mise/core/today';
import type { MiseBackup } from '@mise/core/backup-tables';
import type { BackupPreview, RestoreReview } from '@mise/core/backup';
import type { Purchase } from '@mise/core/models';
import type { PurchaseInput } from '@mise/core/purchases';
import type { ExportAuditInput } from '@mise/core/export-audit';
import type { ShopLinkInput,ShopLinkReview } from '@mise/core/shop-links';

export class MiseDatabase extends Dexie {
  businesses!: EntityTable<Business, 'id'>;
  outlets!: EntityTable<Outlet, 'id'>;
  members!: EntityTable<Member, 'id'>;
  categories!: EntityTable<Category, 'id'>;
  items!: EntityTable<Item, 'id'>;
  events!: EntityTable<AuditEvent, 'id'>;
  sales!: EntityTable<Sale, 'id'>;
  customers!: EntityTable<Customer, 'id'>;
  creditAccounts!: EntityTable<CreditAccount, 'id'>;
  creditEntries!: EntityTable<CreditEntry, 'id'>;
  orders!: EntityTable<Order,'id'>;
  orderNotes!: EntityTable<OrderNote,'id'>;
  orderCommunications!: EntityTable<OrderCommunication,'id'>;
  orderRefunds!: EntityTable<OrderRefund,'id'>;
  stockItems!: EntityTable<StockItem,'id'>;
  stockMoves!: EntityTable<StockMove,'id'>;
  suppliers!: EntityTable<Supplier,'id'>;
  supplierMessages!: EntityTable<SupplierMessage,'id'>;
  dayClosings!: EntityTable<DayClosing,'id'>;
  purchases!: EntityTable<Purchase,'id'>;
  constructor(name = 'mise-local') {
    super(name);
    this.version(1).stores({ businesses: 'id', outlets: 'id,businessId', members: 'id,businessId', categories: 'id,outletId', items: 'id,outletId,categoryId', events: 'id,outletId,at,command' });
    this.version(2).stores({ sales: 'id,outletId,createdAt' });
    this.version(3).stores({ customers:'id,businessId,phone,&[businessId+phone]', creditAccounts:'id,outletId,customerId,&[outletId+customerId+currency]', creditEntries:'id,outletId,accountId,customerId,createdAt,saleId,eventId,&reversalOf,&[accountId+sequence]', events:'id,outletId,at,command,customerId' });
    this.version(4).stores({orders:'id,outletId,status,customer.id,createdAt,&[outletId+sequence],&[outletId+number]',orderNotes:'id,orderId,outletId,&[orderId+revision]',orderCommunications:'id,orderId,outletId,&[orderId+revision]',events:'id,outletId,at,command,customerId,orderId,[orderId+orderRevision]'});
    this.version(5).stores({orderRefunds:'id,outletId,orderId,saleId,createdAt',sales:'id,outletId,createdAt,orderId',creditEntries:'id,outletId,accountId,customerId,createdAt,saleId,eventId,orderId,refundId,&reversalOf,&[accountId+sequence]'});
    this.version(6).stores({stockItems:'id,outletId,supplierId,category,&[outletId+activeKey]',stockMoves:'id,outletId,stockItemId,createdAt,countBatchId,&undoOf,&[stockItemId+revision]',suppliers:'id,outletId',supplierMessages:'id,outletId,supplierId,createdAt',events:'id,outletId,at,command,customerId,orderId,[orderId+orderRevision],stockItemId,supplierId,[stockItemId+stockRevision]'});
    this.version(7).stores({dayClosings:'id,outletId,day,&[outletId+activeKey]',events:'id,outletId,at,command,customerId,orderId,[orderId+orderRevision],stockItemId,supplierId,[stockItemId+stockRevision],closingId'});
    this.version(8).stores({purchases:'id,outletId,supplierId,createdAt'});
    this.version(9).stores({events:'id,outletId,at,command,customerId,orderId,[orderId+orderRevision],stockItemId,supplierId,[stockItemId+stockRevision],closingId,handoffId,handoffTopic,&[handoffId+handoffRevision]'});
  }
  async prepareHandoff(input:HandoffDraft,fresh=false):Promise<HandoffSession> {return (await import('./handoff')).prepareDatabaseHandoff(this,input,fresh);}
  async readHandoff(id:string):Promise<HandoffSession> {return (await import('./handoff')).readDatabaseHandoff(this,id);}
  async changeHandoff(id:string,revision:number,choice:HandoffChoice,requestId?:string):Promise<HandoffSession> {return (await import('./handoff')).changeDatabaseHandoff(this,id,revision,choice,requestId);}
  async setup(): Promise<SetupSnapshot | null> {
    const business = await this.businesses.toCollection().first();
    if (!business) return null;
    const [outlet, owner] = await Promise.all([this.outlets.where('businessId').equals(business.id).first(), this.members.where('businessId').equals(business.id).first()]);
    if (!outlet || !owner) throw new Error('Shop data is incomplete. Keep this browser’s data and try again.');
    return { business, outlet, owner };
  }
  async saveSetup(input: SetupInput): Promise<SetupSnapshot> {
    return this.transaction('rw', this.tables, async () => {
      const command = setupCommand(input, await this.setup());
      const { business, outlet, owner } = command.snapshot;
      await this.businesses.put(business); await this.outlets.put(outlet); await this.members.put(owner);
      await this.categories.bulkPut(command.categories); await this.items.bulkPut(command.items); await this.events.add(command.event);
      return command.snapshot;
    });
  }
  async removeSample(id: string): Promise<void> {
    await this.transaction('rw', this.tables, async () => {
      const [item, setup] = await Promise.all([this.items.get(id), this.setup()]);
      if (!item || !setup || item.outletId !== setup.outlet.id) throw new Error('Sample item not found.');
      const event = removeSampleCommand(item, setup.owner.id);
      await this.items.delete(id); await this.events.add(event);
    });
  }
  async saveItem(input: ItemInput, id?: string): Promise<Item> {
    return this.transaction('rw', this.tables, async () => {
      const setup = await this.setup(); if (!setup) throw new Error('Set up your shop first.');
      const before = id ? await this.items.get(id) : null;
      if (id && !before) throw new Error('Item not found.');
      const command = saveItemCommand(input, { outletId: setup.outlet.id, actorId: setup.owner.id, categories: await this.categories.where('outletId').equals(setup.outlet.id).toArray() }, before);
      if (command.category) await this.categories.add(command.category);
      await this.items.put(command.item); await this.events.add(command.event);
      return command.item;
    });
  }
  async setItemAvailable(id: string, available: boolean): Promise<void> {
    await this.transaction('rw', this.tables, async () => {
      const [item, setup] = await Promise.all([this.items.get(id), this.setup()]);
      if (!item || !setup || item.outletId !== setup.outlet.id) throw new Error('Item not found.');
      const command = itemAvailabilityCommand(item, available, setup.owner.id);
      await this.items.put(command.item); await this.events.add(command.event);
    });
  }
  async deleteItem(id: string): Promise<void> {
    await this.transaction('rw', this.tables, async () => {
      const [item, setup] = await Promise.all([this.items.get(id), this.setup()]);
      if (!item || !setup || item.outletId !== setup.outlet.id) throw new Error('Item not found.');
      const event = deleteItemCommand(item, setup.owner.id);
      await this.items.delete(id); await this.events.add(event);
    });
  }
  async addItems(inputs: ItemInput[]): Promise<void> {
    if (!inputs.length || inputs.length > 1000) throw new Error('Paste between 1 and 1,000 items at a time.');
    await this.transaction('rw', this.tables, async () => {
      const setup = await this.setup(); if (!setup) throw new Error('Set up your shop first.');
      const categories = await this.categories.where('outletId').equals(setup.outlet.id).toArray();
      for (const input of inputs) {
        const command = saveItemCommand(input, { outletId: setup.outlet.id, actorId: setup.owner.id, categories });
        if (command.category) { await this.categories.add(command.category); categories.push(command.category); }
        await this.items.add(command.item); await this.events.add(command.event);
      }
    });
  }
  async recordSale(input: SaleInput): Promise<Sale> {
    return this.transaction('rw', this.tables, async () => {
      const setup = await this.setup(); if (!setup) throw new Error('Set up your shop first.');
      const command = recordSaleCommand(input, { setup, wallets: marketPacks[setup.business.marketCode]['pay/wallets'], items: await this.items.where('outletId').equals(setup.outlet.id).toArray() });
      await this.sales.add(command.sale); await this.events.add(command.event); return command.sale;
    });
  }
  async undoSale(id: string): Promise<void> {
    await this.transaction('rw', this.tables, async () => {
      const [sale, setup] = await Promise.all([this.sales.get(id), this.setup()]);
      if (!sale || !setup || sale.outletId !== setup.outlet.id) throw new Error('Sale not found.');
      if (sale.orderId) {
        const {order} = await this.orderContext(sale.orderId), context = await this.orderMoneyContext(order,setup);
        let change: OrderMoneyChange;
        if (sale.voidReason === 'order-cancel') {
          const event = await this.events.get(order.statusEventId); if (!event) throw new Error('Cancellation history not found.');
          change = undoOrderCancellationCommand(order,event,sale,context,order.revision);
        } else change = undoOrderPaymentCommand(order,sale,context,order.revision);
        await this.writeOrderMoney(change); return;
      }
      if (sale.method === 'credit') {
        const context = await this.ledgerContext(sale.creditAccountId || '');
        const charge = context.entries.find(entry => entry.saleId === sale.id && entry.type === 'charge');
        if (!charge) throw new Error('Credit charge not found.');
        const command = undoCreditSaleCommand(sale,charge,context);
        await this.sales.put(command.sale); await this.events.add(command.event);
        await this.creditEntries.add(command.entry); await this.events.add(command.creditEvent); return;
      }
      const command = undoSaleCommand(sale, setup.owner.id);
      await this.sales.put(command.sale); await this.events.add(command.event);
    });
  }
  private async ledgerContext(accountId: string): Promise<LedgerContext> {
    const [account,setup] = await Promise.all([this.creditAccounts.get(accountId),this.setup()]);
    const customer = account ? await this.customers.get(account.customerId) : undefined;
    if (!setup || !account || !customer || customer.businessId !== setup.business.id || account.outletId !== setup.outlet.id) throw new Error('Khata not found in this shop.');
    return {setup,account,customer,entries:await this.creditEntries.where('accountId').equals(accountId).toArray()};
  }
  async readCreditLedger(accountId: string): Promise<LedgerContext> { return this.transaction('r',this.tables,() => this.ledgerContext(accountId)); }
  async saveCustomer(input: CustomerInput, options: { id?: string; credit?: CreditTermsInput; opening?: {amount:number;occurredAt:number} } = {}): Promise<Customer> {
    return this.transaction('rw',this.tables,async () => {
      const setup = await this.setup(); if (!setup) throw new Error('Set up your shop first.');
      const before = options.id ? await this.customers.get(options.id) : null;
      if (options.id && !before) throw new Error('Customer not found.');
      const command = saveCustomerCommand(input,setup,await this.customers.where('businessId').equals(setup.business.id).toArray(),before);
      const existing = await this.creditAccounts.where('[outletId+customerId+currency]').equals([setup.outlet.id,command.customer.id,setup.outlet.currency]).first();
      if (options.opening && existing) throw new Error('Opening balances are only available on a new khata.');
      await this.customers.put(command.customer); await this.events.add(command.event);
      if (!existing || options.credit) {
        const terms = saveCreditTermsCommand(options.credit || defaultCreditTerms,command.customer,setup,existing || null);
        await this.creditAccounts.put(terms.account); await this.events.add(terms.event);
        if (options.opening) { const opening = openingBalanceCommand(options.opening.amount,options.opening.occurredAt,{setup,customer:command.customer,account:terms.account,entries:[]}); await this.creditEntries.add(opening.entry); await this.events.add(opening.event); }
      }
      return command.customer;
    });
  }
  async saveCreditTerms(customerId: string, input: CreditTermsInput, accountId?: string): Promise<CreditAccount> {
    return this.transaction('rw',this.tables,async () => {
      const setup = await this.setup(), customer = await this.customers.get(customerId);
      if (!setup || !customer) throw new Error('Customer not found.');
      const before = accountId ? await this.creditAccounts.get(accountId) : await this.creditAccounts.where('[outletId+customerId+currency]').equals([setup.outlet.id,customerId,setup.outlet.currency]).first();
      if (accountId && !before) throw new Error('Khata not found.');
      const command = saveCreditTermsCommand(input,customer,setup,before || null);
      await this.creditAccounts.put(command.account); await this.events.add(command.event); return command.account;
    });
  }
  async archiveCustomer(id: string, archive = true): Promise<void> {
    await this.transaction('rw',this.tables,async () => {
      const setup = await this.setup(), customer = await this.customers.get(id);
      if (!setup || !customer) throw new Error('Customer not found.');
      const accounts = await this.creditAccounts.where('customerId').equals(id).toArray(), entries = await this.creditEntries.where('customerId').equals(id).toArray();
      const command = archiveCustomerCommand(customer,setup,accounts.some(account => creditBalance(account,entries) !== 0),archive);
      await this.customers.put(command.customer); await this.events.add(command.event);
    });
  }
  async recordCreditSale(input: CreditSaleInput): Promise<Sale> {
    return this.transaction('rw',this.tables,async () => {
      const context = await this.ledgerContext(input.accountId);
      const command = recordCreditSaleCommand(input,context,{setup:context.setup,wallets:marketPacks[context.setup.business.marketCode]['pay/wallets'],items:await this.items.where('outletId').equals(context.setup.outlet.id).toArray()});
      await this.sales.add(command.sale); await this.events.add(command.event);
      await this.creditEntries.add(command.entry); await this.events.add(command.creditEvent); return command.sale;
    });
  }
  async recordCreditPayment(accountId: string, amount: number, method: PaymentMethod, wallet?: string, note = ''): Promise<CreditEntry> {
    return this.transaction('rw',this.tables,async () => {
      const context = await this.ledgerContext(accountId), command = recordCreditPaymentCommand(amount,method,wallet,context,marketPacks[context.setup.business.marketCode]['pay/wallets'],note);
      await this.creditEntries.add(command.entry); await this.events.add(command.event); return command.entry;
    });
  }
  async undoCreditEntry(id: string): Promise<void> {
    await this.transaction('rw',this.tables,async () => {
      const entry = await this.creditEntries.get(id); if (!entry) throw new Error('Credit entry not found.');
      if (entry.refundId) { await this.undoOrderRefund(entry.refundId); return; }
      const command = undoCreditEntryCommand(entry,await this.ledgerContext(entry.accountId));
      await this.creditEntries.add(command.entry); await this.events.add(command.event);
    });
  }
  async recordCommunication(accountId: string, purpose: 'reminder'|'receipt'|'call', text: string, channel: 'whatsapp'|'manual'|'call'): Promise<void> {
    await this.transaction('rw',this.tables,async () => {
      const command = recordCommunicationCommand(await this.ledgerContext(accountId),purpose,text,channel);
      await this.creditEntries.add(command.entry); await this.events.add(command.event);
    });
  }
  async saveCreditMessaging(input: CreditMessaging): Promise<void> {
    await this.transaction('rw',this.tables,async () => {
      const setup = await this.setup(); if (!setup) throw new Error('Set up your shop first.');
      const command = saveCreditMessagingCommand(input,setup);
      await this.outlets.put(command.outlet); await this.events.add(command.event);
    });
  }

  async saveOrder(input: OrderInput, options: {id?:string;revision?:number;settlement?:OrderSettlementInput} = {}): Promise<Order> {
    return this.transaction('rw',this.tables,async () => {
      const setup = await this.setup(); if (!setup) throw new Error('Set up your shop first.');
      const before = options.id ? await this.orders.get(options.id) : null;
      if (options.id && !before) throw new Error('Order not found.');
      const last = before || await this.orders.where('[outletId+sequence]').between([setup.outlet.id,Dexie.minKey],[setup.outlet.id,Dexie.maxKey]).last();
      const command = saveOrderCommand(input,{setup,items:await this.items.where('outletId').equals(setup.outlet.id).toArray(),customer:input.customerId ? await this.customers.get(input.customerId) : undefined,sequence:before?.sequence || (last?.sequence || 0)+1},before,options.revision);
      await this.orders.put(command.order); await this.events.add(command.event);
      return options.settlement ? this.settleOrder(command.order.id,options.settlement,command.order.revision) : command.order;
    });
  }
  private async orderContext(id: string) {
    const setup = await this.setup(), order = await this.orders.get(id);
    if (!setup || !order || order.outletId !== setup.outlet.id) throw new Error('Order not found in this shop.');
    return {setup,order};
  }
  async changeOrderStatus(id: string, status: OrderStatus, revision: number): Promise<Order> {
    return this.transaction('rw',this.tables,async () => {
      const {setup,order} = await this.orderContext(id);
      if (status === 'cancelled') {
        const sale = order.payment.saleId ? await this.sales.get(order.payment.saleId) : undefined;
        const change = cancelOrderCommand(order,sale,await this.orderMoneyContext(order,setup),revision); await this.writeOrderMoney(change); return change.order;
      }
      const command = changeOrderStatusCommand(order,status,setup,revision);
      await this.orders.put(command.order); await this.events.add(command.event); return command.order;
    });
  }
  async undoOrderStatus(id: string, revision: number): Promise<Order> {
    return this.transaction('rw',this.tables,async () => {
      const {setup,order} = await this.orderContext(id), event = await this.events.get(order.statusEventId);
      if (!event) throw new Error('Status history not found.');
      if (order.status === 'cancelled') {
        const sale = order.payment.saleId ? await this.sales.get(order.payment.saleId) : undefined;
        const change = undoOrderCancellationCommand(order,event,sale,await this.orderMoneyContext(order,setup),revision); await this.writeOrderMoney(change); return change.order;
      }
      const command = undoOrderStatusCommand(order,event,setup,revision);
      await this.orders.put(command.order); await this.events.add(command.event); return command.order;
    });
  }
  async addOrderNote(id: string, text: string, revision: number): Promise<void> {
    await this.transaction('rw',this.tables,async () => {
      const {setup,order} = await this.orderContext(id), command = addOrderNoteCommand(order,text,setup,revision);
      await this.orders.put(command.order); await this.orderNotes.add(command.note); await this.events.add(command.event);
    });
  }
  async recordOrderCommunication(id: string, input: Pick<OrderCommunication,'purpose'|'channel'|'text'>, revision: number): Promise<void> {
    await this.transaction('rw',this.tables,async () => {
      const {setup,order} = await this.orderContext(id), command = recordOrderCommunicationCommand(order,input,setup,revision);
      await this.orders.put(command.order); await this.orderCommunications.add(command.communication); await this.events.add(command.event);
    });
  }
  async saveOrderWarning(minutes: number): Promise<void> {
    await this.transaction('rw',this.tables,async () => {
      const setup = await this.setup(); if (!setup) throw new Error('Set up your shop first.');
      const command = saveOrderWarningCommand(minutes,setup); await this.outlets.put(command.outlet); await this.events.add(command.event);
    });
  }

  private async orderMoneyContext(order: Order, setup: SetupSnapshot, accountId?:string): Promise<OrderMoneyContext> {
    const sale = order.payment.saleId ? await this.sales.get(order.payment.saleId) : undefined;
    const id = accountId || sale?.creditAccountId;
    return {setup,ledger:id ? await this.ledgerContext(id) : undefined};
  }
  private async writeOrderMoney(change: OrderMoneyChange): Promise<void> {
    await this.orders.put(change.order);
    if (change.sales.length) await this.sales.bulkPut(change.sales);
    if (change.entries.length) await this.creditEntries.bulkAdd(change.entries);
    if (change.refunds.length) await this.orderRefunds.bulkPut(change.refunds);
    await this.events.bulkAdd(change.events);
  }
  async settleOrder(id: string, input: OrderSettlementInput, revision: number): Promise<Order> {
    return this.transaction('rw',this.tables,async () => {
      const {setup,order} = await this.orderContext(id);
      const account = input.method === 'credit' && !input.accountId && order.customer.id ? await this.creditAccounts.where('[outletId+customerId+currency]').equals([order.outletId,order.customer.id,order.currency]).first() : undefined;
      const context = await this.orderMoneyContext(order,setup,input.method === 'credit' ? input.accountId || account?.id : undefined);
      const change = settleOrderCommand(order,{...input,accountId:input.accountId || account?.id},context,revision); await this.writeOrderMoney(change); return change.order;
    });
  }
  async undoOrderPayment(id: string, revision: number): Promise<Order> {
    return this.transaction('rw',this.tables,async () => {
      const {setup,order} = await this.orderContext(id), sale = order.payment.saleId ? await this.sales.get(order.payment.saleId) : undefined;
      const change = undoOrderPaymentCommand(order,sale,await this.orderMoneyContext(order,setup),revision); await this.writeOrderMoney(change); return change.order;
    });
  }
  async refundOrder(id: string, input: OrderRefundInput, revision: number): Promise<OrderRefund> {
    return this.transaction('rw',this.tables,async () => {
      const {setup,order} = await this.orderContext(id), sale = order.payment.saleId ? await this.sales.get(order.payment.saleId) : undefined;
      if (!sale) throw new Error('The original receipt is missing.');
      const change = refundOrderCommand(order,sale,input,await this.orderMoneyContext(order,setup),revision); await this.writeOrderMoney(change); return change.refunds[0];
    });
  }
  async undoOrderRefund(id: string, revision?:number): Promise<void> {
    await this.transaction('rw',this.tables,async () => {
      const refund = await this.orderRefunds.get(id); if (!refund) throw new Error('Refund not found.');
      const {setup,order} = await this.orderContext(refund.orderId);
      const change = undoOrderRefundCommand(order,refund,await this.orderMoneyContext(order,setup),revision ?? order.revision); await this.writeOrderMoney(change);
    });
  }
  private async stockContext():Promise<StockContext> {
    const setup = await this.setup();if (!setup) throw new Error('Set up your shop first.');
    const [items,suppliers,moves] = await Promise.all([this.stockItems.where('outletId').equals(setup.outlet.id).toArray(),this.suppliers.where('outletId').equals(setup.outlet.id).toArray(),this.stockMoves.where('outletId').equals(setup.outlet.id).toArray()]);return {setup,items,suppliers,moves};
  }
  private async writeStock(change:StockChange):Promise<void> {
    await this.stockItems.bulkPut(change.items);await this.stockMoves.bulkAdd(change.moves);await this.events.bulkAdd(change.events);
  }
  async saveStockItem(input:StockInput,options:{id?:string;revision?:number} = {}):Promise<StockItem> {
    return this.transaction('rw',this.tables,async () => {
      const context = await this.stockContext(), before = options.id ? context.items.find(item => item.id === options.id) : null;
      if (options.id && !before) throw new Error('Stock item not found.');
      const change = saveStockItemCommand(input,context,before,options.revision);await this.writeStock(change);return change.items[0];
    });
  }
  async adjustStock(input:StockAdjustment):Promise<StockItem> {
    return this.transaction('rw',this.tables,async () => {const change = adjustStockCommand(input,await this.stockContext());await this.writeStock(change);return change.items[0];});
  }
  async applyStockBatch(inputs:StockAdjustment[],count = false):Promise<StockItem[]> {
    return this.transaction('rw',this.tables,async () => {const change = stockBatchCommand(inputs,await this.stockContext(),Date.now(),count);await this.writeStock(change);return change.items;});
  }
  async undoStockMove(id:string,revision:number):Promise<StockItem> {
    return this.transaction('rw',this.tables,async () => {
      const context = await this.stockContext(),record = context.moves.find(move => move.id === id);if (!record) throw new Error('Stock movement not found.');
      const change = undoStockMoveCommand(record,revision,context);await this.writeStock(change);return change.items[0];
    });
  }
  async archiveStockItem(id:string,archive:boolean,revision:number):Promise<StockItem> {
    return this.transaction('rw',this.tables,async () => {
      const context = await this.stockContext(),before = context.items.find(item => item.id === id);if (!before) throw new Error('Stock item not found.');
      const change = archiveStockItemCommand(before,archive,revision,context);await this.writeStock(change);return change.items[0];
    });
  }
  async saveSupplier(input:SupplierInput,options:{id?:string;revision?:number} = {}):Promise<Supplier> {
    return this.transaction('rw',this.tables,async () => {
      const setup = await this.setup();if (!setup) throw new Error('Set up your shop first.');const before = options.id ? await this.suppliers.get(options.id) : null;if (options.id && !before) throw new Error('Supplier not found.');
      const change = saveSupplierCommand(input,setup,before,options.revision);await this.suppliers.put(change.supplier);await this.events.add(change.event);return change.supplier;
    });
  }
  async archiveSupplier(id:string,archive:boolean,revision:number):Promise<Supplier> {
    return this.transaction('rw',this.tables,async () => {
      const setup = await this.setup(),before = await this.suppliers.get(id);if (!setup || !before) throw new Error('Supplier not found.');
      const change = archiveSupplierCommand(before,archive,revision,setup);await this.suppliers.put(change.supplier);await this.events.add(change.event);return change.supplier;
    });
  }
  async recordSupplierMessage(input:SupplierMessageInput):Promise<SupplierMessage> {
    return this.transaction('rw',this.tables,async () => {
      const context = await this.stockContext(),before = await this.supplierMessages.get(input.id);
      if (before) {if (before.outletId !== context.setup.outlet.id || before.voidedAt !== undefined || !sameSupplierMessage(input,before)) throw new Error('This sent record changed. Reopen the supplier draft.');return before;}
      const change = recordSupplierMessageCommand(input,context);await this.supplierMessages.add(change.message);await this.events.add(change.event);return change.message;
    });
  }
  async undoSupplierMessage(id:string):Promise<void> {
    await this.transaction('rw',this.tables,async () => {
      const setup = await this.setup(),before = await this.supplierMessages.get(id);if (!setup || !before) throw new Error('Sent record not found.');
      const change = undoSupplierMessageCommand(before,setup);await this.supplierMessages.put(change.message);await this.events.add(change.event);
    });
  }
  private async todayContext():Promise<TodayContext> {
    const setup = await this.setup();if (!setup) throw new Error('Set up your shop first.');
    const outletId = setup.outlet.id;
    const [sales,orders,refunds,accounts,entries,customers,stock,closings] = await Promise.all([
      this.sales.where('outletId').equals(outletId).toArray(),this.orders.where('outletId').equals(outletId).toArray(),this.orderRefunds.where('outletId').equals(outletId).toArray(),
      this.creditAccounts.where('outletId').equals(outletId).toArray(),this.creditEntries.where('outletId').equals(outletId).toArray(),this.customers.where('businessId').equals(setup.business.id).toArray(),
      this.stockItems.where('outletId').equals(outletId).toArray(),this.dayClosings.where('outletId').equals(outletId).toArray(),
    ]);
    return {setup,sales,orders,refunds,accounts,entries,customers,stock,closings};
  }
  async readToday():Promise<TodayContext> {
    return this.transaction('r',this.tables,() => this.todayContext());
  }
  async closeDay(input:ClosingInput):Promise<DayClosing> {
    return this.transaction('rw',this.tables,async () => {
      const context = await this.todayContext(), before = await this.dayClosings.get(input.id);
      if (before) {
        if (before.outletId !== context.setup.outlet.id || before.voidedAt !== undefined || !sameClosingRequest(input,before)) throw new Error('This closing request changed. Reopen the review.');
        return before;
      }
      const change = closeDayCommand(input,context);
      await this.dayClosings.add(change.closing);if (change.sale) await this.sales.add(change.sale);await this.events.bulkAdd(change.events);return change.closing;
    });
  }
  async undoDayClosing(id:string):Promise<void> {
    await this.transaction('rw',this.tables,async () => {
      const setup = await this.setup(), before = await this.dayClosings.get(id);if (!setup || !before) throw new Error('Day closing not found.');
      const sale = before.addedSaleId ? await this.sales.get(before.addedSaleId) : undefined, change = undoClosingCommand(before,setup,sale);
      await this.dayClosings.put(change.closing);if (change.sale) await this.sales.put(change.sale);await this.events.bulkAdd(change.events);
    });
  }
  async readBackup():Promise<MiseBackup> {
    return (await import('./backup')).readDatabaseBackup(this);
  }
  async recordPreparedExport(input:ExportAuditInput):Promise<void> {
    return (await import('./export-audit')).recordPreparedExport(this,input);
  }
  async generateShopLink(input:ShopLinkInput,review:ShopLinkReview,base:string):Promise<AuditEvent> {
    return (await import('./shop-links')).generateDatabaseShopLink(this,input,review,base);
  }
  async undoShopLink(id:string):Promise<void> {
    return (await import('./shop-links')).undoDatabaseShopLink(this,id);
  }
  async recordPurchase(input:PurchaseInput):Promise<Purchase> {
    return (await import('./purchases')).recordDatabasePurchase(this,input);
  }
  async undoPurchase(id:string):Promise<void> {
    return (await import('./purchases')).undoDatabasePurchase(this,id);
  }
  async previewRestore(input:unknown):Promise<BackupPreview> {
    return (await import('./backup')).previewDatabaseRestore(this,input);
  }
  async restoreBackup(input:unknown,review:RestoreReview):Promise<SetupSnapshot> {
    return (await import('./backup')).restoreDatabaseBackup(this,input,review);
  }
}
export const db = new MiseDatabase(`mise-local:${import.meta.env.BASE_URL}`);
