import type { Page } from '@playwright/test';
import type { startDeviceUiService as ServiceFactory } from './device-ui-service';
export function startDeviceUiService(): Promise<
  Awaited<ReturnType<typeof ServiceFactory>>
>;
export function installDeviceUi(page: Page): Promise<void>;
