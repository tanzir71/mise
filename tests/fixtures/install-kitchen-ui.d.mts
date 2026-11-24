import type {Page} from '@playwright/test';
import type {startKitchenUiService as Factory} from './kitchen-ui-service';
export function startKitchenUiService():Promise<Awaited<ReturnType<typeof Factory>>>;
export function installKitchenUi(page:Page):Promise<void>;
export function captureKitchenScreen(page:Page,mode?:'board'|'offline'|'queued'|'review'|'undone'|'cancelled'|'scheduled'|'handoff'|'permission-no'|'permission-original'|'permission-restored'|'saved-original'|'saved-close'|'saved-confirmed'):Promise<void>;
export function closeKitchenScreenVisual():Promise<void>;
