import type {Page} from '@playwright/test';
export const startCustomerLinkService:typeof import('./customer-link-service').startCustomerLinkService;
export function installCustomerLinks(page:Page):Promise<void>;
