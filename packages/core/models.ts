import type { BusinessType, MarketCode, MessageLanguage } from './packs';
export interface Entity { id: string; createdAt: number; updatedAt: number }
export interface Business extends Entity { name: string; businessType: BusinessType; marketCode: MarketCode; languages: ('en' | 'bn')[] }
export interface Outlet extends Entity { businessId: string; name: string; address: string; timezone: string; currency: string }
export interface Member extends Entity { businessId: string; outletIds: string[]; name: string; phone: string; role: 'owner'; active: boolean }
export interface Category extends Entity { outletId: string; name: string; sort: number }
export interface Item extends Entity { outletId: string; name: string; nameLocal: string; categoryId: string; price: number; unit: string; available: boolean; isSample: boolean }
export interface SetupSnapshot { business: Business; outlet: Outlet; owner: Member }
export interface AuditEvent { id: string; outletId: string; actor: { type: 'member' | 'system' | 'agent'; id: string }; command: string; before: unknown; after: unknown; at: number; undoOf?: string }
export interface SetupInput { businessType: BusinessType; marketCode: MarketCode; name: string; phone: string; outletName?: string; address?: string; language?: MessageLanguage; timezone?: string; currency?: string }
export interface SetupCommand { snapshot: SetupSnapshot; items: Item[]; categories: Category[]; event: AuditEvent }
