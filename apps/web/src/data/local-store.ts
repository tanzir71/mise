import Dexie, { type EntityTable,type Table } from 'dexie';
import type { Business, Outlet, Member, Category, Item, Sale, Customer, CreditAccount, CreditEntry, AuditEvent, SetupSnapshot, Order, OrderNote, OrderCommunication, OrderRefund, StockItem, StockMove, Supplier, SupplierMessage, DayClosing, Purchase } from '@mise/core/models';
import type { StoredInboxItem } from './inbox';
import {installOutboxCapture} from './outbox-capture';
import type {LocalCloudState,LocalOutboxEntry} from '@mise/core/local-outbox';
import type {LocalSyncDownload,LocalSyncPage,LocalSyncRecord} from '@mise/core/sync-download';
import {parseLocalOperatorState,resolveOperator,type LocalOperatorState} from '@mise/core/operators';
import type {LocalSyncImage} from '@mise/core/sync-images';
import type {LocalSyncCoverage} from '@mise/core/sync-coverage';
import type {LocalCanonicalSnapshot} from '@mise/core/sync-canonical';
import type {LocalCanonicalApplication} from '@mise/core/sync-materialize';
import type {LocalOwnerUploadAdmission} from '@mise/core/sync-upload-admission';
import type {SyncSession} from '@mise/core/sync-session';
import type {JoinSession} from '@mise/core/join-session';
import type {ScopeRecoveryRecord} from '@mise/core/scope-recovery';
import type {SyncActionReview} from '@mise/core/sync-action-review';
import type {LocalOrderReview} from '@mise/core/order-review-journal';
import type {LocalMoneyReview} from '@mise/core/money-review-journal';
import type {LocalPurchaseReview} from '@mise/core/purchase-review-journal';
import type {LocalStockReview} from '@mise/core/stock-review-journal';
import type {LocalCustomerReview} from '@mise/core/customer-review-journal';
import type {LocalClosingReview} from '@mise/core/closing-review-journal';
import type {Payment} from '@mise/core/models';

import type {StoredPaymentOriginalBasis,StoredPaymentOriginalNode} from '@mise/core/payment-archive';
import type {SharedJsonNode} from '@mise/core/shared-json';
import type {NativePaymentOutboxEntry} from '@mise/core/native-payment-outbox';
/** Shared schema and read-only setup lookup; safe to import in the receiving worker. */
export class LocalStore extends Dexie {
  nativePaymentActions!:EntityTable<NativePaymentOutboxEntry,'id'>;
  paymentOriginalBases!:EntityTable<StoredPaymentOriginalBasis,'id'>;
  paymentOriginalNodes!:EntityTable<StoredPaymentOriginalNode,'digest'>;
  paymentOriginalValues!:EntityTable<SharedJsonNode,'digest'>;
  payments!:EntityTable<Payment,'id'>;
  closingReviews!:EntityTable<LocalClosingReview,'id'>;
  customerReviews!:EntityTable<LocalCustomerReview,'id'>;
  stockReviews!:EntityTable<LocalStockReview,'id'>;
  purchaseReviews!:EntityTable<LocalPurchaseReview,'id'>;
  moneyReviews!:EntityTable<LocalMoneyReview,'id'>;
  orderReviews!:EntityTable<LocalOrderReview,'id'>;
  syncActionReviews!:EntityTable<SyncActionReview,'id'>;
  scopeRecoveries!:Table<ScopeRecoveryRecord,string>;
  joinSessions!:EntityTable<JoinSession,'id'>;
  syncSessions!:EntityTable<SyncSession,'id'>;
  syncAdmissions!:EntityTable<LocalOwnerUploadAdmission,'id'>;
  syncApplications!:EntityTable<LocalCanonicalApplication,'id'>;
  syncCanonical!:EntityTable<LocalCanonicalSnapshot,'id'>;
  syncCoverage!:Table<LocalSyncCoverage,[string,string]>;
  syncImages!:Table<LocalSyncImage,[string,string]>;
  operatorState!:EntityTable<LocalOperatorState,'id'>;
  syncReads!:EntityTable<LocalSyncDownload,'id'>;
  syncPages!:Table<LocalSyncPage,[string,number]>;
  syncRecords!:Table<LocalSyncRecord,[string,string]>;
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
    this.version(12).stores({syncReads:'id,source.targetHash,source.target.outletId',syncPages:'[readId+index],readId',syncRecords:'[readId+changeId],readId'});
    this.version(13).stores({operatorState:'id'});
    this.version(14).stores({syncImages:'[readId+imageId],readId,source.target.targetHash'});
    this.version(15).stores({syncCoverage:'[readId+batchHash],readId,source.target.targetHash'});
    this.version(16).stores({syncCanonical:'id'});
    this.version(17).stores({syncApplications:'id'});
    this.version(18).stores({syncAdmissions:'id'});
    this.version(19).stores({syncSessions:'id,target.targetHash'});
    this.version(20).stores({joinSessions:'id,target.targetHash'});
    this.version(21).stores({scopeRecoveries:'id,kind,operationId'});
    this.version(22).stores({syncActionReviews:'id,uploadId,commandId,targetHash'});
    this.version(23).stores({orderReviews:'id,uploadId,entryId,identityHash'});
    this.version(24).stores({moneyReviews:'id,uploadId,entryId,identityHash'});
    this.version(25).stores({purchaseReviews:'id,uploadId,entryId,identityHash'});
    this.version(26).stores({stockReviews:'id,uploadId,entryId,identityHash'});
    this.version(27).stores({customerReviews:'id,uploadId,entryId,identityHash'});
    this.version(28).stores({closingReviews:'id,uploadId,entryId,identityHash'});
    this.version(29).stores({payments:'id,outletId,inboxId,&[outletId+inboxId],&[outletId+referenceKey],&[outletId+matchKey]',events:'id,outletId,at,command,customerId,orderId,[orderId+orderRevision],stockItemId,supplierId,[stockItemId+stockRevision],closingId,handoffId,handoffTopic,&[handoffId+handoffRevision],inboxId,&[inboxId+inboxRevision],paymentId,&[paymentId+paymentRevision]'});
    this.version(30).stores({paymentOriginalBases:'id',paymentOriginalNodes:'digest,value',paymentOriginalValues:'digest'});
    this.version(31).stores({nativePaymentActions:'id,original.group.id,original.marker.entryId,state'});
    // Expand the public transaction scope before Dexie validates nested reads.
    // DBCore expansion alone cannot make a store visible to a parent wrapper.
    // Identity reads and operator changes share the same native transaction lock.
    const transaction=this.transaction;
    this.transaction=((mode:unknown,...args:unknown[])=>{
      const callback=args.at(-1),tables=args.slice(0,-1).flat(Infinity);
      if(tables.some(table=>['businesses','outlets','members'].includes(typeof table==='string'?table:(table as {name?:string})?.name??''))&&!tables.some(table=>(typeof table==='string'?table:(table as {name?:string})?.name)==='operatorState'))tables.push(this.operatorState);
      return Reflect.apply(transaction,this,[mode,...tables,callback]);
    }) as typeof this.transaction;
    installOutboxCapture(this);
  }
  async setup(): Promise<SetupSnapshot | null> {
    return this.transaction('r',this.businesses,this.outlets,this.members,this.operatorState,async()=>{const [businesses,outlets,members,saved]=await Promise.all([this.businesses.toArray(),this.outlets.toArray(),this.members.toArray(),this.operatorState.get('active')]);return resolveOperator(businesses,outlets,members,saved===undefined?null:parseLocalOperatorState(saved));});
  }
}
