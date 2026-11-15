import { defineConfig } from '@playwright/test';
import { normalizeBase } from './packages/core/paths';

const base = normalizeBase(process.env.BASE_PATH);
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: true, retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  use: { baseURL: `http://127.0.0.1:4321${base}`, browserName: 'chromium', trace: 'retain-on-failure' },
  webServer: { command: 'node scripts/serve.mjs', url: `http://127.0.0.1:4321${base}`, reuseExistingServer: !process.env.CI },
});
