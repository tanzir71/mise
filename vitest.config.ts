import { configDefaults, defineConfig } from 'vitest/config';
// Native PostgreSQL/WASM and deployment-build fixtures each own substantial memory.
const kitchenHistory='tests/kitchen-current-tickets.test.ts';
export default defineConfig({test:{maxWorkers:2,projects:[
  {test:{name:'unit',include:['tests/**/*.test.ts'],exclude:[...configDefaults.exclude,kitchenHistory],sequence:{groupOrder:0}}},
  // Generate the full original history after other WASM databases have closed.
  // The dataset and the fixture/application deadlines remain unchanged.
  {test:{name:'kitchen-history',include:[kitchenHistory],sequence:{groupOrder:1}}},
]}});
