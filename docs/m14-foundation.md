# M14 · Manual-order data foundation

The order foundation includes commands, settlement and IndexedDB version 5. Its stages were published with Orders off while the reference-based screens were connected. See [M14 delivery](m14-delivery.md) for the UI and its delivery checks.

Orders keep their business flow, currency, timezone, customer contact and item-price snapshots. Sources are manual phone, walk-in, table, pasted text or other; pasted text remains literal data. Each order has a unique outlet number and an optimistic revision. Creation, edits, status changes, cancellation, notes, contact completion and warning settings use pure commands with atomic database writes and actor/time audit events.

The four business flows follow `05-data-model.md`, including pickup shortcuts and the online-shop return branch. They do not claim that another device, agent or courier has acted. A status undo restores only the last changed status and its time, preserving subsequent notes and contact records. Another status change or an earlier undo makes that reversal unavailable. Concurrent edits fail rather than overwrite newer data.

Prices use integer minor units. Quantities allow three decimal places; line totals round half up using integer arithmetic. Unpriced lines and proposed swaps keep the total incomplete. Out-of-stock lines do not charge the customer, and swaps require explicit acceptance before advancement. Saved catalogue snapshots survive later price changes; new or changed lines recheck availability and price. After a currency change, new catalogue amounts cannot be inserted into an older-currency order. Reusing a previous order refreshes catalogue prices and leaves free-text prices blank across currencies.

Notes and completed contact actions have separate tables, with their order revision recorded for causal history. Quotes support the configured Bangla/English languages and WhatsApp/call links; preparing a link does not write a completed communication. The configurable warning defaults to 15 minutes, excludes finished orders and waits until a scheduled order is due.

The six required Figma frames have been fetched at full fidelity and all 270 exports are present. The next UI increment connects these commands to the new-order, queue, detail and pricing screens.

Validation: 186 unit tests, including 1,000 independently checked decimal-price cases, all four state machines, unpriced/swap gates, status undo with later notes, scoped contacts, currency retention, concurrent numbering/edits, audit rollback and a version 3 credit-data migration. The browser suite now has 101 tests, alongside 89 visual comparisons.

The foundation passed [CI and Pages](https://github.com/tanzir71/mise/actions/runs/43743813776), including the [visual report](https://github.com/tanzir71/mise/actions/runs/43743813776/artifacts/14173229313). Controlled browser QA used the published Pages artifacts from `181f2cc` and `132a0e7`: a returning visitor upgraded from schema 3 to 4 with the same two sale IDs, customer ID, two ledger-entry IDs, seven audit IDs and 175 credit balance. Offline reload retained the balance with no page errors.

A fresh browser on the public Pages deployment also confirmed schema 4 and the new tables, with Orders still staged and no page errors.

That check also exposed a separate first-install-session update bug. The follow-up handles activation only after this tab's explicit Reload action and does not automatically navigate another tab. A new browser test changes the real worker bytes, confirms the requesting tab reloads, preserves another tab's unsaved calculation and retains a recorded sale offline. The order UI remains staged.

## Settlement foundation — schema 5

Order payments now create a linked receipt and, for credit, a matching khata charge atomically with their audit events. The compound create-and-pay operation also rolls back the order number if payment or consent fails. Cash, wallet, card, zero-total and current-currency credit are supported. Stale revisions, duplicate settlement and incomplete prices are rejected. Paid and advanced orders allow fulfilment details to change while protecting item prices, fees, customer identity and payment links.

Cancellation preserves the receipt and removes the sale from revenue. Cash remains physically held until a refund is recorded. Credit cancellation removes the order's own unpaid lot before other debt, so older unpaid purchases keep their age. It clears at most the current balance; previously collected excess becomes a refund owed rather than a negative customer balance. Partial refunds record the actual return method and reduce that amount owed. Credit refunds reduce net collections without changing the debt balance. A mistaken refund record can be corrected within ten minutes; cancellation undo requires all recorded refunds to be corrected first.

Schema 5 adds `orderRefunds` and order/refund lookup indexes. Existing orders, notes, receipts, customers, ledger entries and events remain intact. Customer archival retains historical collection totals, and an open receipt observes later changes from another tab. M14 remains unchecked and the `orders` flag remains off until UI delivery.

Payment corrections respect the cancellation dependency: undo a later credit cancellation before reversing a payment used in its return/refund calculation. This prevents recreating debt for a cancelled order.

Validation before publication: 210 unit tests pass, including 500 independent credit-return/refund scenarios, atomic rollback, concurrent settlement/refund/correction, payment-correction dependencies, debt ageing, historical currency/wallet retention and a version 4-to-5 migration. The browser suite passes all 101 tests, including the archived-customer collection regression, responsive/axe checks and explicit app updates. The visual report contains 89 comparisons. Final CI and live deployment results are recorded below after they finish.

Settlement commit `cfb155c` passed [CI and Pages](https://github.com/tanzir71/mise/actions/runs/43751391621), including the [89-comparison visual report](https://github.com/tanzir71/mise/actions/runs/43751391621/artifacts/14176117967). A controlled browser upgraded the published `132a0e7` schema-4 build to the published `cfb155c` schema-5 build using the explicit Reload action. It retained both sale IDs, the customer ID, both ledger-entry IDs, all seven audit IDs and the 175 credit balance, then reloaded offline without page errors. A fresh public browser confirmed schema 5, two new receipts and the same offline balance. Both regional footer credits were visibly verified on the public site.
