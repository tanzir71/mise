import { defineConfig } from 'vitest/config';
// Native PostgreSQL/WASM and deployment-build fixtures each own substantial memory.
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], maxWorkers: 2 } });
