import { configDefaults, defineConfig } from 'vitest/config';
// Native PostgreSQL/WASM and deployment-build fixtures each own substantial memory.
const kitchenHistory='tests/kitchen-current-tickets.test.ts';
const paymentOriginals='tests/payment-originals.test.ts';
const nativePaymentBackend='tests/native-payment-backend.test.ts';
const paymentArchive='tests/payment-archive.test.ts';
const originalCopies='tests/native-original-copies.test.ts';
const nativePaymentDelivery='tests/native-payment-delivery.test.ts';
const nativePaymentSync='tests/native-payment-sync.test.ts';
const nativePaymentOriginalLinks='tests/native-payment-original-links.test.ts';
const nativePaymentCanonical='tests/native-payment-canonical.test.ts';
const nativePaymentInstall='tests/native-payment-install.test.ts';
export default defineConfig({test:{maxWorkers:2,projects:[
  // Start the full original history in a fresh worker before accumulated WASM
  // allocations from the other suites. Groups run sequentially; its original
  // 5,004 records and 120-second setup/60-second case deadlines are unchanged.
  {test:{name:'kitchen-history',include:[kitchenHistory],sequence:{groupOrder:0}}},
  // Original-snapshot hashing owns its large native ledger/graph allocations
  // before the SQL/build fixtures. Keep every existing case deadline intact.
  {test:{name:'payment-originals',include:[paymentOriginals],sequence:{groupOrder:1}}},
  // The native PostgreSQL/original-ledger proof owns a fresh worker before
  // ordinary SQL/build fixtures; all existing corpora and deadlines stay intact.
  {test:{name:'native-payment-backend',include:[nativePaymentBackend],sequence:{groupOrder:2}}},
  {test:{name:'payment-archive',include:[paymentArchive],sequence:{groupOrder:3}}},
  {test:{name:'original-copies',include:[originalCopies],sequence:{groupOrder:4}}},
  {test:{name:'native-payment-delivery',include:[nativePaymentDelivery],sequence:{groupOrder:5}}},
  {test:{name:'native-payment-sync',include:[nativePaymentSync],sequence:{groupOrder:6}}},
  {test:{name:'native-payment-original-links',include:[nativePaymentOriginalLinks],sequence:{groupOrder:7}}},
  {test:{name:'native-payment-canonical',include:[nativePaymentCanonical],sequence:{groupOrder:8}}},
  // The complete installer owns its full original corpus in a separate worker group.
  {test:{name:'native-payment-install',include:[nativePaymentInstall],sequence:{groupOrder:9}}},
  // Installed Vitest 3 sorts group IDs as strings: 99 keeps ordinary suites last.
  {test:{name:'unit',include:['tests/**/*.test.ts'],exclude:[...configDefaults.exclude,kitchenHistory,paymentOriginals,nativePaymentBackend,paymentArchive,originalCopies,nativePaymentDelivery,nativePaymentSync,nativePaymentOriginalLinks,nativePaymentCanonical,nativePaymentInstall],sequence:{groupOrder:99}}},
]}});
