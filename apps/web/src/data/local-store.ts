import Dexie, { type EntityTable } from 'dexie';
import type { Business, Outlet, Member, Category, Item, Sale, Customer, CreditAccount, CreditEntry, AuditEvent, SetupSnapshot, Order, OrderNote, OrderCommunication, OrderRefund, StockItem, StockMove, Supplier, SupplierMessage, DayClosing, Purchase } from '@mise/core/models';
import type { StoredInboxItem } from './inbox';
import {installOutboxCapture} from './outbox-capture';
import type {LocalCloudState,LocalOutboxEntry} from '@mise/core/local-outbox';

/** Shared schema and read-only setup lookup; safe to import in the receiving worker. */
export class LocalStore extends Dexie {
  cloudState!:EntityTable<LocalCloudState,'id'>;
  outbox!:EntityTable<LocalOutboxEntry,'id'>;
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
  inboxItems!: EntityTable<StoredInboxItem,'id'>;
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
    this.version(10).stores({inboxItems:'id,outletId,createdAt,kind',events:'id,outletId,at,command,customerId,orderId,[orderId+orderRevision],stockItemId,supplierId,[stockItemId+stockRevision],closingId,handoffId,handoffTopic,&[handoffId+handoffRevision],inboxId,&[inboxId+inboxRevision]'});
    this.version(11).stores({cloudState:'id',outbox:'id,uploadId,&[uploadId+sequence],status'});
    installOutboxCapture(this);
  }
  async setup(): Promise<SetupSnapshot | null> {
    const business = await this.businesses.toCollection().first();
    if (!business) return null;
    const [outlet, owner] = await Promise.all([this.outlets.where('businessId').equals(business.id).first(), this.members.where('businessId').equals(business.id).first()]);
    if (!outlet || !owner) throw new Error('Shop data is incomplete. Keep this browser’s data and try again.');
    return { business, outlet, owner };
  }
}
