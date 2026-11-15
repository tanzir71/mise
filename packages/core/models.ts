import type { BusinessType, MarketCode, MessageLanguage } from './packs';
export interface Entity { id: string; createdAt: number; updatedAt: number }
export interface Business extends Entity { name: string; businessType: BusinessType; marketCode: MarketCode; languages: ('en' | 'bn')[] }
export interface Outlet extends Entity { businessId: string; name: string; address: string; timezone: string; currency: string; shopLink?: string; creditMessaging?: CreditMessaging; orderWarningMinutes?: number }
export interface Member extends Entity { businessId: string; outletIds: string[]; name: string; phone: string; role: 'owner'; active: boolean }
export interface Category extends Entity { outletId: string; name: string; sort: number }
export interface Item extends Entity { outletId: string; name: string; nameLocal: string; categoryId: string; price: number; unit: string; available: boolean; isSample: boolean; oftenBought?: boolean }
export interface SetupSnapshot { business: Business; outlet: Outlet; owner: Member }
export interface AuditEvent { id: string; outletId: string; customerId?: string; orderId?: string; orderRevision?: number; stockItemId?:string; stockRevision?:number; supplierId?:string; actor: { type: 'member' | 'system' | 'agent'; id: string }; command: string; before: unknown; after: unknown; at: number; undoOf?: string }
export interface SetupInput { businessType: BusinessType; marketCode: MarketCode; name: string; phone: string; outletName?: string; address?: string; language?: MessageLanguage; timezone?: string; currency?: string }
export interface SetupCommand { snapshot: SetupSnapshot; items: Item[]; categories: Category[]; event: AuditEvent }
export type PaymentMethod = 'cash' | 'wallet' | 'card';
export type SaleMethod = PaymentMethod | 'credit';
export interface SaleLine { itemId?: string; name: string; unit: string; unitPrice: number; qty: number; lineTotal: number }
export interface Sale extends Entity { outletId: string; orderId?:string; orderNumber?:string; deliveryFee?:number; discount?:number; expression: string; amount: number; currency: string; method: SaleMethod; methodName: string; given?: number; change?: number; who: string; customerId?: string; creditAccountId?: string; items: SaleLine[]; shopName: string; shopLink?: string; timezone: string; createdBy: string; eventId: string; voidedAt?: number; voidReason?:'undo'|'order-cancel' }
export interface Customer extends Entity { businessId: string; name: string; nickname: string; phone?: string; address: string; notes: string; tags: string[]; consent: { savedAt: number; source: 'manual' }; archivedAt?: number }
export type ReminderTone = 'gentle' | 'direct';
export interface CreditReminder { enabled: boolean; dayOfMonth: number; tone: ReminderTone; channel: 'whatsapp' }
export interface CreditAccount extends Entity { customerId: string; outletId: string; currency: string; allowed: boolean; limit: number; reminder: CreditReminder }
export interface CreditEntry extends Entity { accountId: string; customerId: string; outletId: string; currency: string; sequence: number; type: 'charge' | 'payment' | 'adjustment' | 'reminder' | 'refund'; amount: number; note: string; createdBy: string; eventId: string; saleId?: string; orderId?:string; refundId?:string; returnsChargeId?:string; methodName?: string; occurredAt?: number; reversalOf?: string; purpose?: 'reminder' | 'receipt' | 'call'; overLimit?: { balance: number; limit: number } }
export interface CreditMessaging { paymentNote: string; templates: Record<ReminderTone, { en: string; bn: string }> }
export type OrderSource = 'phone'|'walk_in'|'table'|'paste'|'other';
export type OrderType = 'delivery'|'pickup'|'dine_in';
export type OrderStatus = 'new'|'confirmed'|'kitchen_seen'|'cooking'|'ready'|'out'|'delivered'|'to_confirm'|'packed'|'booked'|'with_courier'|'returning'|'returned'|'ordered'|'making'|'ready_called'|'collected'|'requested'|'priced'|'accepted'|'packing'|'delivering'|'done'|'cancelled';
export interface OrderLine { id:string; itemId?:string; name:string; unit:string; qty:number; unitPrice:number|null; lineTotal:number|null; note:string; unavailable:boolean; substitution?:{from:string;accepted:boolean;acceptedAt?:number} }
export interface OrderPayment { method:PaymentMethod|'credit'; wallet?:string; status:'pending'|'paid'|'credited'; saleId?:string; at?:number; cancellation?:{creditEntryId?:string;refundTotal:number;refundDue:number} }
export interface Order extends Entity {
  outletId:string; businessType:BusinessType; sequence:number; number:string; revision:number; source:OrderSource; sourceText:string;
  customer:{id?:string;name:string;phone?:string}; type:OrderType; status:OrderStatus; statusChangedAt:number; statusEventId:string;
  lines:OrderLine[]; subtotal:number; deliveryFee:number; discount:number; total:number|null; currency:string; timezone:string;
  address:string; table:string; scheduledFor?:number; payment:OrderPayment; handledBy:string; createdBy:string; eventId:string;
}
export interface OrderNote extends Entity { orderId:string; outletId:string; revision:number; text:string; createdBy:string; eventId:string }
export interface OrderCommunication extends Entity { orderId:string; outletId:string; revision:number; purpose:'quote'|'message'|'call'; channel:'whatsapp'|'manual'|'call'; text:string; createdBy:string; eventId:string }
export interface OrderRefund extends Entity { orderId:string; saleId:string; outletId:string; customerId?:string; accountId?:string; amount:number; currency:string; method:PaymentMethod; methodName:string; note:string; createdBy:string; eventId:string; creditEntryId?:string; voidedAt?:number }
export interface Supplier extends Entity { outletId:string;revision:number;name:string;phone?:string;note:string;archivedAt?:number;eventId:string }
export interface StockItem extends Entity { outletId:string;revision:number;name:string;nameLocal:string;activeKey?:string;unit:string;category:string;aliases:string[];onHand:number;target:number;packSize:number;lowAt:number;supplierId?:string;archivedAt?:number;lastCountedAt?:number;eventId:string }
export type StockReason = 'used'|'received'|'count'|'waste'|'undo';
export interface StockMove extends Entity { outletId:string;stockItemId:string;revision:number;name:string;unit:string;before:number;after:number;delta:number;reason:StockReason;source:'manual'|'quick_update'|'count';note:string;createdBy:string;eventId:string;countBatchId?:string;undoOf?:string }
export interface SupplierMessage extends Entity { outletId:string;supplierId?:string;supplierName:string;phone?:string;text:string;channel:'whatsapp'|'manual';stockItemIds:string[];part:number;parts:number;createdBy:string;eventId:string;voidedAt?:number }
