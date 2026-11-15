import Dexie, { type EntityTable } from 'dexie';
import type { Business, Outlet, Member, Category, Item, Sale, Customer, CreditAccount, CreditEntry, CreditMessaging, PaymentMethod, AuditEvent, SetupSnapshot, SetupInput, Order, OrderNote, OrderCommunication, OrderStatus } from '@mise/core/models';
import { setupCommand } from '@mise/core/setup';
import { removeSampleCommand, saveItemCommand, itemAvailabilityCommand, deleteItemCommand, type ItemInput } from '@mise/core/catalogue';
import { recordSaleCommand, undoSaleCommand, type SaleInput } from '@mise/core/sales';
import { marketPacks } from '@mise/core/packs';
import { saveCustomerCommand, archiveCustomerCommand, type CustomerInput } from '@mise/core/customers';
import { creditBalance, defaultCreditTerms, saveCreditTermsCommand, openingBalanceCommand, recordCreditPaymentCommand, undoCreditEntryCommand, recordCommunicationCommand, type CreditTermsInput, type LedgerContext } from '@mise/core/khata';
import { recordCreditSaleCommand, undoCreditSaleCommand, type CreditSaleInput } from '@mise/core/credit-sales';
import { saveCreditMessagingCommand } from '@mise/core/khata-messages';
import { saveOrderCommand, changeOrderStatusCommand, undoOrderStatusCommand, addOrderNoteCommand, recordOrderCommunicationCommand, saveOrderWarningCommand, type OrderInput } from '@mise/core/orders';

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
  constructor(name = 'mise-local') {
    super(name);
    this.version(1).stores({ businesses: 'id', outlets: 'id,businessId', members: 'id,businessId', categories: 'id,outletId', items: 'id,outletId,categoryId', events: 'id,outletId,at,command' });
    this.version(2).stores({ sales: 'id,outletId,createdAt' });
    this.version(3).stores({ customers:'id,businessId,phone,&[businessId+phone]', creditAccounts:'id,outletId,customerId,&[outletId+customerId+currency]', creditEntries:'id,outletId,accountId,customerId,createdAt,saleId,eventId,&reversalOf,&[accountId+sequence]', events:'id,outletId,at,command,customerId' });
    this.version(4).stores({orders:'id,outletId,status,customer.id,createdAt,&[outletId+sequence],&[outletId+number]',orderNotes:'id,orderId,outletId,&[orderId+revision]',orderCommunications:'id,orderId,outletId,&[orderId+revision]',events:'id,outletId,at,command,customerId,orderId,[orderId+orderRevision]'});
  }
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

  async saveOrder(input: OrderInput, options: {id?:string;revision?:number} = {}): Promise<Order> {
    return this.transaction('rw',this.tables,async () => {
      const setup = await this.setup(); if (!setup) throw new Error('Set up your shop first.');
      const before = options.id ? await this.orders.get(options.id) : null;
      if (options.id && !before) throw new Error('Order not found.');
      const last = before || await this.orders.where('[outletId+sequence]').between([setup.outlet.id,Dexie.minKey],[setup.outlet.id,Dexie.maxKey]).last();
      const command = saveOrderCommand(input,{setup,items:await this.items.where('outletId').equals(setup.outlet.id).toArray(),customer:input.customerId ? await this.customers.get(input.customerId) : undefined,sequence:before?.sequence || (last?.sequence || 0)+1},before,options.revision);
      await this.orders.put(command.order); await this.events.add(command.event); return command.order;
    });
  }
  private async orderContext(id: string) {
    const setup = await this.setup(), order = await this.orders.get(id);
    if (!setup || !order || order.outletId !== setup.outlet.id) throw new Error('Order not found in this shop.');
    return {setup,order};
  }
  async changeOrderStatus(id: string, status: OrderStatus, revision: number): Promise<Order> {
    return this.transaction('rw',this.tables,async () => {
      const {setup,order} = await this.orderContext(id), command = changeOrderStatusCommand(order,status,setup,revision);
      await this.orders.put(command.order); await this.events.add(command.event); return command.order;
    });
  }
  async undoOrderStatus(id: string, revision: number): Promise<Order> {
    return this.transaction('rw',this.tables,async () => {
      const {setup,order} = await this.orderContext(id), event = await this.events.get(order.statusEventId);
      if (!event) throw new Error('Status history not found.');
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
}
export const db = new MiseDatabase(`mise-local:${import.meta.env.BASE_URL}`);
