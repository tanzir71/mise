# Native payment recording

The [shared original-evidence follow-up](payment-storage.md) addresses the reproduced long-ledger/large-label backup problem with schema-13 compact references. This document and its verification record describe the preceding schema-12 financial delivery.

M41 now has an explicit native financial action after a saved payment observation has been checked. It records a real order settlement, khata collection or new counter receipt through the existing Core commands. Matching an already-recorded receipt remains a separate metadata action and changes no money.

This increment does not complete M41. Its product capture/review interface and full backend command/canonical adapter remain required in this same milestone. The native APIs have no production review consumer yet, and they reject writes under a live cloud binding. The existing manual money interfaces remain available. Workflows, CI uploads, publication, service/migration deployment, provider commissioning and tags stay held.

## Recording actual received money

`compareSavedPaymentMoney` reads the actual saved source, selected operator/outlet, checked Payment and current financial records. The comparison is bound to that database and source in memory; copying, serializing or modifying it grants no write authority. Saving rereads those values in its native transaction and requires an explicit confirmation that the money was received and is not already recorded.

- **Order:** choose an actual unpaid order with final prices/swaps and exactly matching amount/currency. The adapter calls `settleOrderCommand`, keeps its actual sale and both audits, and associates the Payment with the new sale rather than the obsolete unpaid-order snapshot.
- **Khata:** choose the actual customer account in the observed currency. Collection cannot exceed its current debt. The adapter calls `recordCreditPaymentCommand`; it reduces debt and creates no sale/revenue.
- **Counter:** explicitly choose a new receipt and optional customer label. The adapter calls `recordSaleCommand` in the current outlet currency. Incoming text is never automatically classified as new revenue.

An existing sale/collection association must be inspected or unmatched before a different new recording. Another source's order reservation and duplicate active references remain guarded. Outgoing originals stay available for review and cannot be converted to incoming money through this adapter. Unknown formats can use checked manual fields, retaining the full original even when it contains controls or literal instructions.

The original received time remains separate from the recording time. A genuinely old message can settle its actual old unpaid order, while the new financial receipt and audits retain the current recording time. The adapter neither backdates records nor changes the planner's match window. Currentness of its own posted receipt uses the actual financial identity and snapshot independently of the message's age. Historical order/account currency stays intact after an outlet currency change; a new counter receipt uses the current currency.

## End-user bank/source labels

Before recording a Bank transfer, the end user names its bank/source using `referenceScope`. Its normalized value participates in the method/currency/reference namespace, distinguishing the same reference from two banks. bKash/Nagad reference keys and older unscoped bank observations retain their original representation. Adding or correcting a source label preserves the original capture and audit chain.

The label neither authenticates the sender nor proves that money arrived. This adapter configures no receiving account and calls no provider. Source sender/timezone/date-order choices, receiving accounts, backend connections, credentials, phone numbers and any later enrollment belong to the installation. Privileged credentials stay in its private server environment; no maintainer account, key, OTP or phone is required.

## Original recording, undo and recovery

Each posting retains its original checked money, current target snapshot, recording note, actual financial receipt snapshot and every companion audit identity. A stable action reserves deterministic distinct financial identities before the native transaction. Domain records, Payment history and all audits commit together. Uniqueness/quota/audit failures roll them all back.

The native writer checks original action identity on retries. A lost reply can be inspected after reload through `recoverSavedPaymentMoneyAction`, independently of a fresh financial comparison. Recovery returns the original audit and current history; it does not repeat money or overwrite a later undo/repost. Concurrent connections using the same original request converge on one financial receipt.

While its own money is active, a Payment cannot be edited, unmatched or set aside through metadata actions. Financial undo uses a fresh actual comparison and explicit confirmation, then calls the corresponding existing Core undo command. Its original ten-minute window and later financial dependencies remain in force. Order notes/status added afterward are preserved. Cancellation/refund correction remains in the original order flow.

