import type {BrowserContext,Page} from '@playwright/test';
import type {startDeskUiService as Factory} from './desk-ui-service';
export function startDeskUiService():Promise<Awaited<ReturnType<typeof Factory>>>;
export function installDeskUi(page:Page):Promise<void>;
export function mockDeskBrowser(context:BrowserContext,permission?:NotificationPermission):Promise<void>;
export function captureDeskNotifications(page:Page,mode?:'inbox'|'settings'|'queue'|'cleanup'|'offline'):Promise<void>;
export function closeDeskNotificationsVisual():Promise<void>;
declare global{interface Window{miseDeskPermissionCalls:boolean[]}}
