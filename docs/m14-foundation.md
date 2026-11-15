# M14 · Manual-order data foundation

This increment adds the order commands and IndexedDB version 4. M14 remains unchecked and `orders` defaults off while financial settlement and the reference-based screens are connected. The current landing, counter and khata remain available.

Orders keep their business flow, currency, timezone, customer contact and item-price snapshots. Sources are manual phone, walk-in, table, pasted text or other; pasted text remains literal data. Each order has a unique outlet number and an optimistic revision. Creation, edits, status changes, cancellation, notes, contact completion and warning settings use pure commands with atomic database writes and actor/time audit events.

The four business flows follow `05-data-model.md`, including pickup shortcuts and the online-shop return branch. They do not claim that another device, agent or courier has acted. A status undo restores only the last changed status and its time, preserving subsequent notes and contact records. Another status change or an earlier undo makes that reversal unavailable. Concurrent edits fail rather than overwrite newer data.

Prices use integer minor units. Quantities allow three decimal places; line totals round half up using integer arithmetic. Unpriced lines and proposed swaps keep the total incomplete. Out-of-stock lines do not charge the customer, and swaps require explicit acceptance before advancement. Saved catalogue snapshots survive later price changes; new or changed lines recheck availability and price. After a currency change, new catalogue amounts cannot be inserted into an older-currency order. Reusing a previous order refreshes catalogue prices and leaves free-text prices blank across currencies.

Notes and completed contact actions have separate tables, with their order revision recorded for causal history. Quotes support the configured Bangla/English languages and WhatsApp/call links; preparing a link does not write a completed communication. The configurable warning defaults to 15 minutes, excludes finished orders and waits until a scheduled order is due.

The next increment adds audited payment/credit settlement before enabling the UI. A new order currently records a pending payment choice, never an invented receipt or khata charge. The six required Figma frames have been fetched at full fidelity and all 270 exports are present.

Validation: 186 unit tests, including 1,000 independently checked decimal-price cases, all four state machines, unpriced/swap gates, status undo with later notes, scoped contacts, currency retention, concurrent numbering/edits, audit rollback and a version 3 credit-data migration. The browser suite now has 101 tests, alongside 89 visual comparisons.

The foundation passed [CI and Pages](https://github.com/tanzir71/mise/actions/runs/43743813776), including the [visual report](https://github.com/tanzir71/mise/actions/runs/43743813776/artifacts/14173229313). Controlled browser QA used the published Pages artifacts from `181f2cc` and `132a0e7`: a returning visitor upgraded from schema 3 to 4 with the same two sale IDs, customer ID, two ledger-entry IDs, seven audit IDs and 175 credit balance. Offline reload retained the balance with no page errors.

A fresh browser on the public Pages deployment also confirmed schema 4 and the new tables, with Orders still staged and no page errors.

That check also exposed a separate first-install-session update bug. The follow-up handles activation only after this tab's explicit Reload action and does not automatically navigate another tab. A new browser test changes the real worker bytes, confirms the requesting tab reloads, preserves another tab's unsaved calculation and retains a recorded sale offline. The order UI remains staged.
