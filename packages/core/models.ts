import type { BusinessType, MarketCode, MessageLanguage } from './packs';
export interface Entity { id: string; createdAt: number; updatedAt: number }
export interface Business extends Entity { name: string; businessType: BusinessType; marketCode: MarketCode; languages: ('en' | 'bn')[] }
export interface Outlet extends Entity { businessId: string; name: string; address: string; timezone: string; currency: string; shopLink?: string; creditMessaging?: CreditMessaging }
export interface Member extends Entity { businessId: string; outletIds: string[]; name: string; phone: string; role: 'owner'; active: boolean }
export interface Category extends Entity { outletId: string; name: string; sort: number }
export interface Item extends Entity { outletId: string; name: string; nameLocal: string; categoryId: string; price: number; unit: string; available: boolean; isSample: boolean; oftenBought?: boolean }
export interface SetupSnapshot { business: Business; outlet: Outlet; owner: Member }
export interface AuditEvent { id: string; outletId: string; customerId?: string; actor: { type: 'member' | 'system' | 'agent'; id: string }; command: string; before: unknown; after: unknown; at: number; undoOf?: string }
export interface SetupInput { businessType: BusinessType; marketCode: MarketCode; name: string; phone: string; outletName?: string; address?: string; language?: MessageLanguage; timezone?: string; currency?: string }
export interface SetupCommand { snapshot: SetupSnapshot; items: Item[]; categories: Category[]; event: AuditEvent }
export type PaymentMethod = 'cash' | 'wallet' | 'card';
export type SaleMethod = PaymentMethod | 'credit';
export interface SaleLine { itemId: string; name: string; unit: string; unitPrice: number; qty: number; lineTotal: number }
export interface Sale extends Entity { outletId: string; expression: string; amount: number; currency: string; method: SaleMethod; methodName: string; given?: number; change?: number; who: string; customerId?: string; creditAccountId?: string; items: SaleLine[]; shopName: string; shopLink?: string; timezone: string; createdBy: string; eventId: string; voidedAt?: number }
export interface Customer extends Entity { businessId: string; name: string; nickname: string; phone?: string; address: string; notes: string; tags: string[]; consent: { savedAt: number; source: 'manual' }; archivedAt?: number }
export type ReminderTone = 'gentle' | 'direct';
export interface CreditReminder { enabled: boolean; dayOfMonth: number; tone: ReminderTone; channel: 'whatsapp' }
export interface CreditAccount extends Entity { customerId: string; outletId: string; currency: string; allowed: boolean; limit: number; reminder: CreditReminder }
export interface CreditEntry extends Entity { accountId: string; customerId: string; outletId: string; currency: string; sequence: number; type: 'charge' | 'payment' | 'adjustment' | 'reminder'; amount: number; note: string; createdBy: string; eventId: string; saleId?: string; methodName?: string; occurredAt?: number; reversalOf?: string; purpose?: 'reminder' | 'receipt' | 'call'; overLimit?: { balance: number; limit: number } }
export interface CreditMessaging { paymentNote: string; templates: Record<ReminderTone, { en: string; bn: string }> }
