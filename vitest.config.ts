import { configDefaults, defineConfig } from 'vitest/config';
// Native PostgreSQL/WASM and deployment-build fixtures each own substantial memory.
const kitchenHistory='tests/kitchen-current-tickets.test.ts';
const paymentOriginals='tests/payment-originals.test.ts';
export default defineConfig({test:{maxWorkers:2,projects:[
  // Start the full original history in a fresh worker before accumulated WASM
  // allocations from the other suites. Groups run sequentially; its original
  // 5,004 records and 120-second setup/60-second case deadlines are unchanged.
  {test:{name:'kitchen-history',include:[kitchenHistory],sequence:{groupOrder:0}}},
  // Original-snapshot hashing owns its large native ledger/graph allocations
  // before the SQL/build fixtures. Keep every existing case deadline intact.
  {test:{name:'payment-originals',include:[paymentOriginals],sequence:{groupOrder:1}}},
  {test:{name:'unit',include:['tests/**/*.test.ts'],exclude:[...configDefaults.exclude,kitchenHistory,paymentOriginals],sequence:{groupOrder:2}}},
]}});