If the original money was already undone through that flow, the adapter proves the exact original sale/entry undo and records a metadata acknowledgement only. It can acknowledge that genuine outcome after the original window has expired, without undoing a newer order payment or creating another khata reversal. Original posting/undo evidence remains in append-only Payment history.

## Portable backups and the current sync boundary

Native schema 29 needs no new table/index for these fields. Ordinary backup schema 12 retains complete Payment posting history, actual financial entities/audits and original Inbox text/images. Validation checks original recording/undo links and snapshots, same-outlet identities, complete ledger prefixes, money/method consistency and the continuous Payment audit chain. Later domain changes can make an association stale without deleting the original evidence. Restored snapshots grant no new runtime authority.

Strict schema-11 backups upgrade their existing observations unchanged, and reject newer source-scope/posting fields in both rows and Payment audit snapshots. Schemas 7–10 still upgrade with empty Payments. Existing empty-payment cloud fingerprints and the version-one schema-10 wire snapshot remain compatible. Nonempty Payments are rejected before preparing unsupported uploads and are retained during canonical application. Full backend/source commands, financial/allocation receipts, upload vocabulary and canonical recovery remain M41 implementation work. Before a production review is enabled, this same milestone must verify long-ledger/imported-label storage and save performance. Current credit targets repeat complete ledger snapshots in source/audit history; they are not yet a format qualified for large collection histories. Compact evidence must retain the complete original records and fresh-comparison guards.

## Verification

The [verification record](payment-finance-verification.json) records checks for this increment. Tests cover actual native order/khata/counter effects, explicit/manual confirmation, method/source scope, old source times and historical currency, stale/forged comparisons, competing requests, original recovery, audit rollback, domain undo/dependencies and complete backup recovery. A test-only Chromium module exercises real IndexedDB across two database connections and offline reload; it is isolated from production entry points.

No product screen is introduced here. Existing export/upload/restore contexts are rechecked at both base paths, including the restore dialog's Payment count and axe checks. Their supplied-reference comparisons are operational context checks, not a claim that the unfinished M41 review interface has been delivered.

The complete unit run passes **5,438 tests in 284 files**, including 21 native financial cases and 14 Core order-money cases. The original 5,004-record migration, 1,000-line and million-character corpora and wall-clock deadlines remain unchanged. The run used the repository's two-worker limit and private process-local Node priority; browser checks used one worker.

Both production builds and **165 distinct browser cases per hosting path** pass, with no skipped cases or automatic retries. Root initially passed 164 cases; the new bank test disconnected before the installed worker controlled its page. Waiting for actual worker activation/control through the existing PWA helper corrected that test setup. The complete five-case native-payment file then passed, including two-connection idempotency and financial undo after offline reload. Application/package source checksums remained unchanged during the correction. Pages passed all 165 cases in its original complete run.

Both paths have 18 supplied-reference comparisons across 360, 390, 768, 1024 and 1440 px, with no overflow; pixel differences remain informational. The actual restore count panels pass axe at 390/1440 px and have matching PNG bytes between the two paths. No complete M41 capture/review screen or whole-build byte identity is claimed.

Local comparison reports: [root](../.private/m41-finance-root-qa/report.html) and [Pages](../.private/m41-finance-pages-qa/report.html). Three inspection captures are the [phone restore counts](../.private/m41-finance-root-qa/screens/native-payment-restore-390.png), [desktop restore counts](../.private/m41-finance-root-qa/screens/native-payment-restore-1440.png) and [retained upload review](../.private/m41-finance-root-qa/screens/m30-upload-review-armed-phone-screen-390.png). These ignored local artifacts have not been uploaded or published. Reproduce the reference contexts with `pnpm qa:visual qa/configs/m17.json qa/configs/m30-upload-review.json` against an owned production preview.

Final lint and strict types pass after the browser-fixture correction; Astro reports zero errors, warnings and hints across 218 files. All 270 supplied exports are present. The final source/history/artifact credential check and normal Git guards remain required before pushing; private installation values stay outside tracked sources.
