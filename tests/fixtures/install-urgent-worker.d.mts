import type { BrowserContext, Page } from '@playwright/test';
export function installUrgentWorker(
  context: BrowserContext,
  page: Page,
): Promise<{
  push: (notice: unknown) => Promise<void>;
  click: () => Promise<void>;
  shown: () => Promise<
    { title: string; body: string; tag: string; data: unknown }[]
  >;
  flush: () => Promise<void>;
}>;
